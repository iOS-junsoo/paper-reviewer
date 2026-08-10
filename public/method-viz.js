// method-viz.js — 연구 방법론 인터랙티브 시각화 렌더러 (app.js에서 분리, index.html에서 app.js보다 먼저 로드).
// 클래식 스크립트라 app.js와 전역 스코프를 공유한다. 여기 함수/변수는 전역이 되고,
// renderMethod(app.js)가 buildMethodViz/buildFigure 등을 호출한다. 최상위 실행문 없음(로드순서 안전).

/* ==========================================================================
   연구 방법론: 인터랙티브 2.5D 파이프라인 (method_visualization)
   모델이 준 구조 스펙을 렌더러가 SVG 파이프라인 + 스테퍼 + 컨트롤 슬라이더 +
   정성 시뮬레이션 + 상태 바인딩 detail_viz 패널로 그린다. (method_viz_prompt v3.2)
   v3.2: edges 기반 rank/lane 위상 배치(병렬 분기·합류가 실제 2D로) · groups 점선 묶음 ·
   alternating 스위치 엣지 · switch_box/queue_bank 프리미티브 · fit-to-view(스크롤 금지,
   콘텐츠 bbox=viewBox) · 텍스트 실측 랩핑 · 스키마 주도 리드아웃(sim.readouts) ·
   단일 rAF(입자+스위치, 백그라운드 탭 자동 정지)
   ========================================================================== */
let activeMethodViz = null; // 현재 애니메이션/타이머 컨트롤러 (논문 전환 시 destroy)
let _mvizHtmlCleanup = null; // method_viz_html iframe의 높이 메시지 리스너 정리 훅
const MVNS = "http://www.w3.org/2000/svg";
function mvE(tag, attrs) { const e = document.createElementNS(MVNS, tag); for (const k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; }
function mvT(x, y, s, attrs) { const t = mvE("text", Object.assign({ x, y }, attrs || {})); t.textContent = s == null ? "" : String(s); return t; }
function mvClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// 슬래브(2.5D 판): 앞면 rect + 윗면 평행사변형으로 살짝 입체감
function mvSlab(x, y, w, h, fill, stroke, rx) {
  const g = mvE("g");
  const d = 6;
  g.appendChild(mvE("path", { d: `M${x} ${y} L${x + d} ${y - d} L${x + w + d} ${y - d} L${x + w} ${y} Z`, fill: stroke, opacity: "0.35" }));
  g.appendChild(mvE("rect", { x, y, width: w, height: h, rx: rx || 4, fill, stroke, "stroke-width": "1" }));
  return g;
}
// ── 텍스트 실측(canvas measureText, 헤드리스 폴백은 CJK 2칸 근사) + 랩핑 ──
const MV_WIDE = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿！-｠]/;
function mvUnits(s) { let u = 0; for (const ch of String(s || "")) u += MV_WIDE.test(ch) ? 2 : 1; return u; }
let mvMeasureCtx = null;
function mvTextW(s, size) {
  try {
    if (!mvMeasureCtx) mvMeasureCtx = document.createElement("canvas").getContext("2d");
    mvMeasureCtx.font = `${size}px sans-serif`;
    const w = mvMeasureCtx.measureText(String(s || "")).width;
    if (Number.isFinite(w) && w > 0) return w;
  } catch {}
  return mvUnits(s) * size * 0.56;
}
function mvCutPx(s, maxW, size) {
  s = String(s || "");
  if (mvTextW(s, size) <= maxW) return s;
  let out = "";
  for (const ch of s) { if (mvTextW(out + ch + "…", size) > maxW) break; out += ch; }
  return out + "…";
}
// 어절 경계 우선 2줄 랩핑, 2줄 초과분은 말줄임. {lines, truncated} 반환
function mvWrapPx(text, maxW, size) {
  text = String(text == null ? "" : text).trim();
  if (!text) return { lines: [], truncated: false };
  if (mvTextW(text, size) <= maxW) return { lines: [text], truncated: false };
  let l1 = "";
  const words = text.split(/\s+/);
  if (words.length > 1) {
    for (const w of words) { const cand = l1 ? l1 + " " + w : w; if (mvTextW(cand, size) <= maxW) l1 = cand; else break; }
  }
  if (!l1) { for (const ch of text) { if (mvTextW(l1 + ch, size) > maxW) break; l1 += ch; } }
  const rest = text.slice(l1.length).trim();
  if (!rest) return { lines: [l1], truncated: false };
  if (mvTextW(rest, size) <= maxW) return { lines: [l1, rest], truncated: false };
  return { lines: [l1, mvCutPx(rest, maxW, size)], truncated: true };
}

function validateMethodViz(raw) {
  if (!raw || typeof raw !== "object") return null;
  const _sv = []; // P3: §9 검증기의 강등 내역(조용한 강등 → 기록)
  const PRIM = new Set(["io_cube", "iso_stack", "card_stack", "op_box", "dual_dist_box", "switch_box", "queue_bank"]);
  const DVIZ = new Set(["pixel_grid", "activation_bars", "histogram", "sorted_threshold", "slab_mask", "convergence_curve", "transform", "summary_rows", "dual_dist"]);
  const EKIND = ["forward", "gradient", "frozen", "alternating"];
  // 모듈 리스트 공용 강제(프리미티브·lane·iso_stack layers). tag는 로그용 depth 표기.
  const coerceMods = (mods, tag) => mods.forEach((m) => {
    if (!PRIM.has(m.primitive)) { _sv.push({ rule: "primitive_unknown", target: `module:${m.id}${tag}`, action: `"${m.primitive}"→op_box` }); m.primitive = "op_box"; }
    m.primitive_spec = m.primitive_spec && typeof m.primitive_spec === "object" ? m.primitive_spec : {};
    if (!["top", "middle", "bottom"].includes(m.lane_hint)) m.lane_hint = null;
    if (m.primitive === "iso_stack") {
      let ls = (Array.isArray(m.primitive_spec.layers) ? m.primitive_spec.layers : []).filter((l) => l && Number.isFinite(Number(l.ch))).map((l) => ({ ch: mvClamp(Math.round(Number(l.ch)), 4, 8), h: mvClamp(Math.round(Number(l.h)) || 90, 50, 130) }));
      if (!ls.length) ls = [{ ch: 4, h: 116 }, { ch: 6, h: 84 }, { ch: 8, h: 58 }];
      m.primitive_spec.layers = ls;
    }
  });
  const coerceEdges = (rawE, eids, tag) => { const es = rawE.filter((e) => e && eids.has(e.to) && (eids.has(e.from) || e.from === "input"))
      .map((e) => ({ from: e.from, to: e.to, kind: EKIND.includes(e.kind) ? e.kind : "forward", label: e.label || "", badge: (e.badge && typeof e.badge === "object" && e.badge.text != null) ? { text: String(e.badge.text).slice(0, 8) } : null }));
    if (rawE.length > es.length) _sv.push({ rule: "edge_invalid_endpoint", target: `edges${tag}`, action: `${rawE.length - es.length}개 제거(from/to 미존재)` }); return es; };
  const coerceSteps = (rawS, sids, tag) => { const ss = (Array.isArray(rawS) ? rawS : []).filter((s) => s && sids.has(s.module));
    ss.forEach((s, si) => { s.detail_viz = s.detail_viz && typeof s.detail_viz === "object" ? s.detail_viz : {};
      if (!DVIZ.has(s.detail_viz.type)) { _sv.push({ rule: "detail_viz_unknown_type", target: `steps[${si}]${tag}`, action: `"${s.detail_viz.type}"→transform` }); s.detail_viz.type = "transform"; }
      s.detail_viz.binds = Array.isArray(s.detail_viz.binds) ? s.detail_viz.binds : []; }); return ss; };
  // P1(LOD): expand(모듈 내부 파이프라인) 재귀 검증. 깊이≤2, id 네임스페이스(부모id.자식id) 전역 고유, source_ref 필수.
  const validateExpand = (parentId, ex, depth, gIds) => {
    if (ex == null) return null;
    if (typeof ex !== "object") { _sv.push({ rule: "expand_malformed", target: `${parentId} (depth ${depth})`, action: "expand 제거" }); return null; }
    const dtag = ` (depth ${depth})`;
    if (!ex.source_ref || !String(ex.source_ref).trim()) { _sv.push({ rule: "expand_no_source_ref", target: parentId + dtag, action: "expand 제거(근거 없음)" }); return null; }
    if (depth > 2) { _sv.push({ rule: "expand_depth_exceeded", target: parentId + dtag, action: "깊이 3+ expand 무시" }); return null; }
    let mods = (Array.isArray(ex.modules) ? ex.modules : []).filter((m) => m && typeof m === "object" && typeof m.id === "string");
    const badNs = mods.some((m) => m.id.indexOf(parentId + ".") !== 0);
    const dupSet = new Set(mods.map((m) => m.id));
    const dup = mods.some((m) => gIds.has(m.id)) || dupSet.size !== mods.length;
    if (badNs || dup) { _sv.push({ rule: "expand_id_namespace", target: parentId + dtag, action: `expand 제거(${badNs ? "id 접두 누락" : "중복 id"})` }); return null; }
    if (mods.length < 2 || mods.length > 6) { _sv.push({ rule: "expand_module_count", target: parentId + dtag, action: `expand 제거(모듈 ${mods.length}개, 2~6 아님)` }); return null; }
    mods.forEach((m) => gIds.add(m.id));
    coerceMods(mods, dtag);
    const eids = new Set(mods.map((m) => m.id));
    const edges = coerceEdges(Array.isArray(ex.edges) ? ex.edges : [], eids, `:${parentId}${dtag}`);
    const steps = coerceSteps(ex.steps, eids, `:${parentId}${dtag}`);
    mods.forEach((m) => { m.expand = validateExpand(m.id, m.expand, depth + 1, gIds); });
    return { source_ref: String(ex.source_ref), modules: mods, edges, steps };
  };
  const seen = new Set();
  let modules = (Array.isArray(raw.modules) ? raw.modules : [])
    .filter((m) => m && typeof m === "object" && m.id && !seen.has(m.id) && seen.add(m.id));
  if (modules.length < 2) return null; // 최소 구조 없음 → 상위에서 폴백
  coerceMods(modules, "");
  // expand 재귀 검증 — gIds에 전역 id 누적(하위호환: expand 없으면 아무 변화 없음)
  const gIds = new Set(modules.map((m) => m.id));
  modules.forEach((m) => { m.expand = validateExpand(m.id, m.expand, 1, gIds); });
  const ids = new Set(modules.map((m) => m.id));
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const edges = rawEdges
    .filter((e) => e && (ids.has(e.from) || e.from === "input") && ids.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, kind: ["forward", "gradient", "frozen", "alternating"].includes(e.kind) ? e.kind : "forward", label: e.label || "",
      badge: (e.badge && typeof e.badge === "object" && e.badge.text != null) ? { text: String(e.badge.text).slice(0, 8) } : null }));
  if (rawEdges.length > edges.length) _sv.push({ rule: "edge_invalid_endpoint", target: "edges", action: `${rawEdges.length - edges.length}개 제거(from/to 미존재)` });
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const groups = rawGroups
    .filter((g) => g && typeof g === "object")
    .map((g) => ({ id: g.id || "", label: g.label || "", members: (Array.isArray(g.members) ? g.members : []).filter((id) => ids.has(id)), style: g.style === "solid" ? "solid" : "dashed" }))
    .filter((g) => g.members.length);
  if (rawGroups.length > groups.length) _sv.push({ rule: "group_no_valid_member", target: "groups", action: `${rawGroups.length - groups.length}개 제거` });
  let steps = (Array.isArray(raw.steps) ? raw.steps : []).filter((s) => s && ids.has(s.module));
  if (steps.length < 2) {
    _sv.push({ rule: "steps_insufficient", target: "steps", action: "모듈에서 자동 생성(transform)" });
    steps = modules.map((m) => ({ module: m.id, title: m.name || m.id, desc: m.role || "", detail_viz: { type: "transform", binds: ["example"], caption: m.data_state || "" } }));
  }
  steps.forEach((s, si) => {
    s.detail_viz = s.detail_viz && typeof s.detail_viz === "object" ? s.detail_viz : {};
    if (!DVIZ.has(s.detail_viz.type)) { _sv.push({ rule: "detail_viz_unknown_type", target: "steps[" + si + "]", action: `"${s.detail_viz.type}"→transform` }); s.detail_viz.type = "transform"; }
    s.detail_viz.binds = Array.isArray(s.detail_viz.binds) ? s.detail_viz.binds : [];
  });
  let control = raw.control && typeof raw.control === "object" ? raw.control : null;
  if (control) {
    // affects는 expand 내부 전역 id도 허용(P1.6) — gIds 기준으로 필터
    control.affects = (Array.isArray(control.affects) ? control.affects : []).filter((id) => gIds.has(id));
    let { min, max, default: def, step } = control;
    min = Number(min); max = Number(max); def = Number(def); step = Number(step);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max) || max <= min) max = min + 100;
    if (!Number.isFinite(def)) def = (min + max) / 2;
    def = mvClamp(def, min, max);
    if (!Number.isFinite(step) || step <= 0) step = Math.max(1, Math.round((max - min) / 20));
    control.min = min; control.max = max; control.default = def; control.step = step;
    // direction은 '마스크/선택' 의미일 때만 스펙이 명시 — 없으면 마스크 관련 UI(활성 리드아웃 등) 생략
    if (!["keep_top", "remove_top"].includes(control.direction)) control.direction = null;
    // P1: control.mode (mask/coeff/text). 하위호환: mode 부재 → direction 있으면 mask, 없으면 text.
    const modeGiven = ["mask", "coeff", "text"].includes(control.mode); // 스펙이 mode를 명시했나
    let cmode = control.mode;
    if (!modeGiven) cmode = control.direction ? "mask" : "text";           // 부재 → 하위호환
    if (control.mode != null && !modeGiven) { _sv.push({ rule: "control_mode_invalid", target: "control", action: `"${control.mode}"→제거(정적)` }); control = null; } // ④ mode 값 3종 밖
    if (control) {
      control.mode = cmode;
      // 비mask 모드는 direction(마스크 UI 트리거)을 제거 — coeff/text에서 슬래브·활성 리드아웃 누출 방지(AC-3)
      if (cmode !== "mask") control.direction = null;
      if (!control.affects.length) { _sv.push({ rule: "control_no_affects", target: "control", action: "제거(정적)" }); control = null; }
      else {
        const findDeep = (id, list) => { for (const mm of list) { if (mm.id === id) return mm; if (mm.expand && mm.expand.modules) { const f = findDeep(id, mm.expand.modules); if (f) return f; } } return null; };
        const primOf = (id) => { const m = findDeep(id, modules); return m ? m.primitive : null; };
        // 검증 규칙 (AC-7): 위반 시 control만 제거(정적) — 전체 폴백 아님
        if (cmode === "mask" && !control.direction) { _sv.push({ rule: "mask_no_direction", target: "control", action: "제거(정적)" }); control = null; } // ①
        // ②③ 시각-효과-대상 제약은 mode를 명시한 v4 스펙에만 적용 — mode 없는 v3 스펙은 강등 금지(AC-1 하위호환)
        else if (modeGiven && cmode === "mask" && !control.affects.some((id) => ["iso_stack", "op_box"].includes(primOf(id)))) { _sv.push({ rule: "mask_no_visual_target", target: "control", action: "제거(정적)" }); control = null; } // ②
        else if (modeGiven && cmode === "coeff" && !(control.affects.some((id) => ["dual_dist_box", "queue_bank"].includes(primOf(id)))
          || steps.some((s) => ["convergence_curve", "dual_dist"].includes(s.detail_viz.type)))) { _sv.push({ rule: "coeff_no_visual_target", target: "control", action: "제거(정적)" }); control = null; } // ③
      }
    }
  }
  const sim = raw.sim && typeof raw.sim === "object" ? raw.sim : {};
  sim.readouts = (Array.isArray(sim.readouts) ? sim.readouts : null);
  return { ...raw, modules, edges, groups, steps, control, sim, _specValidation: _sv };
}

