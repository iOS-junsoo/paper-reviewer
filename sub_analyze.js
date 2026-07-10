#!/usr/bin/env node
/**
 * 서브 전체분석 하니스 — 최적화 파이프라인으로 논문 1편을 처음부터 끝까지 분석.
 * 본 서비스·Firestore 미접촉. P1(V4 제거)+P3(JSON 시각화 생략)로 텍스트 섹션+method_steps 생성 →
 * P2/P4/P5/P6 최적화로 method_viz_html 생성 → 완전한 분석 JSON을 파일로 저장(앱에서 renderResult).
 * 사용법: node sub_analyze.js <hash>
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { query } = require("@anthropic-ai/claude-agent-sdk");
const { PDFDocument } = require("pdf-lib");

const HASH = (process.argv[2] || "").replace(/[^a-f0-9]/g, "");
const MODEL = process.env.MODEL || "claude-opus-4-8";
const ROOT = __dirname;
const PDF_DIR = path.join(ROOT, "pdfs");
const OUT_JSON = path.join("/tmp", `sub_full_${HASH.slice(0, 8)}.json`);
const OUT_HTML = path.join("/tmp", `sub_full_${HASH.slice(0, 8)}_viz.html`);

function parseModelJson(raw) {
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// ── SYSTEM_PROMPT_CORE: 현행 SYSTEM_PROMPT에서 V4 블록 + method_visualization 요청만 제거 (P1+P3) ──
function buildCoreSystemPrompt() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const m = "const SYSTEM_PROMPT = `";
  const s = src.indexOf(m) + m.length;
  const e = src.indexOf("`;", s);
  let tpl = src.slice(s, e); // ${METHOD_VIZ_V4} 리터럴 포함
  // 1) 스키마 필드: method_visualization 값 설명 → null 지시
  tpl = tpl.replace(/"method_visualization": "[^"]*",/,
    '"method_visualization": "null로 두세요 — 방법론 시각화는 별도 HTML 파이프라인이 생성합니다. 여기서 만들지 마세요.",');
  // 2) method_visualization/figures 지시 + V4 전문 블록 통째 제거
  tpl = tpl.replace(/- method_visualization \/ figures: 아래 \[연구 방법론[\s\S]*?지시문 v4 \(끝\) ={5,}/,
    '- method_visualization: null로 두세요. 방법론 시각화는 별도 HTML 파이프라인이 생성하므로 여기서 만들지 마세요. (figure_guide/그림 해설은 평소대로 생성)');
  return tpl; // ${METHOD_VIZ_V4}는 제거된 블록 안에 있었으므로 잔여 없음
}

const SYSTEM_PROMPT_MINI =
  "당신은 논문의 방법론을 초심자용 인터랙티브 HTML 시각화로 만드는 전문가입니다. 한국어로 작성하고 " +
  "고유명사·수식은 원어를 병기합니다. 정직성 최우선 — 논문에서 확인한 값만 실제 수치로 쓰고, 확인 못 한 " +
  "값은 \"(예시)\"로 명시하며 지어내지 않습니다. 상세 제작 규칙·검증·출력 형식은 사용자 메시지가 지정한 지침서와 절차를 따릅니다.";
const METHOD_VIZ_HTML_GEN = fs.readFileSync(path.join(ROOT, "prompts", "method_viz_html_gen.md"), "utf8");

function runVerify(p) {
  return new Promise((res) => execFile("node", [path.join(ROOT, "scripts", "verify_mviz.js"), p, "--json"],
    { cwd: ROOT, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => { try { res(JSON.parse(out)); } catch (e) { res({ pass: false, violations: [{ rule: "verify_err" }] }); } }));
}

async function runQuery(prompt, systemPrompt, tools, cwd, tag) {
  let raw = null, usage = null, cost = null, turns = null;
  const t0 = Date.now();
  for await (const msg of query({ prompt, options: { systemPrompt, model: MODEL, allowedTools: tools, maxTurns: 160, cwd } })) {
    if (msg.type === "result") { usage = msg.usage; cost = msg.total_cost_usd; turns = msg.num_turns; if (msg.subtype === "success") raw = msg.result; else console.log(`[${tag}] 실패:`, msg.subtype); }
  }
  console.log(`[${tag}] ${((Date.now() - t0) / 1000).toFixed(0)}초 · ${turns}턴 · input ${usage && usage.input_tokens} · cache_read ${usage && usage.cache_read_input_tokens} · output ${usage && usage.output_tokens} · $${cost && cost.toFixed(3)}`);
  return { raw, usage, cost, turns };
}

(async () => {
  const rec = await fetch(`http://localhost:3000/api/history/${HASH}`).then((r) => r.json());
  const pdfPath = path.join(PDF_DIR, `${HASH}.pdf`);
  const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
  const pageCount = doc.getPageCount();

  console.log(`\n===== 서브 전체분석 (optimized) · ${rec.title} =====`);
  console.log(`시작: ${new Date().toISOString()}`);

  // ── 1단계: 전체 분석 (SYSTEM_PROMPT_CORE, V4/JSON시각화 제거) ──
  const corePrompt =
    `${pdfPath} 경로에 ${pageCount}페이지짜리 논문 PDF가 있습니다.\n` +
    `Read 도구로 논문 전체를 읽으세요(20페이지씩 끝까지). 다 읽은 뒤 필요시 WebSearch 1~2회 참고하고,\n` +
    `시스템 프롬프트의 스키마대로 JSON 객체 하나만 최종 출력하세요. (method_visualization은 null)`;
  const core = buildCoreSystemPrompt();
  console.log(`CORE 시스템 프롬프트: ${Buffer.byteLength(core)} bytes (V4 제거) ≈ ${Math.round(Buffer.byteLength(core) / 3.2)} tok`);
  const a1 = await runQuery(corePrompt, core, ["Read", "WebSearch"], PDF_DIR, "전체분석");
  const analysis = parseModelJson(a1.raw);
  analysis.hash = HASH;

  // ── 2단계: 방법론 HTML 시각화 (optimized: mini + reuse + hints) ──
  const steps = analysis.method_steps || [];
  const sectionRef = analysis.method_visualization && analysis.method_visualization.section_ref || "";
  const figPages = [...new Set((analysis.figure_guide || []).map((f) => f.page).filter(Boolean))].slice(0, 8);
  try { fs.rmSync(OUT_HTML, { force: true }); } catch (e) {}
  let vizCtx =
    `\n\n---\n## 이번 논문 (컨텍스트)\n- 제목: ${analysis.title || rec.title}\n` +
    `- 원문 PDF: pdfs/${HASH}.pdf (${pageCount}페이지) — Read로 필요한 범위만 읽어라.\n` +
    `- 한 줄 요약: ${(analysis.one_liner || "").slice(0, 200)}\n- <OUTPUT_PATH> = ${OUT_HTML}\n  → 완성 HTML을 이 절대경로에 Write하라.\n` +
    `- 자가검증: \`node scripts/verify_mviz.js ${OUT_HTML} --json\` 를 pass:true까지 반복(최대 5회).\n작업 디렉터리는 저장소 루트다.` +
    `\n\n## 읽기 힌트(P6)\n- 방법론/overview figure 위치: ${sectionRef || "(캡션 검색)"}\n` + (figPages.length ? `- figure 페이지: ${figPages.join(", ")}\n` : "") +
    `\n\n## method_steps 재사용(P4 — 재생성 금지, 그대로 응답에 넣어라)\n\`\`\`json\n${JSON.stringify(steps).slice(0, 4000)}\n\`\`\`` +
    `\n\n## 재시도(P5)\n verify 위반은 Edit로 부분 수정.`;
  const a2 = await runQuery(METHOD_VIZ_HTML_GEN + vizCtx, SYSTEM_PROMPT_MINI, ["Read", "Write", "Bash", "WebSearch"], ROOT, "HTML시각화");
  let verify = { pass: false };
  if (fs.existsSync(OUT_HTML)) { verify = await runVerify(OUT_HTML); analysis.method_viz_html = fs.readFileSync(OUT_HTML, "utf8"); }
  try { const meta = parseModelJson(a2.raw); if (Array.isArray(meta.method_steps) && meta.method_steps.length) analysis.method_steps = meta.method_steps; } catch (e) {}

  fs.writeFileSync(OUT_JSON, JSON.stringify(analysis));
  const totalCost = (a1.cost || 0) + (a2.cost || 0);
  console.log(`\n===== 완료 =====`);
  console.log(`섹션: ${Object.keys(analysis).filter(k => analysis[k] && (Array.isArray(analysis[k]) ? analysis[k].length : true)).join(", ")}`);
  console.log(`method_viz_html: ${(analysis.method_viz_html || "").length}B · verify ${verify.pass ? "통과" : "실패"}`);
  console.log(`총 비용: $${totalCost.toFixed(3)} (분석 $${(a1.cost || 0).toFixed(3)} + 시각화 $${(a2.cost || 0).toFixed(3)})`);
  console.log(`저장: ${OUT_JSON}`);
})().catch((e) => { console.error("오류:", e.message); process.exit(1); });
