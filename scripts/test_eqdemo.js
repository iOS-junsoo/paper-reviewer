#!/usr/bin/env node
"use strict";
// 수식 "숫자로 확인" 블록 검증.
//   ① 샌드박스 — 모델이 낸 식을 브라우저에서 실행하므로 허용 토큰 밖은 반드시 막혀야 한다
//   ② 계산 — 단계 연쇄·샘플별 실행·집계가 실제로 맞는 값을 내는지
//   ③ 표기 — 숫자 포맷과 "값을 대입한 식" 문자열
//   node scripts/test_eqdemo.js

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "method-viz.js"), "utf8");
function grab(name, re) {
  const m = src.match(re);
  if (!m) throw new Error(`${name}을(를) method-viz.js에서 찾지 못했습니다`);
  return m[0];
}
const code = [
  grab("DEMO_MATH", /const DEMO_MATH = \[[\s\S]*?\];/),
  grab("DEMO_MATH_SET", /const DEMO_MATH_SET = new Set\(DEMO_MATH\);/),
  grab("compileExpr", /function compileExpr\(expr, vars\) \{[\s\S]*?\n\}/),
  grab("fmtDemo", /function fmtDemo\(v\) \{[\s\S]*?\n\}/),
  grab("fmtPrecise", /function fmtPrecise\(v\) \{[\s\S]*?\n\}/),
  grab("substituteExpr", /function substituteExpr\(expr, scope\) \{[\s\S]*?\n\}/),
  grab("prepareDemo", /function prepareDemo\(demo\) \{[\s\S]*?\n\}/),
  grab("aggregateOf", /function aggregateOf\(kind, nums\) \{[\s\S]*?\n\}/),
  "module.exports = { compileExpr, fmtDemo, fmtPrecise, substituteExpr, prepareDemo, aggregateOf };",
].join("\n");
const M = (() => {
  const m = { exports: {} };
  new Function("module", "exports", code)(m, m.exports);
  return m.exports;
})();

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); pass++; };
const bad = (n, why) => { console.log(`  ❌ ${n}\n     ${why}`); fail++; };
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== ① 샌드박스: 위험한 식은 전부 막힌다 ===");
const VARS = ["sp", "sn", "tau", "pos"];
const ATTACKS = [
  ["네트워크 접근", "fetch('http://evil')"],
  ["전역 객체", "window.location"],
  ["document 접근", "document.cookie"],
  ["globalThis", "globalThis.x"],
  ["생성자 우회", "sp.constructor"],
  ["생성자 호출", "sp.constructor('return 1')()"],
  ["Function 생성", "new Function('return 1')()"],
  ["함수 정의", "function(){return 1}"],
  ["화살표 함수", "(()=>1)()"],
  ["대입", "sp = 1"],
  ["세미콜론 다중 구문", "1; fetch('u')"],
  ["템플릿 리터럴", "`${sp}`"],
  ["배열 인덱싱", "[1,2][sp]"],
  ["대괄호 멤버 접근", "Math['exp'](sp)"],
  ["객체 리터럴", "{a:1}"],
  ["유니코드 이스케이프 우회", "M\\u0061th.exp(sp)"],
  ["백슬래시", "sp \\ sn"],
  ["줄 주석으로 숨기기", "sp //\nfetch('u')"],
  ["블록 주석", "sp /* x */ + 1"],
  ["Math의 없는 멤버", "Math.constructor"],
  ["괄호로 Math 감싸기", "(Math).exp(sp)"],
  ["정의되지 않은 변수", "foo(sp)"],
  ["선언 안 된 입력 변수", "unknownVar + 1"],
  ["프로토타입 접근", "sp.__proto__"],
  ["eval", "eval('1')"],
  ["arguments", "arguments"],
  ["this", "this"],
  ["빈 식", ""],
  ["과도하게 긴 식", "sp+".repeat(150) + "1"],
];
ATTACKS.forEach(([name, expr]) => {
  M.compileExpr(expr, VARS) ? bad(name, `통과됨 — 반드시 막아야 함: ${expr}`) : ok(name);
});

console.log("\n=== ① 샌드박스: 정상 식은 통과하고 값이 맞는다 ===");
const GOOD = [
  ["단순 변수", "sp - sn", { sp: 0.9, sn: 0.2 }, 0.7],
  ["Math 함수", "Math.exp(sp/tau)", { sp: 0.7, tau: 0.07 }, Math.exp(10)],
  ["중첩 Math", "Math.log(Math.exp(sp))", { sp: 2 }, 2],
  ["앞 단계 결과 사용", "pos/(pos+1)", { pos: 3 }, 0.75],
  ["Math 상수", "Math.PI*sp", { sp: 2 }, Math.PI * 2],
  ["음수·괄호", "-(sp-sn)/2", { sp: 1, sn: 3 }, 1],
  ["공백 있는 Math", "Math . sqrt ( sp )", { sp: 16 }, 4],
];
GOOD.forEach(([name, expr, scope, want]) => {
  const f = M.compileExpr(expr, VARS);
  if (!f) return bad(name, `거부됨 — 통과해야 함: ${expr}`);
  const got = f(scope);
  near(got, want) ? ok(`${name} → ${got}`) : bad(name, `값 불일치: ${got} ≠ ${want}`);
});