function buildMethodViz(raw, opts) {
  // opts.panel: expand 내부 파이프라인 패널 모드(크롬·입자·전역 컨트롤러 생략, 레이아웃/그리기/불변식은 동일 재사용)
  // opts.depth: 현재 깊이(0=레벨0). opts.preValidated: raw가 이미 검증된 스펙. opts.qaSink: QA 리포트 수집 배열.
  opts = opts || {};
  const panel = !!opts.panel, depth = opts.depth || 0;
  const spec = opts.preValidated ? raw : validateMethodViz(raw);
  if (!spec) return null;

  // ── 상태 ──
  const cardMod = spec.modules.find((m) => m.primitive === "card_stack" || m.primitive === "queue_bank");
  const C = cardMod ? mvClamp(Number(cardMod.primitive_spec.count) || 16, 8, 24) : 16;
  const hasDirection = !!(spec.control && spec.control.direction);
  const ctrlMode = spec.control ? spec.control.mode : null; // "mask" | "coeff" | "text" | null
  const S = {
    spec, stepIdx: 0,
    eta: spec.control ? spec.control.default : 50,
    iter: 0, C, scores: [], flips: 0, pulse: 0,
    reduce: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    raf: 0, playTimer: 0, ro: null, mods: new Map(),
  };
  const resetScores = () => { S.scores = Array.from({ length: C }, () => 0.35 + Math.random() * 0.3); S.iter = 0; S.flips = 0; };
  resetScores();
  const dirRemove = () => spec.control && spec.control.direction === "remove_top";
  // P1(coeff): 슬라이더 값 → 정규화 계수 c∈[0,1]
  const coeffC = () => {
    if (ctrlMode !== "coeff" || !spec.control) return 0.5;
    const { min, max } = spec.control;
    return mvClamp((S.eta - min) / ((max - min) || 1), 0, 1);
  };
  // gap 단일 소스(P2 AC-4): (반복, 계수)의 순수 함수 — 미니 분포·detail 패널이 같은 값을 읽는다.
  // 슬라이더(c)든 반복(iter)이든 바뀌면 즉시 반영. 1(초기) → 0(수렴).
  const gapValue = () => Math.pow(1 - 0.10 * (0.3 + 1.4 * coeffC()), S.iter);
  // 살아남는(활성) 개수 — remove_top이면 (1−α), keep_top(또는 방향 미지정 마스크 시각화)이면 η
  const keepCount = () => {
    const frac = S.eta / 100;
    return mvClamp(Math.round(C * (dirRemove() ? 1 - frac : frac)), 0, C);
  };
  const maskOf = () => {
    const keep = keepCount();
    const order = S.scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    const m = new Array(C).fill(0);
    (dirRemove() ? order.slice(C - keep) : order.slice(0, keep)).forEach((i) => (m[i] = 1));
    return m;
  };
  // 정성 지표(감소 경향) — coeff 모드면 gap(계수 c 반영), 아니면 기존 공식 그대로(하위호환)
  const simMetric = () => ctrlMode === "coeff" ? 0.07 + 0.55 * gapValue() : 0.55 * Math.exp(-S.iter / 7) + 0.07;
  const simStep = () => {
    const before = maskOf();
    const noise = 0.16 / (1 + S.iter * 0.6);
    S.scores = S.scores.map((v, i) => mvClamp(v + (before[i] ? 0.06 : -0.06) + (Math.random() - 0.5) * noise, 0, 1));
    const after = maskOf();
    S.flips = before.reduce((a, _, i) => a + (before[i] !== after[i] ? 1 : 0), 0);
    S.iter++;
    S.pulse = 10; // queue_bank 카드 밀려들어오는 펄스 프레임
  };

  /* ── P1. 위상 배치: forward(+alternating) edge로 rank(깊이) → x, 같은 rank는 lane → y ──
     gradient/frozen은 rank에서 제외(역방향·우회). 전부 직렬이면 기존과 같은 한 줄이 나온다. */
  const n = spec.modules.length;
  const idxOf = (id) => spec.modules.findIndex((m) => m.id === id);
  const rank = new Array(n).fill(0);
  {
    const re = spec.edges.filter((e) => (e.kind === "forward" || e.kind === "alternating") && idxOf(e.from) >= 0);
    for (let it = 0; it < n + 1; it++) {
      let changed = false;
      re.forEach((e) => {
        const f = idxOf(e.from), t = idxOf(e.to);
        if (f >= 0 && t >= 0 && rank[f] + 1 > rank[t] && rank[t] <= n) { rank[t] = rank[f] + 1; changed = true; }
      });
      if (!changed) break;
    }
  }
  const R = Math.max(...rank) + 1;
  const byRank = Array.from({ length: R }, () => []);
  spec.modules.forEach((m, i) => byRank[rank[i]].push(i));
  const maxLanes = Math.max(...byRank.map((l) => l.length));

  // 프리미티브별 실제 폭(가변) — op/switch는 이름 실측(110~190px)
  const HINT = { top: 0, middle: 1, bottom: 2 };
  const boxMeta = new Map(); // i -> {w, boxW(op류 내부박스), nameLines, nameTrunc}
  const modW = (m, i) => {
    if (m.primitive === "iso_stack") return m.primitive_spec.layers.length * 20 + 14;
    if (m.primitive === "io_cube") return 64;
    if (m.primitive === "card_stack") return 62;
    if (m.primitive === "queue_bank") return 30 + Math.min(Number(m.primitive_spec.count) || 6, 10) * 10;
    if (m.primitive === "dual_dist_box") return 76;
    // op_box / switch_box: 이름 실측 폭 기반 (min 110, max 190)
    const wrap = mvWrapPx(m.name || m.id, 166, 10);
    const wMax = Math.max(...wrap.lines.map((l) => mvTextW(l, 10)), 60);
    const w = mvClamp(Math.ceil(wMax) + 24, 110, 190);
    boxMeta.set(i, { boxW: w, nameLines: wrap.lines, nameTrunc: wrap.truncated });
    return w;
  };
  const widths = spec.modules.map((m, i) => modW(m, i));

  // 직렬(모든 rank 1레인) + 길면 두 줄 serpentine — 가독성 하한 대응 (P2-4b)
  // 단, 되돌아가는 back-edge(gradient·역방향 forward)가 있으면 serpentine 금지:
  // 줄바꿈 wrap을 back-edge가 그대로 되짚어 겹치므로, 한 줄로 펴서 아래 외곽으로 우회시킨다.
  const hasBackEdge = spec.edges.some((e) => {
    if (idxOf(e.from) < 0 || idxOf(e.to) < 0) return false;
    if (e.kind === "gradient") return true;
    return (e.kind === "forward" || e.kind === "alternating") && rank[idxOf(e.to)] - rank[idxOf(e.from)] < 0;
  });
  const serp = maxLanes === 1 && R >= 6 && !hasBackEdge;
  const GAP = 48, MARGIN = 30, LANE_V = 164, CY0 = 118, ROWH = 196;
  const positions = new Array(n);
  if (serp) {
    const split = Math.ceil(R / 2);
    const rowRanks = [Array.from({ length: split }, (_, r) => r), Array.from({ length: R - split }, (_, k) => split + k)];
    const rowW = rowRanks.map((rs) => rs.reduce((a, r) => a + (byRank[r][0] != null ? widths[byRank[r][0]] : 0), 0) + GAP * Math.max(0, rs.length - 1));
    const W = Math.max(rowW[0], rowW[1] || 0) + MARGIN * 2;
    let x = MARGIN;
    rowRanks[0].forEach((r) => { const i = byRank[r][0]; positions[i] = { cx: x + widths[i] / 2, cy: CY0, halfW: widths[i] / 2, row: 0 }; x += widths[i] + GAP; });
    let xr = W - MARGIN;
    rowRanks[1].forEach((r) => { const i = byRank[r][0]; positions[i] = { cx: xr - widths[i] / 2, cy: CY0 + ROWH, halfW: widths[i] / 2, row: 1 }; xr -= widths[i] + GAP; });
  } else {
    // rank → 컬럼 x (컬럼 폭 = 그 rank 최대 모듈 폭), lane → y (lane_hint > 부모 barycenter > 원래 순서)
    const colW = byRank.map((list) => Math.max(...list.map((i) => widths[i]), 60));
    const colX = []; let x = MARGIN;
    for (let r = 0; r < R; r++) { colX[r] = x; x += colW[r] + GAP; }
    const laneOf = new Array(n).fill(0);
    for (let r = 0; r < R; r++) {
      const list = byRank[r];
      const key = (i) => {
        const m = spec.modules[i];
        if (m.lane_hint) return HINT[m.lane_hint] * 1000 + i;
        // barycenter: 부모(lane 배정 완료된 rank<r)의 평균 lane
        const parents = spec.edges.filter((e) => e.to === m.id && idxOf(e.from) >= 0 && rank[idxOf(e.from)] < r).map((e) => laneOf[idxOf(e.from)]);
        return (parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 1) * 1000 + i;
      };
      list.slice().sort((a, b) => key(a) - key(b)).forEach((i, li) => { laneOf[i] = li; });
      list.forEach((i) => {
        const k = list.length;
        positions[i] = { cx: colX[rank[i]] + colW[rank[i]] / 2, cy: CY0 + (laneOf[i] - (k - 1) / 2) * LANE_V + (maxLanes > 1 ? ((maxLanes - 1) * LANE_V) / 2 : 0), halfW: widths[i] / 2, row: 0 };
      });
    }
  }

  // 콘텐츠 bbox 추적(P2) — 모듈·라벨·엣지·그룹·외곽 우회 경로 전부 포함
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
    add(x0, y0, x1, y1) { this.x0 = Math.min(this.x0, x0); this.y0 = Math.min(this.y0, y0); this.x1 = Math.max(this.x1, x1); this.y1 = Math.max(this.y1, y1); } };
  positions.forEach((p) => bb.add(p.cx - p.halfW - 8, p.cy - 72, p.cx + p.halfW + 8, p.cy + 74));

  // ── 골격 DOM ──
  const wrap = document.createElement("div");
  wrap.className = panel ? "mviz mviz-panelbody" : "mviz";
  const header = document.createElement("div");
  header.className = "mviz-head";
  header.innerHTML = `<span class="mviz-badge">인터랙티브 파이프라인</span>` +
    (spec.section_ref ? `<span class="mviz-ref">${escapeHtmlAttr(spec.section_ref)}</span>` : "");
  if (!panel) wrap.appendChild(header);

  const stage = document.createElement("div");
  stage.className = panel ? "mviz-stage mviz-panel-svg" : "mviz-stage mviz-left";
  const svg = mvE("svg", { class: "mviz-svg", preserveAspectRatio: "xMidYMid meet" });
  const defs = mvE("defs");
  ["#6b6258", "#8c2f39"].forEach((c, k) => {
    const mk = mvE("marker", { id: `mviz-arrow${k}`, viewBox: "0 0 8 8", refX: "6", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
    mk.appendChild(mvE("path", { d: "M0 0 L8 4 L0 8 Z", fill: c }));
    defs.appendChild(mk);
  });
  const gGroups = mvE("g"); const gEdges = mvE("g"); const gMods = mvE("g"); const gParticles = mvE("g");
  // 라벨 전용 최상단 레이어 — 그룹·엣지 텍스트를 모듈 그래픽 위로 올려 가려지지 않게(박스·선은 아래 유지)
  const gGrpLab = mvE("g"); const gEdgeLab = mvE("g");
  svg.append(defs, gGroups, gEdges, gMods, gParticles, gGrpLab, gEdgeLab);
  stage.appendChild(svg);

  // ── 모듈 그리기 (primitive별) — 그래픽/라벨 서브그룹 분리(디밍 강도 다르게) ──
  const altSwitches = []; // switch_box 레버 참조 (alternating 토글 애니메이션)
  const queueEls = []; // queue_bank 카드 그룹 (sim 펄스)
  function drawModule(m, i) {
    const pos = positions[i];
    const cy = 118;
    const g = mvE("g", { "data-mod": m.id, "data-hw": pos.halfW, class: "mviz-mod", transform: `translate(${pos.cx},${pos.cy - 118})` });
    const gfx = mvE("g"); const lab = mvE("g");
    g.append(gfx, lab);
    g.__gfx = gfx; g.__lab = lab;
    const affected = spec.control && spec.control.affects.includes(m.id);
    const TAN = "#e7dcc3", TAN_S = "#c9b892", PURPLE = "#7c5cbf", INK = "#211d19", FAINT = "#9b9285";
    let labelBelow = true;
    if (m.primitive === "io_cube") {
      const glyph = (m.primitive_spec.glyph || "none");
      gfx.appendChild(mvSlab(-26, cy - 26, 52, 52, "#fff", "#c9b892", 8));
      if (glyph === "face") {
        gfx.append(mvE("circle", { cx: -8, cy: cy - 6, r: 3, fill: INK }), mvE("circle", { cx: 8, cy: cy - 6, r: 3, fill: INK }),
          mvE("path", { d: `M-10 ${cy + 8} Q0 ${cy + 16} 10 ${cy + 8}`, stroke: INK, fill: "none", "stroke-width": "2" }));
      } else if (glyph === "text") {
        [0, 1, 2].forEach((k) => gfx.appendChild(mvE("rect", { x: -16, y: cy - 8 + k * 8, width: 32 - k * 6, height: 3, rx: 1.5, fill: FAINT })));
      } else gfx.appendChild(mvT(0, cy + 4, "▦", { "text-anchor": "middle", fill: FAINT, "font-size": "18" }));
    } else if (m.primitive === "iso_stack") {
      const layers = m.primitive_spec.layers;
      const frozen = !!m.primitive_spec.frozen;
      const totalW = layers.length * 20 - 6;
      let lx = -totalW / 2;
      const aliveFrac = keepCount() / C;
      layers.forEach((L) => {
        const h = L.h * 0.62, top = cy + 22 - h;
        const slab = mvSlab(lx, top, 15, h, frozen ? "#eee9de" : TAN, frozen ? "#c8c0b0" : TAN_S, 3);
        const nLines = Math.min(L.ch, 6);
        for (let c = 0; c < nLines; c++) {
          const yy = top + 5 + (c * (h - 10)) / Math.max(1, nLines - 1);
          const off = affected && hasDirection && (c + 1) / nLines > aliveFrac;
          slab.appendChild(mvE("line", { x1: lx + 3, y1: yy, x2: lx + 12, y2: yy, stroke: off ? "#c9b892" : TAN_S, "stroke-width": off ? "1" : "1.6", "stroke-dasharray": off ? "2 2" : "", opacity: off ? "0.5" : "1" }));
        }
        gfx.appendChild(slab);
        lx += 20;
      });
      lab.appendChild(mvT(0, cy - 46, frozen ? "🔒 frozen" : "🔥 학습", { "text-anchor": "middle", fill: frozen ? FAINT : "#8c2f39", "font-size": "9", class: "mv-sub" }));
    } else if (m.primitive === "card_stack") {
      const col = m.primitive_spec.color === "tan" ? TAN : PURPLE;
      for (let k = 3; k >= 0; k--) {
        gfx.appendChild(mvE("rect", { x: -20 + k * 4, y: cy - 24 + k * 4, width: 40, height: 46, rx: 5, fill: k === 0 ? col : "#fff", stroke: col, "stroke-width": "1.4", opacity: k === 0 ? "0.92" : "0.5" }));
      }
      gfx.appendChild(mvT(0, cy + 4, mvCutPx(m.primitive_spec.label || "r", 36, 10), { "text-anchor": "middle", fill: "#fff", "font-size": "10.5", "font-weight": "600" }));
    } else if (m.primitive === "queue_bank") {
      // 가로로 눕힌 카드 열 (큐 뱅크 Q_v/Q_t). grow=true면 sim 반복 시 새 카드가 밀려 들어옴
      const cnt = Math.min(Number(m.primitive_spec.count) || 6, 10);
      const qg = mvE("g");
      for (let k = cnt - 1; k >= 0; k--) {
        qg.appendChild(mvE("rect", { x: -pos.halfW + 12 + k * 10, y: cy - 16, width: 13, height: 32, rx: 3, fill: k === 0 ? PURPLE : "#fff", stroke: PURPLE, "stroke-width": "1.2", opacity: k === 0 ? "0.92" : String(0.75 - k * 0.04) }));
      }
      gfx.appendChild(qg);
      if (m.primitive_spec.grow) queueEls.push({ g: qg, baseX: 0 });
      gfx.appendChild(mvT(pos.halfW - 6, cy + 5, m.primitive_spec.label || "Q", { "text-anchor": "end", fill: PURPLE, "font-size": "10", "font-weight": "700" }));
    } else if (m.primitive === "dual_dist_box") {
      gfx.appendChild(mvSlab(-32, cy - 24, 64, 50, "#fff", "#c9b892", 7));
      const labels = Array.isArray(m.primitive_spec.labels) ? m.primitive_spec.labels : [];
      // P2: coeff 모드면 두 분포 간격이 gap(단일 소스)을 반영 — detail 패널 dual_dist와 같은 값. 비coeff는 기존 정적 곡선(AC-1 불변).
      const ddSep = ctrlMode === "coeff" ? [["#8c2f39", -(5 + gapValue() * 11)], ["#7c5cbf", 5 + gapValue() * 11]] : [["#8c2f39", -14], ["#7c5cbf", 12]];
      ddSep.forEach(([col, ox]) => {
        let d = `M${ox - 12} ${cy + 12}`;
        for (let t = 0; t <= 12; t++) { const x = ox - 12 + t * 2; const yy = cy + 12 - 26 * Math.exp(-Math.pow((t - 6) / 3, 2)); d += ` L${x} ${yy}`; }
        gfx.appendChild(mvE("path", { d, stroke: col, fill: "none", "stroke-width": "1.6" }));
      });
      if (labels.length) gfx.appendChild(mvT(0, cy + 22, mvCutPx(labels.slice(0, 2).join("·"), 58, 7.5), { "text-anchor": "middle", fill: FAINT, "font-size": "7.5", class: "mv-sub" }));
    } else { // op_box / switch_box — 이름 실측 폭 가변 박스, 이름은 박스 안(2줄 랩핑)
      labelBelow = false;
      const meta = boxMeta.get(i) || { boxW: 110, nameLines: [m.name || m.id], nameTrunc: false };
      const bw = meta.boxW, two = meta.nameLines.length > 1;
      const bh = two ? 54 : 46;
      const isSwitch = m.primitive === "switch_box";
      gfx.appendChild(mvSlab(-bw / 2, cy - bh / 2, bw, bh, "#fff", "#8c2f39", 7));
      meta.nameLines.forEach((ln, k) => {
        const t = mvT(isSwitch ? 8 : 0, cy - (two ? 8 : 2) + k * 11 - (isSwitch && !two ? 0 : 0), ln, { "text-anchor": "middle", fill: INK, "font-size": "10", "font-weight": "600" });
        if (meta.nameTrunc) { const ti = mvE("title"); ti.textContent = m.name || ""; t.appendChild(ti); } // 말줄임 시 hover로 전체
        gfx.appendChild(t);
      });
      let sub = m.sub || "";
      if (m.primitive_spec.dynamic_sub && spec.control) sub = `${spec.control.symbol || spec.control.param}=${S.eta}${spec.control.unit || ""}`;
      if (sub) gfx.appendChild(mvT(isSwitch ? 8 : 0, cy + (two ? 18 : 12), mvCutPx(sub, bw - 18, 9), { "text-anchor": "middle", fill: "#8c2f39", "font-size": "9", class: "mv-sub" }));
      if (isSwitch) {
        // 스위치 레버: alternating 출력 edge가 있으면 rAF에서 각도 토글
        const pivotX = -bw / 2 + 13;
        gfx.appendChild(mvE("circle", { cx: pivotX, cy: cy, r: 3.2, fill: "#8c2f39" }));
        const arm = mvE("line", { x1: pivotX, y1: cy, x2: pivotX + 11, y2: cy - 8, stroke: "#8c2f39", "stroke-width": "2.4", "stroke-linecap": "round" });
        gfx.appendChild(arm);
        if (spec.edges.some((e) => e.from === m.id && e.kind === "alternating")) altSwitches.push({ arm, pivotX, cy });
      }
    }
    // 이름 라벨(박스형 제외): 실측 2줄 랩핑 → 말줄임(+hover 전체), name_short 있으면 축소용으로 대체
    if (labelBelow) {
      const budget = Math.max(pos.halfW * 2 + 34, 96);
      const rawName = m.name || m.id;
      const wrap = mvWrapPx(rawName, budget, 9.5);
      const useShort = wrap.truncated && m.name_short;
      const finalWrap = useShort ? mvWrapPx(m.name_short, budget, 9.5) : wrap;
      finalWrap.lines.forEach((ln, k) => {
        const t = mvT(0, cy + 44 + k * 11, ln, { "text-anchor": "middle", fill: INK, "font-size": "9.5", "font-weight": "600" });
        if (finalWrap.truncated || useShort) { const ti = mvE("title"); ti.textContent = rawName; t.appendChild(ti); }
        lab.appendChild(t);
      });
      if (m.sub) {
        lab.appendChild(mvT(0, cy + 44 + finalWrap.lines.length * 11 + 1, mvCutPx(m.sub, budget, 8.5), { "text-anchor": "middle", fill: FAINT, "font-size": "8.5", class: "mv-sub" }));
      }
    }
    return g;
  }

  function refreshMods() {
    gMods.textContent = "";
    S.mods.clear();
    spec.modules.forEach((m, i) => { const g = drawModule(m, i); gMods.appendChild(g); S.mods.set(m.id, g); });
    applyHighlight();
    if (typeof decorateExpandable === "function") decorateExpandable(); // P2: expand 표시·클릭 재적용(모듈 재생성마다)
  }

  // ── 그룹(점선 라운드 박스) — 멤버 모듈 bbox 합집합 ──
  function drawGroups() {
    gGroups.textContent = ""; gGrpLab.textContent = "";
    (spec.groups || []).forEach((grp) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      grp.members.forEach((id) => {
        const i = idxOf(id); if (i < 0) return;
        const p = positions[i];
        x0 = Math.min(x0, p.cx - p.halfW - 12); y0 = Math.min(y0, p.cy - 66);
        x1 = Math.max(x1, p.cx + p.halfW + 12); y1 = Math.max(y1, p.cy + 68);
      });
      if (!isFinite(x0)) return;
      gGroups.appendChild(mvE("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 10, fill: "none", stroke: "#b7a680", "stroke-width": "1.2", "stroke-dasharray": grp.style === "dashed" ? "6 4" : "" }));
      if (grp.label) {
        gGrpLab.appendChild(mvT(x0 + 8, y0 - 5, grp.label, { fill: "#8c2f39", "font-size": "9", "font-weight": "700", "paint-order": "stroke", stroke: "#fbf7f0", "stroke-width": "3" }));
        bb.add(x0, y0 - 16, x0 + mvTextW(grp.label, 9) + 10, y0);
      }
      bb.add(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    });
  }

  // ── 엣지: rank 인접은 직선/S-커브, 건너뛰기는 위 직교 우회, gradient 회귀는 아래 직교 우회 ──
  const altEdgeEls = []; // alternating 엣지 (rAF 토글)
  const textBadges = []; // P3: text 모드에서 슬라이더로 N값 갱신되는 loop_badge (pill+text 참조)
  function drawEdges() {
    gEdges.textContent = ""; gEdgeLab.textContent = "";
    const contentBottom = Math.max(...positions.map((p) => p.cy + 74));
    const contentTop = Math.min(...positions.map((p) => p.cy - 72));
    let gradIdx = 0, skipIdx = 0;
    const pairSeen = new Map(); // 같은 (from,to) 다중 edge 세로 오프셋
    const gateSeen = new Map(); // 게이트 X 분산 — 키: 열(cx)+방향 (같은 열 세로선 충돌 방지)
    const jogSeen = new Map();   // jog Y·부착점 분산 — 키: 모듈(cy)+방향 (한 모듈에 모이는 것만 분산, 다른 레인 불간섭)
    spec.edges.forEach((e) => {
      const ti = idxOf(e.to); if (ti < 0) return;
      const b = positions[ti];
      const col = e.kind === "gradient" ? "#8c2f39" : e.kind === "frozen" ? "#c2b8a2" : "#6b6258";
      const dash = e.kind === "forward" || e.kind === "alternating" ? "" : e.kind === "gradient" ? "5 4" : "3 4";
      const mk = e.kind === "gradient" ? "url(#mviz-arrow1)" : "url(#mviz-arrow0)";
      let d, lx, ly, len;
      if (idxOf(e.from) < 0) {
        const x2 = b.cx - b.halfW - 6;
        d = `M${x2 - 30} ${b.cy} L${x2} ${b.cy}`; lx = x2 - 15; ly = b.cy - 9; len = 30;
        bb.add(x2 - 34, b.cy - 14, x2, b.cy + 4);
      } else {
        const fi = idxOf(e.from);
        const a = positions[fi];
        const key = e.from + ">" + e.to;
        const off = (pairSeen.get(key) || 0) * 9; pairSeen.set(key, (pairSeen.get(key) || 0) + 1);
        const dr = rank[ti] - rank[fi];
        if (a.row !== b.row) { // serpentine 줄 건너 S-커브
          const down = b.cy > a.cy;
          const y1 = a.cy + (down ? 70 : -64), y2 = b.cy + (down ? -64 : 70);
          d = `M${a.cx} ${y1} C${a.cx} ${y1 + (down ? 56 : -56)} ${b.cx} ${y2 + (down ? -56 : 56)} ${b.cx} ${y2}`;
          lx = (a.cx + b.cx) / 2; ly = (y1 + y2) / 2; len = Math.hypot(b.cx - a.cx, y2 - y1);
          bb.add(Math.min(a.cx, b.cx) - 6, Math.min(y1, y2) - 6, Math.max(a.cx, b.cx) + 6, Math.max(y1, y2) + 6);
        } else if (e.kind === "gradient" && dr <= 0) {
          // 회귀: 아래 외곽으로 직교 우회 — 세로선은 컬럼 바깥(게이트)으로 빼 모듈 관통·상호 겹침 금지
          const outY = contentBottom + 26 + gradIdx * 14; gradIdx++;
          const goLeft = b.cx <= a.cx;
          // 게이트 X는 열(cx)별로, jog Y·부착점은 모듈(cy)별로 각각 순번만큼 벌린다
          const sGk = a.cx + (goLeft ? "L" : "R"), tGk = b.cx + (goLeft ? "R" : "L");
          const skG = gateSeen.get(sGk) || 0; gateSeen.set(sGk, skG + 1);
          const tkG = gateSeen.get(tGk) || 0; gateSeen.set(tGk, tkG + 1);
          const sJk = a.cy + (goLeft ? "L" : "R"), tJk = b.cy + (goLeft ? "R" : "L");
          const skJ = jogSeen.get(sJk) || 0; jogSeen.set(sJk, skJ + 1);
          const tkJ = jogSeen.get(tJk) || 0; jogSeen.set(tJk, tkJ + 1);
          const sGate = a.cx + (goLeft ? -(a.halfW + 12 + skG * 13) : a.halfW + 12 + skG * 13);
          const tGate = b.cx + (goLeft ? b.halfW + 12 + tkG * 13 : -(b.halfW + 12 + tkG * 13));
          const sJog = a.cy + 78 + skJ * 7, tJog = b.cy + 78 + tkJ * 7; // 레인 간극(74~92) 안
          const sx = a.cx - 7 - skJ * 6, tx = b.cx + 7 + tkJ * 6; // 부착점도 어긋나게(공선 겹침 방지)
          d = `M${sx} ${a.cy + 70} L${sx} ${sJog} L${sGate} ${sJog} L${sGate} ${outY} L${tGate} ${outY} L${tGate} ${tJog} L${tx} ${tJog} L${tx} ${b.cy + 74}`;
          lx = (sGate + tGate) / 2; ly = outY - 4; len = Math.abs(tGate - sGate);
          bb.add(Math.min(sGate, tGate, a.cx, b.cx) - 6, a.cy, Math.max(sGate, tGate, a.cx, b.cx) + 6, outY + 8);
        } else if (Math.abs(dr) > 1) {
          // rank 건너뛰기: 위 외곽으로 직교 우회 — 세로선은 컬럼 바깥(게이트)
          const outY = contentTop - 22 - skipIdx * 14; skipIdx++;
          const goLeft = b.cx <= a.cx;
          const sGk = a.cx + (goLeft ? "L" : "R"), tGk = b.cx + (goLeft ? "R" : "L");
          const skG = gateSeen.get(sGk) || 0; gateSeen.set(sGk, skG + 1);
          const tkG = gateSeen.get(tGk) || 0; gateSeen.set(tGk, tkG + 1);
          const sJk = a.cy + (goLeft ? "L" : "R"), tJk = b.cy + (goLeft ? "R" : "L");
          const skJ = jogSeen.get(sJk) || 0; jogSeen.set(sJk, skJ + 1);
          const tkJ = jogSeen.get(tJk) || 0; jogSeen.set(tJk, tkJ + 1);
          const sGate = a.cx + (goLeft ? -(a.halfW + 12 + skG * 13) : a.halfW + 12 + skG * 13);
          const tGate = b.cx + (goLeft ? b.halfW + 12 + tkG * 13 : -(b.halfW + 12 + tkG * 13));
          const sJog = a.cy - 76 - skJ * 7, tJog = b.cy - 76 - tkJ * 7; // 레인 간극(−90~−72) 안
          const sx = a.cx - 7 - skJ * 6, tx = b.cx + 7 + tkJ * 6;
          d = `M${sx} ${a.cy - 64} L${sx} ${sJog} L${sGate} ${sJog} L${sGate} ${outY} L${tGate} ${outY} L${tGate} ${tJog} L${tx} ${tJog} L${tx} ${b.cy - 64}`;
          lx = (sGate + tGate) / 2; ly = outY - 4; len = Math.abs(tGate - sGate);
          bb.add(Math.min(sGate, tGate, a.cx, b.cx) - 6, outY - 14, Math.max(sGate, tGate, a.cx, b.cx) + 6, b.cy);
        } else {
          // 인접 rank: 수평 or 세로차 S-커브 (+같은 쌍 다중 edge는 세로 오프셋 분리)
          // 방향 인식 — serpentine 아래줄처럼 타깃이 왼쪽이면 소스 왼쪽→타깃 오른쪽(마주 보는 변)에서 잇는다
          const leftward = b.cx < a.cx;
          const x1 = a.cx + (leftward ? -(a.halfW + 5) : a.halfW + 5);
          const x2 = b.cx + (leftward ? b.halfW + 5 : -(b.halfW + 5));
          const y1 = a.cy + off, y2 = b.cy + off;
          if (Math.abs(y1 - y2) < 4) { d = `M${x1} ${y1} L${x2} ${y2}`; }
          // 제어점을 가운데 몰지 않고 분산 → 수직으로 길게 붙지 않는 대각 S(우회 세로선과 나란히 겹침 완화)
          else { const c1 = x1 + (x2 - x1) * 0.28, c2 = x1 + (x2 - x1) * 0.72; d = `M${x1} ${y1} C${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`; }
          lx = (x1 + x2) / 2; ly = Math.min(y1, y2) - 8 + (off ? off + 16 : 0); len = Math.hypot(x2 - x1, y2 - y1);
          bb.add(Math.min(x1, x2) - 4, Math.min(y1, y2) - 16, Math.max(x1, x2) + 4, Math.max(y1, y2) + 6);
        }
      }
      const path = mvE("path", { d, stroke: col, fill: "none", "stroke-width": "1.6", "stroke-dasharray": dash, "marker-end": mk, "data-kind": e.kind, "data-from": e.from, "data-to": e.to });
      gEdges.appendChild(path);
      if (e.kind === "alternating") altEdgeEls.push(path);
      if (e.label) {
        if (len >= 70) {
          gEdgeLab.appendChild(mvT(lx, ly, mvCutPx(e.label, 90, 8.5), {
            "text-anchor": "middle", fill: col, "font-size": "8.5", class: "mv-elabel",
            "paint-order": "stroke", stroke: "#fbf7f0", "stroke-width": "3", "stroke-linejoin": "round",
          }));
        } else { const ti2 = mvE("title"); ti2.textContent = e.label; path.appendChild(ti2); } // 짧은 엣지는 hover로
      }
      // P3-a: loop_badge — 엣지 중점 아래 알약 배지. text 모드이고 affects에 이 엣지 모듈이 있으면 N=슬라이더 값
      if (e.badge && e.badge.text) {
        const affected = ctrlMode === "text" && spec.control && (spec.control.affects.includes(e.to) || spec.control.affects.includes(e.from));
        const unit = (spec.control && spec.control.unit) || ""; // 접미사는 스펙의 unit 사용(× 날조 금지)
        const btxt = affected ? `${S.eta}${unit}` : String(e.badge.text);
        const by = ly + (e.label && len >= 70 ? 15 : 2); // 라벨 있으면 그 아래로 분리
        const bw = mvTextW(btxt, 8.5) + 12;
        const pill = mvE("rect", { x: lx - bw / 2, y: by - 8, width: bw, height: 15, rx: 7.5, fill: "#fbf7f0", stroke: "#8c2f39", "stroke-width": "1" });
        const ptxt = mvT(lx, by + 3.2, btxt, { "text-anchor": "middle", fill: "#8c2f39", "font-size": "8.5", "font-weight": "600" });
        gEdgeLab.append(pill, ptxt);
        bb.add(lx - bw / 2 - 2, by - 10, lx + bw / 2 + 2, by + 8); // fit-to-view가 배지를 자르지 않게(AC-5)
        if (affected) textBadges.push({ pill, ptxt, unit, cx: lx });
      }
    });
  }
  // text 모드: 슬라이더 조작 시 배지 N값만 갱신(파이프라인 그래픽 불변 — AC-3)
  function updateBadges() {
    textBadges.forEach((b) => {
      const t = `${S.eta}${b.unit}`; b.ptxt.textContent = t;
      const w = mvTextW(t, 8.5) + 12;
      b.pill.setAttribute("x", b.cx - w / 2); b.pill.setAttribute("width", w);
    });
  }

  function applyHighlight() {
    // P3: S.stepIdx는 effSteps(내부 스텝 삽입 반영) 인덱스다. 내부 스텝이면 상위 파이프라인에서는 부모 모듈을 강조한다.
    const es = (typeof effSteps !== "undefined") ? effSteps[S.stepIdx] : null;
    const active = es ? (es.internal ? es.parentId : (es.step && es.step.module)) : (spec.steps[S.stepIdx] && spec.steps[S.stepIdx].module);
    S.mods.forEach((g, id) => {
      const on = !active || id === active;
      if (g.__gfx) g.__gfx.setAttribute("opacity", on ? "1" : "0.5");
      if (g.__lab) g.__lab.setAttribute("opacity", on ? "1" : "0.75");
    });
  }
  // P2.5: 패널이 열릴 때 내부 모듈을 흐름 순서대로 1회 순차 하이라이트(방향만) — 입자 대체
  const _seqTimers = [];
  function sequentialHighlight() {
    _seqTimers.forEach(clearTimeout); _seqTimers.length = 0;
    if (S.reduce || !S.mods.size) return;
    const ids = spec.modules.map((m) => m.id);
    ids.forEach((id, k) => _seqTimers.push(setTimeout(() => { S.mods.forEach((g, gid) => { if (g.__gfx) g.__gfx.setAttribute("opacity", gid === id ? "1" : "0.4"); }); }, k * 150)));
    _seqTimers.push(setTimeout(() => applyHighlight(), ids.length * 150 + 200));
  }

  // ── 스테퍼 + desc + detail 패널 ──
  const stepBar = document.createElement("div");
  stepBar.className = "mviz-stepbar";
  const stepInfo = document.createElement("div");
  stepInfo.className = "mviz-stepinfo";
  const detailWrap = document.createElement("div");
  detailWrap.className = "mviz-detail";
  const detailSvg = mvE("svg", { viewBox: "0 0 320 136", class: "mviz-detail-svg", preserveAspectRatio: "xMidYMid meet" });
  const detailCap = document.createElement("div");
  detailCap.className = "mviz-detail-cap";
  detailWrap.append(detailSvg, detailCap);

  // P3: 계층 스테퍼 — 유효 스텝 목록(내부 스텝 삽입 반영). {step, label, internal, parentId, ctrl}
  let effSteps = spec.steps.map((s, i) => ({ step: s, label: String(i + 1), internal: false, parentId: null, ctrl: null }));
  function drawDetail(stepArg) {
    const step = stepArg || (effSteps[S.stepIdx] && effSteps[S.stepIdx].step) || spec.steps[S.stepIdx]; if (!step) return;
    const dv = step.detail_viz || {};
    detailSvg.textContent = "";
    const g = mvE("g"); detailSvg.appendChild(g);
    const INK = "#211d19", FAINT = "#9b9285", ACC = "#8c2f39", TAN = "#c9b892";
    const type = dv.type;
    try {
      if (type === "pixel_grid") {
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const dist = Math.hypot(r - 3.5, c - 3.5) / 5;
          g.appendChild(mvE("rect", { x: 112 + c * 12, y: 12 + r * 12, width: 11, height: 11, fill: ACC, opacity: (1 - dist).toFixed(2) }));
        }
      } else if (type === "activation_bars") {
        // P3-b: groups 배열 [{label,count}] (신) 또는 {n,label}(구, 하위호환). 막대 총수 = count 합계.
        let grp = Array.isArray(dv.groups) ? dv.groups : (dv.spec && Array.isArray(dv.spec.groups) ? dv.spec.groups : null);
        if (!grp && dv.groups && Number(dv.groups.n) >= 2) {
          const nn = mvClamp(Math.round(Number(dv.groups.n)), 2, 12), pr = Math.max(1, Math.round(12 / nn));
          grp = Array.from({ length: nn }, (_, i) => ({ label: `${dv.groups.label || ""}${i + 1}`, count: pr }));
        }
        grp = grp && grp.length ? grp.map((x) => ({ label: String(x.label || ""), count: mvClamp(Math.round(Number(x.count) || 1), 1, 20) })) : null;
        const K = grp ? grp.reduce((a, x) => a + x.count, 0) : 12;
        const bw = 296 / K;
        const rv = (k) => { const x = Math.sin(k * 91.7 + S.stepIdx * 13.1) * 43758.5; return x - Math.floor(x); };
        for (let k = 0; k < K; k++) { const h = 12 + rv(k) * 86; g.appendChild(mvE("rect", { x: 12 + k * bw + 1, y: 110 - h, width: Math.max(2, bw - 2), height: h, rx: 2, fill: TAN, stroke: "#b7a680" })); }
        if (grp) {
          let acc = 0;
          grp.forEach((gg, gi) => {
            const x0 = 12 + acc * bw, x1 = 12 + (acc + gg.count) * bw;
            if (gi > 0) g.appendChild(mvE("line", { x1: x0, y1: 14, x2: x0, y2: 112, stroke: FAINT, "stroke-dasharray": "3 3", opacity: "0.6" }));
            // 폭이 한 글자도 안 되면 라벨 생략(구분선만) — '…'만 남는 붕괴 방지
            if (x1 - x0 - 2 >= 14) g.appendChild(mvT((x0 + x1) / 2, 126, mvCutPx(gg.label, x1 - x0 - 2, 7.5), { "text-anchor": "middle", fill: FAINT, "font-size": "7.5" }));
            acc += gg.count;
          });
        }
      } else if (type === "histogram") {
        const bins = new Array(10).fill(0); S.scores.forEach((v) => bins[mvClamp(Math.floor(v * 10), 0, 9)]++);
        const mx = Math.max(1, ...bins);
        bins.forEach((b, k) => { const h = (b / mx) * 96; g.appendChild(mvE("rect", { x: 24 + k * 28, y: 116 - h, width: 22, height: h, rx: 2, fill: "#7c5cbf" })); });
      } else if (type === "sorted_threshold") {
        const sorted = S.scores.slice().sort((a, b) => b - a);
        const keep = keepCount(), removeN = C - keep;
        const bw = Math.max(3, 296 / C);
        sorted.forEach((v, k) => {
          const survive = dirRemove() ? k >= removeN : k < keep;
          g.appendChild(mvE("rect", { x: 12 + k * bw, y: 116 - v * 96, width: bw - 1, height: v * 96, fill: survive ? ACC : "#d8cfbc", opacity: survive ? "1" : "0.75" }));
        });
        const boundary = dirRemove() ? removeN : keep;
        const tx = 12 + boundary * bw;
        const sym = (spec.control && (spec.control.symbol || spec.control.param)) || "η";
        const unit = (spec.control && spec.control.unit) || "";
        g.append(mvE("line", { x1: tx, y1: 8, x2: tx, y2: 116, stroke: ACC, "stroke-width": "1.5", "stroke-dasharray": "4 3" }),
          mvT(mvClamp(tx + 3, 12, 236), 16, `${sym}=${S.eta}${unit} ${dirRemove() ? "제거" : "유지"}`, { fill: ACC, "font-size": "10", "font-weight": "600", "paint-order": "stroke", stroke: "#fbf7f0", "stroke-width": "3" }));
      } else if (type === "slab_mask") {
        const mask = maskOf();
        const bw = Math.max(8, 300 / C);
        mask.forEach((mk2, k) => g.appendChild(mvE("rect", { x: 12 + k * bw, y: 40, width: bw - 3, height: 52, rx: 2, fill: mk2 ? "#e7dcc3" : "#fff", stroke: mk2 ? "#b7a680" : "#d8cfbc", "stroke-dasharray": mk2 ? "" : "3 2", opacity: mk2 ? "1" : "0.6" })));
      } else if (type === "convergence_curve") {
        // coeff 모드면 계수 c가 클수록 곡선이 가파름(같은 반복 수 대비 더 수렴) — 비coeff는 k=0.1로 기존과 동일
        const k = ctrlMode === "coeff" ? 0.05 + 0.16 * coeffC() : 0.1;
        let d = "M12 108"; for (let t = 0; t <= 40; t++) { const x = 12 + t * 7.4; const yy = 108 - 92 * (1 - Math.exp(-t * k)); d += ` L${x} ${yy}`; }
        g.appendChild(mvE("path", { d, stroke: ACC, fill: "none", "stroke-width": "2" }));
        const it = Math.min(40, S.iter); const px = 12 + it * 7.4, py = 108 - 92 * (1 - Math.exp(-it * k));
        g.appendChild(mvE("circle", { cx: px, cy: py, r: 4, fill: ACC }));
        g.appendChild(mvT(px + 6, py - 4, `iter ${S.iter}`, { fill: FAINT, "font-size": "9" }));
      } else if (type === "summary_rows") {
        const rows = [];
        if (hasDirection) rows.push(["활성 채널", `${keepCount()} / ${C}`]);
        rows.push(["학습 반복", `${S.iter}회`]);
        if (hasDirection) rows.push(["마스크 변동", `${S.flips}`]);
        else rows.push(["정성 지표", `${simMetric().toFixed(2)} (예시)`]);
        rows.forEach((row, k) => {
          g.append(mvT(20, 36 + k * 30, row[0], { fill: FAINT, "font-size": "12" }), mvT(300, 36 + k * 30, row[1], { fill: INK, "font-size": "13", "font-weight": "700", "text-anchor": "end" }));
        });
      } else if (type === "dual_dist") {
        // P2: 두 집단 분포 대비. 미니 dual_dist_box와 동일 게이트 — coeff면 gapValue(단일 소스), 아니면 정적(gap=1)로 일치.
        const gap = ctrlMode === "coeff" ? gapValue() : 1;
        const mid = 160, sep = 22 + gap * 92, base = 116, amp = 80, sd = 25;
        const cA = mid - sep / 2, cB = mid + sep / 2;
        const bell = (cen, col) => {
          let d = `M${cen - 52} ${base}`;
          for (let x = -52; x <= 52; x += 4) d += ` L${cen + x} ${base - amp * Math.exp(-(x * x) / (2 * sd * sd))}`;
          d += ` L${cen + 52} ${base} Z`;
          return mvE("path", { d, fill: col, opacity: "0.32", stroke: col, "stroke-width": "1.6" });
        };
        const ddMod = spec.modules.find((mm) => mm.primitive === "dual_dist_box");
        const labels = (ddMod && Array.isArray(ddMod.primitive_spec.labels) && ddMod.primitive_spec.labels.length) ? ddMod.primitive_spec.labels : ["분포 A", "분포 B"];
        g.append(bell(cA, ACC), bell(cB, "#7c5cbf"));
        g.append(
          mvE("line", { x1: cA, y1: 18, x2: cB, y2: 18, stroke: FAINT, "stroke-dasharray": "3 3" }),
          mvT(mid, 13, `격차 ${gap.toFixed(2)}`, { "text-anchor": "middle", fill: FAINT, "font-size": "9", "paint-order": "stroke", stroke: "#fbf7f0", "stroke-width": "3" }),
          mvT(cA, base + 13, mvCutPx(labels[0] || "A", 90, 9.5), { "text-anchor": "middle", fill: ACC, "font-size": "9.5" }),
          mvT(cB, base + 13, mvCutPx(labels[1] || "B", 90, 9.5), { "text-anchor": "middle", fill: "#7c5cbf", "font-size": "9.5" }));
      } else { // transform
        const mod = spec.modules.find((mm) => mm.id === step.module) || {};
        const prev = spec.modules[idxOf(step.module) - 1];
        const box = (x, label, sub, col) => {
          const gg = mvE("g");
          gg.appendChild(mvE("rect", { x, y: 44, width: 96, height: 44, rx: 6, fill: "#fff", stroke: col }));
          gg.appendChild(mvT(x + 48, 62, mvCutPx(label || "", 88, 9.5), { "text-anchor": "middle", fill: INK, "font-size": "9.5", "font-weight": "600" }));
          if (sub) gg.appendChild(mvT(x + 48, 76, mvCutPx(sub, 88, 8), { "text-anchor": "middle", fill: FAINT, "font-size": "8" }));
          return gg;
        };
        g.append(box(6, prev ? prev.name : "입력", prev ? prev.data_state : "", "#c9b892"),
          mvT(160, 40, mvCutPx(mod.name || "", 110, 9), { "text-anchor": "middle", fill: ACC, "font-size": "9" }),
          mvE("path", { d: "M104 66 L120 66", stroke: ACC, "stroke-width": "1.5", "marker-end": "url(#mviz-arrow1)" }),
          mvE("path", { d: "M200 66 L216 66", stroke: ACC, "stroke-width": "1.5", "marker-end": "url(#mviz-arrow1)" }),
          box(218, mod.name || "출력", mod.data_state || "", "#8c2f39"));
      }
    } catch (e) { g.appendChild(mvT(160, 66, "(시각화 생략)", { "text-anchor": "middle", fill: FAINT, "font-size": "11" })); }
    detailCap.textContent = dv.caption || "";
  }

  function renderStepInfo() {
    const es = effSteps[S.stepIdx]; if (!es) return; const step = es.step;
    stepInfo.innerHTML = "";
    const t = document.createElement("h4"); t.className = "mviz-step-title" + (es.internal ? " mviz-step-internal" : "");
    t.textContent = `${es.label}. ${step.title || ""}`;
    const d = document.createElement("p"); d.className = "mviz-step-desc";
    renderRich(d, step.desc || "");
    stepInfo.append(t, d);
    if (!es.internal) { const mod = spec.modules.find((m) => m.id === step.module);
      if (mod && mod.expand && (mod.expand.steps || []).length && openState.id !== mod.id) {
        const b = mvBtn("⤢ 내부 단계 보기", "내부 파이프라인을 펼치고 단계를 삽입", () => toggleExpand(mod));
        b.classList.add("mviz-instep-btn"); stepInfo.appendChild(b);
      } }
  }
  function goStep(i) {
    S.stepIdx = mvClamp(i, 0, effSteps.length - 1);
    const es = effSteps[S.stepIdx]; if (!es) return;
    posEl.textContent = `${es.label} / ${effSteps.length}`;
    if (es.internal && es.ctrl) {
      S.mods.forEach((g, id) => { const on = id === es.parentId; if (g.__gfx) g.__gfx.setAttribute("opacity", on ? "1" : "0.4"); if (g.__lab) g.__lab.setAttribute("opacity", on ? "1" : "0.6"); });
      try { const pm = es.step.module; es.ctrl.S.mods.forEach((g, id) => { const on = id === pm; if (g.__gfx) g.__gfx.setAttribute("opacity", on ? "1" : "0.45"); }); } catch (e) {}
      renderStepInfo(); drawDetail(es.step);
    } else { applyHighlight(); renderStepInfo(); drawDetail(); }
  }
  const updateStepUI = () => { const es = effSteps[S.stepIdx]; if (es) posEl.textContent = `${es.label} / ${effSteps.length}`; };
  const _insertSteps = (m) => { _removeSteps();
    const pi = effSteps.findIndex((e) => !e.internal && e.step.module === m.id);
    if (pi < 0 || !m.expand || !(m.expand.steps || []).length || !openState.ctrl) { updateStepUI(); return; }
    const plabel = effSteps[pi].label;
    const inserts = m.expand.steps.map((s, k) => ({ step: s, label: `${plabel}.${k + 1}`, internal: true, parentId: m.id, ctrl: openState.ctrl }));
    effSteps.splice(pi + 1, 0, ...inserts); if (!panel) goStep(pi + 1); else updateStepUI(); // 첫 내부 스텝으로 이동
  };
  const _removeSteps = () => { const cur = effSteps[S.stepIdx]; effSteps = effSteps.filter((e) => !e.internal);
    if (cur && cur.internal) { const pi = effSteps.findIndex((e) => e.step.module === cur.parentId); S.stepIdx = pi >= 0 ? pi : mvClamp(S.stepIdx, 0, effSteps.length - 1); }
    else if (cur) { S.stepIdx = mvClamp(effSteps.indexOf(cur), 0, Math.max(0, effSteps.length - 1)); } updateStepUI();
  };

  // 스테퍼 버튼
  const prevB = mvBtn("◀", "이전 단계", () => goStep(S.stepIdx - 1));
  const nextB = mvBtn("▶", "다음 단계", () => goStep(S.stepIdx + 1));
  const playB = mvBtn("⏵ 자동", "자동 재생", () => togglePlay());
  const posEl = document.createElement("span"); posEl.className = "mviz-pos";
  stepBar.append(prevB, posEl, nextB, playB);
  function togglePlay() {
    if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = 0; playB.textContent = "⏵ 자동"; return; }
    playB.textContent = "⏸ 정지";
    S.playTimer = setInterval(() => { if (S.stepIdx >= effSteps.length - 1) { goStep(0); } else goStep(S.stepIdx + 1); }, 2200);
  }

  // ── 컨트롤 바 (control + sim + 스키마 주도 리드아웃) ──
  const ctrlBar = document.createElement("div");
  ctrlBar.className = "mviz-ctrl";
  if (spec.control) {
    const c = spec.control;
    const lab = document.createElement("label"); lab.className = "mviz-ctrl-lab";
    lab.textContent = c.label || `${c.symbol || c.param}`;
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = c.min; slider.max = c.max; slider.step = c.step; slider.value = S.eta;
    const val = document.createElement("span"); val.className = "mviz-ctrl-val";
    val.textContent = `${S.eta}${c.unit || ""}`;
    slider.addEventListener("input", () => {
      S.eta = Number(slider.value); val.textContent = `${S.eta}${c.unit || ""}`;
      refreshMods(); drawDetail(); updateReadout(); updateBadges();
      try { if (openState.ctrl && openState.ctrl.updateFromControl) openState.ctrl.updateFromControl(S.eta); } catch (e) {} // P2.6: 열린 패널도 갱신
    });
    lab.title = c.semantics || "";
    ctrlBar.append(lab, slider, val);
  }
  // 리드아웃: 스펙(sim.readouts) 정의가 있으면 그것만, 없으면 기본(마스크 의미가 있을 때만 '활성')
  const readout = document.createElement("span"); readout.className = "mviz-readouts";
  const readoutItems = (() => {
    if (spec.sim.readouts && spec.sim.readouts.length) {
      return spec.sim.readouts
        .filter((r) => r && typeof r === "object" && r.label)
        .slice(0, 4)
        .map((r) => ({ label: String(r.label), source: String(r.source || "iter"), format: r.format ? String(r.format) : null }));
    }
    const items = [];
    if (hasDirection) items.push({ label: "활성", source: "keep_frac" });
    items.push({ label: "학습 반복", source: "iter" });
    if (hasDirection) items.push({ label: "마스크 변동", source: "flips" });
    return items;
  })();
  const readoutValue = (r) => {
    switch (r.source) {
      case "keep_frac": case "mask_count": return `${keepCount()}/${C}`;
      case "control": return `${S.eta}${(spec.control && spec.control.unit) || ""}`;
      case "flips": return String(S.flips);
      case "sim_metric": {
        const v = simMetric();
        return r.format ? r.format.replace(/0\.0+/, v.toFixed((r.format.match(/0\.(0+)/) || [, "00"])[1].length)) : v.toFixed(2);
      }
      default: return String(S.iter); // iter
    }
  };
  function updateReadout() {
    readout.innerHTML = "";
    readoutItems.forEach((r) => {
      const s = document.createElement("span");
      s.className = "mviz-ro";
      s.innerHTML = `<b>${escapeHtmlAttr(r.label)}</b> ${escapeHtmlAttr(readoutValue(r))}`;
      readout.appendChild(s);
    });
  }
  const simB = mvBtn("↻ 학습 1회 반복", "정성 시뮬레이션 한 스텝", () => { simStep(); refreshMods(); drawDetail(); updateReadout(); });
  const resetB = mvBtn("초기화", "시뮬레이션 리셋", () => { resetScores(); refreshMods(); drawDetail(); updateReadout(); });
  simB.classList.add("mviz-sim"); resetB.classList.add("mviz-reset");
  ctrlBar.append(simB, resetB, readout);

  // disclaimer 각주
  const foot = document.createElement("p");
  foot.className = "mviz-foot";
  foot.textContent = spec.sim.disclaimer || "내부 시각화 값은 논문의 정성적 패턴을 반영한 예시이며 실제 학습 수치가 아닙니다.";

  // ── 좌우 분할: 왼쪽 = 파이프라인, 오른쪽 = 스테퍼·단계 설명·세부 시각화 ──
  const split = document.createElement("div");
  split.className = "mviz-split";
  const divider = document.createElement("div");
  divider.className = "mviz-divider";
  divider.title = "드래그해서 좌우 비율 조절";
  const rightPane = document.createElement("div");
  rightPane.className = "mviz-right";
  rightPane.append(stepBar, stepInfo, detailWrap);
  split.append(stage, divider, rightPane);

  let splitRatio = 0.58, splitH = 380;
  try {
    const r = Number(localStorage.getItem("mvizSplit"));
    if (r >= 0.25 && r <= 0.75) splitRatio = r;
    const h = Number(localStorage.getItem("mvizHeight"));
    if (h >= 240 && h <= 760) splitH = h;
  } catch {}
  const applySplit = () => { stage.style.flex = `0 0 calc(${(splitRatio * 100).toFixed(1)}% - 5px)`; };
  const applyHeight = () => { split.style.height = `${Math.round(splitH)}px`; };
  applySplit(); applyHeight();

  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { divider.setPointerCapture(e.pointerId); } catch {}
    const onMove = (ev) => {
      const r = split.getBoundingClientRect();
      if (r.width > 0) { splitRatio = mvClamp((ev.clientX - r.left) / r.width, 0.25, 0.75); applySplit(); }
    };
    const onUp = () => {
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      try { localStorage.setItem("mvizSplit", splitRatio.toFixed(3)); } catch {}
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
  });

  const hHandle = document.createElement("div");
  hHandle.className = "mviz-hresize";
  hHandle.title = "드래그해서 시각화 높이 조절";
  hHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { hHandle.setPointerCapture(e.pointerId); } catch {}
    const y0 = e.clientY, h0 = splitH;
    const onMove = (ev) => { splitH = mvClamp(h0 + (ev.clientY - y0), 240, 760); applyHeight(); };
    const onUp = () => {
      hHandle.removeEventListener("pointermove", onMove);
      hHandle.removeEventListener("pointerup", onUp);
      try { localStorage.setItem("mvizHeight", String(Math.round(splitH))); } catch {}
    };
    hHandle.addEventListener("pointermove", onMove);
    hHandle.addEventListener("pointerup", onUp);
  });

  // P2: expand 패널이 펼쳐질 영역(파이프라인 바로 아래) — 지연 렌더(처음 열릴 때만 생성)
  const expandArea = document.createElement("div"); expandArea.className = "mviz-expand-area";
  if (panel) wrap.append(stage, expandArea); else wrap.append(split, hHandle, expandArea, ctrlBar, foot);

  // ── P2: expand 인라인 확장 UI (지연 렌더 · 한 경로만 열림 · 부모 하이라이트 · 화면고정 배지) ──
  const openState = { id: null, ctrl: null, panelEl: null };
  const expandBadges = new Map();
  const hasExpandable = spec.modules.some((m) => m.expand);
  // 패널 QA 리포트 싱크는 상위 뷰 수명에 고정한다(레벨0 렌더마다 초기화 — 세션 무한 누적 방지).
  if (!panel) { try { window.__vizQAPanels = []; } catch (e) {} }
  function decorateExpandable() {
    if (!hasExpandable) return;
    spec.modules.forEach((m) => { if (!m.expand) return; const g = S.mods.get(m.id), p = positions[idxOf(m.id)]; if (!g || !p) return;
      const r = mvE("rect", { x: -p.halfW - 5, y: 118 - 54, width: p.halfW * 2 + 10, height: 90, rx: 7, fill: "none", stroke: "#8c2f39", "stroke-width": openState.id === m.id ? "2.8" : "1.8", "vector-effect": "non-scaling-stroke", "stroke-dasharray": openState.id === m.id ? "" : "5 3", class: "mviz-expand-border" });
      g.insertBefore(r, g.firstChild); if (g.style) g.style.cursor = "pointer";
      g.addEventListener("click", (ev) => { ev.stopPropagation(); toggleExpand(m); });
    });
    ensureBadges();
  }
  function ensureBadges() { spec.modules.forEach((m) => { if (!m.expand || expandBadges.has(m.id)) return;
    const b = document.createElement("button"); b.type = "button"; b.className = "mviz-expand-badge"; b.textContent = "⤢"; b.title = "내부 파이프라인 펼치기";
    b.addEventListener("click", (ev) => { ev.stopPropagation(); const mm = spec.modules.find((x) => x.id === m.id); toggleExpand(mm); });
    stage.appendChild(b); expandBadges.set(m.id, b); }); }
  function positionBadges() { if (!expandBadges.size) return; let sr; try { sr = stage.getBoundingClientRect(); } catch (e) { return; }
    expandBadges.forEach((b, id) => { const g = S.mods.get(id); if (!g || !g.__gfx) { b.style.display = "none"; return; }
      try { const gr = g.__gfx.getBoundingClientRect(); if (!gr.width) { b.style.display = "none"; return; }
        b.style.display = ""; b.style.left = (gr.right - sr.left - 8) + "px"; b.style.top = (gr.top - sr.top - 4) + "px"; b.textContent = openState.id === id ? "✕" : "⤢"; b.classList.toggle("open", openState.id === id);
      } catch (e) { b.style.display = "none"; } }); }
  function markOpen(id, on) { const g = S.mods.get(id); if (!g) return; const bd = g.querySelector(".mviz-expand-border");
    if (bd) { bd.setAttribute("stroke-width", on ? "2.8" : "1.8"); bd.setAttribute("stroke-dasharray", on ? "" : "5 3"); } if (on && g.__gfx) g.__gfx.setAttribute("opacity", "1"); }
  function toggleExpand(m) {
    if (!m || !m.expand) return;
    if (openState.id === m.id) { closePanel(); return; }
    if (openState.id) closePanel();
    openState.id = m.id; markOpen(m.id, true);
    const mini = { modules: m.expand.modules, edges: m.expand.edges, steps: m.expand.steps || [], groups: [], section_ref: m.expand.source_ref, sim: {}, paper_type_primary: spec.paper_type_primary || spec.paper_type };
    const panelWrap = document.createElement("div"); panelWrap.className = "mviz-panel";
    const head = document.createElement("div"); head.className = "mviz-panel-head";
    head.innerHTML = `<span class="mviz-panel-title">▸ ${escapeHtmlAttr(m.name || m.id)} 내부</span><span class="mviz-panel-ref">${escapeHtmlAttr(m.expand.source_ref)}</span>`;
    const closeBtn = document.createElement("button"); closeBtn.type = "button"; closeBtn.className = "mviz-panel-close"; closeBtn.textContent = "✕"; closeBtn.title = "닫기";
    closeBtn.addEventListener("click", (ev) => { ev.stopPropagation(); closePanel(); }); head.appendChild(closeBtn);
    let ctrl = null; try { ctrl = buildMethodViz(mini, { panel: true, depth: depth + 1, preValidated: true, qaSink: (window.__vizQAPanels = window.__vizQAPanels || []) }); } catch (e) { ctrl = null; }
    panelWrap.appendChild(head);
    if (ctrl) panelWrap.appendChild(ctrl.wrap); else { const err = document.createElement("div"); err.className = "mviz-panel-empty"; err.textContent = "(내부 파이프라인 없음)"; panelWrap.appendChild(err); }
    expandArea.appendChild(panelWrap); openState.ctrl = ctrl; openState.panelEl = panelWrap;
    requestAnimationFrame(() => { panelWrap.classList.add("open"); try { positionBadges(); } catch (e) {} if (ctrl && !ctrl._destroyed) { try { ctrl.runVizQA(); } catch (e) {} try { ctrl.sequentialHighlight(); } catch (e) {} } });
    insertExpandSteps(m);
  }
  function closePanel() {
    if (!openState.id) return; const wasId = openState.id;
    if (openState.ctrl && openState.ctrl.destroy) try { openState.ctrl.destroy(); } catch (e) {}
    if (openState.panelEl) openState.panelEl.remove();
    openState.id = null; openState.ctrl = null; openState.panelEl = null;
    markOpen(wasId, false); removeExpandSteps(); if (!panel) goStep(S.stepIdx); applyHighlight(); positionBadges();
  }
  // P3.5: Esc → 열린 패널 닫기(최상위부터). destroy에서 해제.
  let _escH = null;
  if (!panel && hasExpandable) { _escH = (e) => { if ((e.key === "Escape" || e.key === "Esc") && openState.id && !e.isComposing) { e.stopPropagation(); closePanel(); } };
    try { document.addEventListener("keydown", _escH, true); } catch (e) {} }
  // P3: 계층 스테퍼 — 열린 모듈의 내부 스텝을 부모 스텝 뒤에 삽입/제거 (아래에서 정의, 여기선 전방참조)
  function insertExpandSteps(m) { if (typeof _insertSteps === "function") _insertSteps(m); }
  function removeExpandSteps() { if (typeof _removeSteps === "function") _removeSteps(); }

  // ── 초기 렌더 → 콘텐츠 bbox 기반 viewBox (fit-to-view: 스크롤 없이 전체 표시) ──
  drawGroups(); drawEdges(); refreshMods();
  {
    const pad = 24;
    const vb = [bb.x0 - pad, bb.y0 - pad, (bb.x1 - bb.x0) + pad * 2, (bb.y1 - bb.y0) + pad * 2];
    svg.setAttribute("viewBox", vb.map((v) => Math.round(v)).join(" "));
    svg.__vbW = vb[2]; svg.__vbH = vb[3];
  }
  if (!panel) { goStep(0); updateReadout(); } else { applyHighlight(); }

  // 축소 배율이 낮으면 부제·엣지 라벨 숨김(가독성 하한) — ResizeObserver로 반응, viewBox는 불변
  const updateCompact = () => {
    try {
      const r = stage.getBoundingClientRect();
      if (!r.width || !svg.__vbW) return;
      const scale = Math.min(r.width / svg.__vbW, (r.height || 1) / svg.__vbH);
      svg.classList.toggle("mviz-compact", scale < 0.62);
    } catch {}
    try { positionBadges(); } catch (e) {} // P2: expand 배지 화면좌표 재배치
  };
  updateCompact();
  if (typeof ResizeObserver !== "undefined") {
    S.ro = new ResizeObserver(updateCompact);
    try { S.ro.observe(stage); } catch {}
  }
  if (!panel && hasExpandable) try { requestAnimationFrame(() => { try { positionBadges(); } catch (e) {} }); } catch (e) {}

  // ── 단일 rAF: 순전파 입자 + alternating 토글 + 스위치 레버 + 큐 펄스 (백그라운드 탭은 rAF가 자동 정지) ──
  function startAnim() {
    const needAlt = altEdgeEls.length > 0 || altSwitches.length > 0;
    if (S.reduce || (positions.length < 2 && !needAlt)) return;
    const pts = positions.map((p) => ({ x: p.cx, y: p.cy }));
    const segs = [];
    let total = 0;
    for (let k = 1; k < pts.length; k++) {
      const L = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
      segs.push({ a: pts[k - 1], b: pts[k], L }); total += L;
    }
    const at = (t) => {
      let d = t * total;
      for (const s of segs) { if (d <= s.L) { const r = s.L ? d / s.L : 0; return { x: s.a.x + (s.b.x - s.a.x) * r, y: s.a.y + (s.b.y - s.a.y) * r }; } d -= s.L; }
      return pts[pts.length - 1];
    };
    const dots = Array.from({ length: 4 }, (_, k) => {
      const c = mvE("circle", { r: 3, fill: "#8c2f39", opacity: "0" }); gParticles.appendChild(c);
      return { c, t: k / 4 };
    });
    let last = performance.now();
    let lastQueue = last;
    let altPhase = -1;
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      // coeff 모드: queue_bank 카드 유입 간격을 계수 c에 비례(c 클수록 짧게). 마스크·슬래브는 불변.
      if (ctrlMode === "coeff" && queueEls.length) {
        const interval = 2400 * (1 - 0.6 * coeffC());
        if (now - lastQueue > interval) { lastQueue = now; S.pulse = 10; }
      }
      // 입자
      dots.forEach((d) => {
        d.t += dt / 10; if (d.t > 1.15) d.t -= 1.15;
        const p = Math.min(1, d.t); const pos = at(p);
        d.c.setAttribute("cx", pos.x); d.c.setAttribute("cy", pos.y);
        d.c.setAttribute("opacity", d.t > 1 ? "0" : (p < 0.05 ? (p / 0.05).toFixed(2) : (p > 0.92 ? ((1 - p) / 0.08).toFixed(2) : "0.85")));
      });
      // alternating: 1초 간격으로 두 갈래 중 활성 쪽만 진하게
      const phase = Math.floor(now / 1000) % 2;
      if (phase !== altPhase) {
        altPhase = phase;
        altEdgeEls.forEach((el, i) => {
          const on = i % 2 === phase;
          el.setAttribute("opacity", on ? "1" : "0.28");
          el.setAttribute("stroke-width", on ? "2.1" : "1.4");
        });
        altSwitches.forEach((sw) => {
          sw.arm.setAttribute("y2", phase === 0 ? sw.cy - 8 : sw.cy + 8);
        });
      }
      // queue_bank 카드 밀림 펄스
      if (S.pulse > 0) {
        S.pulse--;
        const dx = -(S.pulse) * 0.9;
        queueEls.forEach((q) => q.g.setAttribute("transform", `translate(${dx},0)`));
        if (S.pulse === 0) queueEls.forEach((q) => q.g.setAttribute("transform", ""));
      }
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  }
  if (!panel) startAnim(); // 패널은 입자 없음(P2.5) — 대신 열릴 때 1회 순차 하이라이트

  // ── P1~P3 렌더러 자가진단: 불변식 8종 검사 → 자동 복구 → QA 리포트 (getBBox/BCR 필요 → rAF 후) ──
  function runVizQA() {
    const inv = [];
    const push = (id, target, detail) => { const o = { id, target, detail, recovery: [], resolved: false }; inv.push(o); return o; };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    // 모듈 그래픽 bbox(사용자 좌표) — getBBox 우선, 실패 시 positions 추정
    const modBox = {};
    spec.modules.forEach((m, i) => {
      const p = positions[i]; if (!p) return;
      let b = { x0: p.cx - p.halfW, y0: p.cy - 46, x1: p.cx + p.halfW, y1: p.cy + 30 };
      try { const g = S.mods.get(m.id), bb2 = g && g.__gfx && g.__gfx.getBBox && g.__gfx.getBBox();
        if (bb2 && bb2.width > 1) b = { x0: p.cx + bb2.x, y0: (p.cy - 118) + bb2.y, x1: p.cx + bb2.x + bb2.width, y1: (p.cy - 118) + bb2.y + bb2.height }; } catch (e) {}
      modBox[m.id] = b;
    });
    const segsOf = (d) => { const t = String(d || "").match(/[MLC]|-?[\d.]+/g); if (!t) return []; const pts = []; let i = 0, cur = null;
      while (i < t.length) { const c = t[i++];
        if (c === "M" || c === "L") { cur = [+t[i++], +t[i++]]; pts.push(cur); }
        else if (c === "C") { const x1 = +t[i++], y1 = +t[i++], x2 = +t[i++], y2 = +t[i++], x = +t[i++], y = +t[i++], p0 = cur || [x, y];
          for (let s = 1; s <= 10; s++) { const u = s / 10, mm = 1 - u; pts.push([mm * mm * mm * p0[0] + 3 * mm * mm * u * x1 + 3 * mm * u * u * x2 + u * u * u * x, mm * mm * mm * p0[1] + 3 * mm * mm * u * y1 + 3 * mm * u * u * y2 + u * u * u * y]); } cur = [x, y]; } }
      const s = []; for (let k = 1; k < pts.length; k++) s.push([pts[k - 1], pts[k]]); return s; };
    const edges = [...gEdges.querySelectorAll("path[data-kind]")].map((el) => ({ el, kind: el.getAttribute("data-kind"), from: el.getAttribute("data-from"), to: el.getAttribute("data-to"), segs: segsOf(el.getAttribute("d")) }));
    const inRect = (p, r, pad) => p[0] > r.x0 + pad && p[0] < r.x1 - pad && p[1] > r.y0 + pad && p[1] < r.y1 - pad;
    const orient = (A, B, C) => Math.sign((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
    const segseg = (p, q, u, v) => orient(p, q, u) !== orient(p, q, v) && orient(u, v, p) !== orient(u, v, q);
    const segRect = (a, b, r) => { if (Math.max(a[0], b[0]) < r.x0 || Math.min(a[0], b[0]) > r.x1 || Math.max(a[1], b[1]) < r.y0 || Math.min(a[1], b[1]) > r.y1) return false;
      if (inRect(a, r, 0) || inRect(b, r, 0)) return true; const c = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
      for (let k = 0; k < 4; k++) if (segseg(a, b, c[k], c[(k + 1) % 4])) return true; return false; };

    // INV-1 종단 직선 — 화살촉 직전 '방향이 유지되는' 마지막 직선 구간 ≥14px + 진입 ⊥(±15°)
    edges.forEach((e) => { const s = e.segs; if (!s.length) return; const endPt = s[s.length - 1][1];
      // 종단 접선은 샘플 chord가 아니라 d의 실제 종단(마지막 점 − 직전 정점/제어점)으로 — 곡선 종단의 각도 오판 방지
      const _n = (e.el.getAttribute("d").match(/-?[\d.]+/g) || []).map(Number), _l = _n.length;
      const endDir = _l >= 4 ? (() => { const v = [_n[_l - 2] - _n[_l - 4], _n[_l - 1] - _n[_l - 3]], m = Math.hypot(...v) || 1; return [v[0] / m, v[1] / m]; })() : [1, 0];
      // 끝에서 뒤로, 연속 세그먼트가 30°이내(부드러운 곡선/직선)면 같은 종단으로 누적 — 직전 '코너'에서 멈춤
      let straightLen = dist(s[s.length - 1][0], s[s.length - 1][1]);
      for (let k = s.length - 2; k >= 0; k--) { const a = [s[k + 1][1][0] - s[k + 1][0][0], s[k + 1][1][1] - s[k + 1][0][1]], b = [s[k][1][0] - s[k][0][0], s[k][1][1] - s[k][0][1]];
        if ((a[0] * b[0] + a[1] * b[1]) / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1)) < 0.866) break; straightLen += Math.hypot(...b); }
      const ang = Math.atan2(Math.abs(endDir[1]), Math.abs(endDir[0])) * 180 / Math.PI, perp = Math.min(ang, Math.abs(90 - ang)) <= 15;
      if (straightLen < 14 || !perp) { const o = push("INV-1", `edge:${e.from}→${e.to}`, `종단 직선 ${straightLen.toFixed(0)}px${perp ? "" : "·비직교"}`);
        try { const dstr = e.el.getAttribute("d"); // 복구: 마지막 코너를 화살촉 반대로 밀어 종단 직선 16px 확보(직선 L 종단만)
          const m2 = /L\s*-?[\d.]+\s+-?[\d.]+\s+L\s*(-?[\d.]+)\s+(-?[\d.]+)\s*$/.exec(dstr);
          if (perp && m2) { const ex = +m2[1], ey = +m2[2], np = [ex - 16 * endDir[0], ey - 16 * endDir[1]];
            const d2 = dstr.replace(/L\s*-?[\d.]+\s+-?[\d.]+\s+L\s*-?[\d.]+\s+-?[\d.]+\s*$/, `L${np[0].toFixed(1)} ${np[1].toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}`);
            e.el.setAttribute("d", d2); o.recovery.push("terminal_extend"); o.resolved = true; }
          else o.recovery.push(perp ? "reroute_needed" : "angle_needs_reroute");
        } catch (x) {} }
    });
    // INV-2 앵커 유효성 — 끝점이 대상 bbox 경계 위(±5px), 내부 침투/허공 금지
    edges.forEach((e) => { const s = e.segs; if (!s.length || !modBox[e.to]) return; const end = s[s.length - 1][1], r = modBox[e.to];
      const onBoundary = (Math.abs(end[0] - r.x0) <= 6 || Math.abs(end[0] - r.x1) <= 6 || Math.abs(end[1] - r.y0) <= 6 || Math.abs(end[1] - r.y1) <= 6) && end[0] >= r.x0 - 8 && end[0] <= r.x1 + 8 && end[1] >= r.y0 - 8 && end[1] <= r.y1 + 8;
      const deepInside = inRect(end, r, 6);
      if (deepInside || (!onBoundary && dist(end, [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]) < Math.hypot(r.x1 - r.x0, r.y1 - r.y0))) {
        if (deepInside) push("INV-2", `edge:${e.from}→${e.to}`, `끝점 bbox 내부 침투`); }
    });
    // INV-3 관통 — 비인접 모듈 bbox 교차
    edges.forEach((e) => { spec.modules.forEach((m) => { if (m.id === e.from || m.id === e.to) return; const r = modBox[m.id]; if (!r) return;
      const rr = { x0: r.x0 + 2, y0: r.y0 + 2, x1: r.x1 - 2, y1: r.y1 - 2 };
      if (e.segs.some((sg) => segRect(sg[0], sg[1], rr))) { push("INV-3", `edge:${e.from}→${e.to}`, `모듈 ${m.id} 관통`); } }); });
    // INV-4 텍스트 오버플로 — 모듈 내부 텍스트 실측 폭(getComputedTextLength)이 모듈 할당 폭(halfW·2) 초과
    spec.modules.forEach((m, i) => { try { const g = S.mods.get(m.id); if (!g || !g.__gfx) return; const cw = positions[i].halfW * 2;
      [...g.__gfx.querySelectorAll("text")].forEach((t) => { let tl = 0; try { tl = t.getComputedTextLength(); } catch (e) { return; }
        if (tl > cw + 2) { const o = push("INV-4", `module:${m.id}`, `내부 텍스트 "${(t.textContent || "").slice(0, 12)}" ${tl.toFixed(0)}>${cw.toFixed(0)}px`);
          try { t.setAttribute("opacity", "0"); const ti = document.createElementNS("http://www.w3.org/2000/svg", "title"); ti.textContent = t.textContent; t.appendChild(ti); o.recovery.push("label_hide→title"); o.resolved = true; } catch (x) {} } });
    } catch (e) {} });
    // INV-5 라벨 충돌 — 엣지 라벨·배지·부제·그룹 라벨 bbox 쌍 겹침(화면 좌표)
    const labels = [...gEdgeLab.querySelectorAll("text"), ...gGrpLab.querySelectorAll("text"), ...svg.querySelectorAll(".mv-sub")].filter((t) => (t.textContent || "").trim());
    const lb = labels.map((t) => { try { return { t, r: t.getBoundingClientRect() }; } catch (e) { return null; } }).filter((x) => x && x.r.width > 1);
    for (let i = 0; i < lb.length; i++) for (let j = i + 1; j < lb.length; j++) { const a = lb[i].r, b = lb[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
        const o = push("INV-5", `labels`, `"${(lb[i].t.textContent || "").slice(0, 8)}"↔"${(lb[j].t.textContent || "").slice(0, 8)}" 겹침`);
        try { const hide = lb[i].t.classList.contains("mv-elabel") ? lb[i].t : (lb[j].t.classList.contains("mv-elabel") ? lb[j].t : lb[i].t); hide.setAttribute("opacity", "0"); o.recovery.push("label_hide"); o.resolved = true; } catch (x) {} } }
    // INV-6 그룹 패딩 ≥16px (사용자 좌표) + 복구: 박스 확장
    [...gGroups.querySelectorAll("rect")].forEach((rect, gi) => { const grp = spec.groups[gi]; if (!grp) return;
      let u = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; grp.members.forEach((id) => { const r = modBox[id]; if (!r) return; u.x0 = Math.min(u.x0, r.x0); u.y0 = Math.min(u.y0, r.y0); u.x1 = Math.max(u.x1, r.x1); u.y1 = Math.max(u.y1, r.y1); });
      if (!isFinite(u.x0)) return; const gx = +rect.getAttribute("x"), gy = +rect.getAttribute("y"), gw = +rect.getAttribute("width"), gh = +rect.getAttribute("height");
      const pad = Math.min(u.x0 - gx, u.y0 - gy, gx + gw - u.x1, gy + gh - u.y1);
      if (pad < 16) { const o = push("INV-6", `group:${grp.label || grp.id}`, `패딩 ${pad.toFixed(0)}px<16`);
        try { const nx = Math.min(gx, u.x0 - 16), ny = Math.min(gy, u.y0 - 16), nx1 = Math.max(gx + gw, u.x1 + 16), ny1 = Math.max(gy + gh, u.y1 + 16);
          rect.setAttribute("x", nx); rect.setAttribute("y", ny); rect.setAttribute("width", nx1 - nx); rect.setAttribute("height", ny1 - ny); o.recovery.push("group_pad_expand"); o.resolved = true; } catch (x) {} }
    });
    // INV-7 점선 혼동 — gradient edge가 그룹 테두리와 20px 이내 평행. 복구: 그룹 점선을 구분 상수(2 6)로 강제
    const grpRects = [...gGroups.querySelectorAll("rect")].map((rc) => ({ el: rc, fixed: false, x0: +rc.getAttribute("x"), y0: +rc.getAttribute("y"), x1: +rc.getAttribute("x") + +rc.getAttribute("width"), y1: +rc.getAttribute("y") + +rc.getAttribute("height") }));
    edges.filter((e) => e.kind === "gradient").forEach((e) => { grpRects.forEach((gr) => {
      const near = e.segs.some((sg) => { const horiz = Math.abs(sg[1][1] - sg[0][1]) < 3, vert = Math.abs(sg[1][0] - sg[0][0]) < 3;
        if (horiz && (Math.abs(sg[0][1] - gr.y0) < 20 || Math.abs(sg[0][1] - gr.y1) < 20) && Math.max(sg[0][0], sg[1][0]) > gr.x0 && Math.min(sg[0][0], sg[1][0]) < gr.x1) return true;
        if (vert && (Math.abs(sg[0][0] - gr.x0) < 20 || Math.abs(sg[0][0] - gr.x1) < 20) && Math.max(sg[0][1], sg[1][1]) > gr.y0 && Math.min(sg[0][1], sg[1][1]) < gr.y1) return true; return false; });
      if (near) { const o = push("INV-7", `edge:${e.from}→${e.to}`, `gradient 점선이 그룹 테두리와 20px내 평행`);
        try { const cur = gr.el.getAttribute("stroke-dasharray"); if (cur !== "2 6") { gr.el.setAttribute("stroke-dasharray", "2 6"); gr.el.setAttribute("stroke", "#b7a680"); gr.el.setAttribute("stroke-opacity", "0.6"); }
          o.recovery.push("group_dash_distinct(2 6)"); o.resolved = true; } catch (x) {} } }); });
    // INV-8 교차각 ≥60°
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) { const A = edges[i], B = edges[j];
      if (A.from === B.from || A.to === B.to || A.from === B.to || A.to === B.from) continue; // 공유 엔드포인트는 교차 아님
      for (const a of A.segs) for (const b of B.segs) { if (!segseg(a[0], a[1], b[0], b[1])) continue;
        const va = [a[1][0] - a[0][0], a[1][1] - a[0][1]], vb = [b[1][0] - b[0][0], b[1][1] - b[0][1]];
        const dot = va[0] * vb[0] + va[1] * vb[1], ang = Math.acos(Math.min(1, Math.abs(dot) / (Math.hypot(...va) * Math.hypot(...vb) || 1))) * 180 / Math.PI;
        if (ang < 60) { const o = push("INV-8", `edge:${A.from}→${A.to} × ${B.from}→${B.to}`, `교차각 ${ang.toFixed(0)}°<60`);
          try { const c = mvE("circle", { cx: (a[0][0] + a[1][0]) / 2, cy: (a[0][1] + a[1][1]) / 2, r: 4, fill: "#fbf7f0" }); gEdges.insertBefore(c, B.el); o.recovery.push("crossing_halo"); o.resolved = true; } catch (x) {} }
      } }

    // ── P3 QA 리포트 ──
    const specVal = (spec._specValidation || []).slice();
    let scale = 1; try { const r = stage.getBoundingClientRect(); if (r.width && svg.__vbW) scale = Math.min(r.width / svg.__vbW, (r.height || 1) / svg.__vbH); } catch (e) {}
    const hidden = svg.querySelectorAll('[opacity="0"]').length;
    // P4: depth 표기 — 패널(depth>0)의 위반·강등 target에 전역 id 경로+depth 부기
    if (depth > 0) { inv.forEach((v) => { if (!/depth/.test(v.target)) v.target += `, depth ${depth}`; }); }
    // 트리 지표(레벨 0 집계)
    const countExp = (mods) => (mods || []).reduce((a, m) => a + (m.expand ? 1 + countExp(m.expand.modules) : 0), 0);
    const maxDep = (mods, d) => (mods || []).reduce((mx, m) => Math.max(mx, m.expand ? maxDep(m.expand.modules, d + 1) : d), d);
    const report = { paper_ref: spec.section_ref || spec.source_ref || "", paper_type: spec.paper_type_primary || spec.paper_type || "", depth, timestamp: new Date().toISOString(),
      spec_validation: specVal, invariants: inv,
      layout_metrics: { scale: +scale.toFixed(2), modules: spec.modules.length, steps: spec.steps.length, edges: edges.length, hidden_labels: hidden, serpentine: !!serp, text_overflow_count: inv.filter((v) => v.id === "INV-4").length,
        expandable_modules: countExp(spec.modules), expand_removed: specVal.filter((v) => /^expand_/.test(v.rule)).length, max_depth_used: maxDep(spec.modules, 0) } };
    const nViol = inv.length, nUnres = inv.filter((v) => !v.resolved).length;
    if (panel) { // 패널: 레벨0 리포트를 덮지 않고 수집처에 병합, 배지·콘솔 생략
      try { if (Array.isArray(opts.qaSink)) { opts.qaSink.push(report); if (opts.qaSink.length > 200) opts.qaSink.shift(); } } catch (e) {} // 상한(누적 방어)
      return report;
    }
    try { window.__vizQA = report; } catch (e) {}
    try { if (console && console.table) { console.log(`%c[vizQA] ${report.paper_ref || report.paper_type} — 위반 ${nViol} / 미해결 ${nUnres} · 강등 ${specVal.length}`, "color:#8c2f39;font-weight:bold");
      if (nViol) console.table(inv.map((v) => ({ id: v.id, target: v.target, detail: v.detail, recovery: v.recovery.join(",") || "-", resolved: v.resolved })));
      if (specVal.length) console.table(specVal); } } catch (e) {}
    // dev 모드 배지 (localStorage.mvizDev==="1" 또는 window.MVIZ_DEV)
    let dev = false; try { dev = localStorage.getItem("mvizDev") === "1" || window.MVIZ_DEV === true; } catch (e) {}
    if (dev && (nViol || specVal.length || report.layout_metrics.expandable_modules)) { try {
      const badge = document.createElement("button"); badge.type = "button"; badge.className = "mviz-qa-badge";
      badge.textContent = `QA: 위반 ${nViol} / 미해결 ${nUnres}${specVal.length ? " · 강등 " + specVal.length : ""}${report.layout_metrics.expandable_modules ? " · 확장 " + report.layout_metrics.expandable_modules : ""}`;
      badge.title = "클릭 시 QA 리포트를 콘솔에 출력";
      badge.addEventListener("click", () => { console.log("[vizQA] 전체 리포트:", report, "패널:", window.__vizQAPanels || []); });
      stage.appendChild(badge);
    } catch (e) {} }
    return report;
  }
  // 렌더 후 자동 실행(검사+복구+리포트). window.__vizNoAutoQA로 끄면 수동 호출만(전후 비교 테스트용).
  let _noAuto = false; try { _noAuto = (typeof window !== "undefined" && window.__vizNoAutoQA === true); } catch (e) {}
  if (!panel && !_noAuto) try { requestAnimationFrame(() => { try { runVizQA(); } catch (e) { try { console.warn("[vizQA] 리포트 생성 실패(렌더는 계속):", e); } catch (x) {} } }); } catch (e) {}

  // 패널 모드: 크롬·전역 컨트롤러 없이 재사용용 핸들만 반환
  if (panel) {
    return { wrap, stage, svg, spec, S, positions, runVizQA, refreshMods, applyHighlight, sequentialHighlight,
      updateFromControl: (eta) => { S.eta = eta; refreshMods(); }, // P2.6: 상위 슬라이더가 열린 패널 갱신
      _destroyed: false,
      destroy() {
        this._destroyed = true;
        if (S.raf) cancelAnimationFrame(S.raf);
        if (S.ro) { try { S.ro.disconnect(); } catch (e) {} }
        _seqTimers.forEach(clearTimeout); _seqTimers.length = 0; // 순차 하이라이트 타이머 정리(닫힌 패널의 detached DOM 발화 방지)
        try { if (openState.ctrl && openState.ctrl.destroy) openState.ctrl.destroy(); } catch (e) {} // 손자 패널 재귀 정리(ResizeObserver 누수 방지)
        S.raf = 0; S.ro = null;
      } };
  }

  // 컨트롤러 (논문 전환 시 정리)
  activeMethodViz = {
    runVizQA, // 테스트/골든셋에서 동기 호출 가능
    destroy() {
      if (S.raf) cancelAnimationFrame(S.raf);
      if (S.playTimer) clearInterval(S.playTimer);
      if (S.ro) { try { S.ro.disconnect(); } catch {} }
      _seqTimers.forEach(clearTimeout); _seqTimers.length = 0;
      try { if (openState.ctrl && openState.ctrl.destroy) openState.ctrl.destroy(); } catch (e) {}
      try { if (_escH) document.removeEventListener("keydown", _escH, true); } catch (e) {}
      S.raf = 0; S.playTimer = 0; S.ro = null;
    },
  };
  return wrap;
}
function mvBtn(label, title, fn) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "mviz-btn"; b.textContent = label; b.title = title || "";
  b.addEventListener("click", fn);
  return b;
}
function escapeHtmlAttr(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- figure 렌더러 (flow / bar / line) — 구버전 분석 호환 ----------
function buildFigure(f) {
  let body;
  if (f.type === "flow" && Array.isArray(f.flow) && f.flow.length) body = buildFlow(f);
  else if (f.type === "bar" && Array.isArray(f.bars) && f.bars.length) body = buildBars(f);
  else if (f.type === "line" && Array.isArray(f.lines) && f.lines.length) body = buildLines(f);
  if (!body) return null;

  const fig = document.createElement("figure");
  fig.className = "pfig";

  const head = document.createElement("div");
  head.className = "pfig-head";
  const title = document.createElement("span");
  title.className = "pfig-title";
  title.textContent = f.title || "그림";
  head.appendChild(title);
  if (f.source) {
    const src = document.createElement("span");
    src.className = "pfig-source";
    src.textContent = f.source;
    head.appendChild(src);
  }
  fig.appendChild(head);
  if (f.example) {
    const ex = document.createElement("div");
    ex.className = "pfig-example";
    renderRich(ex, "🧪 " + f.example);
    fig.appendChild(ex);
  }
  fig.appendChild(body);

  if (f.caption) {
    const cap = document.createElement("figcaption");
    renderRich(cap, f.caption);
    fig.appendChild(cap);
  }
  return fig;
}

// flow: 원 그림의 모양(기둥 구조)을 보존해 렌더링하고,
// ◀ ▶ 스테퍼로 한 블록씩 짚어가며 role 설명을 보여준다.
// 모델이 그린 SVG를 안전하게 파싱 (script·이벤트 핸들러 제거)
function sanitizeSvg(svgText) {
  try {
    let s = String(svgText).trim();
    // 모델이 xmlns를 빠뜨리면 SVG 네임스페이스가 아닌 null 네임스페이스로 파싱돼
    // 도형(rect/line 등)은 안 그려지고 <text>만 흘러나온다 → 없으면 주입
    if (!/\sxmlns\s*=/.test(s)) {
      s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const doc = new DOMParser().parseFromString(s, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
    // 네임스페이스가 SVG가 아니면(파싱 실패의 다른 징후) 폴백
    if (svg.namespaceURI !== "http://www.w3.org/2000/svg") return null;
    // 도형 요소가 하나도 없으면 텍스트만 있는 깨진 그림 → 폴백(텍스트 박스 다이어그램)
    if (!svg.querySelector("rect, path, line, circle, polygon, polyline, ellipse")) return null;
    svg.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
    [svg, ...svg.querySelectorAll("*")].forEach((el) => {
      [...el.attributes].forEach((a) => {
        if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) el.removeAttribute(a.name);
      });
    });
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    return document.importNode(svg, true);
  } catch {
    return null;
  }
}

function buildFlow(fig) {
  const blocks = fig.flow;
  const wrap = document.createElement("div");
  const flow = document.createElement("div");
  flow.className = "arch-flow";

  // ── 모드 1: 모델이 원 figure를 그대로 그린 SVG가 있으면 그것을 사용 ──
  let blockEls = null;
  if (fig.svg) {
    const svgRoot = sanitizeSvg(fig.svg);
    if (svgRoot) {
      const els = blocks.map((_, i) => svgRoot.querySelector(`[data-block="${i}"]`));
      // data-block 매핑이 절반 이상 살아 있으면 SVG 모드 채택
      if (els.filter(Boolean).length >= Math.ceil(blocks.length / 2)) {
        flow.classList.add("arch-svg");
        flow.appendChild(svgRoot);
        blockEls = els;
      }
    }
  }

  if (!blockEls) {
    blockEls = buildFlowDom(blocks, flow);
  }

  return assembleFlowUI(wrap, flow, blocks, blockEls);
}

// ── 모드 2 (폴백): 블록 정보로 다이어그램을 직접 조립 ──
function buildFlowDom(blocks, flow) {
  // 블록 DOM 생성 (원래 배열 순서 = 스테퍼 진행 순서)
  const blockEls = blocks.map((block, idx) => {
    const box = document.createElement("div");
    box.className = "arch-block";
    box.dataset.idx = idx;

    const name = document.createElement("div");
    name.className = "arch-name";
    const nameText = document.createElement("span");
    renderRich(nameText, block.name || ""); // 블록 이름에 $수식$ 허용
    name.appendChild(nameText);
    if (block.repeat) {
      const rep = document.createElement("span");
      rep.className = "arch-repeat";
      rep.textContent = block.repeat;
      name.appendChild(rep);
    }
    if (block.inner_viz) {
      // 내부 시각화가 있는 블록 표시 — 클릭 유도
      const lens = document.createElement("span");
      lens.className = "arch-lens";
      lens.textContent = "🔍";
      lens.title = "클릭하면 내부 값 시각화를 볼 수 있습니다";
      name.appendChild(lens);
    }
    box.appendChild(name);

    if (block.sublabel) {
      const sub = document.createElement("div");
      sub.className = "arch-sub";
      renderRich(sub, block.sublabel); // $수식$ 렌더링
      box.appendChild(sub);
    }
    if (Array.isArray(block.children) && block.children.length) {
      const chips = document.createElement("div");
      chips.className = "arch-children";
      block.children.forEach((c) => {
        const chip = document.createElement("span");
        chip.className = "arch-chip";
        renderRich(chip, c);
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }
    return box;
  });

  // 레이아웃: lane 없는 블록은 단독 행, 연속된 lane 블록들은 기둥(컬럼)으로 나란히
  const rows = [];
  blocks.forEach((block, idx) => {
    if (block.lane) {
      let last = rows[rows.length - 1];
      if (!last || last.type !== "lanes") {
        last = { type: "lanes", lanes: new Map() };
        rows.push(last);
      }
      if (!last.lanes.has(block.lane)) last.lanes.set(block.lane, []);
      last.lanes.get(block.lane).push(idx);
    } else {
      rows.push({ type: "single", idx });
    }
  });

  rows.forEach((row, r) => {
    if (r > 0) {
      const arrow = document.createElement("div");
      arrow.className = "arch-arrow";
      arrow.textContent = "↓";
      flow.appendChild(arrow);
    }
    if (row.type === "single") {
      flow.appendChild(blockEls[row.idx]);
    } else {
      const lanesEl = document.createElement("div");
      lanesEl.className = "arch-lanes";
      for (const [label, idxs] of row.lanes) {
        const laneEl = document.createElement("div");
        laneEl.className = "arch-lane";
        const labEl = document.createElement("div");
        labEl.className = "arch-lane-label";
        labEl.textContent = label;
        laneEl.appendChild(labEl);
        idxs.forEach((idx, j) => {
          if (j > 0) {
            const a = document.createElement("div");
            a.className = "arch-arrow";
            a.textContent = "↓";
            laneEl.appendChild(a);
          }
          laneEl.appendChild(blockEls[idx]);
        });
        lanesEl.appendChild(laneEl);
      }
      flow.appendChild(lanesEl);
    }
  });
  return blockEls;
}

// 토큰·스크롤·우측 패널·스테퍼 컨트롤 조립 (SVG 모드/DOM 모드 공용)
function assembleFlowUI(wrap, flow, blocks, blockEls) {
  // 데이터 토큰: 스테퍼 진행 시 블록 사이를 타고 이동하는 빛나는 점
  const token = document.createElement("div");
  token.className = "flow-token hidden";
  flow.appendChild(token);

  // 다이어그램이 길어도 컨트롤이 항상 보이도록 내부 스크롤 영역에 담는다
  const scroller = document.createElement("div");
  scroller.className = "arch-scroll";
  scroller.appendChild(flow);

  // 좌: 다이어그램 / 우: 내부 값 시각화
  const VIZ_EMPTY =
    '<div class="flow-viz-empty">왼쪽 다이어그램의 블록을 클릭하거나 "다음 ▶"으로 시작하세요<br/>각 단계의 내부 데이터가 여기에 시각화됩니다</div>';
  const vizPanel = document.createElement("div");
  vizPanel.className = "flow-viz-panel";
  vizPanel.innerHTML = VIZ_EMPTY;

  const grid = document.createElement("div");
  grid.className = "flow-grid";
  grid.append(scroller, vizPanel);
  wrap.appendChild(grid);

  // ── 인터랙티브 스테퍼 ──
  let current = -1;
  let playTimer = null;

  const controls = document.createElement("div");
  controls.className = "flow-controls";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "flow-btn";
  prevBtn.textContent = "◀ 이전";
  const counter = document.createElement("span");
  counter.className = "flow-counter";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "flow-btn flow-btn-primary";
  nextBtn.textContent = "다음 ▶";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "flow-btn";
  playBtn.textContent = "▶ 자동 재생";
  controls.append(prevBtn, counter, nextBtn, playBtn);

  // 🔍 내부 시각화가 있는 블록만 순회하는 네비게이터
  const vizIdxs = blocks.map((b, i) => (b.inner_viz ? i : -1)).filter((i) => i >= 0);
  if (vizIdxs.length) {
    const vizBtn = document.createElement("button");
    vizBtn.type = "button";
    vizBtn.className = "flow-btn";
    vizBtn.textContent = `🔍 시각화 ${vizIdxs.length}곳`;
    vizBtn.title = "내부 값 시각화가 있는 블록만 차례로 이동";
    vizBtn.addEventListener("click", () => {
      stopPlay();
      const next = vizIdxs.find((i) => i > current) ?? vizIdxs[0];
      activate(next);
    });
    controls.appendChild(vizBtn);
  }

  const rolePanel = document.createElement("div");
  rolePanel.className = "flow-role hidden";

  function moveToken(i) {
    if (!blockEls[i]) return token.classList.add("hidden");
    const b = blockEls[i].getBoundingClientRect();
    const f = flow.getBoundingClientRect();
    token.style.left = `${b.left - f.left + 12}px`;
    token.style.top = `${b.top - f.top + b.height / 2 - 7}px`;
  }

  function stopPlay() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      playBtn.textContent = "▶ 자동 재생";
    }
  }

  function activate(i) {
    current = i;
    flow.classList.toggle("stepping", i >= 0);
    blockEls.forEach((el, j) => el && el.classList.toggle("arch-active", j === i));
    if (i < 0) {
      token.classList.add("hidden");
      counter.textContent = "▶ 흐름을 따라가 보세요";
      rolePanel.classList.add("hidden");
      vizPanel.innerHTML = VIZ_EMPTY;
    } else {
      const b = blocks[i];
      token.classList.remove("hidden");
      moveToken(i);
      counter.textContent = `${i + 1} / ${blocks.length}`;
      rolePanel.classList.remove("hidden");
      rolePanel.innerHTML = "";
      const roleName = document.createElement("strong");
      roleName.textContent = b.name;
      rolePanel.appendChild(roleName);
      const roleText = document.createElement("span");
      renderRich(roleText, " — " + (b.role || b.sublabel || "설명이 제공되지 않은 블록입니다."));
      rolePanel.appendChild(roleText);
      if (b.data_state) {
        const ds = document.createElement("div");
        ds.className = "flow-data";
        renderRich(ds, "📦 이 시점의 데이터: " + b.data_state);
        rolePanel.appendChild(ds);
      }
      // 내부 값 시각화는 오른쪽 패널에 — 빈 블록은 data_state로 transform 합성(빈 placeholder 금지)
      vizPanel.innerHTML = "";
      let viz = b.inner_viz ? buildInnerViz(b.inner_viz) : null;
      if (!viz) {
        const prev = blocks[i - 1];
        viz = buildInnerViz({
          type: "transform",
          title: b.name || "이 단계의 데이터 변화",
          from: { label: (prev && prev.data_state) || prev?.name || "입력" },
          op: b.role || b.sublabel || "",
          to: { label: b.data_state || b.name || "출력" },
        });
      }
      if (viz) vizPanel.appendChild(viz);
      else vizPanel.innerHTML = VIZ_EMPTY;
      blockEls[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    prevBtn.disabled = current <= 0;
    nextBtn.textContent = current >= blocks.length - 1 ? "처음으로 ↺" : "다음 ▶";
  }

  prevBtn.addEventListener("click", () => { stopPlay(); activate(Math.max(0, current - 1)); });
  nextBtn.addEventListener("click", () => {
    stopPlay();
    activate(current >= blocks.length - 1 ? 0 : current + 1);
  });
  playBtn.addEventListener("click", () => {
    if (playTimer) return stopPlay();
    playBtn.textContent = "⏸ 정지";
    activate(current >= blocks.length - 1 || current < 0 ? 0 : current + 1);
    playTimer = setInterval(() => {
      if (current >= blocks.length - 1) stopPlay();
      else activate(current + 1);
    }, 2400);
  });
  blockEls.forEach((el, i) => el && el.addEventListener("click", () => { stopPlay(); activate(i); }));

  activate(-1);
  wrap.append(controls, rolePanel);
  return wrap;
}

// ── 블록 내부 값 시각화 (heatmap / vectors / bars) ──
function buildInnerViz(viz) {
  let body = null;
  if (viz.type === "heatmap" && Array.isArray(viz.matrix) && Array.isArray(viz.tokens)) {
    body = buildVizHeatmap(viz);
  } else if (viz.type === "vectors" && Array.isArray(viz.vectors)) {
    body = buildVizVectors(viz);
  } else if (viz.type === "bars" && Array.isArray(viz.bars)) {
    body = buildVizBars(viz);
  } else if (viz.type === "distribution" && Array.isArray(viz.curves) && viz.curves.length) {
    body = buildVizDistribution(viz);
  } else if (viz.type === "scatter" && Array.isArray(viz.points) && viz.points.length) {
    body = buildVizScatter(viz);
  } else if (viz.type === "surface" && Array.isArray(viz.grid) && viz.grid.length) {
    body = buildVizSurface(viz);
  } else if (viz.type === "transform" || viz.from || viz.to) {
    body = buildVizTransform(viz);
  }
  if (!body) return null;

  const wrap = document.createElement("div");
  wrap.className = "iviz";
  if (viz.title) {
    const t = document.createElement("h5");
    t.className = "iviz-title";
    renderRich(t, viz.title);
    wrap.appendChild(t);
  }
  wrap.appendChild(body);
  if (viz.explanation) {
    const ex = document.createElement("p");
    ex.className = "iviz-expl";
    renderRich(ex, viz.explanation);
    wrap.appendChild(ex);
  }
  return wrap;
}

// 히트맵: 행=보는 주체. 셀 호버 툴팁, 행 레이블 클릭 시 그 행 하이라이트
function buildVizHeatmap(viz) {
  const tokens = viz.tokens;
  const grid = document.createElement("div");
  grid.className = "iviz-heat";
  grid.style.gridTemplateColumns = `auto repeat(${tokens.length}, 36px)`;

  const focusLine = document.createElement("p");
  focusLine.className = "iviz-focus";
  focusLine.textContent = "행 레이블을 클릭하면 그 단어의 시선만 볼 수 있습니다";

  // 헤더 행
  grid.appendChild(document.createElement("div"));
  tokens.forEach((t) => {
    const h = document.createElement("div");
    h.className = "iviz-heat-col";
    h.textContent = t;
    grid.appendChild(h);
  });

  let focusedRow = -1;
  const rowEls = [];

  viz.matrix.forEach((row, r) => {
    const label = document.createElement("button");
    label.type = "button";
    label.className = "iviz-heat-row";
    label.textContent = tokens[r] ?? `행${r + 1}`;
    grid.appendChild(label);

    const cells = [];
    row.forEach((v, c) => {
      const cell = document.createElement("div");
      cell.className = "iviz-heat-cell";
      const val = Number(v) || 0;
      cell.style.background = `rgba(140, 47, 57, ${Math.min(1, Math.max(0, val))})`;
      cell.style.color = val > 0.45 ? "#fff" : "#8c2f39";
      cell.textContent = val.toFixed(2);
      cell.title = `'${tokens[r]}' → '${tokens[c]}' : ${val.toFixed(2)}`;
      grid.appendChild(cell);
      cells.push(cell);
    });
    rowEls.push({ label, cells });

    label.addEventListener("click", () => {
      focusedRow = focusedRow === r ? -1 : r;
      rowEls.forEach((re, i) => {
        const dim = focusedRow !== -1 && i !== focusedRow;
        re.cells.forEach((c) => c.classList.toggle("iviz-dim", dim));
        re.label.classList.toggle("iviz-row-on", i === focusedRow);
      });
      if (focusedRow === -1) {
        focusLine.textContent = "행 레이블을 클릭하면 그 단어의 시선만 볼 수 있습니다";
      } else {
        const row = viz.matrix[focusedRow];
        const maxC = row.indexOf(Math.max(...row));
        focusLine.textContent = `'${tokens[focusedRow]}'은(는) '${tokens[maxC]}'을(를) 가장 강하게 참조합니다 (${Number(row[maxC]).toFixed(2)})`;
      }
    });
  });

  const wrap = document.createElement("div");
  wrap.append(grid, focusLine);
  return wrap;
}

// 벡터 색띠: 셀 호버 시 실제 값 툴팁
function buildVizVectors(viz) {
  const wrap = document.createElement("div");
  wrap.className = "iviz-vecs";
  viz.vectors.forEach((vec) => {
    const row = document.createElement("div");
    row.className = "iviz-vec-row";
    const label = document.createElement("span");
    label.textContent = vec.label || "";
    row.appendChild(label);
    const cells = document.createElement("div");
    cells.className = "iviz-vec-cells";
    (vec.values || []).forEach((v) => {
      const val = Math.max(-1, Math.min(1, Number(v) || 0));
      const cell = document.createElement("div");
      cell.className = "iviz-vec-cell";
      // 양수=따뜻한 색, 음수=차가운 색, 절댓값=진하기
      cell.style.background = `hsl(${val >= 0 ? 8 : 210}, ${Math.abs(val) * 65 + 20}%, ${88 - Math.abs(val) * 36}%)`;
      cell.title = Number(v).toFixed(2);
      cells.appendChild(cell);
    });
    row.appendChild(cells);
    wrap.appendChild(row);
  });
  return wrap;
}

// SVG 헬퍼
function svgEl(tag, attrs, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
const VIZ_COLORS = ["#8c2f39", "#3d5a80", "#b08a3e", "#5b7553", "#7d5a8c"];

// 분포/함수 곡선: 면이 채워진 곡선 1~3개
function buildVizDistribution(viz) {
  const W = 360, H = 210, P = { t: 14, r: 14, b: 40, l: 40 };
  const pts = viz.curves.flatMap((c) => c.points || []);
  if (!pts.length) return null;
  const xs = pts.map((p) => Number(p.x)), ys = pts.map((p) => Number(p.y));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(0, ...ys), ymax = Math.max(...ys);
  const X = (x) => P.l + ((x - xmin) / (xmax - xmin || 1)) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - ymin) / (ymax - ymin || 1)) * (H - P.t - P.b);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "linechart" });
  svg.appendChild(svgEl("line", { x1: P.l, y1: H - P.b, x2: W - P.r, y2: H - P.b, class: "lc-axis" }));
  svg.appendChild(svgEl("line", { x1: P.l, y1: P.t, x2: P.l, y2: H - P.b, class: "lc-axis" }));
  if (viz.x_label) svg.appendChild(svgEl("text", { x: (P.l + W - P.r) / 2, y: H - 6, class: "lc-label", "text-anchor": "middle" }, viz.x_label));
  if (viz.y_label) svg.appendChild(svgEl("text", { x: 12, y: (P.t + H - P.b) / 2, class: "lc-label", "text-anchor": "middle", transform: `rotate(-90 12 ${(P.t + H - P.b) / 2})` }, viz.y_label));

  viz.curves.forEach((curve, i) => {
    const color = VIZ_COLORS[i % VIZ_COLORS.length];
    const sorted = [...(curve.points || [])].sort((a, b) => a.x - b.x);
    if (!sorted.length) return;
    const line = sorted.map((p) => `${X(p.x)},${Y(p.y)}`).join(" L");
    // 곡선 아래 면 채우기 (분포 느낌)
    const area = `M${X(sorted[0].x)},${Y(ymin)} L${line} L${X(sorted[sorted.length - 1].x)},${Y(ymin)} Z`;
    svg.appendChild(svgEl("path", { d: area, fill: color, opacity: 0.13 }));
    svg.appendChild(svgEl("path", { d: `M${line}`, fill: "none", stroke: color, "stroke-width": 2.4, "stroke-linejoin": "round" }));
  });

  const wrap = document.createElement("div");
  wrap.appendChild(svg);
  if (viz.curves.length > 1 || viz.curves[0].name) {
    const legend = document.createElement("div");
    legend.className = "lc-legend";
    viz.curves.forEach((c, i) => {
      const item = document.createElement("span");
      item.className = "lc-legend-item";
      const dot = document.createElement("span");
      dot.className = "lc-dot";
      dot.style.background = VIZ_COLORS[i % VIZ_COLORS.length];
      item.append(dot, document.createTextNode(c.name || `곡선 ${i + 1}`));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
  }
  return wrap;
}

// 산점도: 공간 배치·군집 (group별 색, 점 호버 시 레이블)
function buildVizScatter(viz) {
  const W = 360, H = 230, P = { t: 16, r: 16, b: 40, l: 40 };
  const xs = viz.points.map((p) => Number(p.x)), ys = viz.points.map((p) => Number(p.y));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const X = (x) => P.l + ((x - xmin) / (xmax - xmin || 1)) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - ymin) / (ymax - ymin || 1)) * (H - P.t - P.b);
  const groups = [...new Set(viz.points.map((p) => p.group).filter(Boolean))];
  const colorOf = (g) => (g ? VIZ_COLORS[groups.indexOf(g) % VIZ_COLORS.length] : VIZ_COLORS[0]);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "linechart" });
  svg.appendChild(svgEl("line", { x1: P.l, y1: H - P.b, x2: W - P.r, y2: H - P.b, class: "lc-axis" }));
  svg.appendChild(svgEl("line", { x1: P.l, y1: P.t, x2: P.l, y2: H - P.b, class: "lc-axis" }));
  if (viz.x_label) svg.appendChild(svgEl("text", { x: (P.l + W - P.r) / 2, y: H - 6, class: "lc-label", "text-anchor": "middle" }, viz.x_label));
  if (viz.y_label) svg.appendChild(svgEl("text", { x: 12, y: (P.t + H - P.b) / 2, class: "lc-label", "text-anchor": "middle", transform: `rotate(-90 12 ${(P.t + H - P.b) / 2})` }, viz.y_label));

  viz.points.forEach((p) => {
    const c = svgEl("circle", { cx: X(p.x), cy: Y(p.y), r: 5, fill: colorOf(p.group), opacity: 0.85 });
    c.appendChild(svgEl("title", {}, (p.label || "") + (p.group ? ` (${p.group})` : "")));
    svg.appendChild(c);
    if (p.label) {
      svg.appendChild(svgEl("text", { x: X(p.x) + 7, y: Y(p.y) + 4, class: "sc-pt-label" }, p.label));
    }
  });

  const wrap = document.createElement("div");
  wrap.appendChild(svg);
  if (groups.length) {
    const legend = document.createElement("div");
    legend.className = "lc-legend";
    groups.forEach((g) => {
      const item = document.createElement("span");
      item.className = "lc-legend-item";
      const dot = document.createElement("span");
      dot.className = "lc-dot";
      dot.style.background = colorOf(g);
      item.append(dot, document.createTextNode(g));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
  }
  return wrap;
}

// 3D 막대 지형: 행렬 값의 크기를 의사 3D로 (뒷줄일수록 위·옆으로 밀려나는 아이소메트릭)
function buildVizSurface(viz) {
  const grid = viz.grid;
  const rows = grid.length, cols = Math.max(...grid.map((r) => r.length));
  const max = Math.max(...grid.flat().map((v) => Number(v) || 0)) || 1;
  const BAR_W = 22, GAP = 5, MAX_H = 72, OFF_X = 13, OFF_Y = 11;

  const stage = document.createElement("div");
  stage.className = "surf-stage";
  stage.style.width = `${cols * (BAR_W + GAP) + rows * OFF_X + 20}px`;
  stage.style.height = `${MAX_H + rows * OFF_Y + 36}px`;

  // 뒷줄(마지막 행)부터 그려서 앞줄이 가리도록
  for (let r = rows - 1; r >= 0; r--) {
    const rowEl = document.createElement("div");
    rowEl.className = "surf-row";
    rowEl.style.left = `${(rows - 1 - r) * OFF_X}px`;
    rowEl.style.bottom = `${(rows - 1 - r) * OFF_Y}px`;
    rowEl.style.zIndex = r + 1;
    (grid[r] || []).forEach((v) => {
      const val = (Number(v) || 0) / max;
      const bar = document.createElement("div");
      bar.className = "surf-bar";
      bar.style.width = `${BAR_W}px`;
      bar.style.height = `${val * MAX_H + 5}px`;
      bar.style.background = `linear-gradient(180deg, rgba(140,47,57,${0.35 + val * 0.6}), rgba(140,47,57,${0.2 + val * 0.45}))`;
      bar.title = Number(v).toFixed(2);
      rowEl.appendChild(bar);
    });
    stage.appendChild(rowEl);
  }

  const wrap = document.createElement("div");
  wrap.className = "surf-wrap";
  wrap.appendChild(stage);
  return wrap;
}

// 데이터 변환: 입력 → (연산) → 출력. 흥미로운 수치가 없는 블록의 기본 시각화
function buildVizTransform(viz) {
  const from = viz.from || { label: "입력", shape: "" };
  const to = viz.to || { label: viz.data_state || "출력", shape: "" };
  const wrap = document.createElement("div");
  wrap.className = "tfm";

  const card = (node, role) => {
    const c = document.createElement("div");
    c.className = "tfm-card tfm-" + role;
    const lab = document.createElement("div");
    lab.className = "tfm-label";
    renderRich(lab, node.label || "");
    c.appendChild(lab);
    if (node.shape) {
      const sh = document.createElement("div");
      sh.className = "tfm-shape";
      sh.textContent = node.shape;
      c.appendChild(sh);
    }
    if (node.kind) {
      const k = document.createElement("div");
      k.className = "tfm-kind";
      k.textContent = node.kind;
      c.appendChild(k);
    }
    return c;
  };

  wrap.appendChild(card(from, "from"));
  const mid = document.createElement("div");
  mid.className = "tfm-op";
  mid.innerHTML = '<span class="tfm-arrow">↓</span>';
  if (viz.op) {
    const op = document.createElement("span");
    op.className = "tfm-op-text";
    renderRich(op, viz.op);
    mid.appendChild(op);
  }
  wrap.appendChild(mid);
  wrap.appendChild(card(to, "to"));
  return wrap;
}

// 확률/점수 막대 (렌더 직후 채워지는 애니메이션)
function buildVizBars(viz) {
  const wrap = document.createElement("div");
  wrap.className = "barchart iviz-bars";
  const max = Math.max(...viz.bars.map((b) => Number(b.value) || 0));
  viz.bars.forEach((b) => {
    const row = document.createElement("div");
    row.className = "bar-row" + (b.highlight ? " bar-highlight" : "");
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = b.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = "0%";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fill.style.width = max > 0 ? `${((Number(b.value) || 0) / max) * 100}%` : "0%";
      })
    );
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "bar-value";
    val.textContent = b.value;
    row.append(label, track, val);
    wrap.appendChild(row);
  });
  return wrap;
}

