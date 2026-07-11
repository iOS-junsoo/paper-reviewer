require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const { execFile } = require("child_process");
const express = require("express");
const multer = require("multer");
const { query } = require("@anthropic-ai/claude-agent-sdk");
const { PDFDocument } = require("pdf-lib");

// ---------------------------------------------------------------------------
// 제한 상수
// 출처: https://platform.claude.com/docs/en/build-with-claude/pdf-support
//   (2026-06-11 확인)
//   - API document 블록 기준: 요청 전체 32MB / 최대 600페이지
//   - 현재는 Claude Agent SDK(Read 도구, 20페이지씩 분할 읽기) 경로를 쓰지만
//     동일한 상한을 업로드 가드로 유지한다 (과대 PDF 거부 목적)
// ---------------------------------------------------------------------------
const MAX_PDF_BYTES = 23 * 1024 * 1024;
const MAX_PDF_PAGES = 600;

const MODEL = process.env.MODEL || "claude-opus-4-8";
const PORT = process.env.PORT || 3000;

// 인증(토큰) 만료·실패 감지 — Agent SDK/CLI가 던지는 메시지나 결과 텍스트에서
// 로그인·OAuth·인증 관련 신호를 찾아 사용자에게 "토큰 재발급" 안내를 띄운다.
const AUTH_ERROR_RE =
  /not logged in|please run\s*\/?login|run .*login|invalid api key|invalid x-api-key|invalid bearer token|invalid_grant|authentication[ _]?(?:error|failed)|failed to authenticate|unable to authenticate|unauthorized|forbidden|oauth|revoked|setup-token|no refresh is available|token[\s\S]{0,80}?expired|expired token|credit balance.*too low|\b40[13]\b(?=[\s\S]*?(?:unauthor|forbidden|authenticat|bearer|token|api key|login|oauth|credential))/i;
const isAuthError = (s) => AUTH_ERROR_RE.test(String(s || ""));
const AUTH_ERROR_MSG =
  "Claude 인증 토큰이 만료되었거나 유효하지 않습니다. 터미널에서 `claude setup-token`을 다시 실행해 새 토큰을 발급한 뒤, .env의 CLAUDE_CODE_OAUTH_TOKEN을 교체하고 서버를 재시작하세요.";

// 업로드된 원문 PDF 보관 (뷰어·재분석·질문 답변에 사용)
const PDF_DIR = path.join(__dirname, "pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });
// 그림 해설용으로 잘라낸 그림 이미지 캐시 (poppler pdftoppm으로 페이지 영역 크롭)
const CROP_DIR = path.join(PDF_DIR, "crops");
fs.mkdirSync(CROP_DIR, { recursive: true });
// 시작 시 30일 넘은 크롭 청소 — 보정 로직 버전(v*)이 바뀔 때마다 옛 키의 파일이 다시는 안 읽히므로
// 그대로 두면 무한 증가한다. 지워져도 요청 시 poppler가 즉시 재생성하므로 안전.
fs.promises.readdir(CROP_DIR).then(async (files) => {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const f of files) {
    const p = path.join(CROP_DIR, f);
    const st = await fs.promises.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) fs.promises.rm(p, { force: true }).catch(() => {});
  }
}).catch(() => {});

// ---------------------------------------------------------------------------
// 저장소: Firebase 서비스 계정 키가 있으면 Firestore, 없으면 메모리 캐시 폴백
// (메모리 캐시는 서버 재시작 시 사라짐 — 테스트용)
// ---------------------------------------------------------------------------
const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT || "./serviceAccountKey.json";

let store;
let firestoreReady = false;

