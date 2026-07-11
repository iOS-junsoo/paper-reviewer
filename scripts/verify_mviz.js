#!/usr/bin/env node
/**
 * verify_mviz.js — 방법론 시각화 HTML(viz_guideline.md 산출물) 자동 검증기.
 * §8.2 동적 기하검사 + §9 함정 대조를 headless Chrome(puppeteer-core + 시스템 Chrome)으로 실측한다.
 *
 * 사용법: node .claude/verify_mviz.js <file.html> [--screenshot out.png] [--json]
 * 종료코드: 위반 0 → 0, 위반 있으면 → 1. --json이면 결과 JSON을 stdout에 출력.
 *
 * 검사 항목:
 *   [정적/§8.1] drill 금지, 필수 id(flowpath 등), 존 수==스텝 수
 *   [동적/§8.2] JS 콘솔·페이지 에러 0, SVG 텍스트 상호 겹침, viewBox 이탈,
 *              막대 display:inline(폭 무시) 버그, 슬라이더 사영(死), 전 스텝 순회 렌더
 *   [함정/§9]  #1 inline 막대, #10 전 스텝 실측(스텝별 에러·빈 렌더)
 * 좌표=점수(#6)·baseline 성장(#3) 등 의미적 함정은 육안(§8.3) 몫 — 여기선 기계적 검사만.
 */
