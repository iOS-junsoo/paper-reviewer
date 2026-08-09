#!/usr/bin/env node
"use strict";
// 수식 "숫자로 확인" 블록의 식 검사기 검증.
// 모델이 낸 문자열을 브라우저에서 실행하므로, 허용 토큰 밖의 것은 반드시 막혀야 한다.
//   node scripts/test_eqdemo.js

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "method-viz.js"), "utf8");
function grab(name, pattern) {
  const m = src.match(pattern);
  if (!m) throw new Error(`${name}을(를) method-viz.js에서 찾지 못했습니다`);
  return m[0];
}
const code =
  grab("DEMO_ALLOWED", /const DEMO_ALLOWED = new Set\(\[[\s\S]*?\]\);/) +
  "\n" +
  grab("compileDemo", /function compileDemo\(expr\) \{[\s\S]*?\n\}/) +
  "\n" +
  grab("fmtDemo", /function fmtDemo\(v\) \{[\s\S]*?\n\}/) +
  "\nmodule.exports = { compileDemo, fmtDemo };";
const { compileDemo, fmtDemo } = (() => {
  const m = { exports: {} };
  new Function("module", "exports", code)(m, m.exports);
  return m.exports;
})();

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); pass++; };
const bad = (n, why) => { console.log(`  ❌ ${n} — ${why}`); fail++; };

function accepts(name, expr, x, expected) {
  const f = compileDemo(expr);
  if (!f) return bad(name, "거부됨 (통과해야 함)");
  const got = f(x);
  if (expected !== undefined && Math.abs(got - expected) > 1e-9) {
    return bad(name, `값 불일치: ${got} ≠ ${expected}`);
  }
  ok(`${name}  →  ${got}`);
}
function rejects(name, expr) {
  compileDemo(expr) ? bad(name, "통과됨 (막아야 함)") : ok(name);
}

console.log("\n=== 정상 식은 계산된다 ===");
accepts("제곱근 (스케일링 계수)", "Math.sqrt(x)", 64, 8);
accepts("시그모이드", "1/(1+Math.exp(-x))", 0, 0.5);
accepts("교차엔트로피 항", "-Math.log(x)", 1, 0);
accepts("softmax 온도 효과", "Math.exp(1/x)/(Math.exp(1/x)+2)", 1, Math.E / (Math.E + 2));
accepts("상수·연산자 조합", "(x*2+1)/3 - 0.5", 4, (4 * 2 + 1) / 3 - 0.5);
accepts("Math.pow / PI", "Math.pow(x,2)*Math.PI", 2, 4 * Math.PI);

console.log("\n=== 위험하거나 잘못된 식은 막는다 ===");
rejects("네트워크 접근", "fetch('http://evil')");
rejects("전역 객체", "window.location");
rejects("document 접근", "document.cookie");
rejects("생성자 우회", "x.constructor");
rejects("함수 정의", "function(){return 1}");
rejects("화살표 함수", "(()=>1)()");
rejects("대입", "x = 1");
rejects("세미콜론(다중 구문)", "1; fetch('u')");
rejects("템플릿 리터럴", "`${x}`");
rejects("인덱싱", "[1,2][x]");
rejects("정의되지 않은 식별자", "foo(x)");
rejects("빈 문자열", "");
rejects("과도하게 긴 식", "x+".repeat(120) + "1");
rejects("숫자를 내지 않는 식", "'문자열'");

console.log("\n=== 값 표기 ===");
const fmtCases = [
  [0, "0"], [8, "8"], [1024, "1024"],
  [0.5, "0.5000"], [3.14159, "3.142"], [1234.5678, "1234.57"],
  [1e-6, "1.00e-6"], [5e7, "5.00e+7"], [null, "—"],
];
fmtCases.forEach(([v, want]) => {
  const got = fmtDemo(v);
  got === want ? ok(`fmtDemo(${v}) = "${got}"`) : bad(`fmtDemo(${v})`, `"${got}" ≠ "${want}"`);
});

console.log(`\n════ 통과 ${pass} · 실패 ${fail} ════`);
process.exit(fail ? 1 : 0);