// 서비스 계정 키가 있으면 Firestore 시도 — 손상/오류 시 던지지 말고 메모리로 폴백
if (fs.existsSync(serviceAccountPath)) {
 try {
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
  });
  const db = admin.firestore();
  const analyses = db.collection("analyses");
  const chats = db.collection("chats");
  const notes = db.collection("notes");
  const library = db.collection("library");
  const extras = db.collection("extras"); // 파생 산출물 캐시(비교·발표 대본 등) — key 임의 문자열
  store = {
    kind: "firestore",
    async getLibrary() {
      try {
        const doc = await library.doc("default").get();
        return doc.exists ? JSON.parse(doc.data().libraryJson || "{}") : { folders: [], assignments: {} };
      } catch (e) {
        console.error("[라이브러리 읽기 실패 — 빈 값으로 폴백]", e.message);
        return { folders: [], assignments: {} };
      }
    },
    async setLibrary(data) {
      await library.doc("default").set({
        libraryJson: JSON.stringify(data),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },
    async getChat(hash) {
      const doc = await chats.doc(hash).get();
      return doc.exists ? JSON.parse(doc.data().messagesJson || "[]") : [];
    },
    async setChat(hash, messages) {
      await chats.doc(hash).set({
        messagesJson: JSON.stringify(messages),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },
    async getExtra(key) {
      const doc = await extras.doc(key).get();
      return doc.exists ? JSON.parse(doc.data().dataJson || "null") : null;
    },
    async setExtra(key, data) {
      await extras.doc(key).set({
        dataJson: JSON.stringify(data),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },
    async getNotes(hash) {
      const doc = await notes.doc(hash).get();
      return doc.exists ? JSON.parse(doc.data().notesJson || "{}") : { notes: "", bookmarks: [] };
    },
    async setNotes(hash, data) {
      await notes.doc(hash).set({
        notesJson: JSON.stringify(data),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },
    async get(hash) {
      const doc = await analyses.doc(hash).get();
      if (!doc.exists) return null;
      const data = doc.data();
      // analysis는 JSON 문자열로 저장됨 (Firestore는 중첩 배열을 허용하지 않음
      // — 예: heatmap inner_viz의 matrix: [[...]]). 구버전 객체 저장 레코드도 호환.
      if (typeof data.analysisGz === "string") {
        // 대형 분석: gzip+base64로 저장된 레코드 (아래 set 참고)
        data.analysis = JSON.parse(zlib.gunzipSync(Buffer.from(data.analysisGz, "base64")).toString("utf8"));
      } else if (typeof data.analysisJson === "string") {
        data.analysis = JSON.parse(data.analysisJson);
      }
      return data;
    },
    async set(hash, record) {
      const { analysis, ...rest } = record;
      const json = JSON.stringify(analysis);
      const payload = {
        ...rest,
        // 호출자가 createdAt을 넘기면 보존(섹션 재생성 등) — 없으면 지금 시각
        createdAt: rest.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
      };
      // Firestore 문서 한도 1MiB — 긴 분석(세미나+시각화 HTML)은 넘길 수 있어 900KB부터 gzip.
      // set()은 문서 전체 교체라 이전 analysisJson/analysisGz 중 안 쓴 쪽은 자연 소거된다.
      if (Buffer.byteLength(json) > 900_000) {
        payload.analysisGz = zlib.gzipSync(json).toString("base64");
        console.log(`[저장 압축] ${rest.title || hash.slice(0, 8)}: ${Buffer.byteLength(json)}B → ${payload.analysisGz.length}B`);
      } else {
        payload.analysisJson = json;
      }
      await analyses.doc(hash).set(payload);
    },
    async delete(hash) {
      await analyses.doc(hash).delete();
      await chats.doc(hash).delete().catch(() => {});
      await notes.doc(hash).delete().catch(() => {});
    },
    async list() {
      const snap = await analyses.orderBy("createdAt", "desc").limit(100).get();
      return snap.docs.map((d) => {
        const { hash, title, one_liner, venue, year, createdAt, analysis_mode } = d.data();
        return {
          hash,
          title,
          one_liner,
          venue: venue || null,
          year: year || null,
          analysis_mode: analysis_mode || "full", // 구 레코드는 full로 간주
          createdAt: createdAt ? createdAt.toDate().toISOString() : null,
        };
      });
    },
  };
  firestoreReady = true;
  console.log("[저장소] Firestore 사용");
 } catch (e) {
  console.error(
    `[경고] Firebase 초기화 실패 — 메모리 캐시로 폴백합니다: ${e.message}\n` +
      "       serviceAccountKey.json이 손상되었거나 형식이 잘못되었는지 확인하세요."
  );
 }
}

if (!firestoreReady) {
  const mem = new Map();
  const chatMem = new Map();
  const notesMem = new Map();
  const extraMem = new Map();
  let libMem = { folders: [], assignments: {} };
  store = {
    kind: "memory",
    async getLibrary() {
      return libMem;
    },
    async setLibrary(data) {
      libMem = data;
    },
    async getChat(hash) {
      return chatMem.get(hash) || [];
    },
    async setChat(hash, messages) {
      chatMem.set(hash, messages);
    },
    async getExtra(key) {
      return extraMem.get(key) ?? null;
    },
    async setExtra(key, data) {
      extraMem.set(key, data);
      if (extraMem.size > 300) extraMem.delete(extraMem.keys().next().value);
    },
    async getNotes(hash) {
      return notesMem.get(hash) || { notes: "", bookmarks: [] };
    },
    async setNotes(hash, data) {
      notesMem.set(hash, data);
    },
    async get(hash) {
      return mem.get(hash) || null;
    },
    async set(hash, record) {
      mem.set(hash, { ...record, createdAt: record.createdAt || new Date().toISOString() });
      // 폴백 저장소 무한 증가 방지 — 가장 오래 전에 넣은 항목부터 제거
      if (mem.size > 200) mem.delete(mem.keys().next().value);
    },
    async delete(hash) {
      mem.delete(hash);
      chatMem.delete(hash);
      notesMem.delete(hash);
    },
    async list() {
      return [...mem.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(({ hash, title, one_liner, venue, year, createdAt, analysis_mode }) => ({
          hash,
          title,
          one_liner,
          venue: venue || null,
          year: year || null,
          analysis_mode: analysis_mode || "full",
          createdAt,
        }));
    },
  };
  console.warn(
    `[경고] Firebase 서비스 계정 키(${serviceAccountPath})가 없어 메모리 캐시로 동작합니다.\n` +
      "       서버를 재시작하면 분석 결과가 사라집니다. Firestore를 쓰려면 키를 추가하세요."
  );
}

// ---------------------------------------------------------------------------
// LLM 호출: Claude Agent SDK (Max 구독의 Claude Code 인증 사용 — API 크레딧 불필요)
// PDF는 임시 파일로 저장 후 Read 도구가 비전으로 읽는다 (20페이지씩 분할).
// ---------------------------------------------------------------------------
// 연구 방법론 시각화 생성 지시문 v4 (판정→라우팅→생성) — 백틱·코드스팬이 많아 파일에서 읽어 주입.
// §13(렌더러 관리자용 구현 노트)·PROGRESS 주석은 prompts/method_viz_v4.md 생성 시 이미 제거됨.
const METHOD_VIZ_V4 = fs.readFileSync(path.join(__dirname, "prompts", "method_viz_v4.md"), "utf8");
// 타입 기반 HTML 시각화 생성 지시문 — method 섹션 재생성 시 별도 파이프라인으로 주입.
const METHOD_VIZ_HTML_GEN = fs.readFileSync(path.join(__dirname, "prompts", "method_viz_html_gen.md"), "utf8");
// 생성 HTML 산출 디렉터리(자가검증·디버깅용으로 파일 보존; .gitignore 대상).
const MVIZ_GEN_DIR = path.join(__dirname, ".mviz_gen");
try { fs.mkdirSync(MVIZ_GEN_DIR, { recursive: true }); } catch (e) {}

// ── ETA(예상 남은 시간) 예측 통계 ─────────────────────────────────────────────
// 성공한 분석의 실측 소요 {pages, analysis_ms, viz_ms}를 롤링 보관해 다음 실행의 ETA를
// 자가학습으로 예측한다(.gitignore 대상). 히스토리가 부족하면 시드값으로 폴백한다.
const STATS_FILE = path.join(__dirname, ".stats", "durations.json");
const STATS_MAX = 40; // 최근 N회만 유지 — 중앙값 안정 + 파일 소형
// 시드: 실측 기반 보수적 기본값(예: Balancing Act 20p ≈ 분석 324s · 시각화 334s).
// 모드별 — simple(간단 분석)은 시각화 생략 + 출력 섹션 축소 + WebSearch 생략이라 훨씬 짧다.
const ETA_SEED = {
  full: { fixedA_ms: 30000, perPage_ms: 15000, viz_ms: 330000 },
  simple: { fixedA_ms: 25000, perPage_ms: 9000, viz_ms: 0 }, // 20p ≈ 3.4분
};

function readDurations() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch (e) { return []; }
}
function appendDuration(rec) {
  try {
    const arr = readDurations();
    arr.push(rec);
    while (arr.length > STATS_MAX) arr.shift();
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(arr));
  } catch (e) { /* 통계 실패는 분석에 영향 없음 */ }
}
function median(xs) {
  const a = xs.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// pages 논문의 분석·시각화 예상 소요(ms). 같은 모드의 히스토리 3회 이상이면 실측 중앙값, 아니면 시드.
// (mode 필드가 없는 기존 레코드는 full로 간주 — 하위호환)
function predictDurations(pages, mode = "full") {
  const p = Math.max(1, pages || 1);
  const seed = ETA_SEED[mode] || ETA_SEED.full;
  const hist = readDurations().filter((h) => (h.mode || "full") === mode);
  let analysisMs, vizMs;
  if (hist.length >= 3) {
    const perPage = median(hist.map((h) => h.analysis_ms / Math.max(1, h.pages)));
    analysisMs = (perPage != null ? perPage : seed.perPage_ms) * p;
    vizMs = mode === "simple" ? 0 : (median(hist.map((h) => h.viz_ms)) ?? seed.viz_ms);
  } else {
    analysisMs = seed.fixedA_ms + seed.perPage_ms * p;
    vizMs = seed.viz_ms;
  }
  analysisMs = Math.round(analysisMs);
  vizMs = Math.round(vizMs);
  return { analysisMs, vizMs, totalMs: analysisMs + vizMs };
}
const SYSTEM_PROMPT = `당신은 논문을 구조적으로 분석하는 전문 리서처입니다.
지정된 논문 PDF 전체(텍스트, 레이아웃, 그림, 표, 수식)를 읽고 아래 JSON 스키마에 맞춰 분석 결과를 작성하세요.

스키마:
{
  "title": "논문 원제목 (영어 그대로)",
  "one_liner": "논문 핵심을 담은 한 줄 요약",
  "venue": "이 논문이 실린 학회/저널 약칭 (예: 'NeurIPS', 'ACL', 'CVPR', 'ICLR', 'TPAMI', 'EMNLP'). 학회/저널이 명시 안 된 arXiv 프리프린트면 'arXiv', 전혀 알 수 없으면 null",
  "year": "출판/공개 연도 (정수, 예: 2023). 모르면 null",
  "contributions": ["이 논문의 핵심 기여 2~4개 — 각각 한 문장, 가장 중요한 것부터"],
  "background": "연구 배경 (## 소제목으로 단락 구분)",
  "timeline": [
    { "year": 2014, "label": "Seq2Seq", "note": "인코더-디코더 등장 (한 줄)" }
  ],
  "problem": "연구에서 해결하려는 것 (## 소제목으로 단락 구분)",
  "method_steps": [
    {
      "title": "단계 이름 (10자 내외로 짧게)",
      "description": "이 단계에서 무엇을 하는지 + 왜 그렇게 하는지",
      "analogy": "이 단계를 일상에 빗댄 비유 한 문장 (예: '도서관에서 질문과 가장 관련 있는 책들을 골라 가중 평균하는 것과 같다')"
    }
  ],
  "method_visualization": "방법 시각화 스펙(지원 유형) 또는 폴백 figures(미지원 유형). ==형식·9유형 판정·라우팅·생성 규칙·검증은 아래 [연구 방법론 시각화 생성 지시문 v4] 전문을 그대로 따른다== — paper_type_primary/secondary·paper_type_reason 포함. 방법 그림이 없거나 미지원 유형이면 지시문의 폴백(§10)을 따르거나 생략(null).",
  "experiments": {
    "takeaway": "전체 실험이 보여주는 핵심 결론 한 줄 (이 논문이 '무엇을 얼마나' 입증했는지)",
    "metrics_explained": [ { "name": "측정 지표 이름 (예: BLEU, perplexity, accuracy)", "meaning": "그 지표가 무엇을 재는지 + 높을수록/낮을수록 좋은지 쉬운 한 줄" } ],
    "datasets": [ { "name": "데이터셋 이름", "detail": "규모·특징 + 무엇을 평가하는 데 쓰는지" } ],
    "terms": [ { "term": "실험 절에 나오는 용어/약자", "meaning": "비전공자도 알 만큼 쉬운 한 줄 뜻" } ],
    "studies": [
      { "title": "실험 이름 (논문 표현 그대로, 예: 'Experiment 1: ...' 또는 '4.2 Ablation')", "purpose": "이 실험으로 무엇을 확인하려는지", "setup": "데이터셋·모델·비교군·조건 등 실험 세팅", "result": "핵심 결과(논문이 보고한 ==실제 수치 포함==)와 그것이 의미하는 바", "paper_page": "이 실험이 시작되는 원문 PDF 페이지 번호 (1부터, 모르면 null)", "anchor": "원문 본문에서 이 실험 위치를 찾기 위한 짧은 검색 문구 — ==논문에 그대로 적힌 제목/소제목/번호를 글자 그대로== (예: 'Experiment 1', '4.2 Ablation Study', 'Main Results'). 없으면 null" }
    ],
    "limitations": "저자가 인정한 한계와 향후 연구 (선택, ## 소제목·마크업·[[p..]] 근거 사용 가능)"
  },
  "figure_guide": [
    {
      "label": "논문 표기 그대로 (예: 'Figure 1', 'Table 2')",
      "page": "이 그림/표가 있는 원문 PDF 페이지 번호 (1부터)",
      "kind": "architecture | results | ablation | qualitative | table | other 중 하나",
      "caption_ko": "==원문에 영어로 적힌 그 그림/표의 캡션을 먼저 한국어로 번역==한 것 (캡션 원문의 뜻 그대로)",
      "explanation": "그 그림/표가 무엇이고 어떻게 해석하면 되는지 — 축·범례·색·비교 대상이 무엇을 뜻하는지, 무엇을 보여주는지",
      "takeaway": "이 그림/표에서 꼭 기억할 핵심 한 줄",
      "bbox": [0.1, 0.18, 0.9, 0.55]
    }
  ],
  "seminar": [
    {
      "section": "원문 섹션 번호 그대로 (예: '1', '2', '3.2'). 번호가 없으면 등장 순번",
      "title": "원문 섹션 제목 그대로 (예: 'Introduction', 'Background & Related Work')",
      "points": [
        {
          "id": "소번호 (예: '1.1', '1.2')",
          "subhead": "섹션 안에서 묶음 소제목이 필요할 때만 (예: '결론' / '논문이 밝힌 한계' / 'Future Work'), 없으면 null",
          "text": "발표 슬라이드용 한국어 완결 문장 — 핵심 용어 **굵게**, 결정적 문장 ==형광==, 수식은 $...$",
          "pages": "이 내용이 실제로 나오는 원문 PDF 페이지 번호 배열 (1부터). 확실치 않으면 빈 배열 []",
          "kind": "기본은 'paper'(논문에 실제로 적힌 내용). 'added'는 오직 — 논문에 Conclusion/Limitation/Future Work가 전혀 없을 때 — 그 부분을 보완한 point에만 쓴다. 그 외 어떤 섹션에도 'added' 금지."
        }
      ]
    }
  ],
  "suggested_questions": [
    { "q": "세미나 청중이 실제로 던질 법한 날카로운 질문", "category": "핵심 공백 | 방법 | 실험 설계 | 선행 연구 대비 중 하나", "why": "이 질문이 왜 나올지 + 어떻게 답하면 좋을지 한 줄 (가능하면 한계·ablation에 근거)" }
  ],
  "glossary": [
    { "term": "핵심 기호/용어 (영어 원어 또는 기호 이름)", "latex": "수학 기호면 KaTeX LaTeX 문자열(예: W_q), 일반 용어면 null", "meaning": "비전공자도 알 만큼 쉬운 한 줄 뜻" }
  ],
  "related_papers": [
    { "title": "선행 논문 제목 (영어 원제)", "year": 2015, "reason": "이 논문을 이해하는 데 왜 먼저 읽으면 좋은지 한 줄", "link": "arXiv 등 실제 URL — WebSearch로 확인, 확실하지 않으면 null" }
  ],
  "equation_flow": {
    "caption": "이 수식 체인이 최종적으로 무엇을 만들어내는지 한 줄",
    "steps": [
      { "eq_index": 0, "goal": "이 수식이 무엇을 구하는지 (15자 내외)", "why": "왜 이걸 구해야 다음으로 갈 수 있는지 한 문장" }
    ]
  },
  "equations": [
    {
      "latex": "LaTeX 수식 문자열 (KaTeX로 렌더링 가능해야 함, $ 기호 없이 수식 본문만)",
      "paper_ref": "원 논문에서의 위치 (수식 번호가 있으면 'Eq. 1', 없으면 'Section 3.2' 같은 절 표기, 그것도 없으면 null)",
      "paper_page": "이 수식이 있는 원문 PDF 페이지 번호 (1부터, 모르면 null)",
      "explanation": "이 수식이 무엇을 하는지, method_steps의 어느 단계에 해당하는지",
      "analogy": "이 수식 전체를 일상 상황에 빗댄, 읽자마자 그림이 그려지는 비유 한 문장",
      "variables": [ { "symbol": "Q", "meaning": "query 행렬 — '내가 지금 찾고 있는 것'에 해당" } ]
    }
  ]
}

섹션별 작성 지침 (독자는 세미나 발표를 준비하거나 정독 전 구조를 잡으려는 대학원생):
- venue / year: 논문 ==첫 페이지 머리말·각주·표지, 헤더/푸터, 워터마크(예: 'Published as a conference paper at ICLR 2024', 저널명, 'Proceedings of …', 'arXiv:2312.xxxxx [cs.CL]')==에서 발표 학회/저널과 연도를 찾아 적으세요. venue는 약칭(NeurIPS·ACL·CVPR 등), 학회/저널 명시가 없는 arXiv 프리프린트면 'arXiv'. 추측하지 말고, 근거가 없으면 둘 다 null. year는 정수.
- contributions: 이 논문이 기존과 다르게 새로 해낸 것 2~4개. 방법·성능·관점 중에서 "이전엔 못 했는데 이 논문이 가능케 한 것"을 한 문장씩, 가장 중요한 것부터. 도입부(제목 아래)에 표시됩니다. 강조 마크업 사용 가능.
- background: "## 소제목" 줄로 2~3개 단락을 나누세요 (예: "## 분야의 흐름", "## 남아 있는 공백"). 분야가 어떤 흐름으로 발전해왔는지 → 현재 어디까지 와 있는지 → 이 논문이 들어갈 공백(gap)이 무엇인지 순서로.
- timeline: 연구 배경 탭 상단에 표시될 분야 발전 이정표 3~6개 (연도순). label은 기법/모델명(영어), note는 한 줄 의미. 마지막 항목은 이 논문 자신으로.
- problem: "## 소제목"으로 2~3개 단락 구분. 기존 방법(existing methods)들을 구체적으로 거명하고 각각의 한계를 짚은 뒤, 이 논문이 정확히 어떤 문제를 타깃하는지 명시하세요.
- method_steps: 4~8개 단계. 각 단계는 짧은 title + "무엇을 + 왜"를 담은 description + 일상 비유(analogy). 비유는 그 단계의 핵심 직관을 비전공자도 떠올릴 수 있게. 데이터가 흘러가는 순서대로 배열하세요.
- method_visualization / figures: 아래 [연구 방법론 시각화 생성 지시문 v4]를 ==그대로 따르세요==. 논문을 읽고 ① 9유형 판정 → ② 지원 유형(T1·T2·T3·T4·T7·T9)이면 method_visualization, 미지원(T5·T6·T8)이면 figures 폴백 → ③ 스펙 생성. ==SVG/HTML 직접 출력 금지==. paper_type_primary/paper_type_secondary/paper_type_reason는 폴백이어도 포함. (figures 폴백의 세부 형식은 기존 그림 규칙을 따른다.)

======================== 연구 방법론 시각화 생성 지시문 v4 (시작) ========================
${METHOD_VIZ_V4}
======================== 연구 방법론 시각화 생성 지시문 v4 (끝) ========================
- equations: 논문의 핵심 수식만 3~8개. ==배열 순서는 계산이 흘러가는 순서(앞 수식의 출력이 뒤 수식의 입력이 되는 순서)로 정렬하세요==. 순서를 재배열하더라도 paper_ref에 원 논문의 수식 번호(Eq. N)나 절 번호를 남겨 사용자가 원문과 대조할 수 있게 하세요. variables에는 수식에 등장하는 주요 기호를 하나도 빠짐없이 나열하고, meaning은 비전공자도 이해할 만큼 쉬운 말로 ("~에 해당", "~를 뜻함" 같은 직관적 설명). explanation은 수식의 역할과 방법론 단계 연결, analogy는 설명 바로 아래에 표시될 일상 비유 한 문장. ==paper_ref에는 원 논문의 수식 번호를 'Eq. 1' 형식으로 정확히== 남기세요(논문이 그 수식에 번호를 붙였다면). 프론트가 PDF에서 그 번호 "(1)"을 찾아 체크 표시를 합니다. 수식이 없는 논문이면 빈 배열 [].
- experiments: 실험·결과 섹션 (전용 탭). ==논문의 Experiments(실험) 절을 보고, 실험을 논문에 나온 번호·순서대로 정리==하세요. 구성:
  · 맨 위 takeaway: 전체 실험이 입증한 핵심 결론 한 줄.
  · metrics_explained: 논문이 쓰는 측정 지표가 있으면 각각 "무엇을 재는지 + 클수록/작을수록 좋은지" 쉬운 설명. (지표가 없으면 빈 배열)
  · datasets: 사용한 데이터셋과 규모·용도 설명.
  · terms: 실험 절에서 처음 보면 헷갈릴 용어/약자 설명.
  · studies: ==각 실험을 하나씩, {title(논문 표현), purpose(목적), setup(실험 세팅: 데이터·모델·비교군·조건), result(결과 — 논문이 보고한 실제 수치 포함 + 의미), paper_page(그 실험이 시작되는 원문 PDF 페이지), anchor(원문에서 그 실험 위치를 찾을 짧은 검색 문구)}로==. ablation·분석 실험도 하나의 study로. paper_page·anchor는 실험 번호 클릭 시 원문 PDF의 그 위치에 ✓ 체크를 찍는 데 쓰입니다 — ==paper_page는 직접 확인한 페이지만, anchor는 본문에 글자 그대로 있는 제목/번호만(모르면 null)==.
  · limitations(선택): 저자가 인정한 한계·향후 연구.
  ==수치는 논문에서 실제로 읽은 값만 쓰고, 확인 못 한 항목은 비우세요(지어내기 절대 금지)==. 실험이 거의 없는 이론/서베이 논문이면 studies를 비우고 takeaway·limitations만 채우거나 experiments 자체를 생략하세요.
- figure_guide: 논문에 실제로 들어 있는 ==모든 핵심 그림과 표(Figure·Table)를 등장 순서대로== 정리(전용 '그림 해설' 탭에 표시). 각 항목:
  · label(논문 표기 그대로 'Figure 1'/'Table 2'), page(해당 페이지), kind(유형).
  · ==caption_ko: 원문에 영어로 적힌 그 그림/표의 캡션을 '먼저' 한국어로 번역==(원문 caption의 뜻).
  · explanation: 그 위에 이어서, 이 그림/표가 무엇이고 어떻게 읽으면 되는지 해설(축·범례·색·비교 대상이 무엇을 뜻하는지).
  · takeaway: 한 줄 핵심.
  · ==bbox: [x0,y0,x1,y1] — 페이지 좌상단 기준 0~1 정규화 좌표==로 그 그림/표(캡션 포함)를 ==넉넉히 감싸는 영역==. 프론트가 이 좌표로 원문 이미지를 잘라 보여줍니다. 영역 추정이 어려우면 null.
  성능 비교 표·결과 플롯·정성(qualitative) 예시도 모두 포함하세요. 그림·표가 거의 없으면 빈 배열.
- seminar: 발표(세미나) 준비용 '섹션별 정리'. ==논문에 실제로 적힌 섹션 구조(목차)를 그대로 따른다==(우리가 임의로 나눈 분석 탭과 다르다 — 논문의 1. Introduction, 2. ..., N. Conclusion 같은 실제 절 제목/번호를 읽어 그 순서대로).
  각 섹션 = { section(원문 절 번호 그대로, 없으면 순번), title(원문 절 제목 그대로), points[] }.
  각 point = { id(소번호 '1.1','1.2'…), subhead(섹션 내 묶음 소제목이 필요할 때만, 없으면 null), text(발표 슬라이드용 한국어 완결 문장 — **굵게**/==형광==/$수식$ 사용), pages(그 내용이 나오는 실제 원문 페이지 번호 배열, 추측 금지·모르면 []), kind }.
  ★출처 정직성 규칙(엄수):
  · 기본은 ==오직 논문에 실제로 적힌 내용만== 옮긴다. 논문에 없는 해석·비판·배경·추측을 ==절대 추가하지 않는다==. 이 경우 kind는 반드시 "paper".
  · ==유일한 예외==: 논문에 'Conclusion/Limitation/Future Work'에 해당하는 내용이 ==아예 없을 때만==, 논문 전체를 근거로 발표자가 직접 생각해 그 부분을 보완할 수 있다. 이렇게 보완한 point는 ==반드시 kind를 "added"==로 표시한다(논문에 명시되지 않은 추가임을 분명히). 논문에 결론/한계/향후연구가 이미 있으면 그대로 옮기고 kind는 "paper".
  · 한계 섹션은 논문이 직접 밝힌 한계(kind:"paper")와, (위 예외에 해당해) 발표자가 추가한 한계(kind:"added")를 subhead로 구분하라.
  · 페이지 번호는 그 내용이 실제 있는 페이지만. 모르면 빈 배열. 가짜 페이지 금지.
- suggested_questions: 세미나 발표에서 청중이 실제로 던질 법한 날카로운 질문 4~6개. 각 질문은 category(핵심 공백/방법/실험 설계/선행 연구 대비)로 분류하고, why에 "이 질문이 왜 나올지 + 어떻게 답하면 좋을지"를 한 줄로 쓰세요(가능하면 limitations·ablations 내용에 근거). 발표자의 'Q&A 준비'에 쓰이며, 클릭하면 질문하기로 연결됩니다. 가장 날카로운(답하기 까다로운) 순서로.
- glossary: 이 논문을 따라가는 데 꼭 필요한 핵심 기호·전문 용어 6~15개. term은 영어 원어나 기호 이름, latex는 수학 기호일 때만 KaTeX 문자열(아니면 null), meaning은 한 줄 쉬운 뜻. 발표 중 표기를 잊지 않도록 돕는 용어집입니다. 수식 변수표와 중복돼도 좋으니 한 곳에 모으세요.
- related_papers: 이 논문을 이해하기 위해 ==먼저 읽으면 좋은 선행 논문 3~5편==. 본문에서 중요하게 인용된 것 위주로, reason에 "왜 먼저"를 한 줄로. link는 WebSearch로 실제 arXiv URL(https://arxiv.org/abs/...)을 확인해 넣고, 확인 못 하면 null (가짜 URL 금지).
- equation_flow: 수식 탭 맨 위에 표시되는 "수식 로드맵". equations의 순서를 따라 각 수식을 하나의 노드로 잇고, goal에는 그 수식이 구하는 것을 짧게, why에는 왜 그걸 구해야 전체 그림이 완성되는지를 쓰세요. 사용자가 개별 수식을 읽기 전에 "왜 이 수식들이 이 순서로 필요한가"를 먼저 이해하는 용도입니다. 수식이 없으면 null.

강조 마크업 (background / problem / description / role / explanation / analogy / meaning 텍스트 안에서 사용):
- **핵심 용어** : 중요한 개념·기법·모델명은 별표 두 개로 감싸 볼드 처리. 예: **Self-Attention(셀프 어텐션)**
- ==결정적 문장== : 그 섹션에서 단 하나만 기억해야 한다면 이것, 이라는 구절은 등호 두 개로 감싸 형광펜 처리. 섹션당 1~2곳만, 남용 금지.
- $인라인 수식$ : 설명 속 수식 기호·표현식은 $로 감싸면 KaTeX 수식으로 렌더링됩니다. 예: "$p(t_i)$로 추정한다". $ 없이 날것의 LaTeX를 본문에 쓰지 마세요.
- [[p7]] 또는 [[p7|원문 근거 구절]] : ==논문 PDF에서 직접 확인한 사실 주장 뒤에 출처 페이지를 다세요==. 클릭하면 좌측 원문 PDF의 그 페이지로 이동합니다. p 뒤 숫자는 PDF 페이지 번호(1부터). | 뒤에 근거가 된 원문 구절(짧게)을 넣으면 배지에 마우스를 올렸을 때 보입니다. 예: "잔차 연결을 6번 반복한다[[p3|each sub-layer ... LayerNorm(x + Sublayer(x))]]".

근거 표기 원칙 (중요):
- background / problem / method_steps.description / equations.explanation 등 사실 주장에는 가능한 한 [[p..]] 근거를 다세요.
- ==논문에서 직접 확인한 내용에만 근거를 달고, 당신의 배경지식·추론·일반론에는 근거를 달지 마세요==. 근거 없는 문장은 "모델의 해석"으로 읽힙니다. 지어낸 페이지 번호는 절대 금지.
- 비유(analogy)·도입 문장 등 사실이 아닌 부분에는 근거를 달지 않습니다.

규칙:
1. 최종 응답은 위 스키마의 JSON 객체 하나만 출력하세요. 마크다운 코드 펜스(\`\`\`), 설명 문장, 기타 텍스트를 절대 붙이지 마세요. ==출력하기 전에 괄호 짝({}, []), 콤마, 이스케이프가 유효한 JSON인지 스스로 검증하세요== — 특히 문자열을 닫는 따옴표 뒤에 잘못된 ]나 }가 붙지 않도록.
2. 설명문은 한국어로 쓰되, ==기법·모델·구성요소 같은 고유명사는 영어 원어를 그대로 쓰고 괄호에 한국어 번역(뜻)을 붙이세요==. 예: "**Scaled Dot-Product Attention**(스케일링된 내적 어텐션)", "**residual connection**(잔차 연결)". 같은 용어가 반복되면 번역 괄호는 처음 한 번만. 논문 내부 인용 키(예: hochreiter1997)나 참조 번호([1], [2])는 절대 쓰지 마세요.
2-1. 비유(analogy)는 전문 용어 없이, 읽는 즉시 장면이 그려지는 일상 상황(도서관, 회의, 요리, 택배 등)으로 쓰세요.
3. latex 문자열 안의 백슬래시는 JSON 규칙에 맞게 이스케이프하세요 (예: "\\\\frac{a}{b}").
4. 정확하고 구체적으로 쓰되 불필요한 수사는 빼세요. 강조 마크업은 위 두 종류만 사용하고 다른 마크다운 문법은 쓰지 마세요.`;

// ── 최적화 프롬프트 (검증 완료: 결과 불변, 토큰 절감) ──────────────────────────
// SYSTEM_PROMPT_CORE: 방법론 시각화(method_visualization)는 별도 HTML 파이프라인이
// 생성하므로, 전체 분석·비-method 재생성 프롬프트에서 V4 지침(~36KB)과 시각화 요청을 뺀다.
// method_visualization은 null이 되고, 방법론 시각화는 generateMethodVizHtml이 담당(figures 폴백 유지).
const SYSTEM_PROMPT_CORE = SYSTEM_PROMPT
  .replace(/"method_visualization": "[^"]*",/, '"method_visualization": "null로 두세요 — 방법론 시각화는 별도 HTML 파이프라인이 생성합니다. 여기서 만들지 마세요.",')
  .replace(/- method_visualization \/ figures: 아래 \[연구 방법론[\s\S]*?지시문 v4 \(끝\) ={5,}/, '- method_visualization: null로 두세요. 방법론 시각화는 별도 HTML 파이프라인이 생성하므로 여기서 만들지 마세요. (figure_guide/그림 해설은 평소대로 생성)');
// SYSTEM_PROMPT_MINI: HTML 시각화 생성 전용. 상세 규칙은 유저 프롬프트가 지정한 지침서를 따른다.
const SYSTEM_PROMPT_MINI =
  "당신은 논문의 방법론을 초심자용 인터랙티브 HTML 시각화로 만드는 전문가입니다. 한국어로 작성하고 " +
  "고유명사·수식은 원어를 병기합니다. 정직성 최우선 — 논문에서 확인한 값만 실제 수치로 쓰고, 확인 못 한 " +
  "값은 \"(예시)\"로 명시하며 지어내지 않습니다. 상세 제작 규칙·검증·출력 형식은 사용자 메시지가 지정한 지침서와 절차를 따릅니다.";

// ── SYSTEM_PROMPT_LITE: '간단 분석' 전용 ─────────────────────────────────────
// CORE에서 세미나·핵심기여·실험·그림·Q&A·용어집·관련논문 스키마와 해당 지침을 제거해
// 4개 섹션(배경+타임라인·문제·방법론 단계·수식+흐름)만 생성한다. WebSearch도 쓰지 않는다.
// 각 정규식이 CORE의 스키마 블록/지침 불릿을 통째로 지운다 — 매칭 실패(silent no-op)는
// 아래 자가검증이 기동 시 잡는다.
const LITE_STRIP_RES = [
  /^ {2}"contributions": \[[^\n]*\],\n/m,
  /^ {2}"method_visualization": "[^"]*",\n/m,
  /^ {2}"experiments": \{[\s\S]*?\n {2}\},\n/m,
  /^ {2}"figure_guide": \[[\s\S]*?\n {2}\],\n/m,
  /^ {2}"seminar": \[[\s\S]*?\n {2}\],\n/m,
  /^ {2}"suggested_questions": \[[\s\S]*?\n {2}\],\n/m,
  /^ {2}"glossary": \[[\s\S]*?\n {2}\],\n/m,
  /^ {2}"related_papers": \[[\s\S]*?\n {2}\],\n/m,
  /^- contributions: [^\n]*\n/m,
  /^- method_visualization: null로[^\n]*\n/m,
  /^- experiments: [\s\S]*?(?=^- figure_guide:)/m,
  /^- figure_guide: [\s\S]*?(?=^- seminar:)/m,
  /^- seminar: [\s\S]*?(?=^- suggested_questions:)/m,
  /^- suggested_questions: [^\n]*\n/m,
  /^- glossary: [^\n]*\n/m,
  /^- related_papers: [^\n]*\n/m,
];
const SYSTEM_PROMPT_LITE =
  LITE_STRIP_RES.reduce((s, re) => s.replace(re, ""), SYSTEM_PROMPT_CORE) +
  "\n\n[간단 분석 모드] 위 스키마에 남아 있는 필드만 생성하세요. 세미나 정리·실험·그림 해설 등 " +
  "제거된 섹션을 임의로 추가하지 마세요. 웹 검색 없이 논문 PDF만 근거로 작성하세요.";
// 기동 시 자가검증: 제거 대상 키가 남았거나 유지 대상 키가 사라졌으면(프롬프트 원문 변경 등)
// 경고를 남긴다 — LITE가 조용히 CORE와 같아져 사용량만 낭비되는 사고 방지.
(function validateLitePrompt() {
  const mustGo = ["contributions", "experiments", "figure_guide", "seminar", "suggested_questions", "glossary", "related_papers", "method_visualization"];
  const mustStay = ["title", "one_liner", "venue", "year", "background", "timeline", "problem", "method_steps", "equations", "equation_flow"];
  const leaked = mustGo.filter((k) => SYSTEM_PROMPT_LITE.includes(`"${k}":`));
  const missing = mustStay.filter((k) => !SYSTEM_PROMPT_LITE.includes(`"${k}":`));
  if (leaked.length || missing.length) {
    console.error(
      `[경고] SYSTEM_PROMPT_LITE 파생 이상 — 잔존: [${leaked.join(", ")}] · 소실: [${missing.join(", ")}]\n` +
        "       server.js의 SYSTEM_PROMPT 원문이 바뀌어 LITE_STRIP_RES 정규식이 어긋난 것 같습니다."
    );
  }
})();
// Phase0: 쿼리 usage 실측 로깅(경로 태그) — 절감 확인용.
function logUsage(tag, msg) {
  try {
    const u = msg.usage || {};
    console.log(`[usage:${tag}] turns ${msg.num_turns} · in ${u.input_tokens} · cache_read ${u.cache_read_input_tokens} · cache_create ${u.cache_creation_input_tokens} · out ${u.output_tokens} · $${(msg.total_cost_usd || 0).toFixed(3)}`);
  } catch (e) {}
}

async function runAnalysis(pdfPath, pageCount, onProgress = () => {}, ac, mode = "full") {
  const simple = mode === "simple";
  const prompt = simple
    ? `${pdfPath} 경로에 ${pageCount}페이지짜리 논문 PDF가 있습니다.\n` +
      `Read 도구로 논문 전체를 읽으세요. 10페이지가 넘으면 pages 파라미터로 최대 20페이지씩 나눠 끝까지 읽어야 합니다 (예: "1-20", "21-40", ...).\n` +
      `전부 읽은 뒤 시스템 프롬프트의 스키마대로 JSON 객체 하나만 최종 출력하세요. (간단 분석 — 웹 검색 없이 논문만 근거로)`
    : `${pdfPath} 경로에 ${pageCount}페이지짜리 논문 PDF가 있습니다.\n` +
      `Read 도구로 논문 전체를 읽으세요. 10페이지가 넘으므로 pages 파라미터로 최대 20페이지씩 나눠 끝까지 읽어야 합니다 (예: "1-20", "21-40", ...).\n` +
      `전부 읽은 뒤 inner_viz 제작 전에 WebSearch로 이 논문의 시각화·해설 자료를 1~2회 검색해 참고하고,\n` +
      `시스템 프롬프트의 스키마대로 JSON 객체 하나만 최종 출력하세요.`;

  let resultText = null;

  // ── 실제 진행도 계산 ──
  // 읽은 페이지/전체 페이지를 0~75%로(실측), 검색 완료 85%, 정리 시작 92%, 결과 100%.
  // 가짜로 차오르지 않고 실제 이벤트(페이지 읽음·검색·생성)에만 % 가 움직인다.
  const total = Math.max(1, pageCount);
  let maxPageRead = 0;
  let pct = 0;
  const bump = (p) => { pct = Math.max(pct, Math.min(99, Math.round(p))); return pct; };

  // 인증 오류로 판단되면 code="AUTH"를 달아 호출부가 재시도 없이 안내 메시지를 띄우게 한다.
  const tagAuth = (e) => {
    if (e && !e.code && isAuthError(e.message)) e.code = "AUTH";
    return e;
  };

  try {
    for await (const msg of query({
      prompt,
      options: {
        // 최적화: V4·method_visualization 제거(별도 HTML 파이프라인이 시각화 담당).
        // 간단 모드는 LITE(4개 섹션) + Read만 — WebSearch 생략으로 사용량·시간 절약.
        systemPrompt: simple ? SYSTEM_PROMPT_LITE : SYSTEM_PROMPT_CORE,
        model: MODEL,
        allowedTools: simple ? ["Read"] : ["Read", "WebSearch"], // WebSearch: inner_viz 예시값·관련 논문 링크의 정확도
        maxTurns: 90, // 600페이지 = Read 30회 + 검색 + 여유
        cwd: PDF_DIR,
        ...(ac ? { abortController: ac } : {}), // 클라이언트 연결 종료 시 분석 중단(사용량 절약)
      },
    })) {
      // 에이전트의 도구 사용을 사람이 읽을 수 있는 진행 메시지 + 실측 % 로 변환
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            if (block.name === "Read") {
              const pages = (block.input && block.input.pages) || "";
              // "21-40" / "1-15" 같은 표기의 끝 페이지 → 읽기 진행도
              const end = Math.max(...String(pages).match(/\d+/g)?.map(Number) || [0]);
              if (end > maxPageRead) maxPageRead = Math.min(total, end);
              const p = bump((maxPageRead / total) * 75);
              onProgress(
                pages ? `논문 읽는 중 ${maxPageRead}/${total}페이지` : "논문을 읽는 중…",
                p
              );
            } else if (block.name === "WebSearch") {
              const q = ((block.input && block.input.query) || "").slice(0, 40);
              onProgress(`해설 자료 검색 중: "${q}"`, bump(Math.max(pct, 85)));
            }
          } else if (block.type === "text" && block.text && block.text.trim().length > 40) {
            onProgress("분석 결과를 정리하는 중…", bump(92));
          }
        }
      }
      if (msg.type === "result") {
        logUsage(simple ? "전체분석:간단" : "전체분석:정밀", msg);
        if (msg.subtype !== "success") {
          // 인증 신호는 모델 본문이 아니라 SDK의 오류 결과에 담긴다. 오류 결과(SDKResultError)는
          // result 필드가 없고 errors[] 배열에 메시지가 들어오므로 둘 다 본다.
          const detail = String(
            msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || ""
          );
          const e = new Error(
            `분석 에이전트 실행 실패 (${msg.subtype})${detail ? ": " + detail.slice(0, 200) : ""}`
          );
          if (isAuthError(detail)) e.code = "AUTH";
          throw e;
        }
        resultText = msg.result;
      }
    }
  } catch (e) {
    throw tagAuth(e); // for-await가 던진 조기 인증 실패도 AUTH로 표시
  }

  if (resultText == null) {
    throw new Error("분석 에이전트가 결과를 반환하지 않았습니다.");
  }
  return resultText;
}

// ---------------------------------------------------------------------------
// SSE 헬퍼 + 공용 분석 작업 (업로드 분석 / 재분석이 공유)
// ---------------------------------------------------------------------------
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // 클라이언트가 끊긴 뒤 발생하는 비동기 소켓 오류(ECONNRESET 등)를 국소적으로 흡수한다.
  // 핸들러가 없으면 process 레벨 uncaughtException으로 올라가 로그를 어지럽힌다.
  res.on("error", () => {});
  // 하트비트: 시각화 생성 같은 무이벤트 구간(~5분)에도 20초마다 SSE 주석을 흘려
  // 중간 장비(프록시·Tailscale)의 유휴 종료를 막고, 끊김을 클라가 빨리 감지하게 한다.
  // 주석 프레임(":ping")은 클라 파서가 "data: " 접두사만 읽으므로 무해하게 무시된다.
  const hb = setInterval(() => {
    if (res.writableEnded || res.destroyed) return clearInterval(hb);
    try { res.write(": ping\n\n"); } catch (e) { clearInterval(hb); }
  }, 20000);
  res.on("close", () => clearInterval(hb));
}
function sseSend(res, obj) {
  if (res.writableEnded || res.destroyed) return; // 이미 닫힌 응답에는 쓰지 않음
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 클라이언트가 연결을 끊으면(탭 닫기·"분석 취소"·네트워크 단절) 진행 중인 에이전트
// 실행을 중단해 구독 사용량을 아낀다. SSE 같은 장기 응답에서는 req가 아니라
// res의 'close'가 신뢰할 수 있는 신호다(req 'close'는 요청 본문 수신 완료 시점에
// 일찍 발생할 수 있음). 정상 종료(res.end 호출)면 writableEnded가 true라 무시한다.
function abortOnDisconnect(res, ac, label = "") {
  res.on("close", () => {
    if (!res.writableEnded) {
      console.log(`[연결 종료 감지] ${label} — 진행 중인 분석을 중단합니다.`);
      ac.abort();
    }
  });
}

// 같은 논문이 동시에 두 번 분석되는 것을 방지 (구독 사용량 이중 소모 방지)
const inFlight = new Set();
// 한 논문(hash)에 대한 모든 변형 작업(전체 분석·재분석·섹션 재생성)을 직렬화한다.
// 키가 hash 또는 `${hash}:${section}` 두 종류라, 어느 하나라도 진행 중이면 새 변형을 거부해야
// 동시 read-modify-write로 인한 덮어쓰기(lost update)를 막는다.
function hashBusy(hash) {
  if (inFlight.has(hash)) return true;
  for (const k of inFlight) if (k.startsWith(hash + ":")) return true;
  return false;
}

// opts: { mode: "simple"|"full", createdAt } — createdAt은 간단→정밀 업그레이드 시
// 기존 분석 시각을 보존하려고 전달한다(히스토리 목록 순서 유지).
async function runAnalysisJob(res, hash, pageCount, fallbackTitle, ac, opts = {}) {
  inFlight.add(hash);
  try {
    await runAnalysisJobInner(res, hash, pageCount, fallbackTitle, ac, opts);
  } finally {
    inFlight.delete(hash);
  }
}

async function runAnalysisJobInner(res, hash, pageCount, fallbackTitle, ac, opts = {}) {
  const mode = opts.mode === "simple" ? "simple" : "full";
  const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
  console.log(`[분석 시작] ${fallbackTitle} (${pageCount}p, ${mode === "simple" ? "간단" : "정밀"}, ${hash.slice(0, 12)}…)`);
  const aborted = () => ac && ac.signal && ac.signal.aborted;
  const onProgress = (msg, pct) => sseSend(res, { type: "progress", msg, pct });
  // ETA: 예상 소요(ms)를 클라이언트에 알려 시간 기반으로 바를 채우게 한다.
  // 간단 모드는 시각화 구간이 없어 전체 = 분석 구간 하나(프론트 티커는 그대로 동작).
  const est = predictDurations(pageCount, mode);
  const estTotal = mode === "simple" ? est.analysisMs : est.totalMs;
  const tA0 = Date.now();
  sseSend(res, { type: "eta", phase: "analysis", estMs: est.analysisMs, estTotalMs: estTotal });
  onProgress(`분석 시작 — ${pageCount}페이지 논문${mode === "simple" ? " (간단 분석)" : ""}`, 0);

  let analysis = null;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2 && !analysis; attempt++) {
    try {
      lastRaw = await runAnalysis(pdfPath, pageCount, onProgress, ac, mode);
      analysis = parseModelJson(lastRaw);
    } catch (e) {
      // 클라이언트가 취소(연결 종료)한 경우: 재시도·에러 전송 없이 조용히 종료
      if (aborted()) {
        console.log(`[분석 취소] ${fallbackTitle} — 클라이언트 연결 종료로 중단`);
        return;
      }
      console.warn(`[분석/파싱 실패 — 시도 ${attempt}/2]`, (e.message || "").slice(0, 200));
      // 인증(토큰) 오류는 재시도해도 동일하게 실패 → 즉시 안내 후 종료
      if (e && e.code === "AUTH") {
        console.error("[인증 오류] CLAUDE_CODE_OAUTH_TOKEN이 만료/무효한 것으로 보입니다.");
        sseSend(res, { type: "error", error: AUTH_ERROR_MSG });
        return res.end();
      }
      if (attempt === 1) {
        onProgress("응답 검증에 실패해 처음부터 다시 시도하는 중…");
        // 재시도: 클라 구간시계를 리셋하고 추정치를 1.3배로 부풀린다.
        sseSend(res, { type: "eta", phase: "analysis", estMs: Math.round(est.analysisMs * 1.3), estTotalMs: estTotal, retry: true });
      } else {
        sseSend(res, {
          type: "error",
          error: `분석에 실패했습니다 (2회 시도): ${e.message || ""}`,
          detail: lastRaw.slice(0, 500),
        });
        return res.end();
      }
    }
  }

  if (aborted()) return; // 루프 종료와 거의 동시에 취소된 경우 저장하지 않음

  const analysisMs = Date.now() - tA0; // 실측 분석 소요(재시도 포함)
  let vizMs = 0;
  analysis.analysis_mode = mode; // 프론트가 간단/정밀을 구분(탭 잠금·배지·업그레이드 버튼)
  const saveRecord = () =>
    store.set(hash, {
      hash,
      title: analysis.title || fallbackTitle,
      one_liner: analysis.one_liner || "",
      venue: typeof analysis.venue === "string" ? analysis.venue.slice(0, 40) : null,
      year: Number.isFinite(Number(analysis.year)) ? Number(analysis.year) : null,
      analysis_mode: mode,
      // 업그레이드(간단→정밀)면 기존 분석 시각 보존 — 히스토리 순서가 튀지 않게
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      analysis,
    });
  // P1 부분 선렌더: 텍스트 분석이 끝난 시점(바 ~50%)에 먼저 저장·전송 — 사용자는
  // 시각화(~5분)가 구워지는 동안 세미나·배경·문제를 먼저 읽는다. 선저장 덕분에
  // 시각화 중 취소해도 텍스트 분석은 남는다(최종 저장이 나중에 덮어씀).
  if (mode !== "simple" && !aborted()) {
    try { await saveRecord(); } catch (e) { console.warn(`[선저장 실패 — 진행 계속] ${e.message}`); }
    sseSend(res, { type: "partial", data: { cached: false, hash, ...analysis, viz_pending: true } });
  }
  // 방법론 타입 기반 HTML 시각화 생성(§8 자가검증 루프) — 메인 분석 뒤 이어서.
  // 실패·미검증이어도 분석은 그대로 저장(기존 JSON method_visualization이 폴백).
  // 간단 모드는 시각화 파이프라인 전체 생략(−약 5.5분·사용량 절약) — [정밀 업그레이드]로 채운다.
  if (mode !== "simple" && !aborted()) {
    const tB0 = Date.now();
    // ETA: 시각화 구간으로 전환 → 클라 구간시계가 여기서 리셋된다.
    sseSend(res, { type: "eta", phase: "viz", estMs: est.vizMs, estTotalMs: est.totalMs });
    try {
      onProgress("방법론 인터랙티브 시각화 생성 중 — 타입 분류·수치 추출·자동 검증", 92);
      const viz = await generateMethodVizHtml(
        hash,
        { analysis, title: analysis.title || fallbackTitle },
        pdfPath,
        pageCount,
        ac,
        { reuseSteps: true } // P4: 메인 분석이 만든 method_steps 재사용(재생성 금지)
      );
      if (viz && viz.verify && viz.verify.pass) {
        analysis.method_viz_html = viz.html;
        if (viz.method_steps && viz.method_steps.length) analysis.method_steps = viz.method_steps;
        console.log(`[방법론 HTML 생성] ${analysis.title || fallbackTitle}: ${viz.html.length}B · ${viz.viz_report && viz.viz_report.type}`);
      } else {
        console.warn(`[방법론 HTML 미검증 — JSON 폴백 유지] ${analysis.title || fallbackTitle}`);
      }
      vizMs = Date.now() - tB0; // 성공 시에만 실측(폴백·예외는 통계에서 제외)
    } catch (e) {
      if (aborted()) return;
      console.warn(`[방법론 HTML 생성 실패 — JSON 폴백 유지] ${(e.message || "").slice(0, 150)}`);
    }
  }
  if (aborted()) return;
  // ETA 자가학습: 성공 실행의 실측 소요를 모드별로 적재해 다음 예측을 보정한다.
  if (analysisMs > 0) appendDuration({ pages: pageCount, analysis_ms: analysisMs, viz_ms: vizMs > 0 ? vizMs : null, mode });

  try {
    await saveRecord(); // 최종 저장 — 선저장본(텍스트만)을 시각화 포함본으로 덮어쓴다
  } catch (e) {
    // 저장 실패로 완성된 분석을 버리지 않는다 — 화면엔 전달하되 사용자에게도 알린다(새로고침 시 소실)
    console.error(`[저장 실패 — 결과는 화면에 전달] ${analysis.title || fallbackTitle}: ${e.message}`);
    analysis.save_failed = true;
  }
  console.log(`[분석 완료] ${analysis.title || fallbackTitle}`);
  sseSend(res, { type: "result", data: { cached: false, hash, ...analysis } });
  res.end();
}

// --- 방어적 JSON 파싱 ---------------------------------------------------------
function parseModelJson(raw) {
  let text = raw.trim();
  // ```json ... ``` 펜스 제거
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  // 펜스가 아니어도 앞뒤에 잡설이 붙은 경우: 첫 { 부터 마지막 } 까지 시도
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) text = text.slice(first, last + 1);
  }
  return JSON.parse(text); // 실패 시 호출부에서 처리
}

