#!/usr/bin/env node
/**
 * 서브 분석 하니스 — 최적화안(baseline vs optimized)을 같은 논문에 실제로 돌려 토큰·결과 비교.
 * 본 서비스(3000)·Firestore를 건드리지 않는다: 메인 API에서 논문 메타만 읽고, LLM 생성은
 * 서버의 generateMethodVizHtml과 동일 로직을 재현하되 시스템 프롬프트/힌트만 모드별로 바꾼다.
 * 산출 HTML은 /tmp에 쓰고 scripts/verify_mviz.js로 검증.
 *
 * 사용법: node sub_test.js <baseline|optimized> <hash>
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { query } = require("@anthropic-ai/claude-agent-sdk");
const { PDFDocument } = require("pdf-lib");

const MODE = process.argv[2] || "optimized";
const HASH = (process.argv[3] || "").replace(/[^a-f0-9]/g, "");
const MODEL = process.env.MODEL || "claude-opus-4-8";
const ROOT = __dirname;
const OUT = path.join("/tmp", `sub_${MODE}_${HASH.slice(0, 8)}.html`);

// ── 본 서버와 동일한 SYSTEM_PROMPT(full, V4 포함) 재구성 (baseline용) ──
function buildFullSystemPrompt() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const start = src.indexOf("const SYSTEM_PROMPT = `") + "const SYSTEM_PROMPT = `".length;
  const end = src.indexOf("`;", start);
  let tpl = src.slice(start, end);
  const v4 = fs.readFileSync(path.join(ROOT, "prompts", "method_viz_v4.md"), "utf8");
  return tpl.replace("${METHOD_VIZ_V4}", v4);
}
// ── 최적화: HTML 생성 전용 미니 시스템 프롬프트 (P2) ──
const SYSTEM_PROMPT_MINI =
  "당신은 논문의 방법론을 초심자용 인터랙티브 HTML 시각화로 만드는 전문가입니다. 한국어로 작성하고 " +
  "고유명사·수식은 원어를 병기합니다. 정직성 최우선 — 논문에서 확인한 값만 실제 수치로 쓰고, 확인 못 한 " +
  "값은 \"(예시)\"로 명시하며 지어내지 않습니다. 상세 제작 규칙·검증·출력 형식은 사용자 메시지가 지정한 지침서와 절차를 따릅니다.";

const METHOD_VIZ_HTML_GEN = fs.readFileSync(path.join(ROOT, "prompts", "method_viz_html_gen.md"), "utf8");

function runVerify(htmlPath) {
  return new Promise((resolve) => {
    execFile("node", [path.join(ROOT, "scripts", "verify_mviz.js"), htmlPath, "--json"],
      { cwd: ROOT, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => { try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ pass: false, violations: [{ rule: "verify_err", detail: (err && err.message) || "" }] }); } });
  });
}

(async () => {
  // 메인 API에서 논문 메타만 읽음(읽기 전용, 본 서비스 데이터 불변)
  const rec = await fetch(`http://localhost:3000/api/history/${HASH}`).then((r) => r.json());
  const title = rec.title || "";
  const oneLiner = (rec.one_liner || "").slice(0, 200);
  const steps = rec.method_steps || [];
  const sectionRef = (rec.method_visualization && rec.method_visualization.section_ref) || "";
  const figPages = [...new Set((rec.figure_guide || []).map((f) => f.page).filter(Boolean))].slice(0, 8);
  const pdfPath = path.join(ROOT, "pdfs", `${HASH}.pdf`);
  const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
  const pageCount = doc.getPageCount();

  try { fs.rmSync(OUT, { force: true }); } catch (e) {}

  // ── 공통 컨텍스트(본 서버 generateMethodVizHtml과 동일) ──
  let ctx =
    `\n\n---\n## 이번 논문 (컨텍스트)\n` +
    `- 제목: ${title}\n` +
    `- 원문 PDF: pdfs/${HASH}.pdf (${pageCount}페이지) — Read로 필요한 범위만(20페이지씩) 읽어라.\n` +
    `- 한 줄 요약(어조 참고): ${oneLiner}\n` +
    `- <OUTPUT_PATH> = ${OUT}\n  → 완성 HTML을 정확히 이 절대경로에 Write하라.\n` +
    `- 자가검증: \`node scripts/verify_mviz.js ${OUT} --json\` 를 실행해 pass:true까지 고쳐라(최대 5회).\n` +
    `작업 디렉터리는 저장소 루트다. prompts/method_viz_refs/ 와 scripts/ 를 상대경로로 접근할 수 있다.`;

  let systemPrompt;
  if (MODE === "baseline") {
    systemPrompt = buildFullSystemPrompt(); // 현행: 논문분석 전체 프롬프트 + V4
  } else {
    systemPrompt = SYSTEM_PROMPT_MINI; // P2: 미니 프롬프트
    // P6 힌트: 어디부터 읽을지 안내(방법론 섹션·figure 페이지)
    ctx += `\n\n## 읽기 힌트 (P6 — 이미 분석된 정보, 이 범위부터 읽으면 PDF 재독을 줄인다)\n` +
      `- 방법론/overview figure 위치: ${sectionRef || "(미상 — 캡션 검색)"}\n` +
      (figPages.length ? `- 주요 figure 페이지: ${figPages.join(", ")}\n` : "") +
      `- overview figure를 pdftoppm으로 렌더할 때 위 페이지를 우선 시도.`;
    // P4 reuseSteps: 기존 method_steps 재사용(재생성 생략)
    ctx += `\n\n## method_steps 재사용 (P4 — 이미 생성됨, 다시 만들지 말 것)\n` +
      `아래 method_steps를 그대로 응답 JSON에 넣어라(재생성·수정 불필요). HTML 스테퍼는 이와 정합하게:\n` +
      "```json\n" + JSON.stringify(steps).slice(0, 4000) + "\n```";
    // P5: 재시도 시 부분 수정
    ctx += `\n\n## 재시도 규칙 (P5)\n verify 위반 수정은 HTML 전체 재작성(Write)이 아니라 **Edit 도구로 해당 부분만** 고쳐라.`;
  }

  const prompt = METHOD_VIZ_HTML_GEN + ctx;
  const sysBytes = Buffer.byteLength(systemPrompt), promBytes = Buffer.byteLength(prompt);
  console.log(`\n========== [${MODE}] ${title.slice(0, 40)} ==========`);
  console.log(`시스템 프롬프트: ${sysBytes} bytes (≈${Math.round(sysBytes / 3.2)} tok) · 유저 프롬프트: ${promBytes} bytes (≈${Math.round(promBytes / 3.2)} tok)`);
  console.log(`시작: ${new Date().toISOString()}`);

  const t0 = Date.now();
  let raw = null, usage = null, cost = null, turns = null;
  for await (const msg of query({
    prompt,
    options: { systemPrompt, model: MODEL, allowedTools: ["Read", "Write", "Bash", "WebSearch"], maxTurns: 160, cwd: ROOT },
  })) {
    if (msg.type === "result") {
      usage = msg.usage; cost = msg.total_cost_usd; turns = msg.num_turns;
      if (msg.subtype === "success") raw = msg.result;
      else { console.log("결과 실패:", msg.subtype, String(msg.result || "").slice(0, 200)); }
    }
  }
  const dur = ((Date.now() - t0) / 1000).toFixed(0);

  const verify = fs.existsSync(OUT) ? await runVerify(OUT) : { pass: false, violations: [{ rule: "no_file" }] };
  const htmlLen = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").length : 0;

  const summary = {
    mode: MODE, title, duration_s: +dur, num_turns: turns,
    system_prompt_tok_est: Math.round(sysBytes / 3.2),
    usage, total_cost_usd: cost,
    html_bytes: htmlLen, verify_pass: verify.pass, violations: (verify.violations || []).length,
  };
  console.log("\n===== 결과 =====");
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join("/tmp", `sub_${MODE}_${HASH.slice(0, 8)}_summary.json`), JSON.stringify(summary, null, 2));
})().catch((e) => { console.error("오류:", e.message); process.exit(1); });
