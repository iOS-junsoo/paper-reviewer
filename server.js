require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
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

// 업로드된 원문 PDF 보관 (뷰어·재분석·질문 답변에 사용)
const PDF_DIR = path.join(__dirname, "pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 저장소: Firebase 서비스 계정 키가 있으면 Firestore, 없으면 메모리 캐시 폴백
// (메모리 캐시는 서버 재시작 시 사라짐 — 테스트용)
// ---------------------------------------------------------------------------
const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT || "./serviceAccountKey.json";

let store;

if (fs.existsSync(serviceAccountPath)) {
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
  });
  const analyses = admin.firestore().collection("analyses");
  store = {
    kind: "firestore",
    async get(hash) {
      const doc = await analyses.doc(hash).get();
      if (!doc.exists) return null;
      const data = doc.data();
      // analysis는 JSON 문자열로 저장됨 (Firestore는 중첩 배열을 허용하지 않음
      // — 예: 표 figure의 rows: [[...]]). 구버전 객체 저장 레코드도 호환.
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
  console.log("[저장소] Firestore 사용");
} else {
  const mem = new Map();
  store = {
    kind: "memory",
    async get(hash) {
      return mem.get(hash) || null;
    },
    async set(hash, record) {
      mem.set(hash, { ...record, createdAt: new Date().toISOString() });
    },
    async delete(hash) {
      mem.delete(hash);
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
  "background": "연구 배경 (## 소제목으로 단락 구분)",
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
            "설명": "이 블록 '내부'에서 예시 값이 어떻게 변하는지 보여주는 미니 시각화. 가장 중요한 블록 2~4개에만 넣고 나머지는 생략",
            "type": "heatmap | vectors | bars",
            "title": "시각화 제목 (예: '단어×단어 어텐션 가중치')",
            "tokens": ["heatmap/vectors의 행·열 레이블 (예시 문장의 토큰들, 3~6개)"],
            "matrix": [[0.8, 0.15, 0.05]],
            "vectors": [ { "label": "행 레이블", "values": [0.2, -0.5, 0.8] } ],
            "bars": [ { "label": "항목", "value": 0.62, "highlight": true } ],
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
      "explanation": "이 수식이 무엇을 하는지, method_steps의 어느 단계에 해당하는지",
      "analogy": "이 수식 전체를 일상 상황에 빗댄, 읽자마자 그림이 그려지는 비유 한 문장",
      "variables": [ { "symbol": "Q", "meaning": "query 행렬 — '내가 지금 찾고 있는 것'에 해당" } ]
    }
  ]
}

섹션별 작성 지침 (독자는 세미나 발표를 준비하거나 정독 전 구조를 잡으려는 대학원생):
- background: "## 소제목" 줄로 2~3개 단락을 나누세요 (예: "## 분야의 흐름", "## 남아 있는 공백"). 분야가 어떤 흐름으로 발전해왔는지 → 현재 어디까지 와 있는지 → 이 논문이 들어갈 공백(gap)이 무엇인지 순서로.
- problem: "## 소제목"으로 2~3개 단락 구분. 기존 방법(existing methods)들을 구체적으로 거명하고 각각의 한계를 짚은 뒤, 이 논문이 정확히 어떤 문제를 타깃하는지 명시하세요.
- method_steps: 4~8개 단계. 각 단계는 짧은 title + "무엇을 + 왜"를 담은 description + 일상 비유(analogy). 비유는 그 단계의 핵심 직관을 비전공자도 떠올릴 수 있게. 데이터가 흘러가는 순서대로 배열하세요.
- figures: ==논문의 핵심 방법론(method)을 보여주는 그림만 1~2개 재구성하세요== — 모델 구조, 파이프라인, 방법의 동작 원리를 담은 그림. ==성능 비교·실험 결과 그림과 표(table)는 재구성하지 마세요== (BLEU/accuracy 비교 막대, 벤치마크 표 등 금지). 시각 유형은 내용에 맞게:
  · 모델 구조/파이프라인 그림 → "flow". ==원 논문 그림과 같은 모양이 되도록 재구성하세요== — 그림에서 블록들이 두 기둥으로 나란히 서 있으면(예: encoder 기둥과 decoder 기둥) lane으로 그 구조를 보존하고, 입력·출력처럼 기둥 바깥의 블록은 lane 없이 두세요. 블록 배열 순서는 데이터가 흐르는 순서이며, 이 순서대로 사용자가 스테퍼로 한 블록씩 따라가므로 모든 블록에 role과 data_state를 반드시 채우세요.
  · 방법 자체가 분포·수치 변화를 다루는 경우에만 → "bar" 또는 "line" (예: 방법이 만드는 분포의 모양, 방법 내부 함수의 곡선)
  수치는 반드시 논문에서 실제로 읽은 값만 쓰세요. ==수치를 확인할 수 없으면 그 figure는 빼세요 (지어내기 절대 금지)==. 각 figure에는 type에 해당하는 데이터 필드만 포함하세요.
- inner_viz (블록 내부 시각화): flow의 핵심 블록 2~4개에, 그 블록 안에서 ==구체적인 예시 값이 어떻게 변하는지== 보여주는 미니 시각화를 넣으세요.
  · figure의 example에 하나의 구체적 예시(짧은 문장, 이미지 패치 등)를 정하고, 모든 inner_viz가 같은 예시를 따라가게 하세요 (연속성).
  · ==시각화를 만들기 전에 WebSearch로 이 논문의 유명 해설·시각화 자료를 1~2회 검색해 참고하세요== (예: "illustrated transformer", "<논문명> explained visualization"). 널리 알려진 예시(예: 어텐션 논문의 "The animal didn't cross the street because it was too tired")가 있으면 그것을 쓰세요.
  · 값은 논문이 명시한 수치가 있으면 그대로, 없으면 ==논문이 설명하는 정성적 패턴을 정확히 반영한 예시값==으로 (예: 동사는 주어에 높은 어텐션, 합이 1인 softmax 행 등). explanation에 "예시값"임이 드러나게 쓰지 말고, 읽어야 할 패턴을 설명하세요.
  · type 선택: 관계·가중치 행렬 → heatmap (행=보는 주체, 각 행 합 ≈ 1), 벡터·표현 변화 → vectors (값 -1~1, 4~8칸), 확률·점수 분포 → bars.
- equations: 논문의 핵심 수식만 3~8개. ==배열 순서는 계산이 흘러가는 순서(앞 수식의 출력이 뒤 수식의 입력이 되는 순서)로 정렬하세요==. 순서를 재배열하더라도 paper_ref에 원 논문의 수식 번호(Eq. N)나 절 번호를 남겨 사용자가 원문과 대조할 수 있게 하세요. variables에는 수식에 등장하는 주요 기호를 하나도 빠짐없이 나열하고, meaning은 비전공자도 이해할 만큼 쉬운 말로 ("~에 해당", "~를 뜻함" 같은 직관적 설명). explanation은 수식의 역할과 방법론 단계 연결, analogy는 설명 바로 아래에 표시될 일상 비유 한 문장. 수식이 없는 논문이면 빈 배열 [].
- related_papers: 이 논문을 이해하기 위해 ==먼저 읽으면 좋은 선행 논문 3~5편==. 본문에서 중요하게 인용된 것 위주로, reason에 "왜 먼저"를 한 줄로. link는 WebSearch로 실제 arXiv URL(https://arxiv.org/abs/...)을 확인해 넣고, 확인 못 하면 null (가짜 URL 금지).
- equation_flow: 수식 탭 맨 위에 표시되는 "수식 로드맵". equations의 순서를 따라 각 수식을 하나의 노드로 잇고, goal에는 그 수식이 구하는 것을 짧게, why에는 왜 그걸 구해야 전체 그림이 완성되는지를 쓰세요. 사용자가 개별 수식을 읽기 전에 "왜 이 수식들이 이 순서로 필요한가"를 먼저 이해하는 용도입니다. 수식이 없으면 null.

강조 마크업 (background / problem / description / role / explanation / analogy / meaning 텍스트 안에서 사용):
- **핵심 용어** : 중요한 개념·기법·모델명은 별표 두 개로 감싸 볼드 처리. 예: **Self-Attention(셀프 어텐션)**
- ==결정적 문장== : 그 섹션에서 단 하나만 기억해야 한다면 이것, 이라는 구절은 등호 두 개로 감싸 형광펜 처리. 섹션당 1~2곳만, 남용 금지.
- $인라인 수식$ : 설명 속 수식 기호·표현식은 $로 감싸면 KaTeX 수식으로 렌더링됩니다. 예: "$p(t_i)$로 추정한다". $ 없이 날것의 LaTeX를 본문에 쓰지 마세요.

규칙:
1. 최종 응답은 위 스키마의 JSON 객체 하나만 출력하세요. 마크다운 코드 펜스(\`\`\`), 설명 문장, 기타 텍스트를 절대 붙이지 마세요. ==출력하기 전에 괄호 짝({}, []), 콤마, 이스케이프가 유효한 JSON인지 스스로 검증하세요== — 특히 문자열을 닫는 따옴표 뒤에 잘못된 ]나 }가 붙지 않도록.
2. 설명문은 한국어로 쓰되, ==기법·모델·구성요소 같은 고유명사는 영어 원어를 그대로 쓰고 괄호에 한국어 번역(뜻)을 붙이세요==. 예: "**Scaled Dot-Product Attention**(스케일링된 내적 어텐션)", "**residual connection**(잔차 연결)". 같은 용어가 반복되면 번역 괄호는 처음 한 번만. 논문 내부 인용 키(예: hochreiter1997)나 참조 번호([1], [2])는 절대 쓰지 마세요.
2-1. 비유(analogy)는 전문 용어 없이, 읽는 즉시 장면이 그려지는 일상 상황(도서관, 회의, 요리, 택배 등)으로 쓰세요.
3. latex 문자열 안의 백슬래시는 JSON 규칙에 맞게 이스케이프하세요 (예: "\\\\frac{a}{b}").
4. 정확하고 구체적으로 쓰되 불필요한 수사는 빼세요. 강조 마크업은 위 두 종류만 사용하고 다른 마크다운 문법은 쓰지 마세요.`;

async function runAnalysis(pdfPath, pageCount, onProgress = () => {}) {
  const prompt =
    `${pdfPath} 경로에 ${pageCount}페이지짜리 논문 PDF가 있습니다.\n` +
    `Read 도구로 논문 전체를 읽으세요. 10페이지가 넘으므로 pages 파라미터로 최대 20페이지씩 나눠 끝까지 읽어야 합니다 (예: "1-20", "21-40", ...).\n` +
    `전부 읽은 뒤 inner_viz 제작 전에 WebSearch로 이 논문의 시각화·해설 자료를 1~2회 검색해 참고하고,\n` +
    `시스템 프롬프트의 스키마대로 JSON 객체 하나만 최종 출력하세요.`;

  let resultText = null;

  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: MODEL,
      allowedTools: ["Read", "WebSearch"], // WebSearch: inner_viz 예시값·관련 논문 링크의 정확도
      maxTurns: 90, // 600페이지 = Read 30회 + 검색 + 여유
      cwd: PDF_DIR,
    },
  })) {
    // 에이전트의 도구 사용을 사람이 읽을 수 있는 진행 메시지로 변환
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          if (block.name === "Read") {
            const pages = block.input && block.input.pages;
            onProgress(pages ? `논문 ${pages}페이지를 읽는 중…` : "논문을 읽는 중…");
          } else if (block.name === "WebSearch") {
            const q = ((block.input && block.input.query) || "").slice(0, 50);
            onProgress(`해설 자료 검색 중: "${q}"`);
          }
        } else if (block.type === "text" && block.text && block.text.trim().length > 40) {
          onProgress("읽기 완료 — 분석 결과를 정리하는 중…");
        }
      }
    }
    if (msg.type === "result") {
      if (msg.subtype !== "success") {
        throw new Error(`분석 에이전트 실행 실패 (${msg.subtype})`);
      }
      resultText = msg.result;
    }
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
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function runAnalysisJob(res, hash, pageCount, fallbackTitle) {
  const pdfPath = path.join(PDF_DIR, `${hash}.pdf`);
  console.log(`[분석 시작] ${fallbackTitle} (${pageCount}p, ${hash.slice(0, 12)}…)`);
  const onProgress = (msg) => sseSend(res, { type: "progress", msg });
  onProgress(`분석 시작 — ${pageCount}페이지 논문`);

  let analysis = null;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2 && !analysis; attempt++) {
    try {
      lastRaw = await runAnalysis(pdfPath, pageCount, onProgress);
      analysis = parseModelJson(lastRaw);
    } catch (e) {
      console.warn(`[분석/파싱 실패 — 시도 ${attempt}/2]`, (e.message || "").slice(0, 200));
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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json()); // /api/ask 본문 파싱

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

      const cached = await store.get(hash);
      sseInit(res); // 여기부터는 SSE 스트림으로 진행 상황 전달
      if (cached) {
        sseSend(res, { type: "result", data: { cached: true, hash, ...cached.analysis } });
        return res.end();
      }
      await runAnalysisJob(res, hash, pageCount, req.file.originalname);
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
    const buffer = await fs.promises.readFile(pdfPath);
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const pageCount = doc.getPageCount();
    const prev = await store.get(hash);
    await store.delete(hash);
    sseInit(res);
    await runAnalysisJob(res, hash, pageCount, (prev && prev.title) || "재분석");
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

// --- POST /api/ask/:hash — 분석된 논문에 대한 후속 질문 -------------------------
app.post("/api/ask/:hash", async (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, "");
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
      background: a.background,
      problem: a.problem,
      method_steps: a.method_steps,
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
      `규칙: 한국어로 간결히(보통 3~8문장, 필요할 때만 길게). 고유명사는 영어 원어 그대로 + 괄호 번역. 인라인 수식은 $...$, 강조는 **볼드**/==형광펜== 사용 가능. 마크다운 헤더·리스트·코드펜스는 쓰지 말고, 답변 텍스트만 출력하세요.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    console.log(`[질문] ${a.title}: ${question.slice(0, 60)}`);
    let answer = null;
    for await (const msg of query({
      prompt,
      options: { model: MODEL, allowedTools: ["Read", "WebSearch"], maxTurns: 20, cwd: PDF_DIR },
    })) {
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(`응답 생성 실패 (${msg.subtype})`);
        answer = msg.result;
      }
    }
    res.json({ answer: answer || "(답변을 생성하지 못했습니다)" });
  } catch (e) {
    console.error("[/api/ask 오류]", e);
    res.status(500).json({ error: `질문 처리 실패: ${e.message}` });
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
    await store.delete(req.params.hash);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /api/history/:hash 오류]", e);
    res.status(500).json({ error: `삭제 실패: ${e.message}` });
  }
});

app.listen(PORT, () => {
  console.log(
    `Paper Reviewer 실행 중: http://localhost:${PORT} (모델: ${MODEL}, 저장소: ${store.kind})`
  );
});