// --- Express ----------------------------------------------------------------
const app = express();

// 프론트를 다른 도메인(예: GitHub Pages)에서 서빙할 때만 CORS 허용
// .env에 ALLOWED_ORIGIN=https://<유저명>.github.io 형태로 설정
if (process.env.ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" })); // /api/ask·/api/notes 본문 (메모 최대치가 100kb 기본 한도 초과 가능)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    cb(isPdf ? null : new Error("PDF 파일만 업로드할 수 있습니다."), isPdf);
  },
});

// --- POST /api/analyze --------------------------------------------------------
app.post("/api/analyze", (req, res) => {
  upload.single("pdf")(req, res, async (err) => {
    try {
      if (err) {
        const msg =
          err.code === "LIMIT_FILE_SIZE"
            ? `PDF가 너무 큽니다. 최대 ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)}MB까지 업로드할 수 있습니다.`
            : err.message;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        return res.status(400).json({ error: "PDF 파일이 첨부되지 않았습니다." });
      }

      // 분석 모드: multer가 멀티파트 텍스트 필드를 req.body에 채운다. 기본 full(하위호환).
      const mode = req.body && req.body.mode === "simple" ? "simple" : "full";
      await analyzeBufferSSE(res, req.file.buffer, req.file.originalname, mode);
    } catch (e) {
      console.error("[/api/analyze 오류]", e);
      if (res.headersSent) {
        sseSend(res, { type: "error", error: `분석 중 오류: ${e.message || "알 수 없는 오류"}` });
        return res.end();
      }
      return res.status(e.status || 500).json({
        error: e.status ? e.message : `분석 중 오류가 발생했습니다: ${e.message || "알 수 없는 오류"}`,
      });
    }
  });
});