console.log("\n=== ① 비정상 결과는 null로 (표에 이상값이 실리지 않게) ===");
[["0으로 나눔", "sp/0", { sp: 1 }], ["log(0) = -∞", "Math.log(sp)", { sp: 0 }],
 ["NaN", "Math.sqrt(sp)", { sp: -1 }]].forEach(([name, expr, scope]) => {
  const f = M.compileExpr(expr, VARS);
  f && f(scope) === null ? ok(name) : bad(name, `null이 아님: ${f ? f(scope) : "compile 실패"}`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== ② 계산: InfoNCE 대조 손실을 실제로 풀어본다 ===");
const demo = {
  purpose: "테스트",
  constants: [{ key: "tau", symbol: "\\tau", value: 0.07, meaning: "온도" }],
  inputs: [{ key: "sp", symbol: "s_p", label: "양성" }, { key: "sn", symbol: "s_n", label: "음성" }],
  steps: [
    { key: "pos", label: "양성 지수화", latex: "e^{s_p/\\tau}", compute: "Math.exp(sp/tau)" },
    { key: "neg", label: "음성 지수화", latex: "e^{s_n/\\tau}", compute: "Math.exp(sn/tau)" },
    { key: "prob", label: "확률", latex: "\\frac{pos}{pos+neg}", compute: "pos/(pos+neg)" },
    { key: "loss", label: "손실", latex: "-\\log(prob)", compute: "-Math.log(prob)" },
  ],
  result: { key: "loss", symbol: "\\mathcal{L}", label: "손실" },
  samples: [
    { name: "확실히 맞음", group: "쉬움", values: { sp: 0.95, sn: 0.10 } },
    { name: "잘 맞음", group: "쉬움", values: { sp: 0.90, sn: 0.20 } },
    { name: "애매함", group: "어려움", values: { sp: 0.55, sn: 0.50 } },
    { name: "거의 같음", group: "어려움", values: { sp: 0.52, sn: 0.51 } },
  ],
  walkthrough: 0,
  aggregate: "mean",
};
const D = M.prepareDemo(demo);
if (!D) {
  bad("prepareDemo", "null 반환 — 준비 자체가 실패");
} else {
  ok(`prepareDemo 성공 — 유효 샘플 ${D.valid.length}개, 단계 ${D.steps.length}개`);

  // 손으로 계산한 기댓값과 대조
  const tau = 0.07;
  const expect = (sp, sn) => {
    const p = Math.exp(sp / tau), n = Math.exp(sn / tau);
    return -Math.log(p / (p + n));
  };
  demo.samples.forEach((s, i) => {
    const want = expect(s.values.sp, s.values.sn);
    const got = D.runs[i].result;
    near(got, want) ? ok(`  ${s.name}: ℒ = ${got.toFixed(6)}`)
                    : bad(`  ${s.name}`, `${got} ≠ ${want}`);
  });

  // 단계 연쇄가 실제로 이어졌는지 (prob는 pos·neg를 써야 한다)
  const t = D.walk.trace;
  const w = demo.samples[0].values;
  near(t[0].value, Math.exp(w.sp / tau)) ? ok("  1단계 pos 정확") : bad("1단계", t[0].value);
  near(t[2].value, t[0].value / (t[0].value + t[1].value)) ? ok("  3단계가 앞 단계 결과를 씀") : bad("3단계", "연쇄 실패");

  // 집계
  const nums = D.valid.map((r) => r.result);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  near(M.aggregateOf("mean", nums), mean) ? ok(`  평균 = ${mean.toFixed(6)}`) : bad("평균", "불일치");
  near(M.aggregateOf("sum", [1, 2, 3]), 6) ? ok("  합") : bad("합", "불일치");
  near(M.aggregateOf("max", [1, 5, 3]), 5) ? ok("  최댓값") : bad("최댓값", "불일치");
  near(M.aggregateOf("min", [1, 5, 3]), 1) ? ok("  최솟값") : bad("최솟값", "불일치");

  // 성향별로 실제로 갈리는지 — 이 기능의 핵심 주장
  const easy = D.valid.filter((r) => r.sample.group === "쉬움").map((r) => r.result);
  const hard = D.valid.filter((r) => r.sample.group === "어려움").map((r) => r.result);
  const em = easy.reduce((a, b) => a + b, 0) / easy.length;
  const hm = hard.reduce((a, b) => a + b, 0) / hard.length;
  hm > em ? ok(`  성향별 차이: 쉬움 ${em.toExponential(2)} < 어려움 ${hm.toFixed(4)}`)
          : bad("성향별 차이", `어려운 쪽 손실이 더 커야 함 (${hm} vs ${em})`);
}

console.log("\n=== ② 잘못된 입력은 블록 자체를 만들지 않는다 ===");
const REJECT = [
  ["null", null],
  ["steps 없음", { inputs: [{ key: "a" }], samples: [{ values: { a: 1 } }, { values: { a: 2 } }] }],
  ["inputs 없음", { steps: [{ key: "s", compute: "1" }], samples: [{ values: {} }, { values: {} }] }],
  ["샘플 1개", { inputs: [{ key: "a" }], steps: [{ key: "s", compute: "a" }], samples: [{ values: { a: 1 } }] }],
  ["위험한 compute", { inputs: [{ key: "a" }], steps: [{ key: "s", compute: "fetch(a)" }],
                       samples: [{ values: { a: 1 } }, { values: { a: 2 } }] }],
  ["뒤 단계를 앞에서 참조", { inputs: [{ key: "a" }],
      steps: [{ key: "s1", compute: "s2+1" }, { key: "s2", compute: "a" }],
      samples: [{ values: { a: 1 } }, { values: { a: 2 } }] }],
  ["키가 식별자가 아님", { inputs: [{ key: "a b" }], steps: [{ key: "s", compute: "1" }],
                          samples: [{ values: {} }, { values: {} }] }],
  ["샘플 값이 숫자가 아님", { inputs: [{ key: "a" }], steps: [{ key: "s", compute: "a" }],
      samples: [{ values: { a: "x" } }, { values: { a: "y" } }] }],
];
REJECT.forEach(([name, d]) => {
  M.prepareDemo(d) ? bad(name, "블록이 만들어짐 — 거부해야 함") : ok(name);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== ③ 표기 ===");
[[0, "0"], [8, "8"], [1024, "1024"], [0.5, "0.5000"], [3.14159, "3.142"],
 [1234.5678, "1234.57"], [1e-6, "1.00e-6"], [5e7, "5.00e+7"], [null, "—"], [NaN, "—"]]
  .forEach(([v, want]) => {
    const got = M.fmtDemo(v);
    got === want ? ok(`fmtDemo(${v}) = "${got}"`) : bad(`fmtDemo(${v})`, `"${got}" ≠ "${want}"`);
  });

const subCases = [
  ["Math.exp(sp/tau)", { sp: 0.95, tau: 0.07 }, "exp(0.95 / 0.07)"],
  ["pos/(pos+neg)", { pos: 2, neg: 3 }, "2 / (2 + 3)"],
  ["-Math.log(prob)", { prob: 0.5 }, "- log(0.5)"],
];
subCases.forEach(([expr, scope, want]) => {
  const got = M.substituteExpr(expr, scope);
  got === want ? ok(`대입식: ${got}`) : bad(`대입식 ${expr}`, `"${got}" ≠ "${want}"`);
});

console.log("\n=== ③ 대입식 정밀도 — 표시된 값으로 재계산해도 결과가 맞아야 한다 ===");
[[0.95, "0.95"], [0.07, "0.07"], [2, "2"], [0, "0"], [0.5, "0.5"],
 [783423.3966, "783423.4"], [0.9999946734, "0.99999467"]].forEach(([v, want]) => {
  const got = M.fmtPrecise(v);
  got === want ? ok(`fmtPrecise(${v}) = "${got}"`) : bad(`fmtPrecise(${v})`, `"${got}" ≠ "${want}"`);
});
{
  // 실제로 겪은 버그: 확률을 1.0000으로 반올림해 "- log(1.0000) = 5.33e-6"처럼
  // 계산이 틀려 보였다. 표시된 값으로 되짚어도 결과가 맞는지 확인한다.
  const tau = 0.07, sp = 0.95, sn = 0.10;
  const pos = Math.exp(sp / tau), neg = Math.exp(sn / tau);
  const prob = pos / (pos + neg), loss = -Math.log(prob);
  const shown = Number(M.fmtPrecise(prob));
  const re = -Math.log(shown);
  Math.abs(re - loss) / loss < 0.01
    ? ok(`연쇄 일관성: -log(${M.fmtPrecise(prob)}) = ${re.toExponential(3)} ≈ 실제 ${loss.toExponential(3)}`)
    : bad("연쇄 일관성", `표시값 재계산 ${re.toExponential(3)} vs 실제 ${loss.toExponential(3)}`);
  M.fmtPrecise(prob) !== "1" && M.fmtPrecise(prob) !== "1.0000"
    ? ok("1에 가까운 확률이 1로 뭉개지지 않는다")
    : bad("반올림", `"${M.fmtPrecise(prob)}"로 뭉개짐`);
}

console.log(`\n════ 통과 ${pass} · 실패 ${fail} ════`);
process.exit(fail ? 1 : 0);
