#!/usr/bin/env node
"use strict";
// lib/jsonrepair.js 검증 — 실제로 관측된 실패 유형을 재현해 고쳐지는지 확인한다.
//   node scripts/test_jsonrepair.js

const { parseLenient, extractJsonObject } = require("../lib/jsonrepair");

let pass = 0, fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    fail++;
  }
}
function eq(a, b, what) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${what || "값 불일치"}\n     기대: ${sb}\n     실제: ${sa}`);
}

console.log("\n=== 정상 입력은 건드리지 않는다 ===");

check("평범한 JSON → strict", () => {
  const r = parseLenient('{"title":"X","year":2025}');
  eq(r.stage, "strict");
  eq(r.data.title, "X");
});

check("```json 펜스 제거", () => {
  const r = parseLenient('```json\n{"title":"X"}\n```');
  eq(r.data.title, "X");
});

check("문자열 안의 중괄호를 깊이로 세지 않는다 (LaTeX)", () => {
  const r = parseLenient('{"latex":"\\\\mathcal{L} = \\\\sum_{t=1}^{T}","ok":true}');
  eq(r.stage, "strict");
  eq(r.data.latex, "\\mathcal{L} = \\sum_{t=1}^{T}");
});

check("이스케이프된 따옴표가 있는 정상 문자열", () => {
  const r = parseLenient('{"q":"he said \\"hi\\" then left","n":1}');
  eq(r.stage, "strict");
  eq(r.data.q, 'he said "hi" then left');
});

console.log("\n=== 실측 오류 ① 문자열 안 이스케이프 안 된 따옴표 ===");

check('"Expected \',\' or \'}\' after property value" 재현 → 복구', () => {
  const broken = '{"title":"X","explanation":"저자들은 "attention"을 쓴다","year":2025}';
  // 먼저 순정 파서가 실제로 그 오류를 내는지 확인 (테스트가 현실을 반영하는지 검증)
  let msg = "";
  try { JSON.parse(broken); } catch (e) { msg = e.message; }
  if (!/Expected ',' or '}' after property value/.test(msg)) {
    throw new Error(`재현 실패 — 실제 오류: ${msg}`);
  }
  const r = parseLenient(broken);
  eq(r.stage, "repair");
  eq(r.data.explanation, '저자들은 "attention"을 쓴다');
  eq(r.data.year, 2025);
});

check('"Expected \',\' or \']\' after array element" 재현 → 복구', () => {
  const broken = '{"items":["하나","둘 "인용" 셋","넷"]}';
  let msg = "";
  try { JSON.parse(broken); } catch (e) { msg = e.message; }
  if (!/Expected ',' or '\]' after array element/.test(msg)) {
    throw new Error(`재현 실패 — 실제 오류: ${msg}`);
  }
  const r = parseLenient(broken);
  eq(r.data.items, ["하나", '둘 "인용" 셋', "넷"]);
});

console.log("\n=== 그 밖의 흔한 오류 ===");

check("무효한 이스케이프 (\\mathcal — 백슬래시 하나)", () => {
  const r = parseLenient('{"latex":"\\mathcal{L}"}');
  eq(r.data.latex, "\\mathcal{L}");
});

check("트레일링 콤마", () => {
  const r = parseLenient('{"a":1,"b":[1,2,],}');
  eq(r.data.b, [1, 2]);
});

check("문자열 안의 생 줄바꿈", () => {
  const r = parseLenient('{"note":"첫 줄\n둘째 줄"}');
  eq(r.data.note, "첫 줄\n둘째 줄");
});

check("앞뒤에 잡설이 붙은 경우", () => {
  const r = parseLenient('네, 분석했습니다:\n{"title":"X"}\n도움이 되었길 바랍니다.');
  eq(r.data.title, "X");
});

console.log("\n=== 위험 케이스: 앞부분이 잘려 나간 응답 ===");

check("중간부터 시작한 응답에서 조각을 통짜 결과로 착각하지 않는다", () => {
  // 실제 관측된 형태 — 응답이 JSON 중간부터 시작한다
  const truncated =
    '128개, 64개"},{"symbol":"d","meaning":"은닉 차원"}]},{"latex":"\\\\mathcal{L}","paper_page":6}';
  let got = null;
  try { got = parseLenient(truncated).data; } catch (e) { got = null; }
  // 파싱이 되더라도 조각일 뿐이므로 title이 없어야 한다 → 호출부의 필수 필드 검사가 걸러낸다
  if (got && got.title) throw new Error("조각인데 title이 생겼다 — 검사가 무의미해진다");
  console.log(`     (참고: 조각 파싱 결과 = ${got ? JSON.stringify(got).slice(0, 60) : "실패"})`);
});

check("extractJsonObject는 가장 긴 균형 객체를 고른다", () => {
  const s = 'noise {"a":1} more {"b":{"c":2},"d":"}"} tail';
  const got = extractJsonObject(s);
  eq(JSON.parse(got), { b: { c: 2 }, d: "}" });
});

console.log(`\n════ 통과 ${pass} · 실패 ${fail} ════`);
process.exit(fail ? 1 : 0);