// 업로드/URL 공용: PDF 버퍼 검사 → 저장 → 캐시 확인 → 분석(SSE 스트림).
// 헤더 전송 전 오류는 err.status를 달아 throw — 라우트가 JSON으로 응답한다.
async function analyzeBufferSSE(res, buffer, fallbackName, mode) {
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  // 페이지 수 검사 (텍스트 추출이 아니라 PDF 구조 파싱만 수행)
  let pageCount;
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    pageCount = doc.getPageCount();
  } catch (e) {
    throw fail(400, "PDF를 읽을 수 없습니다. 손상되었거나 암호화(password-protected)된 파일은 지원되지 않습니다.");
  }
  if (pageCount > MAX_PDF_PAGES) {
    throw fail(400, `PDF가 ${pageCount}페이지로 최대 ${MAX_PDF_PAGES}페이지 제한을 초과합니다.`);
  }

  // SHA-256 해시 → 원문 저장 → 캐시 조회
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  await fs.promises.writeFile(path.join(PDF_DIR, `${hash}.pdf`), buffer); // 뷰어·재분석·질문용

  if (hashBusy(hash)) {
    throw fail(409, "이 논문은 이미 분석이 진행 중입니다. 잠시 후 히스토리에서 확인하세요.");
  }
  inFlight.add(hash); // 검사 직후 등록 — 아래 await 사이 동시 진입(중복 분석·사용량 이중 소모) 방지
  try {
    const cached = await store.get(hash);
    const cachedMode = cached
      ? cached.analysis_mode || (cached.analysis && cached.analysis.analysis_mode) || "full"
      : null;
    sseInit(res); // 여기부터는 SSE 스트림으로 진행 상황 전달
    // 캐시 반환 조건: 정밀 캐시는 어떤 요청이든 충족(full ⊇ simple), 간단 캐시는 간단 요청만.
    // 간단 캐시 + 정밀 요청 = 업그레이드 → 정밀 분석을 돌려 덮어쓴다(분석 시각 보존).
    if (cached && !(cachedMode === "simple" && mode === "full")) {
      sseSend(res, { type: "result", data: { cached: true, hash, ...cached.analysis } });
      return res.end();
    }
    // 클라이언트가 탭을 닫거나 "분석 취소"하면 연결이 끊긴다 → 에이전트 실행 중단(사용량 절약)
    const ac = new AbortController();
    abortOnDisconnect(res, ac, fallbackName);
    await runAnalysisJob(res, hash, pageCount, fallbackName, ac, {
      mode,
      createdAt: cached ? cached.createdAt : undefined,
    });
  } finally {
    inFlight.delete(hash); // runAnalysisJob 내부 finally와 중복 삭제는 무해(Set)
  }
}

