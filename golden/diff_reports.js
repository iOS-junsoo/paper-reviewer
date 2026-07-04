#!/usr/bin/env node
// 골든 셋 QA 리포트 diff — 렌더러 수정 전후의 위반 증감·레이아웃 지표 변화를 비교해 회귀를 잡는다.
//
// 사용법:
//   node golden/diff_reports.js <new_reports.json> [baseline.json]
//     · new_reports.json : 이번 렌더러로 골든 셋을 전수 렌더해 수집한 QA 리포트 묶음
//                          (golden/collect.md 참고 — 브라우저에서 수집).
//     · baseline.json    : 비교 기준(생략 시 golden/reports/baseline.json).
//   node golden/diff_reports.js <new_reports.json> --set-baseline
//     · new를 baseline으로 승격(수정이 의도된 개선일 때).
//
// 종료 코드: 회귀가 하나라도 있으면 1(CI 게이트용), 없으면 0.
// 회귀 정의: 위반 증가 / 미해결 증가 / scale 0.05↑ 급감 / hidden_labels 증가 /
//            text_overflow 증가 / spec_validation(강등) 증가 / 모듈·엣지 수 변화.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (!args.length) { console.error("사용법: node golden/diff_reports.js <new_reports.json> [baseline.json | --set-baseline]"); process.exit(2); }
const newPath = args[0];
const setBaseline = args.includes("--set-baseline");
const baselinePath = args[1] && !args[1].startsWith("--") ? args[1] : path.join(__dirname, "reports", "baseline.json");

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.error(`읽기 실패: ${p} — ${e.message}`); process.exit(2); } };
const newReports = read(newPath);

if (setBaseline) { fs.writeFileSync(baselinePath, JSON.stringify(newReports, null, 2)); console.log(`baseline 승격 완료 → ${baselinePath}`); process.exit(0); }

if (!fs.existsSync(baselinePath)) {
  fs.writeFileSync(baselinePath, JSON.stringify(newReports, null, 2));
  console.log(`baseline이 없어 이번 리포트를 baseline으로 확정했습니다 → ${baselinePath}`);
  process.exit(0);
}
const base = read(baselinePath);

const invCount = (rep) => (rep.invariants || []).length;
const unresCount = (rep) => (rep.invariants || []).filter((v) => !v.resolved).length;
const byInv = (rep) => (rep.invariants || []).reduce((a, v) => { a[v.id] = (a[v.id] || 0) + 1; return a; }, {});
const m = (rep) => rep.layout_metrics || {};

let regressions = 0;
const lines = [];
const allKeys = [...new Set([...Object.keys(base), ...Object.keys(newReports)])].sort();

for (const k of allKeys) {
  const b = base[k], n = newReports[k];
  if (!n) { lines.push(`  ✗ ${k}: 새 리포트에서 사라짐 (골든 셋에서 제거?)`); regressions++; continue; }
  if (!b) { lines.push(`  + ${k}: 새로 추가됨 (baseline 없음)`); continue; }
  const deltas = [];
  const dViol = invCount(n) - invCount(b), dUnres = unresCount(n) - unresCount(b);
  const bm = m(b), nm = m(n), dScale = +((nm.scale || 0) - (bm.scale || 0)).toFixed(2);
  const dHidden = (nm.hidden_labels || 0) - (bm.hidden_labels || 0);
  const dOverflow = (nm.text_overflow_count || 0) - (bm.text_overflow_count || 0);
  const dSpecVal = (n.spec_validation || []).length - (b.spec_validation || []).length;
  const dMod = (nm.modules || 0) - (bm.modules || 0), dEdge = (nm.edges || 0) - (bm.edges || 0);
  // 회귀 판정
  const reg = [];
  if (dViol > 0) reg.push(`위반 +${dViol}`);
  if (dUnres > 0) reg.push(`미해결 +${dUnres}`);
  if (dScale <= -0.05) reg.push(`scale ${dScale}(급감)`);
  if (dHidden > 0) reg.push(`hidden_labels +${dHidden}`);
  if (dOverflow > 0) reg.push(`text_overflow +${dOverflow}`);
  if (dSpecVal > 0) reg.push(`강등 +${dSpecVal}`);
  if (dMod !== 0) reg.push(`모듈 ${dMod > 0 ? "+" : ""}${dMod}`);
  if (dEdge !== 0) reg.push(`엣지 ${dEdge > 0 ? "+" : ""}${dEdge}`);
  // 개선/변화(회귀 아님)
  const impr = [];
  if (dViol < 0) impr.push(`위반 ${dViol}`);
  if (dScale >= 0.05) impr.push(`scale +${dScale}`);
  if (dHidden < 0) impr.push(`hidden ${dHidden}`);
  const bi = byInv(b), ni = byInv(n), invIds = [...new Set([...Object.keys(bi), ...Object.keys(ni)])].sort();
  const invDelta = invIds.map((id) => { const d = (ni[id] || 0) - (bi[id] || 0); return d ? `${id}${d > 0 ? "+" : ""}${d}` : null; }).filter(Boolean).join(" ");
  if (reg.length) { regressions++; lines.push(`  ✗ ${k}: ⚠️ 회귀 [${reg.join(", ")}]${invDelta ? "  (" + invDelta + ")" : ""}`); }
  else if (impr.length || invDelta) lines.push(`  ~ ${k}: 변화 [${impr.join(", ") || "위반 구성 변화"}]${invDelta ? "  (" + invDelta + ")" : ""}`);
  else lines.push(`  = ${k}: 동일 (위반 ${invCount(n)}·미해결 ${unresCount(n)}·scale ${nm.scale})`);
}

console.log(`\n=== 골든 셋 QA diff : ${path.basename(newPath)} vs ${path.basename(baselinePath)} ===`);
lines.forEach((l) => console.log(l));
const totBase = Object.values(base).reduce((a, r) => a + invCount(r), 0), totNew = Object.values(newReports).reduce((a, r) => a + invCount(r), 0);
console.log(`\n총 위반 ${totBase} → ${totNew} (${totNew - totBase >= 0 ? "+" : ""}${totNew - totBase}) · 회귀 논문 ${regressions}편`);
console.log(regressions ? "❌ 회귀 감지 — 수정을 재검토하세요." : "✅ 회귀 없음.");
process.exit(regressions ? 1 : 0);