const fs = require("fs");
const path = require("path");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv) {
  const a = { file: null, screenshot: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--screenshot") a.screenshot = argv[++i];
    else if (argv[i] === "--json") a.json = true;
    else if (!a.file) a.file = argv[i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) { console.error("사용법: node verify_mviz.js <file.html> [--screenshot out.png] [--json]"); process.exit(2); }
  const abs = path.resolve(args.file);
  if (!fs.existsSync(abs)) { console.error("파일 없음: " + abs); process.exit(2); }
  const html = fs.readFileSync(abs, "utf8");

  const violations = [];
  const v = (rule, detail, extra) => violations.push(Object.assign({ rule, detail }, extra || {}));

  // ── 정적 검사 (브라우저 전) ──
  if (/\bdrill/i.test(html.replace(/drill[-_ ]?down/gi, (m) => m))) {
    // 'drill'/'DRILL' 문자열 금지 (드릴인 금지 확인). 'drilldown' 포함 모든 변형.
    if (/drill/i.test(html)) v("§9.static drill_banned", "HTML에 'drill' 문자열 존재 — 드릴인 금지 위반");
  }

  const puppeteer = require("puppeteer-core");
  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto("file://" + abs, { waitUntil: "networkidle0", timeout: 30000 });
    // rAF·2단계 애니메이션·폰트 정착 대기
    await new Promise((r) => setTimeout(r, 1200));

    // ── 동적 검사 (in-page) ──
    const report = await page.evaluate(() => {
      const out = { violations: [], metrics: {} };
      const push = (rule, detail, extra) => out.violations.push(Object.assign({ rule, detail }, extra || {}));
      const rectsOverlap = (a, b) => {
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return ix * iy;
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        if (parseFloat(cs.opacity) === 0) return false;
        return true;
      };

      // 필수 구성: 스테퍼 점(dot), 스텝, 존
      const dots = [...document.querySelectorAll(".dot")];
      // 존 개수 = 고유 data-zone 값 수. 한 존을 여러 g가 공유해 함께 하이라이트하는 것은 허용(§2.3).
      const zoneEls = [...document.querySelectorAll("[data-zone]")];
      const zoneVals = new Set(zoneEls.map((z) => z.getAttribute("data-zone")).filter((v) => v != null && v !== ""));
      out.metrics.dots = dots.length;
      out.metrics.zones = zoneVals.size;
      out.metrics.zone_elements = zoneEls.length;
      // 고유 존 수 == 스텝 수. zone 기반 하이라이트를 쓰는 경우만(고유존>=2).
      // T6/T8처럼 phase 기반(고유존 0~1)은 다른 하이라이트 메커니즘이라 예외.
      if (zoneVals.size >= 2 && dots.length && zoneVals.size !== dots.length) {
        push("§2.3 zone_step_mismatch", `고유 존 ${zoneVals.size} != 스텝(dot) ${dots.length}`);
      }

      // 텍스트 상호 겹침 (SVG text, 화면좌표 실측)
      const texts = [...document.querySelectorAll("svg text")].filter(visible)
        .filter((t) => (t.textContent || "").trim().length > 0);
      let overlapPairs = 0;
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const ra = texts[i].getBoundingClientRect(), rb = texts[j].getBoundingClientRect();
          const ov = rectsOverlap(ra, rb);
          if (ov <= 0) continue;
          const minA = Math.min(ra.width * ra.height, rb.width * rb.height);
          if (minA > 0 && ov / minA > 0.45) {
            overlapPairs++;
            if (overlapPairs <= 6) push("§8.2 text_overlap", `"${(texts[i].textContent || "").trim().slice(0, 14)}" ↔ "${(texts[j].textContent || "").trim().slice(0, 14)}" 겹침 ${(ov / minA * 100).toFixed(0)}%`);
          }
        }
      }
      out.metrics.text_overlap_pairs = overlapPairs;

      // viewBox 이탈: 각 SVG의 자식 text가 SVG 렌더박스를 벗어나는지 (여유 4px)
      let overflow = 0;
      document.querySelectorAll("svg").forEach((svg) => {
        const sr = svg.getBoundingClientRect();
        if (sr.width < 1) return;
        svg.querySelectorAll("text").forEach((t) => {
          if (!visible(t)) return;
          const r = t.getBoundingClientRect();
          if (r.left < sr.left - 4 || r.right > sr.right + 4 || r.top < sr.top - 4 || r.bottom > sr.bottom + 4) {
            overflow++;
            if (overflow <= 6) push("§8.2 viewbox_overflow", `텍스트 "${(t.textContent || "").trim().slice(0, 14)}" SVG 경계 이탈`);
          }
        });
      });
      out.metrics.viewbox_overflow = overflow;

      // #1 inline 막대: width/height 스타일이 있는데 display가 inline이라 폭 무시된 요소
      let inlineBars = 0;
      document.querySelectorAll('[style*="width"],[style*="height"]').forEach((el) => {
        const cs = getComputedStyle(el);
        if (el.tagName === "SPAN" && (cs.display === "inline")) {
          const styleW = el.style.width, styleH = el.style.height;
          if ((styleW && styleW !== "auto" && styleW !== "0px") || (styleH && styleH !== "auto" && styleH !== "0px")) {
            const r = el.getBoundingClientRect();
            // inline span에 width가 있는데 실제로 반영 안 됨(막대 후보)
            if ((styleW && r.width < 2) || (styleH && r.height < 2)) {
              inlineBars++;
              if (inlineBars <= 6) push("§9.1 inline_bar", `span에 width/height(${styleW || styleH})가 있으나 display:inline이라 무시됨(막대 렌더 실패)`);
            }
          }
        }
      });
      out.metrics.inline_bars = inlineBars;

      out.metrics.sliders = document.querySelectorAll('input[type="range"]').length;
      out.metrics.svg_count = document.querySelectorAll("svg").length;
      return out;
    });
    report.violations.forEach((x) => violations.push(x));
    const metrics = report.metrics;

    // ── 인터랙션: 슬라이더 사영 검사 (값 바꾸면 무언가 바뀌어야) ──
    const sliderResult = await page.evaluate(async () => {
      const res = { dead: [], count: 0 };
      const sliders = [...document.querySelectorAll('input[type="range"]')];
      res.count = sliders.length;
      const snapshot = () => {
        // 페이지 시각 상태 서명: SVG 도형 기하 + 지표 텍스트 내용(슬라이더가 숫자만 바꾸는 T8/T9 대응)
        let sig = 0;
        document.querySelectorAll("svg rect, svg circle, svg path, svg line, svg ellipse, svg polygon, svg polyline, .mbar, .lbar, .bar").forEach((e) => {
          const r = e.getBoundingClientRect(); sig += r.width * 1.7 + r.height * 2.3 + r.left * 0.11 + r.top * 0.13;
          const w = e.getAttribute && (e.getAttribute("width") || e.getAttribute("x2") || e.getAttribute("d") || ""); if (w) for (let k = 0; k < String(w).length; k++) sig += String(w).charCodeAt(k) * 0.003;
        });
        // 지표·값 텍스트 변화 반영
        document.querySelectorAll("svg text, .metric .v, .mval, .gap-val, .ro .v, .stat .v, [id^='m-'], [id^='st-'], [id^='ro-']").forEach((e) => {
          const s = (e.textContent || ""); for (let k = 0; k < s.length; k++) sig += s.charCodeAt(k) * 0.019;
        });
        return sig;
      };
      for (const s of sliders) {
        const before = snapshot();
        const min = parseFloat(s.min || "0"), max = parseFloat(s.max || "1");
        s.value = String(min); s.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const mid = snapshot();
        s.value = String(max); s.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const after = snapshot();
        if (Math.abs(after - before) < 0.5 && Math.abs(mid - before) < 0.5) {
          res.dead.push(s.id || s.getAttribute("aria-label") || "(무명 슬라이더)");
        }
      }
      return res;
    });
    sliderResult.dead.forEach((id) => violations.push({ rule: "§8.2 slider_dead", detail: `슬라이더 '${id}' 조작해도 시각 변화 없음(binds 누락 의심)` }));

    // ── 전 스텝 순회: 각 스텝 렌더 확인(#10) ──
    const stepResult = await page.evaluate(async () => {
      const res = { steps: 0, emptyJourney: 0, jerrors: 0 };
      const next = [...document.querySelectorAll("button")].find((b) => /다음|▶|next/i.test(b.textContent || ""));
      const dots = [...document.querySelectorAll(".dot")];
      const n = dots.length || 6;
      res.steps = n;
      const journeySel = "#j-viz, #j-desc, #j-body, .col-journey, .col-case, .col-explain";
      for (let i = 0; i < n; i++) {
        if (dots[i]) dots[i].click(); else if (next) next.click();
        await new Promise((r) => setTimeout(r, 220));
        const j = document.querySelector("#j-desc, #j-title, #j-body");
        if (j && (j.textContent || "").trim().length < 2) res.emptyJourney++;
      }
      return res;
    });
    if (stepResult.emptyJourney > 0) violations.push({ rule: "§9.10 empty_step", detail: `${stepResult.emptyJourney}개 스텝에서 여정 패널이 비어 렌더됨` });

    // raw LaTeX 노출: 독립 HTML엔 KaTeX가 없어 $...$ 소스가 화면에 그대로 보인다.
    // (달러 금액 오탐 방지: $ 뒤가 숫자로 시작하는 매치는 제외 — "$5,000" 등)
    const rawLatex = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const hits = [];
      const re = /\$([^$\n]{1,60})\$|\\\(([^)\n]{1,60})\\\)/g;
      let m;
      while ((m = re.exec(text)) && hits.length < 8) {
        const inner = m[1] ?? m[2] ?? "";
        if (/^\s*[\d,.]+\s*$/.test(inner)) continue; // 금액/숫자
        hits.push(m[0].slice(0, 40));
      }
      return hits;
    });
    if (rawLatex.length) {
      violations.push({ rule: "§7 raw_latex", detail: `LaTeX 소스가 화면에 노출됨(KaTeX 없음 — sub/sup·유니코드로 바꿔라) ${rawLatex.length}건: ${rawLatex.slice(0, 3).join(" · ")}` });
    }

    // 콘솔·페이지 에러
    if (pageErrors.length) violations.push({ rule: "§8.2 page_error", detail: `페이지 JS 에러 ${pageErrors.length}건: ${pageErrors.slice(0, 3).join(" | ").slice(0, 200)}` });
    if (consoleErrors.length) violations.push({ rule: "§8.2 console_error", detail: `콘솔 에러 ${consoleErrors.length}건: ${consoleErrors.slice(0, 3).join(" | ").slice(0, 200)}` });

    if (args.screenshot) {
      await page.evaluate(() => { const d = [...document.querySelectorAll(".dot")]; if (d[0]) d[0].click(); });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: path.resolve(args.screenshot), fullPage: true });
    }

    const result = { file: abs, pass: violations.length === 0, violations, metrics: Object.assign({}, metrics, { sliders: sliderResult.count, steps: stepResult.steps, page_errors: pageErrors.length, console_errors: consoleErrors.length }) };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`\n=== verify_mviz: ${path.basename(abs)} ===`);
      console.log(`판정: ${result.pass ? "✅ 통과" : "❌ 위반 " + violations.length + "건"}`);
      violations.forEach((x) => console.log(`  · [${x.rule}] ${x.detail}`));
      console.log(`지표: ${JSON.stringify(result.metrics)}`);
    }
    await browser.close();
    process.exit(result.pass ? 0 : 1);
  } catch (e) {
    if (browser) try { await browser.close(); } catch (x) {}
    console.error("검증 실행 오류:", e.message);
    process.exit(2);
  }
}
main();