// --- POST /api/analyze-url — arXiv 링크로 바로 분석 (관련 논문 원클릭·URL 붙여넣기) --
// SSRF 방지: arxiv.org 계열 https 화이트리스트만 허용, 리다이렉트 최종 호스트도 재검증.
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);
function normalizeArxivUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch (e) { return null; }
  if (!ARXIV_HOSTS.has(u.hostname.toLowerCase())) return null;
  // /abs/<id> · /pdf/<id>(.pdf) → /pdf/<id> (신형 2301.12345v2 / 구형 cs/0301001 모두 허용)
  const m = u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/);
  if (!m || !/^[a-z-]*\/?\d{4}[.\d]*(?:v\d+)?$/i.test(m[1])) return null;
  return { pdfUrl: `https://arxiv.org/pdf/${m[1]}`, id: m[1] };
}
app.post("/api/analyze-url", async (req, res) => {
  try {
    const { url, mode: rawMode } = req.body || {};
    const mode = rawMode === "simple" ? "simple" : "full";
    const norm = normalizeArxivUrl(String(url || "").trim());
    if (!norm) return res.status(400).json({ error: "arXiv 링크만 지원합니다 (예: https://arxiv.org/abs/1706.03762)." });

    // 다운로드 (크기 상한 스트리밍 — 초과 시 즉시 중단)
    const r = await fetch(norm.pdfUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
      headers: { "User-Agent": "PaperReviewer/1.0 (local research tool)" },
    });
    if (!r.ok) return res.status(502).json({ error: `arXiv에서 PDF를 받지 못했습니다 (HTTP ${r.status}).` });
    if (!ARXIV_HOSTS.has(new URL(r.url).hostname.toLowerCase())) {
      return res.status(400).json({ error: "리다이렉트가 arXiv 밖으로 벗어나 중단했습니다." });
    }
    const chunks = [];
    let total = 0;
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PDF_BYTES) {
        reader.cancel().catch(() => {});
        return res.status(400).json({ error: `PDF가 너무 큽니다 (최대 ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)}MB).` });
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.slice(0, 5).toString("ascii") !== "%PDF-") {
      return res.status(400).json({ error: "받은 파일이 PDF가 아닙니다 (arXiv 페이지 주소가 논문 abs/pdf 링크인지 확인)." });
    }

    console.log(`[URL 분석] arXiv ${norm.id} (${(total / 1024 / 1024).toFixed(1)}MB, ${mode})`);
    await analyzeBufferSSE(res, buffer, `arXiv ${norm.id}`, mode);
  } catch (e) {
    console.error("[/api/analyze-url 오류]", e);
    if (res.headersSent) {
      sseSend(res, { type: "error", error: `분석 중 오류: ${e.message || "알 수 없는 오류"}` });
      return res.end();
    }
    const msg = e.name === "TimeoutError" ? "arXiv 다운로드가 60초를 초과했습니다." : e.message || "알 수 없는 오류";
    return res.status(e.status || 500).json({ error: e.status ? e.message : `URL 분석 중 오류: ${msg}` });
  }
});

// --- POST /api/reanalyze/:hash — 저장된 원문으로 새 프롬프트 재분석 -------------
app.post("/api/reanalyze/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  try {
    const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({
        error: "저장된 원문 PDF가 없습니다. 같은 PDF를 다시 업로드하면 그때부터 재분석할 수 있습니다.",
      });
    }
    if (hashBusy(hash)) {
      return res.status(409).json({ error: "이 논문은 이미 분석이 진행 중입니다." });
    }
    inFlight.add(hash); // 검사 직후 등록 — await 사이 동시 진입(TOCTOU) 방지
    try {
      const buffer = await fs.promises.readFile(pdfPath);
      const doc = await PDFDocument.load(buffer, { updateMetadata: false });
      const pageCount = doc.getPageCount();
      // 기존 분석을 미리 지우지 않는다 — 재분석이 끝에서 store.set으로 덮어쓰므로,
      // 재분석 중에도 기존 결과가 유지되고(채팅·열람 가능) 실패해도 기존 분석이 보존된다.
      const prev = await store.get(hash);
      sseInit(res);
      const ac = new AbortController();
      abortOnDisconnect(res, ac, (prev && prev.title) || "재분석");
      // mode: 업그레이드 버튼(간단→정밀)도 이 경로를 쓴다. 기본 full(기존 🔄 재분석과 동일).
      const mode = req.body && req.body.mode === "simple" ? "simple" : "full";
      // 간단→정밀 업그레이드면 분석 시각 보존(목록 순서 유지). 같은 모드 재분석은 새 시각(최신으로 갱신).
      const prevMode = prev ? prev.analysis_mode || (prev.analysis && prev.analysis.analysis_mode) || "full" : null;
      const keepCreatedAt = prev && prevMode === "simple" && mode === "full" ? prev.createdAt : undefined;
      await runAnalysisJob(res, hash, pageCount, (prev && prev.title) || "재분석", ac, { mode, createdAt: keepCreatedAt });
    } finally {
      inFlight.delete(hash);
    }
  } catch (e) {
    console.error("[/api/reanalyze 오류]", e);
    if (res.headersSent) {
      sseSend(res, { type: "error", error: `재분석 실패: ${e.message}` });
      return res.end();
    }
    res.status(500).json({ error: `재분석 실패: ${e.message}` });
  }
});

// --- GET /api/eta?pages=N — 모드별 예상 소요(모드 선택 다이얼로그용) -------------
app.get("/api/eta", (req, res) => {
  const n = parseInt(req.query.pages, 10);
  const pages = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PDF_PAGES) : 20;
  const s = predictDurations(pages, "simple");
  const f = predictDurations(pages, "full");
  res.json({
    pages,
    simple: { analysisMs: s.analysisMs, totalMs: s.analysisMs }, // 시각화 구간 없음
    full: { analysisMs: f.analysisMs, vizMs: f.vizMs, totalMs: f.totalMs },
  });
});

// --- GET /api/pdf/:hash — 원문 PDF 서빙 (좌측 뷰어) ----------------------------
app.get("/api/pdf/:hash", (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  const p = path.join(PDF_DIR, `${hash}.pdf`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "저장된 원문 PDF가 없습니다." });
  res.sendFile(p);
});

// 그림 크롭 박스 결정은 lib/figurebox.js로 이동 (계획 1: 텍스트 "추론" → 실체 "실측").
// Table→텍스트 스캔(L3), Figure→임베디드 이미지(L1)→잉크 밀도(L2)→L3 라우팅 +
// 백지·절단 검증(L4). 모델 bbox는 방향·컬럼 힌트와 최종 폴백으로만 쓴다.
const { resolveFigureBox } = require("./lib/figurebox");
const clamp01 = (n) => Math.min(Math.max(0, n), 1);

// --- GET /api/figure/:hash?page=N&box=x0,y0,x1,y1&label=Table 2 — 그림 해설 크롭(PNG) -
// poppler(pdftoppm)로 해당 페이지의 영역만 잘라 PNG 반환. 모델 bbox를 캡션 위치로 보정. 디스크 캐시.
app.get("/api/figure/:hash", async (req, res) => {
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
    const page = parseInt(req.query.page, 10);
    const box = String(req.query.box || "").split(",").map(Number);
    if (!Number.isInteger(page) || page < 1 || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({ error: "잘못된 파라미터" });
    }
    let [x0, y0, x1, y1] = box;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const label = String(req.query.label || "").slice(0, 60);

    const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "저장된 원문 PDF가 없습니다." });

    // 캐시 키는 입력(page+box+label) 기준 → 캐시 히트 시 PDF 로드·박스 실측을 건너뛴다.
    // v12: 캡션 스코어링 수정(2단 레이아웃 + "Figure 1." 마침표식) — 버전을 올려 옛 크롭 캐시를 자연 무효화
    const keyHash = crypto.createHash("sha1").update(`v12|${page}|${box.join(",")}|${label}`).digest("hex").slice(0, 16);
    const outBase = path.join(CROP_DIR, `${hash}_${keyHash}`);
    const outPng = `${outBase}.png`;

    if (!fs.existsSync(outPng)) {
      const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
      if (page > doc.getPageCount()) return res.status(404).json({ error: "페이지 범위를 벗어났습니다." });
      const { width: wpt, height: hpt } = doc.getPage(page - 1).getSize();

      // 크롭 박스 실측 (Table→L3 / Figure→L1→L2→L3 + L4 백지·절단 검증) — 실패 시 모델 bbox
      try {
        const r = await resolveFigureBox(pdfPath, page, label, [x0, y0, x1, y1], wpt, hpt);
        if (r && r.box) {
          [x0, y0, x1, y1] = r.box;
          console.log(`[그림 크롭] ${label || "(라벨 없음)"} p${page} → ${r.layer}${r.report && r.report.blank_fallback ? "+백지폴백" : ""}`);
        }
      } catch (e) { console.error("[크롭 박스 실측 실패 — 모델 bbox 사용]", label, e.message); }

      const pad = 0.015; // 약간의 여유로 잘림 방지
      x0 = clamp01(x0 - pad); y0 = clamp01(y0 - pad);
      x1 = clamp01(x1 + pad); y1 = clamp01(y1 + pad);
      if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return res.status(422).json({ error: "영역이 너무 작습니다." });

      const DPI = 150;
      const wpx = (wpt / 72) * DPI, hpx = (hpt / 72) * DPI;
      const X = Math.max(0, Math.round(x0 * wpx));
      const Y = Math.max(0, Math.round(y0 * hpx));
      const W = Math.max(1, Math.round((x1 - x0) * wpx));
      const H = Math.max(1, Math.round((y1 - y0) * hpx));
      await new Promise((resolve, reject) => {
        execFile(
          "pdftoppm",
          ["-png", "-singlefile", "-f", String(page), "-l", String(page), "-r", String(DPI),
           "-x", String(X), "-y", String(Y), "-W", String(W), "-H", String(H), pdfPath, outBase],
          { timeout: 20000 },
          // 실패·타임아웃 시 부분 생성된 PNG를 지운다 — 손상 이미지가 캐시로 영구 서빙되는 것 방지
          (err) => (err ? fs.promises.rm(outPng, { force: true }).catch(() => {}).then(() => reject(err)) : resolve())
        );
      });
    }
    if (!fs.existsSync(outPng)) throw new Error("크롭 이미지를 만들지 못했습니다.");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(outPng);
  } catch (e) {
    console.error("[/api/figure 오류]", e);
    if (!res.headersSent) res.status(500).json({ error: `그림 크롭 실패: ${e.message}` });
  }
});

