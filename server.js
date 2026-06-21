require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
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
  store = {
    kind: "firestore",
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
      if (typeof data.analysisJson === "string") {
        data.analysis = JSON.parse(data.analysisJson);
      }
      return data;
    },
    async set(hash, record) {
      const { analysis, ...rest } = record;
      await analyses.doc(hash).set({
        ...rest,
        analysisJson: JSON.stringify(analysis),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    },
    async delete(hash) {
      await analyses.doc(hash).delete();
      await chats.doc(hash).delete().catch(() => {});
      await notes.doc(hash).delete().catch(() => {});
    },
    async list() {
      const snap = await analyses.orderBy("createdAt", "desc").limit(100).get();
      return snap.docs.map((d) => {
        const { hash, title, one_liner, createdAt } = d.data();
        return {
          hash,
          title,
          one_liner,
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
  store = {
    kind: "memory",
    async getChat(hash) {
      return chatMem.get(hash) || [];
    },
    async setChat(hash, messages) {
      chatMem.set(hash, messages);
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
      mem.set(hash, { ...record, createdAt: new Date().toISOString() });
    },
    async delete(hash) {
      mem.delete(hash);
      chatMem.delete(hash);
      notesMem.delete(hash);
    },
    async list() {
      return [...mem.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(({ hash, title, one_liner, createdAt }) => ({
          hash,
          title,
          one_liner,
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
const SYSTEM_PROMPT = `당신은 논문을 구조적으로 분석하는 전문 리서처입니다.
지정된 논문 PDF 전체(텍스트, 레이아웃, 그림, 표, 수식)를 읽고 아래 JSON 스키마에 맞춰 분석 결과를 작성하세요.

스키마:
{
  "title": "논문 원제목 (영어 그대로)",
  "one_liner": "논문 핵심을 담은 한 줄 요약",
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
  "figures": [
    {
      "type": "flow | bar | line",
      "title": "그림 제목 (한국어)",
      "source": "원 논문의 어느 Figure를 재구성했는지 (예: 'Figure 1 재구성')",
      "caption": "이 그림에서 읽어야 할 핵심 한 줄",
      "example": "flow 전체를 관통하는 하나의 구체적 예시 (예: \\"예시 문장: 'The cat sat'\\" — 모든 inner_viz가 이 예시를 공유)",
      "svg": "원 논문 figure를 그대로 재현한 SVG 문자열 (flow 타입이면 반드시 포함 — 아래 'SVG 작성 규칙' 참고)",
      "flow": [
        {
          "name": "블록 이름 (영어 원어)",
          "sublabel": "보조 설명(선택)",
          "repeat": "× 6 같은 반복 표기(선택)",
          "children": ["내부 서브층(영어)", "..."],
          "lane": "원 그림에서 블록들이 두 기둥으로 나란히 놓여 있으면 그 기둥 이름 (예: 'Encoder', 'Decoder'). 입력/출력처럼 전체 폭 블록은 생략",
          "role": "이 블록이 데이터에 무슨 일을 하는지 1~2문장 — 사용자가 스테퍼로 한 블록씩 짚을 때 표시됨. 쉬운 비유를 섞어도 좋음",
          "data_state": "이 블록을 통과한 직후 데이터가 어떤 형태·의미인지 짧게 (예: '토큰마다 512차원 벡터', '단어 간 관련도 가중치 행렬') — 데이터가 변해가는 흐름을 보여주는 용도",
          "inner_viz": {
            "설명": "이 블록 '내부'에서 예시 값/데이터가 어떻게 변하는지 보여주는 미니 시각화. ==flow의 모든 블록에 반드시 하나씩 넣으세요(빈 블록 금지)==",
            "type": "heatmap | vectors | bars | distribution | scatter | surface | transform",
            "title": "시각화 제목 (예: '단어×단어 어텐션 가중치')",
            "tokens": ["heatmap/vectors의 행·열 레이블 (예시 문장의 토큰들, 3~6개)"],
            "matrix": [[0.8, 0.15, 0.05]],
            "vectors": [ { "label": "행 레이블", "values": [0.2, -0.5, 0.8] } ],
            "bars": [ { "label": "항목", "value": 0.62, "highlight": true } ],
            "curves": [ { "name": "곡선 이름", "points": [ { "x": 0, "y": 0.1 }, "... 8~20개로 곡선 모양 보존" ] } ],
            "points": [ { "x": 1.2, "y": 0.8, "label": "선택 레이블", "group": "군집 이름(선택)" } ],
            "grid": [[0.1, 0.8], [0.4, 0.2]],
            "from": { "label": "입력 데이터 이름", "shape": "[n, 512]", "kind": "tokens|vector|matrix|image|scalar(선택)" },
            "to": { "label": "출력 데이터 이름", "shape": "[n, 512]", "kind": "vector(선택)" },
            "op": "transform에서 이 블록이 가하는 연산 한마디 (예: 'LayerNorm으로 분포 정규화', '잔차 더하기 ⊕')",
            "x_label": "x축 이름 (distribution/scatter)", "y_label": "y축 이름",
            "explanation": "이 시각화에서 읽어야 할 패턴 1~2문장 (예: \\"'sat' 행에서 'cat' 칸이 가장 진함 — 동사가 주어를 찾는 패턴\\")"
          }
        }
      ],
      "bars": [ { "label": "항목", "value": 28.4, "highlight": true } ],
      "unit": "bar 차트의 단위 (예: BLEU, accuracy %)",
      "lines": [ { "name": "계열 이름", "points": [ { "x": 1, "y": 2.5 }, ... ] } ],
      "x_label": "line 차트 x축 이름", "y_label": "line 차트 y축 이름"
    }
  ],
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
- contributions: 이 논문이 기존과 다르게 새로 해낸 것 2~4개. 방법·성능·관점 중에서 "이전엔 못 했는데 이 논문이 가능케 한 것"을 한 문장씩, 가장 중요한 것부터. 도입부(제목 아래)에 표시됩니다. 강조 마크업 사용 가능.
- background: "## 소제목" 줄로 2~3개 단락을 나누세요 (예: "## 분야의 흐름", "## 남아 있는 공백"). 분야가 어떤 흐름으로 발전해왔는지 → 현재 어디까지 와 있는지 → 이 논문이 들어갈 공백(gap)이 무엇인지 순서로.
- timeline: 연구 배경 탭 상단에 표시될 분야 발전 이정표 3~6개 (연도순). label은 기법/모델명(영어), note는 한 줄 의미. 마지막 항목은 이 논문 자신으로.
- problem: "## 소제목"으로 2~3개 단락 구분. 기존 방법(existing methods)들을 구체적으로 거명하고 각각의 한계를 짚은 뒤, 이 논문이 정확히 어떤 문제를 타깃하는지 명시하세요.
- method_steps: 4~8개 단계. 각 단계는 짧은 title + "무엇을 + 왜"를 담은 description + 일상 비유(analogy). 비유는 그 단계의 핵심 직관을 비전공자도 떠올릴 수 있게. 데이터가 흘러가는 순서대로 배열하세요.
- figures: ==논문의 핵심 방법론(method)을 보여주는 그림만 1~2개 재구성하세요== — 모델 구조, 파이프라인, 방법의 동작 원리를 담은 그림. ==성능 비교·실험 결과 그림과 표(table)는 재구성하지 마세요== (BLEU/accuracy 비교 막대, 벤치마크 표 등 금지). 시각 유형은 내용에 맞게:
  · 모델 구조/파이프라인 그림 → "flow". svg 필드에 SVG를 직접 그리세요. flow 배열은 그 그림의 의미 블록 목록으로, 배열 순서 = 데이터가 흐르는 순서(스테퍼 진행 순서)이며 모든 블록에 role과 data_state를 채우세요.
    - 논문에 ==명확한 모델 구조 그림(Figure 1 등)이 있으면 그것과 똑같이 생기게== 재현하세요 (재배치·단순화 금지).
    - 논문에 깔끔한 구조 그림이 없거나 알고리즘/학습기법 논문이면, ==그 방법이 컴포넌트를 어떻게 배선하는지를 2D 구조도로 합성==하세요.
  **SVG 작성 규칙 (flow 타입 필수)**:
  - ==절대 블록을 위에서 아래로 일렬로만 쌓지 마세요(밋밋한 수직하강 금지)==. 그 방법의 실제 구조 관계가 그림에서 드러나야 합니다 — 병렬 모듈은 좌우 기둥으로 나란히, 분기는 갈라지는 화살표로, 합류는 ⊕/⊗ 합류점으로, 스킵·잔차·피드백은 블록을 우회하는 곡선 화살표로, 반복은 "N×" 라벨과 되돌아가는 루프 화살표로, 모듈 묶음은 외곽 점선 상자로. 입력·출력 라벨도 표기.
  - 방법 유형별 배선 예시(해당하면 이 구조를 따르세요):
    · adapter/LoRA류 → 동결된 본체 경로를 가운데 세로로 두고, 그 ==옆에 저계수 곁가지(A↓ B↑)를 병렬로 그린 뒤 ⊕로 본체에 합류==. "frozen"은 회색, 학습 분기는 강조색.
    · teacher–student(증류) → 교사·학생 두 모델을 ==좌우로 나란히==, 교사 출력(soft label)이 가로질러 학생으로 흐르는 화살표.
    · 이중 인코더/대조학습(CLIP류) → 두 인코더를 좌우로, 각 출력이 ==가운데 공유 임베딩 공간에서 만나 정렬(↔)==.
    · 프루닝/중요도 기반 → 원본 모델 → 중요도 산정 분기 → 가지치기 → 압축 모델, 중요도가 본체로 되먹임되는 화살표.
    · 반복/EM/GAN/RL → 핵심 단계들을 두고 ==마지막에서 처음으로 되돌아가는 루프 화살표==로 반복을 표현.
  - viewBox는 가로가 넓게 "0 0 W H" (구조가 옆으로 퍼지므로 W는 480~640 권장, H는 필요한 만큼). width/height 속성은 넣지 마세요.
  - 색상 테마: 배경 투명, 블록은 fill="#fff" stroke="#d8cfbc" (윗변 강조는 #8c2f39), 화살표·강조 #8c2f39, 텍스트 #211d19 (보조 텍스트 #9b9285), 글꼴 font-family="sans-serif" font-size 11~13.
  - ==flow 배열의 i번째 블록에 해당하는 SVG 요소들을 <g data-block="i">로 감싸세요== (스테퍼가 이 그룹을 하이라이트함). 화살표·장식은 g 밖에 둬도 됩니다.
  - rect는 rx="6" 둥근 모서리, 블록 안 텍스트는 <text text-anchor="middle">. JSON 문자열 안이므로 큰따옴표 이스케이프에 주의.
  · 방법 자체가 분포·수치 변화를 다루는 경우에만 → "bar" 또는 "line" (예: 방법이 만드는 분포의 모양, 방법 내부 함수의 곡선)
  수치는 반드시 논문에서 실제로 읽은 값만 쓰세요. ==수치를 확인할 수 없으면 그 figure는 빼세요 (지어내기 절대 금지)==. 각 figure에는 type에 해당하는 데이터 필드만 포함하세요.
- inner_viz (블록 내부 시각화): ==flow의 모든 블록에 빠짐없이 하나씩== 넣으세요(빈 블록 금지). 그 블록 안에서 구체적인 예시 값/데이터가 어떻게 변하는지 보여줍니다.
  · figure의 example에 하나의 구체적 예시(짧은 문장, 이미지 패치 등)를 정하고, 모든 inner_viz가 같은 예시를 따라가게 하세요 (연속성).
  · ==시각화를 만들기 전에 WebSearch로 이 논문의 유명 해설·시각화 자료를 1~2회 검색해 참고하세요== (예: "illustrated transformer", "<논문명> explained visualization"). 널리 알려진 예시(예: 어텐션 논문의 "The animal didn't cross the street because it was too tired")가 있으면 그것을 쓰세요.
  · 값은 논문이 명시한 수치가 있으면 그대로, 없으면 ==논문이 설명하는 정성적 패턴을 정확히 반영한 예시값==으로 (예: 동사는 주어에 높은 어텐션, 합이 1인 softmax 행 등). explanation에 "예시값"임이 드러나게 쓰지 말고, 읽어야 할 패턴을 설명하세요.
  · type 선택 — ==행렬(heatmap)만 반복하지 말고, 그 블록이 다루는 데이터 성격에 가장 잘 맞는 유형을 고르세요==:
    heatmap: 관계·가중치 행렬 (행=보는 주체, 각 행 합 ≈ 1) / vectors: 벡터·표현의 변화 (값 -1~1, 4~8칸) / bars: 이산 확률·점수 비교 /
    distribution: 연속 분포·함수 곡선이 핵심일 때 (예: softmax 온도에 따른 분포 모양, 가우시안 초기화, 게이트 함수 곡선 — curves에 점 8~20개) /
    scatter: 공간 배치·군집·임베딩 관계 (예: 임베딩 공간에서 단어들의 위치, 클래스 분리 — group으로 군집 구분) /
    surface: 행렬의 값 크기 지형이 핵심일 때 3D 막대 지형으로 (예: low-rank 행렬의 구조, 마스킹 패턴 — grid는 4×4 ~ 8×8, 값 0~1 정규화) /
    transform: ==보여줄 흥미로운 내부 수치가 없는 블록(Add & Norm, residual 덧셈, reshape, projection, dropout 등)의 기본 선택==. 입력 데이터(from)가 이 블록을 거쳐 출력 데이터(to)로 어떤 형태(shape)·의미로 바뀌는지 from/to/op로 보여줍니다. 예: from {label:"임베딩", shape:"[n, 512]"} op:"잔차 더하기 ⊕ 후 LayerNorm" to {label:"정규화된 표현", shape:"[n, 512]"}.
  어떤 블록이든 위 6개로 표현이 애매하면 transform을 쓰세요. ==전체 flow에서 같은 type만 반복하지 말고, 데이터가 토큰→벡터→가중치행렬→확률처럼 변해가는 흐름이 type 선택에서 드러나게== 하세요.
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

async function runAnalysis(pdfPath, pageCount, onProgress = () => {}, ac) {
  const prompt =
    `${pdfPath} 경로에 ${pageCount}페이지짜리 논문 PDF가 있습니다.\n` +
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
        systemPrompt: SYSTEM_PROMPT,
        model: MODEL,
        allowedTools: ["Read", "WebSearch"], // WebSearch: inner_viz 예시값·관련 논문 링크의 정확도
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

async function runAnalysisJob(res, hash, pageCount, fallbackTitle, ac) {
  inFlight.add(hash);
  try {
    await runAnalysisJobInner(res, hash, pageCount, fallbackTitle, ac);
  } finally {
    inFlight.delete(hash);
  }
}

async function runAnalysisJobInner(res, hash, pageCount, fallbackTitle, ac) {
  const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
  console.log(`[분석 시작] ${fallbackTitle} (${pageCount}p, ${hash.slice(0, 12)}…)`);
  const aborted = () => ac && ac.signal && ac.signal.aborted;
  const onProgress = (msg, pct) => sseSend(res, { type: "progress", msg, pct });
  onProgress(`분석 시작 — ${pageCount}페이지 논문`, 0);

  let analysis = null;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2 && !analysis; attempt++) {
    try {
      lastRaw = await runAnalysis(pdfPath, pageCount, onProgress, ac);
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

  await store.set(hash, {
    hash,
    title: analysis.title || fallbackTitle,
    one_liner: analysis.one_liner || "",
    analysis,
  });
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

      const buffer = req.file.buffer;

      // 페이지 수 검사 (텍스트 추출이 아니라 PDF 구조 파싱만 수행)
      let pageCount;
      try {
        const doc = await PDFDocument.load(buffer, { updateMetadata: false });
        pageCount = doc.getPageCount();
      } catch (e) {
        return res.status(400).json({
          error:
            "PDF를 읽을 수 없습니다. 손상되었거나 암호화(password-protected)된 파일은 지원되지 않습니다.",
        });
      }
      if (pageCount > MAX_PDF_PAGES) {
        return res.status(400).json({
          error: `PDF가 ${pageCount}페이지로 최대 ${MAX_PDF_PAGES}페이지 제한을 초과합니다.`,
        });
      }

      // SHA-256 해시 → 원문 저장 → 캐시 조회
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      await fs.promises.writeFile(path.join(PDF_DIR, `${hash}.pdf`), buffer); // 뷰어·재분석·질문용

      if (hashBusy(hash)) {
        return res.status(409).json({
          error: "이 논문은 이미 분석이 진행 중입니다. 잠시 후 히스토리에서 확인하세요.",
        });
      }
      const cached = await store.get(hash);
      sseInit(res); // 여기부터는 SSE 스트림으로 진행 상황 전달
      if (cached) {
        sseSend(res, { type: "result", data: { cached: true, hash, ...cached.analysis } });
        return res.end();
      }
      // 클라이언트가 탭을 닫거나 "분석 취소"하면 연결이 끊긴다 → 에이전트 실행 중단(사용량 절약)
      const ac = new AbortController();
      abortOnDisconnect(res, ac, req.file.originalname);
      await runAnalysisJob(res, hash, pageCount, req.file.originalname, ac);
    } catch (e) {
      console.error("[/api/analyze 오류]", e);
      if (res.headersSent) {
        sseSend(res, { type: "error", error: `분석 중 오류: ${e.message || "알 수 없는 오류"}` });
        return res.end();
      }
      return res.status(500).json({
        error: `분석 중 오류가 발생했습니다: ${e.message || "알 수 없는 오류"}`,
      });
    }
  });
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
    const buffer = await fs.promises.readFile(pdfPath);
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const pageCount = doc.getPageCount();
    // 기존 분석을 미리 지우지 않는다 — 재분석이 끝에서 store.set으로 덮어쓰므로,
    // 재분석 중에도 기존 결과가 유지되고(채팅·열람 가능) 실패해도 기존 분석이 보존된다.
    const prev = await store.get(hash);
    sseInit(res);
    const ac = new AbortController();
    abortOnDisconnect(res, ac, (prev && prev.title) || "재분석");
    await runAnalysisJob(res, hash, pageCount, (prev && prev.title) || "재분석", ac);
  } catch (e) {
    console.error("[/api/reanalyze 오류]", e);
    if (res.headersSent) {
      sseSend(res, { type: "error", error: `재분석 실패: ${e.message}` });
      return res.end();
    }
    res.status(500).json({ error: `재분석 실패: ${e.message}` });
  }
});

// --- GET /api/pdf/:hash — 원문 PDF 서빙 (좌측 뷰어) ----------------------------
app.get("/api/pdf/:hash", (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  const p = path.join(PDF_DIR, `${hash}.pdf`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "저장된 원문 PDF가 없습니다." });
  res.sendFile(p);
});

// label("Table 2", "Figure 1" …) → {type, num}
function parseFigLabel(label) {
  const typeM = label.match(/[A-Za-z]+/);
  const numM = label.match(/\d+/);
  if (!typeM || !numM) return null;
  let type = typeM[0].toLowerCase();
  if (type === "fig") type = "figure";
  if (type === "tbl") type = "table";
  return { type, num: numM[0] };
}

// 모델이 찍은 bbox는 세로 위치가 부정확할 때가 많다(특히 표). PDF 텍스트 레이어에서
// 'Table N:'/'Figure N:' 캡션 위치(정확)를 찾아 크롭의 세로 위치를 캡션에 맞춰 보정한다.
// 가로 폭·대략 크기는 모델 bbox를 따른다. 캡션을 못 찾으면 null(→ 원본 bbox 사용).
const clamp01 = (n) => Math.min(Math.max(0, n), 1);
async function captionAnchoredBox(pdfPath, page, label, modelBox, wpt, hpt) {
  const parsed = parseFigLabel(label);
  if (!parsed) return null;
  const xml = await new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-bbox", "-f", String(page), "-l", String(page), pdfPath, "-"],
      { timeout: 15000, maxBuffer: 24 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
  const words = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let m;
  while ((m = re.exec(xml))) words.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] });
  if (!words.length) return null;

  // 대표 줄 높이(중앙값) — 간격(gap) 판정 기준
  const heights = words.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const otherCapRe = /^(table|figure|fig\.?)\s*\d+\s*[:.]/i; // 다른 그림/표 캡션

  // --- 1) 캡션 라벨 단어 찾기 (줄 시작 + 콜론을 강하게 우선) ---
  const cands = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].t.toLowerCase() !== parsed.type) continue;
    const nm = words[i + 1].t.match(/^(\d+)([.:]?)/);
    if (!nm || nm[1] !== parsed.num) continue;
    const w = words[i];
    const lineStart = !words.some((o) => o !== w && Math.abs(o.y0 - w.y0) < lineH * 0.6 && o.x0 < w.x0 - 0.5);
    let score = 0;
    if (nm[2] === ":") score += 3;
    else if (nm[2] === ".") score += 2;
    if (lineStart) score += 3; // 줄 시작 = 캡션(본문 속 'Table 2 provides…' 인용 배제)
    cands.push({ w, score });
  }
  if (!cands.length) return null;
  const modelCY = ((modelBox[1] + modelBox[3]) / 2) * hpt;
  cands.sort((a, b) => b.score - a.score || Math.abs(a.w.y0 - modelCY) - Math.abs(b.w.y0 - modelCY));
  const cap = cands[0];
  if (cap.score < 3) return null; // 캡션이라 확신 못 하면 보정 안 함(원본 bbox 폴백)

  // --- 2) 캡션이 속한 컬럼의 단어만 모아 '줄(row)' 단위로 묶기 (2단 레이아웃 오염 방지) ---
  const mid = wpt / 2;
  let colMin = Math.min(modelBox[0] * wpt, cap.w.x0) - 0.02 * wpt;
  let colMax = Math.max(modelBox[2] * wpt, cap.w.x1) + 0.03 * wpt;
  // 단일 컬럼 그림이면 페이지 중앙(거터)에서 다른 컬럼을 차단 (좌/우 글자 새어듦 방지)
  if (modelBox[2] - modelBox[0] < 0.55) {
    if (modelBox[0] >= 0.45) colMin = Math.max(colMin, mid + 2);
    else if (modelBox[2] <= 0.55) colMax = Math.min(colMax, mid - 2);
  }
  const colWords = words.filter((w) => { const c = (w.x0 + w.x1) / 2; return c > colMin && c < colMax; });
  const rows = [];
  for (const w of [...colWords].sort((a, b) => a.y0 - b.y0)) {
    const c = (w.y0 + w.y1) / 2;
    const r = rows[rows.length - 1];
    if (r && c <= r.cMax + lineH * 0.6 && c >= r.cMin - lineH * 0.6) {
      r.top = Math.min(r.top, w.y0); r.bottom = Math.max(r.bottom, w.y1);
      r.xL = Math.min(r.xL, w.x0); r.xR = Math.max(r.xR, w.x1);
      r.cMin = Math.min(r.cMin, c); r.cMax = Math.max(r.cMax, c); r.words.push(w);
    } else {
      rows.push({ top: w.y0, bottom: w.y1, xL: w.x0, xR: w.x1, cMin: c, cMax: c, words: [w] });
    }
  }
  rows.forEach((r) => { r.text = r.words.slice().sort((a, b) => a.x0 - b.x0).map((w) => w.t).join(" "); });
  const ci = rows.findIndex((r) => r.words.includes(cap.w));
  if (ci < 0) return null;

  // 캡션 라벨 줄부터 아래로 이어지는 캡션 블록(여러 줄)을 실측
  const capBlockFrom = (idx) => {
    let top = rows[idx].top, bottom = rows[idx].bottom, end = idx, xL = rows[idx].xL, xR = rows[idx].xR;
    for (let j = idx + 1; j < rows.length; j++) {
      const r = rows[j];
      if (r.top - bottom > lineH * 1.0) break; // 캡션 줄 간격보다 크면 끝(다음 블록)
      if (otherCapRe.test(r.text)) break; // 다음 그림/표 캡션
      if (r.bottom - top > 0.17 * hpt) break; // 너무 길면 본문 흡수 방지
      bottom = r.bottom; end = j; xL = Math.min(xL, r.xL); xR = Math.max(xR, r.xR);
    }
    return { top, bottom, end, xL, xR };
  };

  // --- 3) 우리 캡션 블록 + 페이지 내 다른 그림/표 캡션 블록(이웃 침범 차단용) ---
  const myCap = capBlockFrom(ci);
  const capTop = myCap.top, capBottom = myCap.bottom, capXL = myCap.xL, capXR = myCap.xR, capEndIdx = myCap.end;
  const foreignBlocks = [];
  for (let idx = 0; idx < rows.length; idx++) {
    if (idx >= ci && idx <= capEndIdx) continue; // 우리 캡션 줄들은 제외
    if (!otherCapRe.test(rows[idx].text)) continue;
    foreignBlocks.push(capBlockFrom(idx));
  }
  const inForeign = (r) => foreignBlocks.some((b) => r.top < b.bottom + 1 && r.bottom > b.top - 1);

  // --- 4) 방향 판정: 모델 박스가 한쪽으로 분명히 치우치면 그걸, 모호하면 가까운 콘텐츠 쪽 ---
  const rowAbove = ci > 0 ? rows[ci - 1] : null;
  const rowBelow = capEndIdx + 1 < rows.length ? rows[capEndIdx + 1] : null;
  const gapAbove = rowAbove ? capTop - rowAbove.bottom : Infinity;
  const gapBelow = rowBelow ? rowBelow.top - capBottom : Infinity;
  const extendsAbove = modelBox[1] < capTop / hpt - 0.05;
  const extendsBelow = modelBox[3] > capBottom / hpt + 0.05;
  const aboveAmt = capTop / hpt - modelBox[1]; // 모델 박스가 캡션 위로 뻗은 정도
  const belowAmt = modelBox[3] - capBottom / hpt; // 아래로 뻗은 정도
  let figureAbove;
  if (extendsAbove && !extendsBelow) figureAbove = true;
  else if (extendsBelow && !extendsAbove) figureAbove = false;
  // 둘 다(혹은 둘 다 아님) 모호 → 위에 붙은 콘텐츠가 더 가깝거나(표),
  // 위에 텍스트가 없어도 모델 박스가 캡션 위로 훨씬 더 뻗어 있으면(순수 이미지 그림) 위로 판단
  else figureAbove = gapAbove <= gapBelow || aboveAmt > belowAmt + 0.1;

  // --- 5) 본체 경계 스캔 ---
  // 표↔본문 경계 간격은 표마다 다르다(빽빽한 표 ~13pt, 느슨한 표는 더 큼). 고정 임계는 한쪽을 깨므로,
  // 스캔하며 '내부 줄 간격'을 누적해 그 대비 큰 간격에서만 멈춘다(적응형). 처음 두 간격은 표본으로만 쓴다.
  // 캡션 바로 위/아래의 아주 큰 빈칸은 그림 이미지로 본다.
  const imageGap = Math.max(lineH * 3.0, 0.045 * hpt); // 이만큼 크면 이미지 빈칸
  const minBoundary = lineH * 0.9, maxBoundary = lineH * 2.6;
  const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const stopBoundary = (gap, gs) => {
    if (gs.length < 2) { gs.push(Math.max(gap, 0)); return false; } // 처음 2개는 표본 확보(멈춤 판정 보류)
    const th = Math.min(Math.max(median(gs) * 2.2, minBoundary), maxBoundary);
    if (gap > th) return true;
    gs.push(Math.max(gap, 0));
    return false;
  };

  let bodyTop, bodyBottom;
  if (figureAbove) {
    bodyBottom = capBottom;
    let top = capTop, acc = false; const gs = [];
    for (let j = ci - 1; j >= 0; j--) {
      const r = rows[j];
      if (inForeign(r)) break; // 위쪽 다른 그림/표 캡션 블록 → 멈춤(제외)
      const gap = top - r.bottom;
      if (!acc) { if (gap > imageGap) { top = r.bottom; break; } } // 캡션 바로 위 큰 빈칸 = 이미지
      else if (stopBoundary(gap, gs)) break; // 내부 줄 간격 대비 큰 간격 = 표/그림 끝
      top = r.top; acc = true;
    }
    let limitTop = 0; // 위쪽으로 가장 가까운 이웃 캡션 블록의 아래 경계
    for (const b of foreignBlocks) if (b.bottom <= capTop + 1 && b.bottom > limitTop) limitTop = b.bottom;
    // 모델 박스가 캡션에 닿을 때만(=위치가 신뢰되는 박스) 하한으로 써서 잘림을 막는다.
    // 닿지 않으면(예: 본문 위에 잘못 찍힌 박스) 스캔 결과만 사용해 과확장을 막는다.
    if (modelBox[3] * hpt >= capTop - 0.08 * hpt) top = Math.min(top, modelBox[1] * hpt);
    bodyTop = Math.max(top, limitTop);
  } else {
    bodyTop = capTop;
    let bottom = capBottom, acc = false; const gs = [];
    for (let j = capEndIdx + 1; j < rows.length; j++) {
      const r = rows[j];
      if (inForeign(r)) break;
      const gap = r.top - bottom;
      if (!acc) { if (gap > imageGap) { bottom = r.top; break; } }
      else if (stopBoundary(gap, gs)) break;
      bottom = r.bottom; acc = true;
    }
    let limitBot = hpt; // 아래쪽으로 가장 가까운 이웃 캡션 블록의 위 경계
    for (const b of foreignBlocks) if (b.top >= capBottom - 1 && b.top < limitBot) limitBot = b.top;
    // 모델 박스가 캡션에 닿을 때만 하한으로 사용 (위 figureAbove와 동일 취지)
    if (modelBox[1] * hpt <= capBottom + 0.08 * hpt) bottom = Math.max(bottom, modelBox[3] * hpt);
    bodyBottom = Math.min(bottom, limitBot);
  }

  // --- 6) 가로 폭: 본체 영역 단어들의 실제 좌우 + 캡션 폭 (우측 범례 잘림 방지) ---
  let nx0pt = Infinity, nx1pt = -Infinity;
  for (const w of colWords) {
    if (w.y1 < bodyTop - 1 || w.y0 > bodyBottom + 1) continue;
    if (w.x0 < nx0pt) nx0pt = w.x0;
    if (w.x1 > nx1pt) nx1pt = w.x1;
  }
  if (!isFinite(nx0pt)) { nx0pt = modelBox[0] * wpt; nx1pt = modelBox[2] * wpt; }
  nx0pt = Math.min(nx0pt, capXL);
  nx1pt = Math.max(nx1pt, capXR);

  const X0 = clamp01(nx0pt / wpt), Y0 = clamp01(bodyTop / hpt);
  const X1 = clamp01(nx1pt / wpt), Y1 = clamp01(bodyBottom / hpt);
  if (Y1 - Y0 < 0.03 || X1 - X0 < 0.05) return null; // 비정상이면 폴백
  return [X0, Y0, X1, Y1];
}

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

    // 캐시 키는 입력(page+box+label) 기준 → 캐시 히트 시 PDF 로드·캡션 탐색을 건너뛴다
    const keyHash = crypto.createHash("sha1").update(`v9|${page}|${box.join(",")}|${label}`).digest("hex").slice(0, 16);
    const outBase = path.join(CROP_DIR, `${hash}_${keyHash}`);
    const outPng = `${outBase}.png`;

    if (!fs.existsSync(outPng)) {
      const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
      if (page > doc.getPageCount()) return res.status(404).json({ error: "페이지 범위를 벗어났습니다." });
      const { width: wpt, height: hpt } = doc.getPage(page - 1).getSize();

      // 캡션 위치로 세로 보정 (실패하면 모델 bbox 그대로)
      if (label) {
        try {
          const fixed = await captionAnchoredBox(pdfPath, page, label, [x0, y0, x1, y1], wpt, hpt);
          if (fixed) [x0, y0, x1, y1] = fixed;
        } catch (e) { console.error("[캡션 보정 실패]", label, e.message); }
      }

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
          (err) => (err ? reject(err) : resolve())
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
    const context = JSON.stringify({
      title: a.title,
      one_liner: a.one_liner,
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
      },
    })) {
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
          } else if (b.type === "text" && b.text && b.text.trim().length > 30) {
            step("✍️ 답변을 정리하는 중…");
          }
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

// --- POST /api/reanalyze-section/:hash — 한 섹션만 다시 생성 (전체 재분석 없이) ---
// 캐시된 원문 PDF에서 해당 부분만 다시 읽어 그 섹션의 JSON만 받아 기존 분석에 병합한다.
// 전체 재분석(30페이지 재독)의 일부 비용으로 약한 섹션만 보강 — Max 사용량 절약.
const SECTION_FIELDS = {
  background: { keys: ["background", "timeline"], label: "연구 배경(과 분야 타임라인)" },
  problem: { keys: ["problem"], label: "해결하려는 것" },
  method: { keys: ["method_steps", "figures"], label: "연구 방법론(단계·시각화)" },
  results: { keys: ["experiments"], label: "실험·결과" },
  equations: { keys: ["equations", "equation_flow"], label: "수식 정리(와 수식 흐름도)" },
  figures: { keys: ["figure_guide"], label: "그림 해설" },
  contributions: { keys: ["contributions"], label: "핵심 기여" },
  qa: { keys: ["suggested_questions"], label: "예상 Q&A" },
  glossary: { keys: ["glossary"], label: "용어집" },
};
app.post("/api/reanalyze-section/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
  const section = String((req.body && req.body.section) || "");
  const spec = SECTION_FIELDS[section];
  if (!spec) return res.status(400).json({ error: "알 수 없는 섹션입니다." });
  const inflightKey = `${hash}:${section}`;
  if (hashBusy(hash)) {
    return res.status(409).json({ error: "이 논문은 이미 분석/재생성이 진행 중입니다." });
  }
  const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).json({ error: "저장된 원문 PDF가 없어 섹션을 다시 생성할 수 없습니다." });
  }
  const record = await store.get(hash);
  if (!record) return res.status(404).json({ error: "해당 논문의 분석 결과가 없습니다." });

  const ac = new AbortController();
  abortOnDisconnect(res, ac, `섹션 재생성: ${spec.label}`);
  inFlight.add(inflightKey);
  try {
    const a = record.analysis || {};
    const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
    const pageCount = doc.getPageCount();
    const prompt =
      `${pdfPath} 경로에 "${a.title || ""}" 논문 PDF(${pageCount}페이지)가 있습니다. 이미 분석된 논문인데 ` +
      `'${spec.label}' 섹션만 더 정확하고 풍부하게 다시 만들려 합니다.\n` +
      `Read 도구로 이 섹션과 관련된 부분을 다시 읽으세요(필요한 범위만, 20페이지씩).\n` +
      `시스템 프롬프트의 스키마·마크업 규칙을 그대로 따르되, ==최종 출력은 다음 키만 담은 JSON 객체 하나==로 하세요: ${spec.keys.map((k) => `"${k}"`).join(", ")}.\n` +
      `다른 섹션과 어조·용어가 일관되도록, 기존 한 줄 요약은 다음과 같습니다: ${(a.one_liner || "").slice(0, 200)}`;

    let raw = null;
    for await (const msg of query({
      prompt,
      options: { systemPrompt: SYSTEM_PROMPT, model: MODEL, allowedTools: ["Read", "WebSearch"], maxTurns: 60, cwd: PDF_DIR, abortController: ac },
    })) {
      if (msg.type === "result") {
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
    await store.delete(hash);
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