function buildBars(f) {
  const wrap = document.createElement("div");
  wrap.className = "barchart";
  const max = Math.max(...f.bars.map((b) => Number(b.value) || 0));
  f.bars.forEach((b) => {
    const row = document.createElement("div");
    row.className = "bar-row" + (b.highlight ? " bar-highlight" : "");
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = b.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = max > 0 ? `${((Number(b.value) || 0) / max) * 100}%` : "0%";
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "bar-value";
    val.textContent = b.value;
    row.append(label, track, val);
    wrap.appendChild(row);
  });
  if (f.unit) {
    const unit = document.createElement("div");
    unit.className = "bar-unit";
    unit.textContent = `단위: ${f.unit}`;
    wrap.appendChild(unit);
  }
  return wrap;
}

function buildLines(f) {
  const W = 560, H = 300, P = { t: 16, r: 16, b: 44, l: 52 };
  const pts = f.lines.flatMap((l) => l.points || []);
  if (!pts.length) return null;
  const xs = pts.map((p) => Number(p.x)), ys = pts.map((p) => Number(p.y));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xspan = xmax - xmin || 1, yspan = ymax - ymin || 1;
  const X = (x) => P.l + ((x - xmin) / xspan) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - ymin) / yspan) * (H - P.t - P.b);
  const COLORS = ["#8c2f39", "#3d5a80", "#b08a3e", "#5b7553"];

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("linechart");

  const mk = (tag, attrs, text) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  // 축
  mk("line", { x1: P.l, y1: H - P.b, x2: W - P.r, y2: H - P.b, class: "lc-axis" });
  mk("line", { x1: P.l, y1: P.t, x2: P.l, y2: H - P.b, class: "lc-axis" });
  // 축 눈금 (min/max만 — 단순하게)
  mk("text", { x: P.l, y: H - P.b + 18, class: "lc-tick", "text-anchor": "middle" }, fmtNum(xmin));
  mk("text", { x: W - P.r, y: H - P.b + 18, class: "lc-tick", "text-anchor": "end" }, fmtNum(xmax));
  mk("text", { x: P.l - 8, y: H - P.b + 4, class: "lc-tick", "text-anchor": "end" }, fmtNum(ymin));
  mk("text", { x: P.l - 8, y: P.t + 8, class: "lc-tick", "text-anchor": "end" }, fmtNum(ymax));
  // 축 이름
  if (f.x_label) mk("text", { x: (P.l + W - P.r) / 2, y: H - 8, class: "lc-label", "text-anchor": "middle" }, f.x_label);
  if (f.y_label) mk("text", { x: 14, y: (P.t + H - P.b) / 2, class: "lc-label", "text-anchor": "middle", transform: `rotate(-90 14 ${(P.t + H - P.b) / 2})` }, f.y_label);

  f.lines.forEach((line, i) => {
    const color = COLORS[i % COLORS.length];
    const sorted = [...(line.points || [])].sort((a, b) => a.x - b.x);
    const d = sorted.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ");
    mk("polyline", { points: d, fill: "none", stroke: color, "stroke-width": 2.2 });
    sorted.forEach((p) => mk("circle", { cx: X(p.x), cy: Y(p.y), r: 3.2, fill: color }));
  });

  const wrap = document.createElement("div");
  wrap.appendChild(svg);
  // 범례
  if (f.lines.length > 1 || f.lines[0].name) {
    const legend = document.createElement("div");
    legend.className = "lc-legend";
    f.lines.forEach((line, i) => {
      const item = document.createElement("span");
      item.className = "lc-legend-item";
      const dot = document.createElement("span");
      dot.className = "lc-dot";
      dot.style.background = COLORS[i % COLORS.length];
      item.append(dot, document.createTextNode(line.name || `계열 ${i + 1}`));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
  }
  return wrap;
}

function fmtNum(n) {
  return Math.abs(n) >= 1000 ? n.toLocaleString() : String(Math.round(n * 100) / 100);
}

// ── 수식 실습: 실제 숫자를 넣어 손으로 풀듯 전개한다 ──────────────────────────
// 세 층으로 보여준다.
//   ① 샘플 하나를 단계별로 — 기호식 → 숫자를 대입한 식 → 값
//   ② 샘플 전체를 같은 계산에 통과시킨 표 + 집계값(평균 등)
//   ③ 샘플 성향(group)별 비교 — 부류에 따라 결과가 어떻게 갈리는지
//
// 값은 전부 여기서 계산한다. 모델에게 숫자를 쓰게 하면 산술이 틀려 표 전체를 못 믿게
// 되기 때문이다. 대신 모델이 낸 식을 실행하는 셈이므로, 허용된 이름만 쓰였는지
// 먼저 검사하고 하나라도 어긋나면 블록을 통째로 그리지 않는다.
const DEMO_MATH = [
  "abs", "sqrt", "cbrt", "exp", "expm1", "log", "log1p", "log2", "log10",
  "pow", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "min", "max", "round", "floor", "ceil", "trunc", "sign", "hypot",
  "PI", "E", "LN2", "LN10", "SQRT2",
];
const DEMO_MATH_SET = new Set(DEMO_MATH);

/**
 * 모델이 낸 식을 검사해 실행 가능한 함수로 만든다. 안 되면 null.
 * @param {string} expr  예: "Math.exp(sp/tau)"
 * @param {string[]} vars 이 식에서 쓸 수 있는 변수명 (inputs·constants·앞선 steps의 key)
 */
function compileExpr(expr, vars) {
  const src = String(expr || "").trim();
  if (!src || src.length > 240) return null;
  // 구문을 늘리거나 객체를 타고 들어갈 수 있는 것은 전부 차단.
  //  · \ — 유니코드 이스케이프로 식별자 검사를 우회하는 길을 막는다 (Math 등)
  //  · // /* — 주석으로 뒷부분을 숨기는 길
  //  · [ ] { } ` ; = => new function return — 인덱싱·구문 확장
  //  · .foo( — Math 외의 메서드 호출 (Math.xxx는 아래에서 따로 허용)
  if (/\\|\/\/|\/\*/.test(src)) return null;
  if (/[=;`\[\]{}]|=>|\bnew\b|\bfunction\b|\breturn\b|\.\s*\w+\s*\(/.test(src.replace(/Math\s*\.\s*\w+/g, "M"))) {
    return null;
  }
  const allowed = new Set(vars);
  allowed.add("Math");
  // 식별자 검사 — Math.xxx 의 xxx는 Math 멤버 목록에 있어야 한다
  const idRe = /(Math\s*\.\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = idRe.exec(src)) !== null) {
    const isMember = !!m[1];
    const name = m[2];
    if (isMember) {
      if (!DEMO_MATH_SET.has(name)) return null;
    } else if (name !== "Math" && !allowed.has(name)) {
      return null;
    }
  }
  const names = Array.from(allowed).filter((n) => n !== "Math");
  try {
    const fn = new Function(...names, "Math", `"use strict"; return (${src});`);
    return (scope) => {
      try {
        const r = fn(...names.map((n) => scope[n]), Math);
        return typeof r === "number" && Number.isFinite(r) ? r : null;
      } catch (e) {
        return null;
      }
    };
  } catch (e) {
    return null;
  }
}

// 자릿수가 제각각인 값들(0.0007과 1024가 한 화면에)을 읽기 좋게 맞춘다
function fmtDemo(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e6 || a < 1e-4) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(a < 1 ? 4 : a < 100 ? 3 : 2);
}

/**
 * 대입식에 쓸 숫자 표기. 표(fmtDemo)보다 정밀하다.
 *
 * 왜 따로 두는가: 표시용 반올림을 그대로 쓰면 대입식이 "− log(1.0000) = 5.33e-6"처럼
 * 계산이 틀린 것으로 보인다(실제 확률은 0.99999467). 과정을 믿게 하려고 만든 기능이
 * 오히려 신뢰를 깎는다. 그래서 ==원값과 사실상 구분되지 않을 만큼== 자리수를 늘리되,
 * 그 조건을 만족하는 ==가장 짧은== 표기를 고른다.
 *
 * 기준을 1e-8로 잡은 이유: 1에 아주 가까운 확률은 상대오차가 작아도 뒤이은 log를 지나며
 * 오차가 크게 벌어진다. 0.999995(상대오차 5e-7)로 줄이면 -log가 5.00e-6이 되어 실제
 * 결과 5.33e-6과 눈에 띄게 어긋난다. 1e-8이면 그 연쇄까지 맞아떨어진다.
 */
function fmtPrecise(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const a = Math.abs(v);
  // 아주 크거나 작은 값은 지수 표기 — 0.0000053262677 같은 줄은 읽히지 않는다.
  // 가수 자리를 넉넉히(6자리) 둬서 정밀도는 유지한다.
  if (a >= 1e7 || a < 1e-4) return v.toExponential(6).replace(/\.?0+e/, "e");
  for (let p = 4; p <= 12; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.abs(s - v) <= a * 1e-8) return String(s);
  }
  return String(Number(v.toPrecision(12)));
}

/**
 * 계산식을 "숫자를 대입한 모습"으로 바꾼다 — 과정을 눈으로 따라가게 하는 핵심.
 *   "Math.exp(sp/tau)" + {sp:0.95, tau:0.07}  →  "exp(0.95 / 0.07)"
 * Math. 접두사를 떼고 변수는 값으로 치환하며, 연산자 둘레에 공백을 넣어 읽기 쉽게 한다.
 */
function substituteExpr(expr, scope) {
  let out = String(expr || "").replace(/Math\s*\.\s*/g, "");
  out = out.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (name) => {
    if (Object.prototype.hasOwnProperty.call(scope, name) && typeof scope[name] === "number") {
      return fmtPrecise(scope[name]);
    }
    return name; // exp·log 같은 함수 이름은 그대로 둔다
  });
  return out.replace(/([+\-*/])/g, " $1 ").replace(/\s{2,}/g, " ").trim();
}

function katexInto(el, latex, fallback) {
  try {
    katex.render(latex, el, { displayMode: false, throwOnError: true });
  } catch (e) {
    el.textContent = fallback != null ? fallback : latex;
  }
}

/**
 * numeric_demo를 실행 가능한 형태로 준비한다. 하나라도 어긋나면 null(블록을 안 그린다).
 * 여기서 모든 검사를 끝내므로, 이후 렌더 코드는 데이터가 성립한다고 가정해도 된다.
 */
function prepareDemo(demo) {
  if (!demo || typeof demo !== "object") return null;

  const isKey = (k) => typeof k === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

  const constants = (Array.isArray(demo.constants) ? demo.constants : [])
    .filter((c) => c && isKey(c.key) && Number.isFinite(Number(c.value)))
    .map((c) => ({ ...c, value: Number(c.value) }));
  const inputs = (Array.isArray(demo.inputs) ? demo.inputs : []).filter((v) => v && isKey(v.key));
  const rawSteps = (Array.isArray(demo.steps) ? demo.steps : []).filter((st) => st && isKey(st.key));
  if (!rawSteps.length || !inputs.length) return null;

  // 단계는 앞선 단계의 결과만 쓸 수 있다 — 순서를 강제해야 계산이 성립한다
  const known = new Set([...constants.map((c) => c.key), ...inputs.map((v) => v.key)]);
  const steps = [];
  for (const st of rawSteps) {
    const fn = compileExpr(st.compute, Array.from(known));
    if (!fn) return null; // 하나라도 못 믿으면 전체를 포기한다
    steps.push({ ...st, fn });
    known.add(st.key);
  }

  const samples = (Array.isArray(demo.samples) ? demo.samples : [])
    .filter((sp) => sp && sp.values && typeof sp.values === "object")
    .map((sp, i) => {
      const values = {};
      let ok = true;
      inputs.forEach((v) => {
        const n = Number(sp.values[v.key]);
        if (!Number.isFinite(n)) ok = false;
        values[v.key] = n;
      });
      return ok ? { name: sp.name || `샘플 ${i + 1}`, group: sp.group || "", values } : null;
    })
    .filter(Boolean)
    .slice(0, 14);
  if (samples.length < 2) return null;

  const resultKey = (demo.result && demo.result.key) || steps[steps.length - 1].key;
  if (!known.has(resultKey)) return null;

  // 샘플별로 전 단계를 실제 계산 — 여기서 나온 값만 화면에 쓴다
  const base = {};
  constants.forEach((c) => { base[c.key] = c.value; });
  const runs = samples.map((sp) => {
    const scope = { ...base, ...sp.values };
    const trace = [];
    for (const st of steps) {
      const v = st.fn(scope);
      trace.push({ step: st, value: v, scopeBefore: { ...scope } });
      if (v === null) break;
      scope[st.key] = v;
    }
    return { sample: sp, scope, trace, result: scope[resultKey] };
  });

  const valid = runs.filter((r) => typeof r.result === "number" && Number.isFinite(r.result));
  if (valid.length < 2) return null;

  const wi = Number.isInteger(demo.walkthrough) && runs[demo.walkthrough] ? demo.walkthrough : 0;
  // 상세 전개용 샘플은 끝까지 계산된 것이어야 한다
  const walk = (typeof runs[wi].result === "number" && Number.isFinite(runs[wi].result)) ? runs[wi] : valid[0];

  return {
    demo, constants, inputs, steps, runs, valid, walk,
    result: demo.result || { key: resultKey, label: "결과" },
    aggregate: ["mean", "sum", "max", "min"].includes(demo.aggregate) ? demo.aggregate : "mean",
  };
}

const AGG_LABEL = { mean: "평균", sum: "합", max: "최댓값", min: "최솟값" };
function aggregateOf(kind, nums) {
  if (!nums.length) return null;
  if (kind === "sum") return nums.reduce((a, b) => a + b, 0);
  if (kind === "max") return Math.max(...nums);
  if (kind === "min") return Math.min(...nums);
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** ① 한 샘플을 단계별로 전개 */
function buildWalkthrough(D) {
  const box = el("div", "eqd-walk");
  const head = el("div", "eqd-walk-head");
  head.append(el("span", "eqd-step-tag", "①"), el("span", "eqd-walk-title", "한 샘플로 직접 계산해 보기"));
  box.appendChild(head);

  // 이 샘플이 무엇인지 + 넣은 값들
  const who = el("div", "eqd-walk-sample");
  who.appendChild(el("strong", null, D.walk.sample.name));
  if (D.walk.sample.group) who.appendChild(el("span", "eqd-group-chip", D.walk.sample.group));
  const given = el("div", "eqd-given");
  D.inputs.forEach((v) => {
    const chip = el("span", "eqd-chip");
    const sym = el("span", "eqd-sym");
    katexInto(sym, v.symbol || v.key, v.key);
    chip.append(sym, document.createTextNode(" = " + fmtPrecise(D.walk.sample.values[v.key])));
    if (v.label) chip.title = v.label;
    given.appendChild(chip);
  });
  D.constants.forEach((c) => {
    const chip = el("span", "eqd-chip eqd-chip-const");
    const sym = el("span", "eqd-sym");
    katexInto(sym, c.symbol || c.key, c.key);
    chip.append(sym, document.createTextNode(" = " + fmtPrecise(c.value)));
    if (c.meaning) chip.title = c.meaning;
    given.appendChild(chip);
  });
  box.append(who, given);

  // 단계별 — 기호식 → 숫자 대입 → 값
  const list = el("ol", "eqd-steps");
  D.walk.trace.forEach((t) => {
    const li = el("li", "eqd-step");
    li.appendChild(el("div", "eqd-step-label", t.step.label || t.step.key));
    if (t.step.latex) {
      const lx = el("div", "eqd-step-latex");
      katexInto(lx, t.step.latex, t.step.latex);
      li.appendChild(lx);
    }
    const calc = el("div", "eqd-step-calc");
    calc.appendChild(el("code", "eqd-subst", substituteExpr(t.step.compute, t.scopeBefore)));
    calc.appendChild(el("span", "eqd-eq", "="));
    calc.appendChild(el("span", "eqd-val", fmtPrecise(t.value)));
    li.appendChild(calc);
    list.appendChild(li);
  });
  box.appendChild(list);

  // 최종 결과
  const fin = el("div", "eqd-final");
  const fsym = el("span", "eqd-sym");
  katexInto(fsym, D.result.symbol || D.result.key, D.result.key);
  fin.append(el("span", "eqd-final-label", D.result.label || "결과"), fsym,
             el("span", "eqd-final-val", "= " + fmtPrecise(D.walk.result)));
  box.appendChild(fin);
  return box;
}

/** ② 샘플 전체 표 + 집계 */
function buildAllSamples(D) {
  const box = el("div", "eqd-all");
  const head = el("div", "eqd-walk-head");
  head.append(el("span", "eqd-step-tag", "②"),
              el("span", "eqd-walk-title", `나머지 샘플도 같은 계산 (${D.valid.length}개)`));
  box.appendChild(head);

  const nums = D.valid.map((r) => r.result);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const span = hi - lo || 1;

  const table = el("table", "eqd-table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  htr.appendChild(el("th", null, "샘플"));
  D.inputs.forEach((v) => {
    const th = document.createElement("th");
    const sym = el("span", "eqd-sym");
    katexInto(sym, v.symbol || v.key, v.key);
    th.appendChild(sym);
    htr.appendChild(th);
  });
  const thR = document.createElement("th");
  const rsym = el("span", "eqd-sym");
  katexInto(rsym, D.result.symbol || D.result.key, D.result.key);
  thR.appendChild(rsym);
  htr.appendChild(thR);
  htr.appendChild(el("th", "eqd-barcol", ""));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  D.valid.forEach((r) => {
    const tr = document.createElement("tr");
    if (r === D.walk) tr.className = "eqd-row-walk"; // ①에서 푼 샘플을 표에서도 찾을 수 있게
    const tdN = el("td", "eqd-name");
    tdN.appendChild(document.createTextNode(r.sample.name));
    if (r.sample.group) tdN.appendChild(el("span", "eqd-group-chip", r.sample.group));
    tr.appendChild(tdN);
    D.inputs.forEach((v) => tr.appendChild(el("td", null, fmtDemo(r.sample.values[v.key]))));
    tr.appendChild(el("td", "eqd-out", fmtDemo(r.result)));
    const tdBar = el("td", "eqd-barcol");
    const bar = el("span", "eqd-bar");
    bar.style.width = `${Math.max(2, ((r.result - lo) / span) * 100)}%`;
    tdBar.appendChild(bar);
    tr.appendChild(tdBar);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);

  const agg = aggregateOf(D.aggregate, nums);
  const aggRow = el("div", "eqd-agg");
  aggRow.append(el("span", "eqd-agg-label", `전체 ${AGG_LABEL[D.aggregate]}`),
                el("span", "eqd-agg-val", fmtDemo(agg)));
  box.appendChild(aggRow);
  return box;
}

/** ③ 성향(group)별 비교 — 부류에 따라 값이 어떻게 갈리는지 */
function buildGroups(D) {
  const map = new Map();
  D.valid.forEach((r) => {
    const g = r.sample.group || "기타";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(r.result);
  });
  if (map.size < 2) return null; // 부류가 하나뿐이면 비교할 게 없다

  const box = el("div", "eqd-groups");
  const head = el("div", "eqd-walk-head");
  head.append(el("span", "eqd-step-tag", "③"), el("span", "eqd-walk-title", "샘플 성향에 따라 어떻게 달라지나"));
  box.appendChild(head);

  const rows = Array.from(map.entries()).map(([g, nums]) => ({
    group: g, n: nums.length, agg: aggregateOf(D.aggregate, nums),
    lo: Math.min(...nums), hi: Math.max(...nums),
  }));
  const allAgg = rows.map((r) => r.agg);
  const lo = Math.min(...allAgg, 0), hi = Math.max(...allAgg, 0);
  const span = hi - lo || 1;

  const list = el("div", "eqd-group-list");
  rows.forEach((r) => {
    const row = el("div", "eqd-group-row");
    const label = el("div", "eqd-group-name");
    label.append(el("span", "eqd-group-chip", r.group), el("span", "eqd-group-n", `${r.n}개`));
    const barWrap = el("div", "eqd-group-barwrap");
    const bar = el("span", "eqd-bar");
    bar.style.width = `${Math.max(3, ((r.agg - lo) / span) * 100)}%`;
    barWrap.appendChild(bar);
    const val = el("div", "eqd-group-val");
    val.append(el("strong", null, fmtDemo(r.agg)),
               el("span", "eqd-group-range", `${fmtDemo(r.lo)} ~ ${fmtDemo(r.hi)}`));
    row.append(label, barWrap, val);
    list.appendChild(row);
  });
  box.appendChild(list);
  box.appendChild(el("p", "eqd-group-note",
    `막대는 부류별 ${AGG_LABEL[D.aggregate]}, 오른쪽 작은 글씨는 그 부류 안에서의 최소~최대 범위입니다.`));
  return box;
}

/**
 * 수식 하나의 "숫자로 확인" 블록. 만들 수 없으면 null(아무것도 그리지 않는다).
 */
function buildNumericDemo(demo) {
  const D = prepareDemo(demo);
  if (!D) return null;

  const wrap = document.createElement("details");
  wrap.className = "eq-demo";
  wrap.open = true;

  const sum = document.createElement("summary");
  sum.appendChild(el("span", "eq-demo-tag", "숫자로 확인"));
  const purpose = el("span", "eq-demo-purpose");
  renderRich(purpose, demo.purpose || "실제 값을 넣어 계산 과정을 따라갑니다.");
  sum.appendChild(purpose);
  wrap.appendChild(sum);

  const body = el("div", "eq-demo-body");
  if (demo.setup) {
    const setup = el("p", "eq-demo-setup");
    renderRich(setup, demo.setup);
    body.appendChild(setup);
  }
  body.appendChild(buildWalkthrough(D));
  body.appendChild(buildAllSamples(D));
  const groups = buildGroups(D);
  if (groups) body.appendChild(groups);

  if (demo.insight) {
    const ins = el("p", "eq-demo-insight");
    renderRich(ins, demo.insight);
    body.appendChild(ins);
  }
  wrap.appendChild(body);
  return wrap;
}

function renderEquations(equations, equationFlow, methodSteps = []) {
  const panel = document.getElementById("panel-equations");
  panel.innerHTML = "";
  if (!equations.length) {
    panel.textContent = "정리된 핵심 수식이 없습니다.";
    return;
  }

  // ── 수식 흐름도: 개별 수식을 읽기 전에 "왜 이 순서로 필요한가"를 먼저 보여줌 ──
  if (equationFlow && Array.isArray(equationFlow.steps) && equationFlow.steps.length) {
    const fig = document.createElement("figure");
    fig.className = "pfig eqflow";

    const head = document.createElement("div");
    head.className = "pfig-head";
    const title = document.createElement("span");
    title.className = "pfig-title";
    title.textContent = "수식 흐름 한눈에 보기";
    head.appendChild(title);
    fig.appendChild(head);

    const chain = document.createElement("div");
    chain.className = "eqflow-chain";
    equationFlow.steps.forEach((step, i) => {
      if (i > 0) {
        const arrow = document.createElement("div");
        arrow.className = "arch-arrow";
        arrow.textContent = "↓";
        chain.appendChild(arrow);
      }
      const node = document.createElement("button");
      node.type = "button";
      node.className = "eqflow-node";
      const no = document.createElement("span");
      no.className = "eqflow-no";
      no.textContent = i + 1;
      const body = document.createElement("span");
      body.className = "eqflow-body";
      const goal = document.createElement("span");
      goal.className = "eqflow-goal";
      renderRich(goal, step.goal || "");
      body.appendChild(goal);
      if (step.why) {
        const why = document.createElement("span");
        why.className = "eqflow-why";
        renderRich(why, step.why);
        body.appendChild(why);
      }
      node.append(no, body);
      node.addEventListener("click", () => {
        const target = document.getElementById(`eq-${step.eq_index ?? i}`);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.remove("eq-flash");
          void target.offsetWidth; // 애니메이션 재시작
          target.classList.add("eq-flash");
        }
      });
      chain.appendChild(node);
    });
    fig.appendChild(chain);

    if (equationFlow.caption) {
      const cap = document.createElement("figcaption");
      renderRich(cap, equationFlow.caption);
      fig.appendChild(cap);
    }
    panel.appendChild(fig);
  }

  equations.forEach((eq, eqIdx) => {
    if (!eq || typeof eq !== "object") return;
    const item = document.createElement("div");
    item.className = "eq-item";
    item.id = `eq-${eqIdx}`;

    const numBadge = document.createElement("span");
    numBadge.className = "eq-no";
    numBadge.textContent = `수식 ${eqIdx + 1}`;
    item.appendChild(numBadge);

    if (eq.paper_ref) {
      const page = Number(eq.paper_page);
      // paper_ref에서 수식 번호 추출 (예: "Eq. 1", "Equation 3" → 1, 3)
      const eqNumMatch = String(eq.paper_ref || "").match(/(?:eq(?:uation)?\.?|식)\s*\(?(\d+)/i);
      const eqNum = eqNumMatch ? eqNumMatch[1] : null;
      const refBadge = document.createElement(page > 0 ? "button" : "span");
      refBadge.className = "eq-ref" + (page > 0 ? " eq-ref-link" : "");
      refBadge.textContent = `원 논문 ${eq.paper_ref}` + (page > 0 ? ` · p.${page} ↗` : "");
      if (page > 0) {
        refBadge.type = "button";
        refBadge.title = eqNum
          ? `원문 ${page}페이지로 이동 + 수식 (${eqNum})에 체크`
          : `원문 PDF ${page}페이지로 이동`;
        refBadge.addEventListener("click", () => jumpToPdfPage(page, eqNum));
      }
      item.appendChild(refBadge);
    }

    // LaTeX 원본 복사 — 자기 노트(Overleaf·Obsidian 등)에 붙여넣기용
    if (eq.latex) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "eq-copy";
      copyBtn.textContent = "📋 LaTeX";
      copyBtn.title = "LaTeX 원본 복사";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(eq.latex);
          copyBtn.textContent = "✓ 복사됨";
        } catch {
          // http(Tailscale) 등 clipboard API 불가 환경 폴백
          const ta = document.createElement("textarea");
          ta.value = eq.latex;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          copyBtn.textContent = "✓ 복사됨";
        }
        setTimeout(() => { copyBtn.textContent = "📋 LaTeX"; }, 1500);
      });
      item.appendChild(copyBtn);
    }

    // 방법론 단계 연결 배지 — 클릭 시 해당 단계로 점프
    const si = Number.isInteger(eq.step_index) ? eq.step_index : -1;
    if (si >= 0 && si < methodSteps.length) {
      const stepBadge = document.createElement("button");
      stepBadge.type = "button";
      stepBadge.className = "eq-step";
      stepBadge.textContent = `단계 ${si + 1} · ${(methodSteps[si].title || "").slice(0, 16)}`;
      stepBadge.title = "연구 방법론의 해당 단계로 이동";
      stepBadge.addEventListener("click", () => {
        switchTab("method");
        const target = document.getElementById(`step-${si}`);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.remove("eq-flash");
          void target.offsetWidth;
          target.classList.add("eq-flash");
        }
      });
      item.appendChild(stepBadge);
    }

    const latexDiv = document.createElement("div");
    latexDiv.className = "eq-latex";
    try {
      katex.render(eq.latex, latexDiv, { displayMode: true, throwOnError: true });
    } catch {
      // 렌더 실패 시 원본 LaTeX를 그대로 노출
      latexDiv.innerHTML = `<span class="eq-error">수식 렌더링 실패: </span>`;
      const code = document.createElement("code");
      code.textContent = eq.latex;
      latexDiv.appendChild(code);
    }

    item.appendChild(latexDiv);

    // 변수 범례: 기본 접힘, 클릭해서 펼침
    if (Array.isArray(eq.variables) && eq.variables.length) {
      const details = document.createElement("details");
      details.className = "eq-vars-wrap";
      const summary = document.createElement("summary");
      summary.textContent = `변수 설명 ${eq.variables.length}개 보기`;
      details.appendChild(summary);

      const legend = document.createElement("dl");
      legend.className = "eq-vars";
      eq.variables.forEach((v) => {
        const dt = document.createElement("dt");
        try {
          katex.render(v.symbol, dt, { displayMode: false, throwOnError: true });
        } catch {
          dt.textContent = v.symbol;
        }
        const dd = document.createElement("dd");
        renderRich(dd, v.meaning || "");
        legend.append(dt, dd);
      });
      details.appendChild(legend);
      item.appendChild(details);
    }

    const expl = document.createElement("p");
    expl.className = "eq-explanation";
    renderRich(expl, eq.explanation || "");
    item.appendChild(expl);

    if (eq.analogy) {
      const ana = document.createElement("p");
      ana.className = "step-analogy";
      renderRich(ana, eq.analogy);
      item.appendChild(ana);
    }

    // 숫자로 확인 — 설명·비유 다음에 두어 "읽고 → 직접 값을 본다" 순서가 되게 한다.
    // 옛 분석에는 numeric_demo가 없으므로 그냥 안 그려진다(섹션 재생성하면 생김).
    const demoEl = buildNumericDemo(eq.numeric_demo);
    if (demoEl) item.appendChild(demoEl);
    panel.appendChild(item);
  });
}