// --- POST /api/ask/:hash — 분석된 논문에 대한 후속 질문 -------------------------
app.post("/api/ask/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  // 사용자가 답변 대기 중 떠나면 중단 (catch에서 ac.signal을 보려고 try 밖에 둔다)
  const ac = new AbortController();
  abortOnDisconnect(res, ac, "질문");
  try {
    const { question, history } = req.body || {};
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "질문이 비어 있습니다." });
    }
    const record = await store.get(hash);
    if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });

    const a = record.analysis;
    const simpleRec = (record.analysis_mode || a.analysis_mode || "full") === "simple";
    const context = JSON.stringify({
      title: a.title,
      one_liner: a.one_liner,
      analysis_mode: simpleRec ? "simple(간단 분석 — 실험·그림·세미나 정리 섹션 없음)" : "full",
      contributions: a.contributions,
      background: a.background,
      problem: a.problem,
      method_steps: a.method_steps,
      experiments: a.experiments,
      equations: (a.equations || []).map((e) => ({ latex: e.latex, explanation: e.explanation })),
    }).slice(0, 14000);
    const histText = (history || [])
      .slice(-6)
      .map((h) => `Q: ${h.q}\nA: ${h.a}`)
      .join("\n\n");
    const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);

    const prompt = [
      `논문 "${a.title}"에 대한 대학원생의 후속 질문에 답하세요.`,
      `기존 분석 요약(JSON): ${context}`,
      fs.existsSync(pdfPath)
        ? `원문 PDF: ${pdfPath} — 분석 요약만으로 부족할 때만 Read 도구(pages 파라미터)로 필요한 부분을 읽으세요.`
        : `원문 PDF는 없으므로 분석 요약과 일반 지식으로 답하세요.`,
      simpleRec
        ? `참고: 이 논문은 '간단 분석' 모드라 분석 요약에 실험·결과, 그림 해설, 세미나 정리가 없습니다. 그 내용을 물으면 원문 PDF를 직접 읽어 답하고, 필요하면 "정밀 분석으로 업그레이드" 기능을 한 줄로 안내하세요.`
        : "",
      histText ? `이전 대화:\n${histText}` : "",
      `질문: ${question}`,
      `규칙: 한국어로 간결히(보통 3~8문장, 필요할 때만 길게). 고유명사는 영어 원어 그대로 + 괄호 번역. 인라인 수식은 $...$, 강조는 **볼드**/==형광펜== 사용 가능. 마크다운 헤더·리스트·코드펜스는 쓰지 말고, 답변 텍스트만 출력하세요. ==원문 PDF에서 확인한 사실에는 [[p7]] 또는 [[p7|근거 구절]] 형식으로 출처 페이지를 다세요(클릭 시 그 페이지로 이동). 직접 확인한 것에만 달고, 추론·일반론에는 달지 마세요. 페이지를 지어내지 마세요.==`,
    ]
      .filter(Boolean)
      .join("\n\n");

    console.log(`[질문] ${a.title}: ${question.slice(0, 60)}`);
    sseInit(res); // 진행 단계(생각 과정)를 실시간으로 흘려보낸다
    let lastStep = "";
    const step = (msg) => { if (msg === lastStep) return; lastStep = msg; sseSend(res, { type: "step", msg }); }; // 직전과 같은 단계는 생략
    step("논문을 살펴보는 중…");
    let answer = null;
    for await (const msg of query({
      prompt,
      options: {
        model: MODEL, allowedTools: ["Read", "WebSearch"], maxTurns: 20, cwd: PDF_DIR,
        abortController: ac,
        includePartialMessages: true, // 답변 텍스트를 delta로 실시간 전송(타자기 렌더)
      },
    })) {
      // 텍스트 토큰 스트리밍 — 메인 스레드(서브에이전트 제외)의 text_delta만 흘려보낸다.
      // 도구 사용 전의 중간 코멘트도 흐르지만, 클라가 tool step 이벤트 때 라이브 버블을 비운다.
      if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
        const ev = msg.event;
        if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
          sseSend(res, { type: "delta", text: ev.delta.text });
        }
      }
      // 에이전트의 도구 사용·작성 단계를 사람이 읽을 메시지로 변환해 전송
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (b.type === "tool_use") {
            if (b.name === "Read") {
              const pages = (b.input && b.input.pages) || "";
              step(pages ? `📄 원문 ${pages}쪽을 읽는 중…` : "📄 원문을 읽는 중…");
            } else if (b.name === "WebSearch") {
              const q = ((b.input && b.input.query) || "").slice(0, 40);
              step(`🔎 자료를 검색하는 중: "${q}"`);
            }
          }
          // (텍스트 블록 step은 제거 — delta 스트리밍이 실제 답변을 실시간 표시하므로
          //  step을 보내면 클라가 라이브 텍스트를 지워버린다)
        }
      }
      if (msg.type === "result") {
        if (msg.subtype !== "success") {
          const detail = String(
            msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || ""
          );
          if (isAuthError(detail)) { sseSend(res, { type: "error", error: AUTH_ERROR_MSG }); return res.end(); }
          throw new Error(`응답 생성 실패 (${msg.subtype})${detail ? ": " + detail.slice(0, 120) : ""}`);
        }
        answer = msg.result;
      }
    }
    // 채팅 기록 저장 (논문별, 기기 간 공유)
    if (answer) {
      try {
        const msgs = await store.getChat(hash);
        msgs.push({ q: question, a: answer, t: Date.now() });
        await store.setChat(hash, msgs.slice(-50)); // 최근 50개만 유지
      } catch (e) {
        console.warn("[채팅 저장 실패]", e.message);
      }
    }
    sseSend(res, { type: "result", answer: answer || "(답변을 생성하지 못했습니다)" });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return; // 사용자가 취소(연결 종료) — 조용히 무시
    console.error("[/api/ask 오류]", e);
    const friendly =
      e && (e.code === "AUTH" || isAuthError(e.message)) ? AUTH_ERROR_MSG : `질문 처리 실패: ${e.message}`;
    if (res.headersSent) {
      // SSE가 이미 시작됨 → error 이벤트로 전달
      if (!res.writableEnded && !res.destroyed) { sseSend(res, { type: "error", error: friendly }); res.end(); }
      return;
    }
    res.status(e && (e.code === "AUTH" || isAuthError(e.message)) ? 401 : 500).json({ error: friendly });
  }
});

// --- GET /api/chat/:hash — 저장된 채팅 기록 ------------------------------------
app.get("/api/chat/:hash", async (req, res) => {
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    res.json({ messages: await store.getChat(hash) });
  } catch (e) {
    res.status(500).json({ error: `채팅 기록 조회 실패: ${e.message}` });
  }
});

// --- 파생 텍스트 생성 공용 (논문 비교 · 발표 대본) -----------------------------
// 도구 없는 단일 LLM 호출을 delta SSE로 스트리밍하고 최종 텍스트를 반환한다.
async function streamTextGen(res, ac, prompt, tag) {
  let answer = null;
  for await (const msg of query({
    prompt,
    options: { model: MODEL, allowedTools: [], maxTurns: 4, abortController: ac, includePartialMessages: true }, // 4: 모델이 마무리 턴을 더 쓰는 경우 대비(도구 없음이라 초과 사용 없음)
  })) {
    if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
      const ev = msg.event;
      if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
        sseSend(res, { type: "delta", text: ev.delta.text });
      }
    }
    if (msg.type === "result") {
      logUsage(tag, msg);
      if (msg.subtype !== "success") {
        const detail = String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || "");
        const e = new Error(`생성 실패 (${msg.subtype})${detail ? ": " + detail.slice(0, 160) : ""}`);
        if (isAuthError(detail)) e.code = "AUTH";
        throw e;
      }
      answer = msg.result;
    }
  }
  if (answer == null) throw new Error("모델이 텍스트를 반환하지 않았습니다.");
  return answer;
}
// 파생 생성 라우트 공용 오류 응답 (SSE 시작 전/후 모두 처리)
function genErrorReply(res, e, label) {
  console.error(`[/api/${label} 오류]`, e.message);
  const friendly = e.code === "AUTH" ? AUTH_ERROR_MSG : `${label} 생성 중 오류: ${e.message || "알 수 없는 오류"}`;
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) { sseSend(res, { type: "error", error: friendly }); res.end(); }
  } else {
    res.status(e.code === "AUTH" ? 401 : e.status || 500).json({ error: e.status ? e.message : friendly });
  }
}
// 비교·대본 컨텍스트용 분석 요약(원문 PDF 재독 없음 — 저렴·빠름)
function analysisDigest(a, { withSeminar = false } = {}) {
  const d = {
    title: a.title, one_liner: a.one_liner, venue: a.venue, year: a.year,
    contributions: a.contributions,
    problem: a.problem,
    method_steps: (a.method_steps || []).map((s) => ({ title: s.title, description: s.description })),
    equations: (a.equations || []).slice(0, 8).map((e) => ({ latex: e.latex, explanation: (e.explanation || "").slice(0, 200) })),
    experiments: a.experiments && typeof a.experiments === "object"
      ? {
          takeaway: a.experiments.takeaway,
          limitations: a.experiments.limitations,
          studies: (a.experiments.studies || []).slice(0, 6).map((s) => ({ title: s.title, result: (s.result || "").slice(0, 220) })),
        }
      : null,
  };
  if (withSeminar) d.seminar = a.seminar;
  return JSON.stringify(d).slice(0, withSeminar ? 15000 : 9000);
}

// --- POST /api/compare — 분석된 두 논문 비교 (B1) ------------------------------
// 두 분석 JSON만 컨텍스트로 쓰는 1회 호출. 결과는 순서 무관 키로 캐시.
app.post("/api/compare", async (req, res) => {
  const ac = new AbortController();
  abortOnDisconnect(res, ac, "논문 비교");
  try {
    const ha = String((req.body && req.body.a) || "").replace(/[^a-f0-9]/g, "");
    const hb = String((req.body && req.body.b) || "").replace(/[^a-f0-9]/g, "");
    const force = !!(req.body && req.body.force);
    if (!isValidHash(ha) || !isValidHash(hb) || ha === hb) {
      return res.status(400).json({ error: "서로 다른 두 논문을 골라 주세요." });
    }
    const [ra, rb] = await Promise.all([store.get(ha), store.get(hb)]);
    if (!ra || !rb) return res.status(404).json({ error: "두 논문 모두 분석돼 있어야 비교할 수 있습니다." });
    // 순서 무관 캐시 + 프롬프트도 정렬 순서로 고정 — 어느 논문에서 열어도 같은 결과 재사용
    const [h1, h2] = [ha, hb].sort();
    const r1 = h1 === ha ? ra : rb;
    const r2 = h1 === ha ? rb : ra;
    const key = `compare2:${h1}:${h2}`; // v2: 구조화(축별 그리드) — 구버전 산문 캐시(compare:)는 자연 폐기
    sseInit(res);
    if (!force) {
      const cached = await store.getExtra(key).catch(() => null);
      if (cached && cached.data) {
        sseSend(res, { type: "result", data: cached.data, cached: true });
        return res.end();
      }
    }
    sseSend(res, { type: "step", msg: "두 논문의 분석을 비교하는 중…" });
    const t1 = (r1.analysis && r1.analysis.title) || r1.title || "논문 1";
    const t2 = (r2.analysis && r2.analysis.title) || r2.title || "논문 2";
    const prompt = [
      `대학원 세미나 준비 중인 학생을 위해 이미 분석된 두 논문을 비교하세요. 원문은 다시 읽을 수 없고, 아래 분석 요약(JSON)만 근거로 씁니다 — 요약에 없는 내용은 지어내지 마세요.`,
      `[논문 1] ${analysisDigest(r1.analysis || {})}`,
      `[논문 2] ${analysisDigest(r2.analysis || {})}`,
      `출력: 아래 스키마의 JSON 객체 하나만. ==한눈에 훑는 비교표가 목적이므로 셀은 반드시 짧게== — ` +
        `각 셀 최대 80자(구·1문장), 산문 금지. 강조 **볼드**/==형광펜==, 수식 $...$ 허용. ` +
        `"a"는 논문 1("${t1.slice(0, 60)}"), "b"는 논문 2("${t2.slice(0, 60)}")입니다.`,
      `{\n` +
        `  "name_a": "논문 1의 짧은 통칭(약어나 핵심어, 12자 내)",\n` +
        `  "name_b": "논문 2의 짧은 통칭",\n` +
        `  "verdict": "결정적 차이 한 문장 (120자 내)",\n` +
        `  "rows": [\n` +
        `    { "axis": "한 줄 정체", "a": "…", "b": "…" },\n` +
        `    { "axis": "푸는 문제", "a": "…", "b": "…" },\n` +
        `    { "axis": "핵심 접근", "a": "…", "b": "…" },\n` +
        `    { "axis": "필요한 것", "a": "학습 데이터·사전학습 모델 등", "b": "…" },\n` +
        `    { "axis": "실험·성능", "a": "대표 수치(있으면)", "b": "…" },\n` +
        `    { "axis": "강점", "a": "…", "b": "…" },\n` +
        `    { "axis": "약점", "a": "…", "b": "…" }\n` +
        `  ],\n` +
        `  "when_a": "이럴 때 논문 1 접근 (1문장)",\n` +
        `  "when_b": "이럴 때 논문 2 접근 (1문장)",\n` +
        `  "qa": "\\"두 논문 차이가 뭐죠?\\"에 대한 30초 모범 답변 — 유일하게 문단 허용(3~4문장)"\n` +
        `}`,
      `비교 불가능한 축(예: 실험 설정이 달라 수치 비교 불가)은 셀에 "직접 비교 불가"라고 정직하게 쓰세요. rows는 필요시 1~2개 추가 가능(총 9개 이하).`,
    ].join("\n\n");
    console.log(`[비교] ${t1.slice(0, 30)} ↔ ${t2.slice(0, 30)}`);
    const raw = await streamTextGen(res, ac, prompt, "비교");
    let data;
    try {
      data = parseModelJson(raw);
      if (!Array.isArray(data.rows) || !data.rows.length) throw new Error("rows 없음");
    } catch (e) {
      // 구조화 실패 시 산문 폴백 — 클라가 text로 렌더
      sseSend(res, { type: "result", data: { fallback_text: raw }, cached: false });
      return res.end();
    }
    data.title_a = t1; data.title_b = t2; // 전체 제목(툴팁·머리글용)
    try { await store.setExtra(key, { data, a: h1, b: h2, at: new Date().toISOString() }); } catch (e) { console.warn("[비교 캐시 저장 실패]", e.message); }
    sseSend(res, { type: "result", data, cached: false });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return; // 사용자가 닫음 — 조용히 종료
    genErrorReply(res, e, "compare");
  }
});

// --- POST /api/script/:hash — 발표 대본 생성 (B3) ------------------------------
// 세미나 정리·기여·방법론을 컨텍스트로 N분 발표 대본을 생성. (hash, minutes)별 캐시.
app.post("/api/script/:hash", async (req, res) => {
  const ac = new AbortController();
  abortOnDisconnect(res, ac, "발표 대본");
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    const minutes = [10, 20, 30].includes(Number(req.body && req.body.minutes)) ? Number(req.body.minutes) : 20;
    const force = !!(req.body && req.body.force);
    if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
    const record = await store.get(hash);
    if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });
    const a = record.analysis || {};
    const key = `script:${hash}:${minutes}`;
    sseInit(res);
    if (!force) {
      const cached = await store.getExtra(key).catch(() => null);
      if (cached && cached.text) {
        sseSend(res, { type: "result", text: cached.text, cached: true });
        return res.end();
      }
    }
    sseSend(res, { type: "step", msg: `${minutes}분 발표 대본을 쓰는 중…` });
    const prompt = [
      `연구실 세미나에서 이 논문을 ${minutes}분 동안 발표할 대학원생의 발표 대본을 쓰세요. ` +
        `아래 분석 요약(JSON)만 근거로 하고, 요약에 없는 내용은 지어내지 마세요.`,
      `분석 요약: ${analysisDigest(a, { withSeminar: true })}`,
      `요구사항: (1) 실제로 소리 내어 말할 문장으로 — 문어체 낭독이 아니라 발표 말투("~인데요", "~입니다"). ` +
        `(2) 각 절 소제목에 시간 배분을 붙이세요 — 예: "## 도입 (0:00–1:30)". 전체 합이 ${minutes}분이 되게. ` +
        `(3) 구조: 도입(왜 이 논문) → 배경·문제 → 방법(가장 길게) → 실험·결과 → 한계·의의 → 마무리 멘트. ` +
        `(4) 방법 절에는 청중이 따라올 수 있는 직관적 설명 한 번 + 핵심 수식이 있으면 $...$로 한두 개만. ` +
        `(5) 마지막에 "## 예상 질문 대비" 절 — 나올 법한 질문 2~3개와 한 줄 답변. ` +
        `(6) 리스트·표·코드펜스 금지, 소제목(##)·**볼드**·==형광펜==·$수식$만. 발표자가 그대로 읽을 수 있어야 합니다.`,
    ].join("\n\n");
    console.log(`[대본] ${a.title || record.title}: ${minutes}분`);
    const text = await streamTextGen(res, ac, prompt, "대본");
    try { await store.setExtra(key, { text, minutes, at: new Date().toISOString() }); } catch (e) { console.warn("[대본 캐시 저장 실패]", e.message); }
    sseSend(res, { type: "result", text, cached: false });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    genErrorReply(res, e, "script");
  }
});

