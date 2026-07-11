/**
 * lib/figurebox.js — 그림 해설 크롭 박스 결정 (계획 1: "추론"에서 "실측"으로)
 *
 * 모델이 찍은 bbox(부정확)를 힌트로만 쓰고, 그림의 실체를 직접 측정한다:
 *   Layer 1  imageAnchoredBox — pdftohtml -xml의 임베디드 이미지 좌표 실측 (래스터 그림)
 *   Layer 2  inkAnchoredBox   — pdftoppm 저해상 PGM + 단어 마스킹 + 행 잉크 밀도 (벡터 그림)
 *   Layer 3  textScanBox      — 기존 캡션 앵커 텍스트 줄 간격 스캔 (표 전용 + 최종 폴백)
 *   Layer 4  sanityAdjust     — 결과 백지·가장자리 절단 검사 + 넓은 폴백/확장
 *
 * 라우팅: Table → L3 → 모델 bbox / Figure → L1 → L2 → L3 → 모델 bbox. 공통으로
 * 이웃 캡션 블록 차단 + 캡션 블록 포함. mode:"legacy"는 개선 전(캡션 텍스트 스캔만)
 * 동작을 재현한다 — scripts/figure_crop_report.js의 before/after 비교용.
 *
 * server.js(/api/figure)와 회귀 하니스가 공유한다. LLM 호출 없음(poppler만).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const clamp01 = (n) => Math.min(Math.max(0, n), 1);
const median = (xs) => {
  const a = xs.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, opts || {}), (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

// label("Table 2", "Figure 1" …) → {type, num}
function parseFigLabel(label) {
  const typeM = String(label || "").match(/[A-Za-z]+/);
  const numM = String(label || "").match(/\d+/);
  if (!typeM || !numM) return null;
  let type = typeM[0].toLowerCase();
  if (type === "fig") type = "figure";
  if (type === "tbl") type = "table";
  return { type, num: numM[0] };
}

// ── 페이지 텍스트 레이어 (pdftotext -bbox) ─────────────────────────────────
async function getWords(pdfPath, page) {
  const xml = await execFileP("pdftotext", ["-bbox", "-f", String(page), "-l", String(page), pdfPath, "-"], {
    timeout: 15000,
    maxBuffer: 24 * 1024 * 1024,
  });
  const words = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let m;
  while ((m = re.exec(xml))) words.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] });
  return words;
}

// 다른 그림/표 캡션 줄: 구두점식("Table 2:", "표 1.") 또는 IEEE 대문자식("TABLE 2" — 구두점 없음).
// 대문자식은 /i 없이 정확히 대문자만 — 본문 "Table 2 shows…"류 줄 시작 인용을 캡션으로 오인하지 않게.
const OTHER_CAP_RE = /^(?:(?:TABLE|FIGURE|FIG\.?)\s*\d+|(?:[Tt]able|[Ff]igure|[Ff]ig\.?|표|그림)\s*\d+\s*[:.])/;

// ── 페이지 분석: 캡션 탐지 + 컬럼 줄(row) 묶기 + 이웃 캡션 블록 ───────────────
// captionAnchoredBox(구 server.js)의 1~3단계를 분리한 것. 캡션을 못 찾아도(cap=null)
// rows/foreignBlocks는 돌려줘 Layer 1의 F4(캡션 미검출) 경로가 쓸 수 있게 한다.
async function analyzePage(pdfPath, page, parsed, modelBox, wpt, hpt) {
  const words = await getWords(pdfPath, page);
  if (!words.length) return null;

  // 대표 줄 높이(중앙값) — 간격(gap) 판정 기준
  const heights = words.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;

  // --- 1) 캡션 라벨 단어 찾기 (줄 시작 + 콜론을 강하게 우선) ---
  let cap = null;
  if (parsed) {
    const cands = [];
    // 저널 스타일 약어 허용: "Fig. 2"(IJCV 등)·"Tab. 1" — figure_guide 라벨은 "Figure 2"라도
    // PDF 본문 캡션은 약어일 수 있다(불일치 시 캡션 미검출 → 캡션 합집합 없이 하단이 어중간해짐).
    const normType = (t) => {
      const n = t.toLowerCase().replace(/\.$/, "");
      if (n === "fig") return "figure";
      if (n === "tab" || n === "tbl") return "table";
      if (n === "표") return "table"; // 한국어 논문 캡션 "표 1."
      if (n === "그림") return "figure"; // 한국어 논문 캡션 "그림 2."
      return n;
    };
    for (let i = 0; i < words.length - 1; i++) {
      if (normType(words[i].t) !== parsed.type) continue;
      const nm = words[i + 1].t.match(/^(\d+)([.:]?)/);
      if (!nm || nm[1] !== parsed.num) continue;
      const w = words[i];
      // 줄 시작 판정: 같은 줄에서 '바로 왼쪽에 인접한' 단어가 있는지만 본다.
      // (기존: 페이지 전체 폭 기준 → 2단 레이아웃에서 오른쪽 컬럼 캡션이
      //  왼쪽 컬럼 텍스트 때문에 항상 탈락 → "Figure 1." 마침표식 캡션 미검출)
      const lineStart = !words.some(
        (o) => o !== w && Math.abs(o.y0 - w.y0) < lineH * 0.6 && o.x1 <= w.x0 + 0.5 && o.x1 > w.x0 - lineH * 1.8
      );
      let score = 0;
      if (nm[2] === ":") score += 3;
      else if (nm[2] === ".") score += 2;
      if (lineStart) score += 3; // 줄 시작 = 캡션(본문 속 'Table 2 provides…' 인용 배제)
      // IEEE 저널 스타일: "TABLE 2"(전부 대문자·구두점 없음·표 위 자체 줄). 본문 인용은
      // "Table 2"라 대문자만으로도 캡션 신호가 된다. 한국어 "표 1."은 유니코드라 대문자 개념 없음.
      if (/^[A-Z]+\.?$/.test(words[i].t) && words[i].t.length >= 3) score += 2;
      cands.push({ w, score, punct: nm[2] });
    }
    if (cands.length) {
      const modelCY = ((modelBox[1] + modelBox[3]) / 2) * hpt;
      cands.sort((a, b) => b.score - a.score || Math.abs(a.w.y0 - modelCY) - Math.abs(b.w.y0 - modelCY));
      // 채택 기준: 줄 시작 + 구두점(5·6점), 또는 콜론 단독(사이드 캡션).
      // 구두점 없는 줄 시작(3점)은 본문 "Figure 1 shows…"류 오탐이라 거부 —
      // lineStart가 인접 단어 기준으로 완화된 만큼 여기서 되조인다.
      if (cands[0].score >= 5 || cands[0].punct === ":") cap = cands[0];
    }
  }

  // --- 2) 캡션(또는 모델 박스)이 속한 컬럼의 단어만 모아 '줄(row)' 단위로 묶기 ---
  const mid = wpt / 2;
  let colMin = (cap ? Math.min(modelBox[0] * wpt, cap.w.x0) : modelBox[0] * wpt) - 0.02 * wpt;
  let colMax = (cap ? Math.max(modelBox[2] * wpt, cap.w.x1) : modelBox[2] * wpt) + 0.03 * wpt;
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

  // 캡션 라벨 줄부터 아래로 이어지는 캡션 블록(여러 줄)을 실측
  const capBlockFrom = (idx) => {
    let top = rows[idx].top, bottom = rows[idx].bottom, end = idx, xL = rows[idx].xL, xR = rows[idx].xR;
    for (let j = idx + 1; j < rows.length; j++) {
      const r = rows[j];
      if (r.top - bottom > lineH * 1.0) break; // 캡션 줄 간격보다 크면 끝(다음 블록)
      if (OTHER_CAP_RE.test(r.text)) break; // 다음 그림/표 캡션
      if (r.bottom - top > 0.17 * hpt) break; // 너무 길면 본문 흡수 방지
      bottom = r.bottom; end = j; xL = Math.min(xL, r.xL); xR = Math.max(xR, r.xR);
    }
    return { top, bottom, end, xL, xR };
  };

  // --- 3) 우리 캡션 블록 + 페이지 내 다른 그림/표 캡션 블록(이웃 침범 차단용) ---
  let ci = -1, capBlock = null;
  if (cap) {
    ci = rows.findIndex((r) => r.words.includes(cap.w));
    if (ci >= 0) capBlock = capBlockFrom(ci);
    else cap = null; // 컬럼 필터에 걸려 행에 없음 — 캡션 없음 취급
  }
  const foreignBlocks = [];
  for (let idx = 0; idx < rows.length; idx++) {
    if (capBlock && idx >= ci && idx <= capBlock.end) continue; // 우리 캡션 줄들은 제외
    if (!OTHER_CAP_RE.test(rows[idx].text)) continue;
    foreignBlocks.push(capBlockFrom(idx));
  }

  // capUpper: IEEE식 전부 대문자 캡션("TABLE 2") — 본체가 항상 캡션 아래(방향 고정용)
  const capUpper = !!(cap && /^[A-Z]+\.?$/.test(cap.w.t) && cap.w.t.length >= 3);
  return { words, lineH, rows, ci, cap, capBlock, foreignBlocks, colWords, colMin, colMax, modelBox, wpt, hpt, capUpper };
}

// ── 방향 판정: 그림 본체가 캡션 위(true)/아래(false) ─────────────────────────
// 모델 박스가 한쪽으로 분명히 치우치면 그걸, 모호하면 가까운 콘텐츠 쪽 (구 4단계 로직 그대로)
function computeFigureAbove(ctx) {
  const { rows, ci, capBlock, modelBox, hpt } = ctx;
  // IEEE 관례: 전부 대문자 캡션("TABLE 2")은 항상 본체 '위'에 놓인다 → 본체는 아래.
  // (방향 모호 판정이 위쪽 그림 잔재를 끌어들이는 것 방지 — ArcFace류)
  if (ctx.capUpper) return false;
  const capTop = capBlock.top, capBottom = capBlock.bottom, capEndIdx = capBlock.end;
  const rowAbove = ci > 0 ? rows[ci - 1] : null;
  const rowBelow = capEndIdx + 1 < rows.length ? rows[capEndIdx + 1] : null;
  const gapAbove = rowAbove ? capTop - rowAbove.bottom : Infinity;
  const gapBelow = rowBelow ? rowBelow.top - capBottom : Infinity;
  const extendsAbove = modelBox[1] < capTop / hpt - 0.05;
  const extendsBelow = modelBox[3] > capBottom / hpt + 0.05;
  const aboveAmt = capTop / hpt - modelBox[1];
  const belowAmt = modelBox[3] - capBottom / hpt;
  if (extendsAbove && !extendsBelow) return true;
  if (extendsBelow && !extendsAbove) return false;
  return gapAbove <= gapBelow || aboveAmt > belowAmt + 0.1;
}

// ── Layer 3: 캡션 앵커 텍스트 줄 간격 스캔 (구 captionAnchoredBox 4~6단계) ────
// 표(본체=텍스트)에 잘 맞음. Figure에선 L1/L2 실패 시 폴백으로만 쓴다.
function textScanBox(ctx) {
  if (!ctx || !ctx.cap || !ctx.capBlock) return null;
  const { rows, ci, capBlock, foreignBlocks, lineH, colWords, modelBox, wpt, hpt } = ctx;
  const capTop = capBlock.top, capBottom = capBlock.bottom, capXL = capBlock.xL, capXR = capBlock.xR, capEndIdx = capBlock.end;
  const inForeign = (r) => foreignBlocks.some((b) => r.top < b.bottom + 1 && r.bottom > b.top - 1);
  const figureAbove = computeFigureAbove(ctx);

  // 본체 경계 스캔 — 내부 줄 간격 대비 큰 간격에서만 멈추는 적응형 (자세한 근거는 구 주석 참조)
  const imageGap = Math.max(lineH * 3.0, 0.045 * hpt); // 이만큼 크면 이미지 빈칸
  const minBoundary = lineH * 0.9, maxBoundary = lineH * 2.6;
  const stopBoundary = (gap, gs) => {
    if (gs.length < 2) { gs.push(Math.max(gap, 0)); return false; } // 처음 2개는 표본 확보
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
      else if (stopBoundary(gap, gs)) break;
      top = r.top; acc = true;
    }
    let limitTop = 0;
    for (const b of foreignBlocks) if (b.bottom <= capTop + 1 && b.bottom > limitTop) limitTop = b.bottom;
    // 모델 박스가 캡션에 닿을 때만(=위치가 신뢰되는 박스) 하한으로 써서 잘림을 막는다.
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
    let limitBot = hpt;
    for (const b of foreignBlocks) if (b.top >= capBottom - 1 && b.top < limitBot) limitBot = b.top;
    if (modelBox[1] * hpt <= capBottom + 0.08 * hpt) bottom = Math.max(bottom, modelBox[3] * hpt);
    bodyBottom = Math.min(bottom, limitBot);
  }

  // 가로 폭: 본체 영역 단어들의 실제 좌우 + 캡션 폭 (우측 범례 잘림 방지)
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

// ── Layer 1: 임베디드 이미지 실측 (pdftohtml -xml) ───────────────────────────
// 페이지 안 모든 래스터 이미지의 정확한 위치를 얻어, 캡션과 인접한 이미지 클러스터의
// 외접 사각형 ∪ 캡션 블록을 크롭으로 쓴다. (서브피규어 격자 = 클러스터 병합으로 대응)
const _imgCache = new Map(); // `${pdfPath}|${page}` -> imgs[] | null
async function getPageImages(pdfPath, page) {
  const key = `${pdfPath}|${page}`;
  if (_imgCache.has(key)) return _imgCache.get(key);
  let result = null;
  let tmp = null;
  try {
    // pdftohtml은 이미지 파일을 디스크에 덤프한다 → 임시 디렉터리에 쓰고 XML만 읽은 뒤 즉시 삭제
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "figxml-"));
    const outBase = path.join(tmp, "p");
    await execFileP("pdftohtml", ["-xml", "-f", String(page), "-l", String(page), "-q", pdfPath, outBase]);
    const xml = await fs.promises.readFile(outBase + ".xml", "utf8");
    const wM = xml.match(/<page[^>]+width="([\d.]+)"/);
    const hM = xml.match(/<page[^>]+height="([\d.]+)"/);
    if (wM && hM) {
      const W = +wM[1], H = +hM[1]; // pdftohtml 자체 줌 좌표계 — 페이지 크기로 나눠 정규화
      const imgs = [];
      const tagRe = /<image\b[^>]*>/g;
      let t;
      while ((t = tagRe.exec(xml))) {
        const attr = (name) => { const m2 = t[0].match(new RegExp(`${name}="(-?[\\d.]+)"`)); return m2 ? +m2[1] : null; };
        const top = attr("top"), left = attr("left"), w = attr("width"), h = attr("height");
        if (top == null || left == null || !w || !h) continue;
        const x0 = clamp01(left / W), y0 = clamp01(top / H);
        const x1 = clamp01((left + w) / W), y1 = clamp01((top + h) / H);
        if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
        imgs.push({ x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
      }
      result = imgs;
    }
  } catch (e) {
    result = null; // pdftohtml 미설치/실패 → Layer 1 불가(다음 레이어로)
  } finally {
    if (tmp) fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  if (_imgCache.size > 300) _imgCache.delete(_imgCache.keys().next().value);
  _imgCache.set(key, result);
  return result;
}

async function imageAnchoredBox(pdfPath, page, ctx, modelBox, wpt, hpt) {
  const all = await getPageImages(pdfPath, page);
  if (!all || !all.length) return null;
  // 워터마크·로고 같은 장식 이미지 제외 (페이지의 0.5% 미만)
  let usable = all.filter((im) => im.area >= 0.005);
  if (!usable.length) return null;
  // 스캔 논문: 페이지 전체가 한 장의 이미지 → Layer 1 무의미(다음 레이어로)
  if (usable.some((im) => im.area >= 0.9)) return null;

  // 컬럼과 가로로 겹치는 이미지만
  const colMinN = ctx ? ctx.colMin / wpt : clamp01(modelBox[0] - 0.02);
  const colMaxN = ctx ? ctx.colMax / wpt : clamp01(modelBox[2] + 0.03);
  usable = usable.filter((im) => Math.min(im.x1, colMaxN) - Math.max(im.x0, colMinN) > 0.02);
  if (!usable.length) return null;

  const cap = ctx && ctx.capBlock ? { top: ctx.capBlock.top / hpt, bottom: ctx.capBlock.bottom / hpt, xL: ctx.capBlock.xL / wpt, xR: ctx.capBlock.xR / wpt } : null;
  let seed = null, pool = null, above = null;
  if (cap) {
    const MAXGAP = 0.12; // 캡션에서 이 이상 떨어진 이미지는 이 캡션의 그림이 아니라고 본다
    const upper = usable.filter((im) => im.y1 <= cap.top + 0.01).sort((a, b) => (cap.top - a.y1) - (cap.top - b.y1));
    const lower = usable.filter((im) => im.y0 >= cap.bottom - 0.01).sort((a, b) => (a.y0 - cap.bottom) - (b.y0 - cap.bottom));
    const aOK = upper.length && cap.top - upper[0].y1 < MAXGAP;
    const bOK = lower.length && lower[0].y0 - cap.bottom < MAXGAP;
    if (aOK && bOK) above = computeFigureAbove(ctx); // 양쪽 다 있으면 휴리스틱으로 방향 결정
    else if (aOK) above = true;
    else if (bOK) above = false;
    else return null;
    pool = above ? upper : lower;
    seed = pool[0];
  } else {
    // F4(캡션 미검출): 모델 박스와 세로로 가장 겹치거나 가까운 이미지에서 시작
    const dist = (im) => {
      const ov = Math.min(im.y1, modelBox[3]) - Math.max(im.y0, modelBox[1]);
      return ov > 0 ? -ov : Math.min(Math.abs(im.y0 - modelBox[3]), Math.abs(im.y1 - modelBox[1]));
    };
    pool = usable.slice().sort((a, b) => dist(a) - dist(b));
    seed = pool[0];
    if (dist(seed) > 0.1) return null; // 모델 박스 근처에 이미지가 없음
  }

  // 클러스터 병합: 세로 간격 3% 이내 + 가로 겹침 있는 이미지를 연쇄로 흡수 (서브피규어 a/b/c)
  const cl = { x0: seed.x0, y0: seed.y0, x1: seed.x1, y1: seed.y1 };
  const used = new Set([seed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const im of pool) {
      if (used.has(im)) continue;
      const vGap = Math.max(im.y0 - cl.y1, cl.y0 - im.y1); // 겹치면 음수
      const hOv = Math.min(im.x1, cl.x1) - Math.max(im.x0, cl.x0);
      if (vGap <= 0.03 && hOv > -0.02) {
        cl.x0 = Math.min(cl.x0, im.x0); cl.y0 = Math.min(cl.y0, im.y0);
        cl.x1 = Math.max(cl.x1, im.x1); cl.y1 = Math.max(cl.y1, im.y1);
        used.add(im); grew = true;
      }
    }
  }
  if (cl.y1 - cl.y0 < 0.02) return null; // 너무 얇은 조각(장식 선 등)

  // pdftohtml은 클리핑 전 '배치 사각형'을 보고할 수 있어(클립 무시) 이미지 rect가 실제
  // 표시 영역보다 넓게 나온다 — 컬럼 경계로 가로 클램프, 캡션 반대편으로 세로 클램프.
  cl.x0 = Math.max(cl.x0, colMinN - 0.01);
  cl.x1 = Math.min(cl.x1, colMaxN + 0.01);
  if (cap) {
    if (above === true) cl.y1 = Math.min(cl.y1, cap.top); // 그림은 캡션 위 — 캡션 아래로 못 내려감
    if (above === false) cl.y0 = Math.max(cl.y0, cap.bottom);
  }
  if (cl.x1 - cl.x0 < 0.05 || cl.y1 - cl.y0 < 0.02) return null;

  // 이웃 캡션 블록 차단: 클러스터가 다른 그림/표 캡션을 삼켰으면 그 앞에서 자른다
  if (ctx) {
    for (const b of ctx.foreignBlocks) {
      const bTop = b.top / hpt, bBot = b.bottom / hpt;
      if (cap) {
        if (above === true && bBot <= cap.top + 0.005 && cl.y0 < bBot && cl.y1 > bBot) cl.y0 = Math.max(cl.y0, bBot + 0.003);
        if (above === false && bTop >= cap.bottom - 0.005 && cl.y1 > bTop && cl.y0 < bTop) cl.y1 = Math.min(cl.y1, bTop - 0.003);
      }
    }
    if (cl.y1 - cl.y0 < 0.02) return null;
  }

  // 클러스터 ∪ 캡션 블록
  const box = cap
    ? [Math.min(cl.x0, cap.xL), Math.min(cl.y0, cap.top), Math.max(cl.x1, cap.xR), Math.max(cl.y1, cap.bottom)]
    : [cl.x0, cl.y0, cl.x1, cl.y1];
  return box.map(clamp01);
}

// ── PGM(P5) 렌더·파싱 — Layer 2·4 공용, 외부 의존성 없이 Node로 파싱 ─────────
const _pgmCache = new Map(); // `${pdfPath}|${page}` -> {w,h,data}|null
async function renderPagePGM(pdfPath, page, dpi = 50) {
  const key = `${pdfPath}|${page}|${dpi}`;
  if (_pgmCache.has(key)) return _pgmCache.get(key);
  let out = null;
  let tmp = null;
  try {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "figpgm-"));
    const base = path.join(tmp, "pg");
    await execFileP("pdftoppm", ["-gray", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", pdfPath, base]);
    const buf = await fs.promises.readFile(base + ".pgm");
    // P5 헤더: 매직/폭/높이/최대값 4개 토큰(공백 구분, # 주석 허용) 뒤 원시 바이트
    let pos = 0;
    const tokens = [];
    while (tokens.length < 4 && pos < buf.length) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; } // # 주석
      let s = pos;
      while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
      tokens.push(buf.slice(s, pos).toString("ascii"));
    }
    pos++; // 헤더 종료 공백 1바이트
    if (tokens[0] === "P5") {
      const w = parseInt(tokens[1], 10), h = parseInt(tokens[2], 10);
      if (w > 0 && h > 0 && buf.length >= pos + w * h) out = { w, h, data: buf.slice(pos, pos + w * h) };
    }
  } catch (e) {
    out = null;
  } finally {
    if (tmp) fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  if (_pgmCache.size > 40) _pgmCache.delete(_pgmCache.keys().next().value);
  _pgmCache.set(key, out);
  return out;
}

const INK_TH = 200; // 이 값보다 어두우면 잉크

// 정규화 박스의 잉크 비율 (0~1)
function inkRatio(pgm, box) {
  const x0 = Math.max(0, Math.floor(box[0] * pgm.w)), x1 = Math.min(pgm.w, Math.ceil(box[2] * pgm.w));
  const y0 = Math.max(0, Math.floor(box[1] * pgm.h)), y1 = Math.min(pgm.h, Math.ceil(box[3] * pgm.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    const off = y * pgm.w;
    for (let x = x0; x < x1; x++) if (pgm.data[off + x] < INK_TH) ink++;
  }
  return ink / ((x1 - x0) * (y1 - y0));
}

// 박스 경계 '바깥쪽' 밴드(경계에서 2~4px 밖)의 잉크 비율 — 절단 검사용.
// 안쪽 밴드를 재면 사진형 그림(잉크가 제 경계까지 꽉 참)이 전부 오탐된다.
// 진짜 절단 = 내용이 경계 너머로 이어짐 = 바깥쪽에 잉크. 페이지 끝이면 0(그 너머 없음).
function edgeInkRatios(pgm, box) {
  const px = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = px(box[0] * pgm.w, pgm.w - 1), x1 = px(box[2] * pgm.w, pgm.w);
  const y0 = px(box[1] * pgm.h, pgm.h - 1), y1 = px(box[3] * pgm.h, pgm.h);
  const band = (bx0, by0, bx1, by1) => {
    bx0 = Math.max(0, bx0); by0 = Math.max(0, by0); bx1 = Math.min(pgm.w, bx1); by1 = Math.min(pgm.h, by1);
    let ink = 0, n = 0;
    for (let y = by0; y < by1; y++) { const off = y * pgm.w; for (let x = bx0; x < bx1; x++) { n++; if (pgm.data[off + x] < INK_TH) ink++; } }
    return n ? ink / n : 0;
  };
  return {
    top: y0 <= 4 ? 0 : band(x0, y0 - 4, x1, y0 - 2),
    bottom: y1 >= pgm.h - 4 ? 0 : band(x0, y1 + 2, x1, y1 + 4),
    left: x0 <= 4 ? 0 : band(x0 - 4, y0, x0 - 2, y1),
    right: x1 >= pgm.w - 4 ? 0 : band(x1 + 2, y0, x1 + 4, y1),
  };
}

// ── Layer 2: 잉크 밀도 실측 (벡터 그림 — matplotlib 등) ──────────────────────
// 페이지를 저해상 그레이로 렌더 → 아는 단어 영역을 전부 마스킹(본문 텍스트 제거) →
// 캡션에 인접한 연속 잉크 밴드 = 그림 본체. 표(=텍스트+선)에는 부적합 — Figure 전용.
async function inkAnchoredBox(pdfPath, page, ctx, wpt, hpt) {
  if (!ctx || !ctx.capBlock) return null;
  const pgm = await renderPagePGM(pdfPath, page);
  if (!pgm) return null;
  // 단어 마스킹 사본
  const data = Buffer.from(pgm.data);
  const sx = pgm.w / wpt, sy = pgm.h / hpt;
  for (const w of ctx.words) {
    const x0 = Math.max(0, Math.floor(w.x0 * sx) - 1), x1 = Math.min(pgm.w, Math.ceil(w.x1 * sx) + 1);
    const y0 = Math.max(0, Math.floor(w.y0 * sy) - 1), y1 = Math.min(pgm.h, Math.ceil(w.y1 * sy) + 1);
    for (let y = y0; y < y1; y++) data.fill(255, y * pgm.w + x0, y * pgm.w + x1);
  }
  const colX0 = Math.max(0, Math.floor((ctx.colMin / wpt) * pgm.w));
  const colX1 = Math.min(pgm.w, Math.ceil((ctx.colMax / wpt) * pgm.w));
  if (colX1 - colX0 < 8) return null;
  const rowInk = (y) => {
    let n = 0;
    const off = y * pgm.w;
    for (let x = colX0; x < colX1; x++) if (data[off + x] < INK_TH) n++;
    return n;
  };
  const isInkRow = (y) => rowInk(y) >= 3;

  const above = computeFigureAbove(ctx);
  const capTopPx = Math.round((ctx.capBlock.top / hpt) * pgm.h);
  const capBotPx = Math.round((ctx.capBlock.bottom / hpt) * pgm.h);
  // 이웃 캡션 블록 경계(스캔 상한/하한)
  let limTop = 0, limBot = pgm.h;
  for (const b of ctx.foreignBlocks) {
    const bT = Math.round((b.top / hpt) * pgm.h), bB = Math.round((b.bottom / hpt) * pgm.h);
    if (bB <= capTopPx && bB > limTop) limTop = bB;
    if (bT >= capBotPx && bT < limBot) limBot = bT;
  }

  const leadMax = Math.round(0.1 * pgm.h); // 캡션과 본체 사이 허용 빈칸
  const gapMax = Math.max(5, Math.round(0.015 * pgm.h)); // 본체 내부 허용 빈칸(축 라벨 사이 등)
  let bandStart = -1, bandEnd = -1;
  if (above) {
    let y = capTopPx - 2, lead = 0;
    while (y > limTop && !isInkRow(y) && lead < leadMax) { y--; lead++; }
    if (y <= limTop || !isInkRow(y)) return null;
    bandEnd = y;
    let blank = 0;
    while (y > limTop && blank <= gapMax) {
      if (isInkRow(y)) { bandStart = y; blank = 0; } else blank++;
      y--;
    }
  } else {
    let y = capBotPx + 2, lead = 0;
    while (y < limBot && !isInkRow(y) && lead < leadMax) { y++; lead++; }
    if (y >= limBot || !isInkRow(y)) return null;
    bandStart = y;
    let blank = 0;
    while (y < limBot && blank <= gapMax) {
      if (isInkRow(y)) { bandEnd = y; blank = 0; } else blank++;
      y++;
    }
  }
  if (bandStart < 0 || bandEnd < 0 || bandEnd - bandStart < 0.03 * pgm.h) return null; // 본체라기엔 너무 얇음

  // 가로 폭: 밴드 안 잉크의 실제 좌우 (마스킹된 사본 기준) + 캡션 폭
  let ix0 = pgm.w, ix1 = 0;
  for (let y = bandStart; y <= bandEnd; y++) {
    const off = y * pgm.w;
    for (let x = colX0; x < colX1; x++) if (data[off + x] < INK_TH) { if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; }
  }
  if (ix1 <= ix0) return null;

  const X0 = Math.min(ix0 / pgm.w, ctx.capBlock.xL / wpt);
  const X1 = Math.max(ix1 / pgm.w, ctx.capBlock.xR / wpt);
  const Y0 = above ? bandStart / pgm.h : ctx.capBlock.top / hpt;
  const Y1 = above ? ctx.capBlock.bottom / hpt : bandEnd / pgm.h;
  if (Y1 - Y0 < 0.04 || X1 - X0 < 0.05) return null;
  return [X0, Y0, X1, Y1].map(clamp01);
}

// ── Layer 4: 결과 검증 — 백지·가장자리 절단 검사 + 폴백/확장 ─────────────────
async function sanityAdjust(pdfPath, page, box, ctx, wpt, hpt, report) {
  const pgm = await renderPagePGM(pdfPath, page);
  if (!pgm) return box;
  let cur = box.slice();

  // 백지 검사: 잉크 <1% → 실패로 보고 컬럼 전체 밴드(캡션 위/아래 × 이웃 캡션까지)로 넓은 폴백
  const ink = inkRatio(pgm, cur);
  if (report) report.ink = +ink.toFixed(4);
  if (ink < 0.01 && ctx && ctx.capBlock) {
    const above = computeFigureAbove(ctx);
    const capTopN = ctx.capBlock.top / hpt, capBotN = ctx.capBlock.bottom / hpt;
    let y0 = 0.02, y1 = 0.98;
    for (const b of ctx.foreignBlocks) {
      const bT = b.top / hpt, bB = b.bottom / hpt;
      if (above && bB <= capTopN && bB > y0) y0 = bB + 0.005;
      if (!above && bT >= capBotN && bT < y1) y1 = bT - 0.005;
    }
    cur = above
      ? [ctx.colMin / wpt, y0, ctx.colMax / wpt, capBotN]
      : [ctx.colMin / wpt, capTopN, ctx.colMax / wpt, y1];
    cur = cur.map(clamp01);
    if (report) report.blank_fallback = true;
  }

  // 가장자리 절단 검사: 경계 바깥 밴드 잉크율 > 15% = 내용이 경계 너머로 이어짐(잘림)
  // → 그 방향 2%씩 미세 확장(최대 3회). 작게 늘리는 이유: 그림 내부 제목·축 라벨이 경계
  // 바로 밖 한 줄인 경우가 흔한데, 크게 늘리면 본문까지 넘어가 버린다. 확장해도 바깥이
  // 좋아지지 않으면(본문 텍스트가 이어지는 경우) 그 확장은 되돌린다 — 무한정 커지는 것 방지.
  if (report) report.edges = edgeInkRatios(pgm, cur);
  const dirs = [
    { key: "top", idx: 1, delta: -0.02 },
    { key: "bottom", idx: 3, delta: +0.02 },
    { key: "left", idx: 0, delta: -0.02 },
    { key: "right", idx: 2, delta: +0.02 },
  ];
  for (const d of dirs) {
    let out = edgeInkRatios(pgm, cur)[d.key];
    for (let i = 0; i < 3 && out > 0.15; i++) {
      const prev = cur[d.idx];
      cur[d.idx] = clamp01(cur[d.idx] + d.delta);
      const out2 = edgeInkRatios(pgm, cur)[d.key];
      if (out2 >= out * 0.9) { cur[d.idx] = prev; break; } // 나아지지 않음 → 되돌림
      out = out2;
      if (report) report.edge_expanded = (report.edge_expanded || 0) + 1;
    }
  }
  return cur;
}

// ── 통합 라우팅 ──────────────────────────────────────────────────────────────
//   Table  → Layer 3 (텍스트 스캔) → 모델 bbox
//   Figure → Layer 1 (임베디드 이미지) → Layer 2 (잉크 밀도) → Layer 3 → 모델 bbox
//   mode:"legacy" = 개선 전 재현(Layer 3 → 모델 bbox, Layer 4 없음) — 하니스 비교용
// 반환: { box, layer, report } — box는 정규화 [x0,y0,x1,y1] (패딩은 호출부 담당)
async function resolveFigureBox(pdfPath, page, label, modelBox, wpt, hpt, opts = {}) {
  const mode = opts.mode === "legacy" ? "legacy" : "full";
  const parsed = parseFigLabel(label);
  const report = { layer: "model", mode };
  let ctx = null;
  try {
    ctx = await analyzePage(pdfPath, page, parsed, modelBox, wpt, hpt);
  } catch (e) { /* 텍스트 레이어 실패 → 모델 bbox */ }

  let box = null;
  if (mode === "legacy") {
    box = ctx ? textScanBox(ctx) : null;
    if (box) report.layer = "text";
    return { box: box || modelBox.map(clamp01), layer: report.layer, report };
  }

  const isTable = parsed && parsed.type === "table";
  if (isTable) {
    box = ctx ? textScanBox(ctx) : null; // 표는 본체가 곧 텍스트 — 현행 방식이 잘 맞음
    if (box) report.layer = "text";
  } else {
    try {
      box = await imageAnchoredBox(pdfPath, page, ctx, modelBox, wpt, hpt);
      if (box) report.layer = "image";
    } catch (e) {}
    if (!box && ctx) {
      try {
        box = await inkAnchoredBox(pdfPath, page, ctx, wpt, hpt);
        if (box) report.layer = "ink";
      } catch (e) {}
    }
    if (!box && ctx) {
      box = textScanBox(ctx);
      if (box) report.layer = "text";
    }
  }
  if (!box) box = modelBox.map(clamp01);

  try {
    box = await sanityAdjust(pdfPath, page, box, ctx, wpt, hpt, report);
  } catch (e) {}
  return { box, layer: report.layer, report };
}

// 하니스용 실측: 최종 박스의 잉크율·변 절단율
async function measureBox(pdfPath, page, box) {
  const pgm = await renderPagePGM(pdfPath, page);
  if (!pgm) return null;
  return { ink: inkRatio(pgm, box), edges: edgeInkRatios(pgm, box) };
}

module.exports = { parseFigLabel, resolveFigureBox, measureBox };