// --- POST /api/explain/:hash — "더 쉽게" 재설명 (P8) ---------------------------
// 특정 섹션을 학부 신입생 수준으로 비유 중심 재설명. (hash, section)별 extras 캐시.
const EXPLAIN_SECTIONS = {
  background: { label: "연구 배경", pick: (a) => ({ background: a.background, timeline: a.timeline }) },
  problem: { label: "해결하려는 것", pick: (a) => ({ problem: a.problem }) },
  method: { label: "연구 방법론", pick: (a) => ({ method_steps: a.method_steps, method_deep_refs: a.method_deep && a.method_deep.sections ? a.method_deep.sections.map((s) => s.ref) : undefined }) },
  results: { label: "실험·결과", pick: (a) => ({ experiments: a.experiments }) },
  equations: { label: "수식 정리", pick: (a) => ({ equations: (a.equations || []).map((e) => ({ latex: e.latex, explanation: e.explanation })) }) },
};
app.post("/api/explain/:hash", async (req, res) => {
  const ac = new AbortController();
  abortOnDisconnect(res, ac, "쉬운 설명");
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    const section = String((req.body && req.body.section) || "");
    const spec = EXPLAIN_SECTIONS[section];
    if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
    if (!spec) return res.status(400).json({ error: "이 탭은 쉬운 설명을 지원하지 않습니다." });
    const record = await store.get(hash);
    if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });
    const a = record.analysis || {};
    const force = !!(req.body && req.body.force);
    const key = `explain:${hash}:${section}`;
    sseInit(res);
    if (!force) {
      const cached = await store.getExtra(key).catch(() => null);
      if (cached && cached.text) {
        sseSend(res, { type: "result", text: cached.text, cached: true });
        return res.end();
      }
    }
    sseSend(res, { type: "step", msg: `'${spec.label}'을(를) 쉽게 풀어 쓰는 중…` });
    const content = JSON.stringify({ title: a.title, one_liner: a.one_liner, ...spec.pick(a) }).slice(0, 12000);
    const prompt = [
      `아래는 논문 "${a.title}"의 '${spec.label}' 섹션 분석입니다. 이걸 ==해당 전공을 아직 안 배운 학부 신입생==도 이해할 수 있게 다시 설명하세요.`,
      `섹션 내용(JSON): ${content}`,
      `규칙: (1) 전제지식 최소 — 전문용어가 나오면 그 자리에서 일상어로 풀기(원어 병기). ` +
        `(2) ==일상 비유를 적극적으로== — 각 핵심 개념마다 하나씩. (3) 내용을 빼먹지 말되 단순화는 허용, ` +
        `단 원문 분석에 없는 사실을 지어내지 말 것. (4) 수식이 있으면 $...$로 쓰되 "이 식이 하는 일"을 말로 먼저. ` +
        `(5) 형식: ## 소제목 몇 개 + 짧은 문단들. **볼드**/==형광펜== 허용, 리스트·표·코드펜스 금지. ` +
        `(6) 분량은 원문 섹션과 비슷하거나 약간 짧게.`,
    ].join("\n\n");
    console.log(`[쉬운 설명] ${a.title || record.title}: ${section}`);
    const text = await streamTextGen(res, ac, prompt, "쉬운설명");
    try { await store.setExtra(key, { text, section, at: new Date().toISOString() }); } catch (e) { console.warn("[쉬운 설명 캐시 저장 실패]", e.message); }
    sseSend(res, { type: "result", text, cached: false });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    genErrorReply(res, e, "explain");
  }
});

// --- POST /api/method-deep/:hash — 방법론 정밀 강독 생성 ------------------------
// 원문 방법 섹션을 서브섹션 구조 그대로 따라가는 주해식 강독(요지 번역 + 해설 + 수식 풀이).
// analysis.method_deep에 영구 저장(1회 생성 후 캐시). SSE: step(읽기 진행)/delta(글자수)/result.
app.post("/api/method-deep/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
  if (hashBusy(hash)) return res.status(409).json({ error: "이 논문은 이미 분석/생성이 진행 중입니다." });
  const inflightKey = `${hash}:method_deep`;
  inFlight.add(inflightKey);
  const ac = new AbortController();
  abortOnDisconnect(res, ac, "정밀 강독");
  try {
    const record = await store.get(hash);
    if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });
    const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "저장된 원문 PDF가 없어 강독을 생성할 수 없습니다." });
    const a = record.analysis || {};
    const force = !!(req.body && req.body.force);
    sseInit(res);
    if (!force && a.method_deep && Array.isArray(a.method_deep.sections) && a.method_deep.sections.length) {
      sseSend(res, { type: "result", data: a.method_deep, cached: true });
      return res.end();
    }
    const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
    const pageCount = doc.getPageCount();
    // 위치 힌트: 기존 분석이 아는 방법 섹션·구조도 위치 (P6과 동일한 유도)
    const figs = Array.isArray(a.figure_guide) ? a.figure_guide : [];
    const archFigs = figs.filter((f) => f && (f.kind === "architecture" || f.kind === "method"));
    const sectionRef =
      (a.method_visualization && a.method_visualization.section_ref) ||
      archFigs.map((f) => `${f.label}(p${f.page})`).join(", ") || "";
    const stepsHint = (a.method_steps || []).map((s) => s.title).filter(Boolean).join(" / ");

    sseSend(res, { type: "step", msg: "원문 방법 섹션을 찾는 중…" });
    const prompt = [
      `${pdfPath} 경로에 "${a.title || record.title || ""}" 논문 PDF(${pageCount}페이지)가 있습니다. ` +
        `이 논문의 ==방법(Method) 부분을 대학원 수업의 논문 강독처럼 정밀하게 해설==하려 합니다.`,
      `Read 도구로 방법 섹션과 그 주변만 읽으세요(pages 파라미터, 필요한 범위만).` +
        (sectionRef ? ` 힌트 — 방법 섹션/구조도 위치: ${sectionRef}.` : "") +
        (stepsHint ? ` 기존 분석의 단계 제목: ${stepsHint}.` : ""),
      `강독 원칙:\n` +
        `- 원문의 ==서브섹션 구조와 논리 전개 순서를 그대로== 따른다 (3.1→3.2…). 명시적 서브섹션이 없으면 논리 단위로 3~6개로 나누고 ref는 서술형 제목으로.\n` +
        `- 각 서브섹션 body는: 문단 요지를 충실히 옮기고(번역 수준의 정확도) + 그 자리에서 주해 — 왜 이렇게 설계했는지, 이 수식이 뭘 하는지, 기호가 처음 나오면 정의.\n` +
        `- 수식은 $...$ 인라인으로 옮기고 바로 풀이. 핵심 문장엔 ==형광펜==, 용어는 **볼드**(원어 병기).\n` +
        `- 문단마다 근거 페이지 칩 [[p숫자|원문 짧은 구절]]을 1개 이상 — 실제 읽은 위치만, 지어내기 금지.\n` +
        `- 서브섹션당 500~1200자. ## 소단락 가능, 리스트·표·코드펜스 금지.\n` +
        `- 원문에 없는 내용을 보태지 않는다. 원문이 생략한 부분은 "원문은 ~를 다루지 않는다"라고 정직하게.`,
      `최종 출력은 JSON 객체 하나만:\n` +
        `{"sections":[{"ref":"3.1 원문 서브섹션 제목(원어)","page":시작페이지,"body":"강독 본문"}]}`,
    ].join("\n\n");

    let raw = null;
    for await (const msg of query({
      prompt,
      options: {
        model: MODEL, allowedTools: ["Read"], maxTurns: 30, cwd: PDF_DIR,
        abortController: ac, includePartialMessages: true,
      },
    })) {
      if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
        const ev = msg.event;
        if (ev && ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
          sseSend(res, { type: "delta", text: ev.delta.text });
        }
      }
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (b.type === "tool_use" && b.name === "Read") {
            const pages = (b.input && b.input.pages) || "";
            sseSend(res, { type: "step", msg: pages ? `📄 원문 ${pages}쪽을 정독하는 중…` : "📄 원문을 정독하는 중…" });
          }
        }
      }
      if (msg.type === "result") {
        logUsage("강독", msg);
        if (msg.subtype !== "success") {
          const detail = String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || "");
          const e = new Error(`강독 생성 실패 (${msg.subtype})`);
          if (isAuthError(detail)) e.code = "AUTH";
          throw e;
        }
        raw = msg.result;
      }
    }
    if (ac.signal.aborted) return;
    const parsed = parseModelJson(raw);
    const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
      .filter((s) => s && s.body)
      .map((s) => ({ ref: String(s.ref || "").slice(0, 120), page: Number(s.page) || null, body: String(s.body) }));
    if (!sections.length) throw new Error("강독 섹션을 생성하지 못했습니다.");
    const data = { generated_at: new Date().toISOString(), sections };

    // 기존 레코드에 method_deep만 병합 저장 (분석 시각·모드 보존 — 섹션 재생성과 동일 패턴)
    const merged = { ...a, method_deep: data };
    await store.set(hash, {
      hash,
      title: merged.title || record.title,
      one_liner: merged.one_liner || record.one_liner,
      venue: record.venue ?? null,
      year: record.year ?? null,
      analysis_mode: record.analysis_mode || a.analysis_mode || "full",
      createdAt: record.createdAt,
      analysis: merged,
    });
    console.log(`[강독 생성] ${a.title || record.title}: ${sections.length}개 섹션 · ${JSON.stringify(data).length}B`);
    sseSend(res, { type: "result", data, cached: false });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    genErrorReply(res, e, "method-deep");
  } finally {
    inFlight.delete(inflightKey);
  }
});

// --- 메모 & 북마크 (논문별 개인 메모, 기기 간 공유) ----------------------------
// sha256 해시(64 hex)만 허용 — 빈/잘못된 hash가 공유 버킷("")에 쓰이는 것 방지
const isValidHash = (h) => /^[a-f0-9]{16,64}$/.test(h);
app.get("/api/notes/:hash", async (req, res) => {
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
    res.json(await store.getNotes(hash));
  } catch (e) {
    res.status(500).json({ error: `메모 조회 실패: ${e.message}` });
  }
});
app.put("/api/notes/:hash", async (req, res) => {
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    if (!isValidHash(hash)) return res.status(400).json({ error: "잘못된 hash" });
    const body = req.body || {};
    const data = {
      notes: typeof body.notes === "string" ? body.notes.slice(0, 20000) : "",
      bookmarks: Array.isArray(body.bookmarks) ? body.bookmarks.slice(0, 200) : [],
    };
    await store.setNotes(hash, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `메모 저장 실패: ${e.message}` });
  }
});

// --- 라이브러리: 폴더 목록 + 논문→폴더 배정 (전역, 기기 간 공유) -----------------
app.get("/api/library", async (req, res) => {
  try {
    const lib = (await store.getLibrary()) || {};
    res.json({
      folders: Array.isArray(lib.folders) ? lib.folders : [],
      assignments: lib.assignments && typeof lib.assignments === "object" ? lib.assignments : {},
    });
  } catch (e) {
    res.status(500).json({ error: `라이브러리 조회 실패: ${e.message}` });
  }
});
app.put("/api/library", async (req, res) => {
  try {
    const body = req.body || {};
    const folders = (Array.isArray(body.folders) ? body.folders : [])
      .slice(0, 200)
      .map((f) => ({ id: String((f && f.id) || "").slice(0, 40), name: String((f && f.name) || "").trim().slice(0, 60) }))
      .filter((f) => f.id && f.name);
    const ids = new Set(folders.map((f) => f.id));
    const assignments = {};
    const src = body.assignments && typeof body.assignments === "object" ? body.assignments : {};
    let n = 0;
    for (const [hash, fid] of Object.entries(src)) {
      if (n >= 5000) break; // 무한 증가 방지 상한
      if (isValidHash(hash) && ids.has(String(fid))) { assignments[hash] = String(fid); n++; }
    }
    const data = { folders, assignments };
    await store.setLibrary(data);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: `라이브러리 저장 실패: ${e.message}` });
  }
});

// --- POST /api/reanalyze-section/:hash — 한 섹션만 다시 생성 (전체 재분석 없이) ---
// 캐시된 원문 PDF에서 해당 부분만 다시 읽어 그 섹션의 JSON만 받아 기존 분석에 병합한다.
// 전체 재분석(30페이지 재독)의 일부 비용으로 약한 섹션만 보강 — Max 사용량 절약.
const SECTION_FIELDS = {
  background: { keys: ["background", "timeline"], label: "연구 배경(과 분야 타임라인)" },
  problem: { keys: ["problem"], label: "해결하려는 것" },
  method: { keys: ["method_steps", "method_visualization", "method_viz_html"], label: "연구 방법론(단계·시각화)" },
  results: { keys: ["experiments"], label: "실험·결과" },
  equations: { keys: ["equations", "equation_flow"], label: "수식 정리(와 수식 흐름도)" },
  figures: { keys: ["figure_guide"], label: "그림 해설" },
  seminar: { keys: ["seminar"], label: "세미나 정리" },
  contributions: { keys: ["contributions"], label: "핵심 기여" },
  qa: { keys: ["suggested_questions"], label: "예상 Q&A" },
  glossary: { keys: ["glossary"], label: "용어집" },
};
// scripts/verify_mviz.js를 실행해 {pass, violations, metrics}를 반환(서버측 최종 게이트).
function runVerifyMviz(htmlPath) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [path.join(__dirname, "scripts", "verify_mviz.js"), htmlPath, "--json"],
      { cwd: __dirname, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ pass: false, violations: [{ rule: "verify_run_error", detail: (err && err.message) || "verify 실행/파싱 실패" }], metrics: {} });
        }
      }
    );
  });
}

// method 섹션: viz_guideline 기반 타입별 독립 HTML 시각화를 생성한다.
// 에이전트가 한 query 안에서 Read(지침·참조·PDF)+Write(HTML)+Bash(verify)로 생성→검증→수정을
// 자가 반복하고, 서버가 최종 게이트로 verify를 재실행한다.
async function generateMethodVizHtml(hash, record, pdfPath, pageCount, ac, opts = {}) {
  const a = record.analysis || {};
  const outPath = path.join(MVIZ_GEN_DIR, `${hash}.html`);
  try { fs.rmSync(outPath, { force: true }); } catch (e) {}
  // P6 힌트: 이미 분석된 figure_guide로 overview/방법 그림 위치를 짚어 PDF 재독 축소.
  // 메인 분석(CORE)에서는 method_visualization=null이므로, figure_guide의 구조도(kind)에서 위치를 유도한다.
  const figs = Array.isArray(a.figure_guide) ? a.figure_guide : [];
  const archFigs = figs.filter((f) => f && (f.kind === "architecture" || f.kind === "method"));
  const sectionRef =
    (a.method_visualization && a.method_visualization.section_ref) ||
    a.section_ref ||
    archFigs.map((f) => `${f.label}(p${f.page})`).join(", ") ||
    "";
  const figPages = [...new Set(figs.map((f) => f && f.page).filter(Boolean))].slice(0, 8);
  let ctx =
    `\n\n---\n## 이번 논문 (컨텍스트)\n` +
    `- 제목: ${a.title || record.title || ""}\n` +
    `- 원문 PDF: pdfs/${hash}.pdf (${pageCount}페이지) — Read로 필요한 범위만(20페이지씩) 읽어라.\n` +
    `- 한 줄 요약(어조 참고): ${(a.one_liner || "").slice(0, 200)}\n` +
    `- <OUTPUT_PATH> = ${outPath}\n` +
    `  → 완성 HTML을 정확히 이 절대경로에 Write하라.\n` +
    `- 자가검증: \`node scripts/verify_mviz.js ${outPath} --json\` 를 실행해 pass:true까지 고쳐라(최대 5회).\n` +
    `작업 디렉터리는 저장소 루트다. prompts/method_viz_refs/ 와 scripts/ 를 상대경로로 접근할 수 있다.`;
  if (sectionRef || figPages.length) {
    ctx += `\n\n## 읽기 힌트 (P6 — 이미 분석된 정보, 이 범위부터 읽으면 PDF 재독을 줄인다)\n` +
      (sectionRef ? `- 방법론/overview figure 위치: ${sectionRef}\n` : "") +
      (figPages.length ? `- 주요 figure 페이지: ${figPages.join(", ")} (overview figure pdftoppm 렌더 시 우선)\n` : "");
  }
  // P4 method_steps 재사용: 메인 분석이 방금 만든 단계는 재생성하지 않는다(섹션 재생성 경로는 미적용).
  // 참조용으로만 넣고 모델이 재출력하지 않게 한다 — 문자열 중간 절단으로 깨진 JSON을 주지 않도록
  // '통째' 직렬화하고(문자 slice 금지), 단계 수만 상한한다. 서버는 reuseSteps일 때 원본 steps를 그대로 유지.
  const reusing = opts.reuseSteps && Array.isArray(a.method_steps) && a.method_steps.length;
  if (reusing) {
    const cap = a.method_steps.slice(0, 14); // 통째 객체 단위로만 상한(항상 유효 JSON)
    const omitted = a.method_steps.length - cap.length;
    ctx += `\n\n## method_steps 재사용 (P4 — 이미 확정됨: 재생성·재출력 금지)\n` +
      "```json\n" + JSON.stringify(cap) + "\n```\n" +
      (omitted > 0 ? `(위는 앞 ${cap.length}단계 — 나머지 ${omitted}단계는 동일 형식으로 이어짐) ` : "") +
      `이 단계들은 이미 확정된 값이다. HTML 스테퍼를 이에 맞춰 구성하되, 응답 JSON의 method_steps는 생략해도 된다(서버가 기존 값을 유지한다).`;
  }
  const prompt = METHOD_VIZ_HTML_GEN + ctx;
  let raw = null;
  for await (const msg of query({
    prompt,
    options: { systemPrompt: SYSTEM_PROMPT_MINI, model: MODEL, allowedTools: ["Read", "Write", "Bash", "WebSearch"], maxTurns: 160, cwd: __dirname, abortController: ac },
  })) {
    if (msg.type === "result") {
      logUsage("HTML시각화", msg);
      if (msg.subtype !== "success") {
        const detail = String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || "");
        const e = new Error(`방법론 HTML 생성 실패 (${msg.subtype})`);
        if (isAuthError(detail)) e.code = "AUTH";
        throw e;
      }
      raw = msg.result;
    }
  }
  const meta = raw != null ? parseModelJson(raw) : {};
  if (!fs.existsSync(outPath)) throw new Error("생성된 HTML 파일이 없습니다(모델이 Write하지 않음).");
  const html = fs.readFileSync(outPath, "utf8");
  if (!html || html.length < 400) throw new Error("생성된 HTML이 비었거나 너무 짧습니다.");
  const verify = await runVerifyMviz(outPath); // 서버측 최종 게이트
  // reuseSteps일 때는 원본 method_steps를 그대로 유지(모델이 재출력하며 analogy 등을 잃는 것 방지).
  const method_steps = reusing ? a.method_steps : Array.isArray(meta.method_steps) ? meta.method_steps : null;
  return { html, method_steps, viz_report: meta.viz_report || null, verify };
}

app.post("/api/reanalyze-section/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  const section = String((req.body && req.body.section) || "");
  const spec = SECTION_FIELDS[section];
  if (!spec) return res.status(400).json({ error: "알 수 없는 섹션입니다." });
  const inflightKey = `${hash}:${section}`;
  if (hashBusy(hash)) {
    return res.status(409).json({ error: "이 논문은 이미 분석/재생성이 진행 중입니다." });
  }
  inFlight.add(inflightKey); // 검사 직후 등록 — await 사이 동시 진입(TOCTOU) 방지. 이후 종료는 finally가 담당
  const ac = new AbortController();
  abortOnDisconnect(res, ac, `섹션 재생성: ${spec.label}`);
  try {
    const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "저장된 원문 PDF가 없어 섹션을 다시 생성할 수 없습니다." });
    }
    const record = await store.get(hash); // try 안에서 조회 — 실패 시 500 응답(요청 영구 대기 방지)
    if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });
    const a = record.analysis || {};
    const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
    const pageCount = doc.getPageCount();

    // 방법론 섹션: 타입 기반 독립 HTML 시각화(method_viz_html) 생성 파이프라인.
    // 자가 verify 루프 + 서버 최종 게이트. 검증 통과분만 저장(버그 있는 시각화 미배포).
    if (section === "method") {
      const result = await generateMethodVizHtml(hash, record, pdfPath, pageCount, ac);
      if (ac.signal.aborted) return;
      if (!result.verify || !result.verify.pass) {
        return res.status(422).json({
          error: "생성된 시각화가 자동 검증(§8.2)을 통과하지 못했습니다 — 버그 배포를 막기 위해 보류했습니다.",
          violations: (result.verify && result.verify.violations) || [],
          viz_report: result.viz_report || null,
        });
      }
      const merged = { ...a, method_viz_html: result.html };
      if (result.method_steps && result.method_steps.length) merged.method_steps = result.method_steps;
      await store.set(hash, {
        hash,
        title: merged.title || record.title,
        one_liner: merged.one_liner || record.one_liner,
        venue: record.venue ?? (typeof merged.venue === "string" ? merged.venue.slice(0, 40) : null),
        year: record.year ?? (Number.isFinite(Number(merged.year)) ? Number(merged.year) : null),
        analysis_mode: record.analysis_mode || a.analysis_mode || "full", // 섹션 재생성이 모드를 지우지 않게
        createdAt: record.createdAt,
        analysis: merged,
      });
      return res.json({ ok: true, section, verify: result.verify, viz_report: result.viz_report, analysis: { cached: false, hash, ...merged } });
    }

    const prompt =
      `${pdfPath} 경로에 "${a.title || ""}" 논문 PDF(${pageCount}페이지)가 있습니다. 이미 분석된 논문인데 ` +
      `'${spec.label}' 섹션만 더 정확하고 풍부하게 다시 만들려 합니다.\n` +
      `Read 도구로 이 섹션과 관련된 부분을 다시 읽으세요(필요한 범위만, 20페이지씩).\n` +
      `시스템 프롬프트의 스키마·마크업 규칙을 그대로 따르되, ==최종 출력은 다음 키만 담은 JSON 객체 하나==로 하세요: ${spec.keys.map((k) => `"${k}"`).join(", ")}.\n` +
      `다른 섹션과 어조·용어가 일관되도록, 기존 한 줄 요약은 다음과 같습니다: ${(a.one_liner || "").slice(0, 200)}`;

    let raw = null;
    for await (const msg of query({
      prompt,
      options: { systemPrompt: SYSTEM_PROMPT_CORE, model: MODEL, allowedTools: ["Read", "WebSearch"], maxTurns: 60, cwd: PDF_DIR, abortController: ac }, // P1: V4 불필요(비-method 섹션)
    })) {
      if (msg.type === "result") {
        logUsage(`섹션재생성:${section}`, msg);
        if (msg.subtype !== "success") {
          const detail = String(msg.result || (Array.isArray(msg.errors) ? msg.errors.join(" ") : "") || "");
          const e = new Error(`섹션 재생성 실패 (${msg.subtype})`);
          if (isAuthError(detail)) e.code = "AUTH";
          throw e;
        }
        raw = msg.result;
      }
    }
    if (raw == null) throw new Error("재생성 결과를 받지 못했습니다.");
    const partial = parseModelJson(raw);
    // 요청한 키만 추려 병합. 빈 값(빈 배열·빈 객체·빈 문자열)으로는 덮어쓰지 않는다
    // — 모델이 일부만 돌려줘도 기존 좋은 데이터(지표·데이터셋 등)가 사라지지 않게.
    const isEmptyVal = (v) =>
      v == null ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "string" && v.trim() === "") ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    const merged = { ...a };
    let applied = 0;
    for (const k of spec.keys) {
      if (k in partial && !isEmptyVal(partial[k])) { merged[k] = partial[k]; applied++; }
    }
    if (applied === 0) {
      // 모델이 요청한 키를 비우거나 빠뜨림 → 저장하지 않고 알림 (사용량만 쓰고 변화 없음 방지)
      return res.status(422).json({ error: "재생성 결과에서 바뀐 내용을 찾지 못했습니다. 다시 시도해 보세요." });
    }

    await store.set(hash, {
      hash,
      title: merged.title || record.title,
      one_liner: merged.one_liner || record.one_liner,
      // 사이드바 메타데이터(학회·연도) 보존 — 섹션 재생성이 지우지 않게
      venue: record.venue ?? (typeof merged.venue === "string" ? merged.venue.slice(0, 40) : null),
      year: record.year ?? (Number.isFinite(Number(merged.year)) ? Number(merged.year) : null),
      analysis_mode: record.analysis_mode || a.analysis_mode || "full", // 모드 보존
      createdAt: record.createdAt, // 분석 시각 유지 — 섹션 하나 고쳤다고 목록 순서가 바뀌지 않게
      analysis: merged,
    });
    res.json({ ok: true, section, analysis: { cached: false, hash, ...merged } });
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error("[/api/reanalyze-section 오류]", e);
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (e && (e.code === "AUTH" || isAuthError(e.message))) {
      return res.status(401).json({ error: AUTH_ERROR_MSG });
    }
    res.status(500).json({ error: `섹션 재생성 실패: ${e.message}` });
  } finally {
    inFlight.delete(inflightKey);
  }
});

// --- GET /api/history -----------------------------------------------------------
app.get("/api/history", async (req, res) => {
  try {
    res.json(await store.list());
  } catch (e) {
    console.error("[/api/history 오류]", e);
    res.status(500).json({ error: `히스토리 조회 실패: ${e.message}` });
  }
});

// --- GET /api/history/:hash ------------------------------------------------------
app.get("/api/history/:hash", async (req, res) => {
  try {
    const record = await store.get(req.params.hash);
    if (!record) {
      return res.status(404).json({ error: "해당 분석 결과를 찾을 수 없습니다." });
    }
    res.json({ cached: true, hash: record.hash, ...record.analysis });
  } catch (e) {
    console.error("[/api/history/:hash 오류]", e);
    res.status(500).json({ error: `조회 실패: ${e.message}` });
  }
});

// --- DELETE /api/history/:hash ---------------------------------------------------
app.delete("/api/history/:hash", async (req, res) => {
  try {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
    if (hashBusy(hash)) {
      // 진행 중 분석의 원문 PDF를 지우면 분석이 깨지고, 완료 시 store.set으로 삭제가 되살아난다
      return res.status(409).json({ error: "이 논문은 분석이 진행 중이라 지금은 삭제할 수 없습니다. 잠시 후 다시 시도하세요." });
    }
    await store.delete(hash);
    // 폴더 배정도 서버에서 정리 — 어느 경로(다른 기기·직접 호출)로 지워도 stale 배정이 남지 않게
    try {
      const lib = (await store.getLibrary()) || {};
      if (lib.assignments && lib.assignments[hash]) {
        delete lib.assignments[hash];
        await store.setLibrary(lib);
      }
    } catch (e) { console.error("[삭제: 라이브러리 정리 실패]", e.message); }
    // 원문 PDF도 함께 제거 (재분석 경로는 store.delete만 호출하므로 여기서만 지운다)
    await fs.promises.rm(path.join(PDF_DIR, `${hash}.pdf`), { force: true }).catch(() => {});
    // 그림 크롭 캐시도 정리 (이 논문의 hash로 시작하는 파일들)
    if (hash) {
      fs.promises.readdir(CROP_DIR).then((files) =>
        Promise.all(files.filter((f) => f.startsWith(`${hash}_`)).map((f) => fs.promises.rm(path.join(CROP_DIR, f), { force: true }).catch(() => {})))
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /api/history/:hash 오류]", e);
    res.status(500).json({ error: `삭제 실패: ${e.message}` });
  }
});

// 상시 구동(Tailscale) 서버라 단발 예외로 죽지 않도록 — 로그만 남기고 유지
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] 처리되지 않은 예외 — 서버는 계속 실행됩니다:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] 처리되지 않은 Promise 거부:", reason);
});

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn(
    "[경고] CLAUDE_CODE_OAUTH_TOKEN이 설정되어 있지 않습니다.\n" +
      "       `claude setup-token`으로 발급한 토큰을 .env에 넣어야 분석이 동작합니다."
  );
}

app.listen(PORT, () => {
  console.log(
    `Paper Reviewer 실행 중: http://localhost:${PORT} (모델: ${MODEL}, 저장소: ${store.kind})`
  );
});
