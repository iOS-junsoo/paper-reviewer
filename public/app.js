const dropzone = document.getElementById("dropzone");
const pickBtn = document.getElementById("pick-btn");
const fileInput = document.getElementById("file-input");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");
const workspaceEl = document.getElementById("workspace");
const cacheBadge = document.getElementById("cache-badge");
const historyList = document.getElementById("history-list");
const pdfScroll = document.getElementById("pdf-scroll");
const pdfMissing = document.getElementById("pdf-missing");

let currentHash = null;
let chatHistory = [];
let currentSuggested = [];
let analysisAbort = null; // 진행 중인 분석/재분석 fetch를 취소하기 위한 AbortController

const cancelBtn = document.getElementById("cancel-analysis");
// "분석 취소" 버튼 — fetch를 끊으면 서버도 연결 종료를 감지해 에이전트 실행을 멈춘다(사용량 절약)
cancelBtn.addEventListener("click", () => {
  if (analysisAbort) analysisAbort.abort();
});

// 취소 가능한 분석/재분석 시작. 이미 진행 중이던 흐름이 있으면 먼저 취소해
// (1) 컨트롤러가 항상 현재 흐름을 가리키게 하고 (2) 버려지는 분석의 사용량을 막는다.
function beginCancellable() {
  if (analysisAbort) analysisAbort.abort();
  const ac = new AbortController();
  analysisAbort = ac;
  cancelBtn.classList.remove("hidden");
  return ac;
}
// 이 흐름 종료 정리 — 그 사이 다른 흐름이 시작돼 컨트롤러가 바뀌었으면 건드리지 않는다.
// 반환값: 이 흐름이 아직 '현재' 흐름이었으면 true (UI 정리해도 되는지 판단용).
function endCancellable(ac) {
  if (analysisAbort === ac) {
    analysisAbort = null;
    cancelBtn.classList.add("hidden");
    return true;
  }
  return false;
}

// 재분석 배너의 "취소"도 동일하게 진행 중 분석을 중단한다
document.getElementById("rebar-cancel").addEventListener("click", () => {
  if (analysisAbort) analysisAbort.abort();
});

// ── 읽기 테마 (기본 → 세피아 → 다크 순환). 속성은 <html>(documentElement)에 둔다
// — head의 인라인 스크립트가 첫 페인트 전에 미리 적용해 깜빡임(FOUC)을 막는다. ──
const THEMES = ["light", "sepia", "dark"];
(function initTheme() {
  let t = document.documentElement.dataset.theme; // head 스크립트가 이미 설정했을 수 있음
  if (!THEMES.includes(t)) {
    try { t = localStorage.getItem("theme"); } catch {}
    document.documentElement.dataset.theme = THEMES.includes(t) ? t : "light";
  }
})();
document.getElementById("theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "light";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

// ── 히스토리 검색 필터 (제목·요약 부분일치) ──
let historyFilter = "";
const historySearch = document.getElementById("history-search");
historySearch.addEventListener("input", () => {
  historyFilter = historySearch.value.trim().toLowerCase();
  applyHistoryFilter();
});
function applyHistoryFilter() {
  document.querySelectorAll("#history-list li[data-hash]").forEach((li) => {
    // 제목·요약만 대상으로 (날짜·버튼 글리프는 제외 — placeholder 약속과 일치)
    const text = (
      (li.querySelector(".h-title")?.textContent || "") + " " +
      (li.querySelector(".h-line")?.textContent || "")
    ).toLowerCase();
    li.style.display = !historyFilter || text.includes(historyFilter) ? "" : "none";
  });
}

// ── URL 딥링크 (#p=<hash>&tab=<tab>) — 북마크·뒤로가기로 논문·탭 복원 ──
let activeTab = "background";
function parseHash() {
  const params = {};
  location.hash.replace(/^#/, "").split("&").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) {
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      try { params[k] = decodeURIComponent(v); } catch { params[k] = v; } // 잘못된 % 시퀀스에도 죽지 않게
    }
  });
  return params;
}
function updateHash() {
  if (!currentHash) return;
  const want = `#p=${currentHash}&tab=${activeTab}`;
  // 탭/논문 전환은 새 history 항목을 쌓지 않도록 replaceState로 교체 (뒤로가기 오염 방지)
  if (location.hash !== want) {
    try { history.replaceState(null, "", want); } catch { location.hash = want; }
  }
}
function clearHash() {
  try { history.replaceState(null, "", location.pathname + location.search); }
  catch {}
}
window.addEventListener("hashchange", () => {
  if (analysisAbort) return; // 분석 진행 중엔 뒤로/앞으로가 분석을 끊지 않도록
  const { p, tab } = parseHash();
  if (p && p !== currentHash) {
    openHistory(p).then((ok) => { if (ok && tab && tab !== activeTab) switchTab(tab); });
  } else if (tab && tab !== activeTab) {
    switchTab(tab);
  }
});
async function restoreFromHash() {
  const { p, tab } = parseHash();
  if (!p) return;
  const ok = await openHistory(p);
  if (ok && tab && tab !== activeTab) switchTab(tab); // 404 등 실패 시 탭 전환 안 함
}

// 백엔드를 다른 도메인에 둘 때(예: 프론트는 GitHub Pages, 백엔드는 Render)
// index.html에서 <script>window.API_BASE = "https://...";</script> 로 지정
const API_BASE = window.API_BASE || "";

// ---------- 업로드 ----------
pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) analyzeFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) analyzeFile(file);
});

async function analyzeFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return showError("PDF 파일만 업로드할 수 있습니다.");
  }
  hideError();
  workspaceEl.classList.add("hidden");
  loadingEl.classList.remove("hidden");
  setActiveAnalysis(file.name.replace(/\.pdf$/i, ""));
  setLoadingProgress("논문을 업로드하는 중…", 0);

  const form = new FormData();
  form.append("pdf", file);

  const ac = beginCancellable();
  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST", body: form, signal: ac.signal,
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error(formatApiError(data, res.status));
    }
    const data = await consumeAnalysisStream(res); // SSE: 진행 메시지 → 최종 결과
    renderResult(data);
    loadHistory();
  } catch (e) {
    if (e.name === "AbortError") loadHistory(); // 사용자가 취소 — 조용히 초기 화면으로
    else showError(e.message);
  } finally {
    // 이 흐름이 다른 새 흐름으로 대체됐다면 UI 정리를 건너뛴다(새 흐름의 화면을 망치지 않게)
    if (endCancellable(ac)) {
      loadingEl.classList.add("hidden");
      setActiveAnalysis(null);
      setLoadingText("논문을 분석하고 있습니다…");
    }
    fileInput.value = "";
  }
}

let lastLoadingPct = 0;

// 실측 진행도 갱신 — msg(상태 문구)와 pct(0~100, 실제 이벤트에만 변함)
function setLoadingProgress(msg, pct) {
  if (msg != null) document.getElementById("loading-text").textContent = msg;
  if (typeof pct === "number" && !Number.isNaN(pct)) {
    lastLoadingPct = Math.max(0, Math.min(100, Math.round(pct)));
    document.getElementById("loading-pct").textContent = `${lastLoadingPct}%`;
    document.getElementById("loading-fill").style.width = `${lastLoadingPct}%`;
  }
  const prog = document.getElementById("sb-active-prog");
  if (prog) prog.textContent = `${lastLoadingPct}% · ${msg || ""}`.trim();
  // 재분석 배너(인라인 재분석) 미러링 — 배너가 떠 있을 때만 의미 있음
  if (msg != null) document.getElementById("rebar-text").textContent = msg;
  document.getElementById("rebar-pct").textContent = `${lastLoadingPct}%`;
  document.getElementById("rebar-fill").style.width = `${lastLoadingPct}%`;
}

// 현재 보고 있는 논문을 재분석할 때: 로딩 화면으로 덮지 않고 기존 결과를 그대로 둔 채
// 상단에 진행 배너만 띄운다(읽던 내용 유지). 완료되면 renderResult가 내용을 교체한다.
function showReanalyzeBanner() {
  document.getElementById("rebar-text").textContent = "재분석을 시작하는 중…";
  document.getElementById("rebar-pct").textContent = "0%";
  document.getElementById("rebar-fill").style.width = "0%";
  document.getElementById("reanalyze-banner").classList.remove("hidden");
}
function hideReanalyzeBanner() {
  document.getElementById("reanalyze-banner").classList.add("hidden");
}

// 메시지만 바꿀 때 (진행률 유지)
function setLoadingText(msg) {
  setLoadingProgress(msg, undefined);
}

// 분석 시작 시 0%로 초기화
function resetLoadingProgress() {
  lastLoadingPct = 0;
  document.getElementById("loading-pct").textContent = "0%";
  document.getElementById("loading-fill").style.width = "0%";
}

// 사이드바 "분석 중" 표시 — title이 있으면 표시, null이면 숨김
function setActiveAnalysis(title) {
  const box = document.getElementById("sb-active");
  if (!box) return;
  if (title) {
    document.getElementById("sb-active-title").textContent = title;
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }
}

// 지나간 진행 단계를 ✓ 로그로 쌓는다
function appendLoadingLog(msg) {
  const log = document.getElementById("loading-log");
  const li = document.createElement("li");
  li.textContent = `✓ ${msg}`;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

// 서버가 보내는 SSE 스트림(progress/result/error)을 소비하고 최종 결과를 반환
async function consumeAnalysisStream(res) {
  document.getElementById("loading-log").innerHTML = "";
  let lastProgress = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.type === "progress") {
        if (lastProgress && lastProgress !== ev.msg) appendLoadingLog(lastProgress);
        lastProgress = ev.msg;
        setLoadingProgress(ev.msg, ev.pct);
      } else if (ev.type === "result") {
        result = ev.data;
        setLoadingProgress("완료!", 100);
      } else if (ev.type === "error") {
        let msg = ev.error || "분석 실패";
        if (ev.detail) msg += `\n\n모델 응답 일부:\n${ev.detail}`;
        throw new Error(msg);
      }
    }
  }
  if (!result) throw new Error("서버 연결이 중간에 끊어졌습니다. 다시 시도해 주세요.");
  return result;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function formatApiError(data, status) {
  if (data && data.error) {
    let msg = data.error;
    if (data.detail) msg += `\n\n모델 응답 일부:\n${data.detail}`;
    return msg;
  }
  return `서버 오류 (HTTP ${status})`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}
function hideError() {
  errorEl.classList.add("hidden");
}

// ---------- 결과 렌더링 ----------
// 지원 마크업: **볼드**, ==형광펜==, $인라인 수식$, 줄 맨 앞 "## 소제목"
// (HTML은 먼저 이스케이프, 수식은 KaTeX로 렌더링)
function richHtml(text) {
  // 1) $...$ 인라인 수식을 플레이스홀더로 추출 (이스케이프/마크업 처리와 충돌 방지)
  const mathParts = [];
  const src = (text || "").replace(/\$([^$\n]+?)\$/g, (match, tex) => {
    if (typeof katex === "undefined") return match;
    try {
      mathParts.push(katex.renderToString(tex, { displayMode: false, throwOnError: true }));
      return `\u0000${mathParts.length - 1}\u0000`;
    } catch {
      return match; // 렌더 실패 시 원문 그대로 (이스케이프되어 텍스트로 표시)
    }
  });

  // 2) HTML 이스케이프 + 마크업 변환
  const escaped = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = escaped
    .split("\n")
    .map((line) =>
      line.startsWith("## ") ? `<h4 class="subhead">${line.slice(3)}</h4>` : line + "\n"
    )
    .join("");
  html = html
    .replace(/\n+(<h4)/g, "$1") // 소제목 앞 빈 줄 제거
    .replace(/==([^=\n][^=]*?)==/g, "<mark>$1</mark>")
    .replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>")
    // [[p7]] / [[p7|근거 구절]] → 원문 PDF 페이지로 점프하는 근거 배지
    .replace(/\[\[\s*p\.?\s*(\d+)\s*(?:\|\s*([^\]]+?))?\s*\]\]/gi, (m, page, quote) => {
      const title = quote ? ` title="${quote.replace(/"/g, "&quot;")}"` : "";
      return `<button type="button" class="ev-badge" data-page="${page}"${title}>p.${page}</button>`;
    });

  // 3) 수식 플레이스홀더 복원
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => mathParts[+i]);
  return html.replace(/\n+$/, "");
}

function renderRich(el, text) {
  el.innerHTML = richHtml(text);
}

function renderResult(data) {
  currentHash = data.hash || null;
  currentSuggested = Array.isArray(data.suggested_questions) ? data.suggested_questions : [];
  loadChat(currentHash); // 저장된 채팅 기록 비동기 로드

  document.getElementById("paper-title").textContent = data.title || "(제목 없음)";
  renderRich(document.getElementById("one-liner"), data.one_liner || "");
  renderContributions(data.contributions);
  cacheBadge.classList.toggle("hidden", !data.cached);

  renderRich(document.getElementById("panel-background"), data.background || "(내용 없음)");
  // 분야 발전 타임라인 (배경 탭 상단)
  if (Array.isArray(data.timeline) && data.timeline.length) {
    const bg = document.getElementById("panel-background");
    bg.insertBefore(buildTimeline(data.timeline), bg.firstChild);
  }
  renderRich(document.getElementById("panel-problem"), data.problem || "(내용 없음)");
  renderMethod(data);
  renderResults(data.experiments);
  renderEquations(data.equations || [], data.equation_flow, data.method_steps || []);
  renderRelated(data.related_papers);
  loadPdf(currentHash);

  workspaceEl.classList.remove("hidden");
  chatFab.classList.remove("hidden"); // 분석 결과가 있어야 질문 가능
  document.body.classList.add("reading"); // 상단 헤더·드롭존 축소
  highlightActiveHistory(); // 사이드바에서 현재 논문 강조
  switchTab("background");
}

// ---------- 분야 발전 타임라인 ----------
function buildTimeline(items) {
  const wrap = document.createElement("div");
  wrap.className = "timeline";
  items.forEach((it, i) => {
    const node = document.createElement("div");
    node.className = "tl-item" + (i === items.length - 1 ? " tl-last" : "");
    const year = document.createElement("div");
    year.className = "tl-year";
    year.textContent = it.year ?? "";
    const dot = document.createElement("div");
    dot.className = "tl-dot";
    const label = document.createElement("div");
    label.className = "tl-label";
    renderRich(label, it.label || "");
    const note = document.createElement("div");
    note.className = "tl-note";
    renderRich(note, it.note || "");
    node.append(year, dot, label, note);
    wrap.appendChild(node);
  });
  return wrap;
}

// ---------- 핵심 기여 (제목 아래) ----------
function renderContributions(items) {
  const el = document.getElementById("contributions");
  el.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    el.classList.add("hidden");
    return;
  }
  const head = document.createElement("div");
  head.className = "contrib-head";
  head.textContent = "핵심 기여";
  el.appendChild(head);
  const ul = document.createElement("ul");
  ul.className = "contrib-list";
  items.forEach((c) => {
    const li = document.createElement("li");
    renderRich(li, typeof c === "string" ? c : (c && c.text) || "");
    ul.appendChild(li);
  });
  el.appendChild(ul);
  el.classList.remove("hidden");
}

// ---------- 실험·결과 탭 ----------
function renderResults(exp) {
  const panel = document.getElementById("panel-results");
  panel.innerHTML = "";
  const has =
    exp && typeof exp === "object" &&
    (exp.takeaway || exp.limitations ||
      (Array.isArray(exp.datasets) && exp.datasets.length) ||
      (Array.isArray(exp.baselines) && exp.baselines.length) ||
      (Array.isArray(exp.metrics) && exp.metrics.length) ||
      (Array.isArray(exp.ablations) && exp.ablations.length));
  if (!has) {
    panel.innerHTML =
      `<p class="muted res-empty">이 분석에는 실험·결과 정보가 없습니다.<br />` +
      `예전에 분석한 논문이면 히스토리에서 🔄로 재분석하면 채워집니다. (이론·서베이 논문은 결과가 적을 수 있어요.)</p>`;
    return;
  }
  if (exp.takeaway) {
    const t = document.createElement("div");
    t.className = "res-takeaway";
    renderRich(t, "📌 " + exp.takeaway);
    panel.appendChild(t);
  }
  if (Array.isArray(exp.metrics) && exp.metrics.length) {
    panel.appendChild(buildResultMetrics(exp.metrics));
  }
  if ((Array.isArray(exp.datasets) && exp.datasets.length) ||
      (Array.isArray(exp.baselines) && exp.baselines.length)) {
    panel.appendChild(buildResultMeta(exp.datasets, exp.baselines));
  }
  if (Array.isArray(exp.ablations) && exp.ablations.length) {
    panel.appendChild(buildResultList("주요 분석 (Ablation)", exp.ablations, "res-ablations"));
  }
  if (exp.limitations) {
    const sec = document.createElement("div");
    sec.className = "res-section";
    const h = document.createElement("h4");
    h.className = "res-h";
    h.textContent = "한계 · 향후 연구";
    const body = document.createElement("div");
    renderRich(body, exp.limitations);
    sec.append(h, body);
    panel.appendChild(sec);
  }
}

// 핵심 지표 — 단위가 제각각이라 막대 대신 카드로 (논문 결과는 강조)
function buildResultMetrics(metrics) {
  const sec = document.createElement("div");
  sec.className = "res-section";
  const h = document.createElement("h4");
  h.className = "res-h";
  h.textContent = "핵심 지표";
  sec.appendChild(h);
  const grid = document.createElement("div");
  grid.className = "res-metric-grid";
  metrics.forEach((m) => {
    if (!m || typeof m !== "object") return; // null·문자열 등 비정상 항목은 건너뜀
    const card = document.createElement("div");
    card.className = "metric-card" + (m.highlight ? " metric-hl" : "");
    const lab = document.createElement("div");
    lab.className = "metric-label";
    renderRich(lab, m.label || "");
    const val = document.createElement("div");
    val.className = "metric-value";
    val.textContent =
      typeof m.value === "number" ? fmtNum(m.value)
      : typeof m.value === "string" ? m.value
      : ""; // 객체·배열 등은 '[object Object]' 대신 공백
    if (m.unit) {
      const u = document.createElement("span");
      u.className = "metric-unit";
      u.textContent = " " + m.unit;
      val.appendChild(u);
    }
    card.append(lab, val);
    if (m.note) {
      const note = document.createElement("div");
      note.className = "metric-note";
      renderRich(note, m.note);
      card.appendChild(note);
    }
    grid.appendChild(card);
  });
  sec.appendChild(grid);
  return sec;
}

// 데이터셋 + 비교 대상(baselines)
function buildResultMeta(datasets, baselines) {
  const wrap = document.createElement("div");
  wrap.className = "res-meta";
  if (Array.isArray(datasets) && datasets.length) {
    const col = document.createElement("div");
    col.className = "res-section res-meta-col";
    const h = document.createElement("h4");
    h.className = "res-h";
    h.textContent = "데이터셋";
    col.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "res-datasets";
    datasets.forEach((d) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "ds-name";
      name.textContent = (d && d.name) || (typeof d === "string" ? d : "");
      li.appendChild(name);
      if (d && d.detail) {
        const det = document.createElement("span");
        det.className = "ds-detail";
        det.textContent = " — " + d.detail;
        li.appendChild(det);
      }
      ul.appendChild(li);
    });
    col.appendChild(ul);
    wrap.appendChild(col);
  }
  if (Array.isArray(baselines) && baselines.length) {
    const col = document.createElement("div");
    col.className = "res-section res-meta-col";
    const h = document.createElement("h4");
    h.className = "res-h";
    h.textContent = "비교 대상 (Baselines)";
    col.appendChild(h);
    const chips = document.createElement("div");
    chips.className = "res-chips";
    baselines.forEach((b) => {
      const c = document.createElement("span");
      c.className = "res-chip";
      c.textContent = typeof b === "string" ? b : (b && b.name) || "";
      chips.appendChild(c);
    });
    col.appendChild(chips);
    wrap.appendChild(col);
  }
  return wrap;
}

function buildResultList(title, items, cls) {
  const sec = document.createElement("div");
  sec.className = "res-section";
  const h = document.createElement("h4");
  h.className = "res-h";
  h.textContent = title;
  const ul = document.createElement("ul");
  ul.className = cls;
  items.forEach((a) => {
    const li = document.createElement("li");
    renderRich(li, typeof a === "string" ? a : (a && a.text) || "");
    ul.appendChild(li);
  });
  sec.append(h, ul);
  return sec;
}

// ---------- 원문 PDF 패널 ----------
let pdfAvailable = false;

// ── PDF.js 뷰어 ───────────────────────────────────────────────────
// iframe 대신 PDF.js로 직접 렌더링 → 페이지 위에 수식 하이라이트 박스를 얹을 수 있다
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
let pdfDoc = null;
let pdfScale = 1;
let pdfRenderToken = 0; // 논문 전환 시 이전 렌더 무효화
const pdfPageEls = new Map(); // pageNum -> wrap div

async function loadPdf(hash) {
  pdfMissing.classList.add("hidden");
  pdfScroll.classList.add("hidden");
  pdfAvailable = false;
  pdfDoc = null;
  pdfPageEls.clear();
  pdfScroll.innerHTML = "";
  const token = ++pdfRenderToken;
  if (!hash) return pdfMissing.classList.remove("hidden");

  try {
    const head = await fetch(`${API_BASE}/api/pdf/${hash}`, { method: "HEAD" });
    if (!head.ok) throw new Error("no pdf");
    if (typeof pdfjsLib === "undefined") throw new Error("pdfjs 미로딩");

    const doc = await pdfjsLib.getDocument(`${API_BASE}/api/pdf/${hash}`).promise;
    if (token !== pdfRenderToken) return; // 그 사이 다른 논문으로 전환됨
    pdfDoc = doc;
    pdfAvailable = true;
    pdfScroll.classList.remove("hidden");

    // 1페이지 크기로 폭에 맞춘 스케일 계산 + 모든 페이지 placeholder 생성(렌더는 지연)
    const first = await doc.getPage(1);
    const baseVp = first.getViewport({ scale: 1 });
    pdfScale = Math.max(0.3, (pdfScroll.clientWidth - 18) / baseVp.width);
    const phH = baseVp.height * pdfScale;

    const lazy = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) renderPdfPage(Number(e.target.dataset.page), token);
      }),
      { root: pdfScroll, rootMargin: "400px 0px" }
    );
    for (let n = 1; n <= doc.numPages; n++) {
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.dataset.page = n;
      wrap.style.height = `${phH}px`;
      pdfScroll.appendChild(wrap);
      pdfPageEls.set(n, wrap);
      lazy.observe(wrap);
    }
  } catch {
    pdfMissing.classList.remove("hidden");
  }
}

async function renderPdfPage(n, token) {
  const wrap = pdfPageEls.get(n);
  if (!wrap || wrap.dataset.rendered || !pdfDoc) return;
  wrap.dataset.rendered = "1";
  try {
    const page = await pdfDoc.getPage(n);
    if (token !== pdfRenderToken) return;
    const vp = page.getViewport({ scale: pdfScale });
    // 고DPI(레티나) 화면 선명도 — 백킹 스토어는 dpr배 해상도, 표시는 논리 px
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    wrap.style.height = "";
    wrap.appendChild(canvas);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
  } catch {
    wrap.dataset.rendered = ""; // 실패 시 재시도 허용
  }
}

// PDF 텍스트 레이어에서 수식 번호 "(N)"의 위치를 찾는다 — 우측 정렬된 것 우선(=수식 번호)
async function findEqNumberPos(pageNum, eqNum) {
  if (!eqNum || !pdfDoc || typeof pdfjsLib === "undefined") return null;
  try {
    const page = await pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: pdfScale });
    const tc = await page.getTextContent();
    const want = `(${eqNum})`;
    let best = null;
    for (const it of tc.items) {
      if (!it.str) continue;
      const s = it.str.replace(/\s+/g, "");
      if (s === want || s.endsWith(want)) {
        const m = pdfjsLib.Util.transform(vp.transform, it.transform);
        const h = Math.hypot(m[2], m[3]) || 11;
        const w = (it.width || 0) * pdfScale;
        const cand = { x: m[4], y: m[5] - h, h, right: m[4] + w };
        if (!best || cand.x > best.x) best = cand; // 가장 오른쪽 = 수식 번호
      }
    }
    return best;
  } catch {
    return null;
  }
}

// 수식 번호 옆에 ✓ 체크 마커를 찍는다 (한 번에 하나만)
function markEqNumber(wrap, pos) {
  wrap.querySelectorAll(".pdf-eqcheck").forEach((e) => e.remove());
  if (!pos) return false;
  const size = Math.max(15, pos.h * 1.5);
  const chk = document.createElement("div");
  chk.className = "pdf-eqcheck";
  chk.textContent = "✓";
  chk.style.width = chk.style.height = `${size}px`;
  // 수식 번호 "(N)" 오른쪽 끝 뒤에 배치 (수식 본문과 겹치지 않게)
  const rightEdge = pos.right || pos.x;
  chk.style.left = `${rightEdge + 4}px`;
  chk.style.top = `${pos.y + pos.h / 2 - size / 2}px`;
  wrap.appendChild(chk);
  void chk.offsetWidth;
  chk.classList.add("show");
  // 3초 뒤 사라짐 (페이드아웃 후 제거)
  setTimeout(() => chk.classList.add("fade"), 2600);
  setTimeout(() => chk.remove(), 3000);
  return true;
}

// 수식 카드의 "원 논문 위치" 클릭 → 해당 페이지로 + 그 수식 번호에 ✓ 체크
async function jumpToPdfPage(page, eqNum) {
  if (!currentHash) return;
  if (!pdfAvailable) {
    showError("이 논문의 원문 PDF가 저장돼 있지 않습니다. 같은 PDF를 다시 업로드하면 페이지 점프가 활성화됩니다.");
    return;
  }
  workspaceEl.classList.remove("pdf-collapsed");
  document.getElementById("pdf-toggle").textContent = "접기 ◀";

  // 이전 페이지의 체크 마커 모두 제거 (한 번에 하나만 표시)
  document.querySelectorAll(".pdf-eqcheck").forEach((e) => e.remove());

  const wrap = pdfPageEls.get(page);
  if (!wrap) return;
  await renderPdfPage(page, pdfRenderToken);

  const pos = await findEqNumberPos(page, eqNum);
  const marked = markEqNumber(wrap, pos);
  // 체크가 찍혔으면 그 위치를, 아니면 페이지 상단을 화면에 보이게
  const target = marked ? wrap.querySelector(".pdf-eqcheck") : wrap;
  target.scrollIntoView({ block: marked ? "center" : "start", behavior: "smooth" });
  flagPdfJump(page);
}

// PDF 패널에 "여기로 이동했다"는 시각 표시 (펄스 + 페이지 플래그)
function flagPdfJump(page) {
  const pane = document.getElementById("pdf-pane");
  pane.classList.remove("pdf-pulse");
  void pane.offsetWidth;
  pane.classList.add("pdf-pulse");

  let flag = document.getElementById("pdf-jump-flag");
  if (!flag) {
    flag = document.createElement("div");
    flag.id = "pdf-jump-flag";
    flag.className = "pdf-jump-flag";
    pane.appendChild(flag);
  }
  flag.textContent = `📍 ${page}페이지로 이동`;
  flag.classList.remove("show");
  void flag.offsetWidth;
  flag.classList.add("show");
}

// 본문·채팅 어디서든 근거 배지(.ev-badge) 클릭 → 해당 PDF 페이지로 (이벤트 위임)
document.addEventListener("click", (e) => {
  const badge = e.target.closest(".ev-badge");
  if (!badge) return;
  const page = Number(badge.dataset.page);
  if (page > 0) jumpToPdfPage(page);
});

// 사이드바 열기/접기 (localStorage에 상태 저장)
(() => {
  const app = document.querySelector(".app");
  const setCollapsed = (c) => {
    app.classList.toggle("sb-collapsed", c);
    localStorage.setItem("sbCollapsed", c ? "1" : "0");
  };
  document.getElementById("sb-collapse").addEventListener("click", () => setCollapsed(true));
  document.getElementById("sb-open").addEventListener("click", () => setCollapsed(false));
  setCollapsed(localStorage.getItem("sbCollapsed") === "1");
})();

// 사이드바 "새 논문 분석" → 워크스페이스 닫고 드롭존으로
document.getElementById("sb-new").addEventListener("click", () => {
  document.body.classList.remove("reading");
  workspaceEl.classList.add("hidden");
  hideError();
  currentHash = null;
  clearHash(); // 새 분석 화면에선 #p= 해시를 비워 새로고침 시 옛 논문이 다시 열리지 않게
  highlightActiveHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.getElementById("pdf-toggle").addEventListener("click", () => {
  const collapsed = workspaceEl.classList.toggle("pdf-collapsed");
  document.getElementById("pdf-toggle").textContent = collapsed ? "펼치기 ▶" : "접기 ◀";
});

// ---------- 관련 논문 ----------
function renderRelated(papers) {
  const box = document.getElementById("related");
  const list = document.getElementById("related-list");
  list.innerHTML = "";
  if (!Array.isArray(papers) || !papers.length) {
    box.classList.add("hidden");
    return;
  }
  papers.forEach((p) => {
    const li = document.createElement("li");
    const title = document.createElement(p.link ? "a" : "span");
    title.className = "rel-title";
    title.textContent = p.title + (p.year ? ` (${p.year})` : "");
    if (p.link) {
      title.href = p.link;
      title.target = "_blank";
      title.rel = "noopener";
    }
    const reason = document.createElement("p");
    reason.className = "rel-reason";
    renderRich(reason, p.reason || "");
    li.append(title, reason);
    list.appendChild(li);
  });
  box.classList.remove("hidden");
}

// ---------- 질문하기 (플로팅 버튼 + 우측 드로어) ----------
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatFab = document.getElementById("chat-fab");
const chatDrawer = document.getElementById("chat-drawer");

chatFab.addEventListener("click", () => {
  const open = chatDrawer.classList.toggle("open");
  chatDrawer.setAttribute("aria-hidden", String(!open));
  if (open) chatInput.focus();
});
document.getElementById("chat-close").addEventListener("click", () => {
  chatDrawer.classList.remove("open");
  chatDrawer.setAttribute("aria-hidden", "true");
});

// 드로어 왼쪽 모서리 드래그로 폭 조절 (localStorage에 저장)
(() => {
  const handle = document.getElementById("chat-resize");
  const saved = Number(localStorage.getItem("chatDrawerWidth"));
  if (saved >= 320) chatDrawer.style.width = `${saved}px`;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("chat-resizing"); // iframe이 마우스를 삼키지 않도록
    chatDrawer.style.transition = "none";

    const onMove = (ev) => {
      const w = Math.min(window.innerWidth * 0.85, Math.max(320, window.innerWidth - ev.clientX));
      chatDrawer.style.width = `${w}px`;
    };
    const onUp = (ev) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("chat-resizing");
      chatDrawer.style.transition = "";
      localStorage.setItem("chatDrawerWidth", String(Math.round(chatDrawer.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
})();

function renderChatLog() {
  chatMessages.innerHTML = "";
  if (!chatHistory.length) {
    chatMessages.innerHTML =
      '<p class="chat-hint">이 논문에 대해 궁금한 점을 물어보세요. 필요하면 원문 PDF를 직접 찾아 읽고 답합니다.</p>';
  } else {
    chatHistory.forEach((m) => {
      appendChat("q", m.q);
      appendChat("a", m.a);
    });
  }
  // 추천 질문 칩 (분석 시 모델이 만든 예상 질문)
  if (currentSuggested.length) {
    const chips = document.createElement("div");
    chips.className = "chat-chips";
    currentSuggested.forEach((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chat-chip";
      b.textContent = q;
      b.addEventListener("click", () => {
        chatInput.value = q;
        chatForm.requestSubmit();
      });
      chips.appendChild(b);
    });
    chatMessages.appendChild(chips);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

async function loadChat(hash) {
  chatHistory = [];
  renderChatLog();
  if (!hash) return;
  try {
    const r = await fetch(`${API_BASE}/api/chat/${hash}`);
    if (r.ok) {
      const d = await r.json();
      if (hash === currentHash && Array.isArray(d.messages) && d.messages.length) {
        chatHistory = d.messages;
        renderChatLog();
      }
    }
  } catch {}
}

function appendChat(role, text) {
  const div = document.createElement("div");
  div.className = role === "q" ? "chat-q" : "chat-a";
  renderRich(div, text);
  chatMessages.querySelector(".chat-hint")?.remove();
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q || !currentHash || chatSend.disabled) return;
  chatInput.value = "";
  chatMessages.querySelector(".chat-chips")?.remove(); // 첫 질문 후 추천 칩 제거
  appendChat("q", q);
  const thinking = appendChat("a", "🤔 논문을 확인하며 생각 중… (보통 30초~2분)");
  thinking.classList.add("chat-thinking");
  chatSend.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/ask/${currentHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, history: chatHistory }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    thinking.remove();
    appendChat("a", data.answer);
    chatHistory.push({ q, a: data.answer });
  } catch (err) {
    thinking.remove();
    appendChat("a", "⚠️ " + err.message);
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
});

// ---------- 연구 방법론: 재구성 figure들 + 스테퍼 ----------
function renderMethod(data) {
  const panel = document.getElementById("panel-method");
  panel.innerHTML = "";

  // figures (신규) 또는 architecture (구버전 호환)
  const figures = Array.isArray(data.figures)
    ? data.figures
    : data.architecture && Array.isArray(data.architecture.flow)
      ? [{ type: "flow", ...data.architecture, title: "모델 아키텍처" }]
      : [];
  figures.forEach((f) => {
    const el = buildFigure(f);
    if (el) panel.appendChild(el);
  });

  if (Array.isArray(data.method_steps) && data.method_steps.length) {
    const ol = document.createElement("ol");
    ol.className = "stepper";
    data.method_steps.forEach((step, stepIdx) => {
      const li = document.createElement("li");
      li.id = `step-${stepIdx}`; // 수식 탭의 단계 배지에서 점프해 오는 앵커
      const title = document.createElement("h4");
      title.className = "step-title";
      renderRich(title, step.title || "");
      const desc = document.createElement("p");
      desc.className = "step-desc";
      renderRich(desc, step.description || "");
      li.append(title, desc);
      if (step.analogy) {
        const ana = document.createElement("p");
        ana.className = "step-analogy";
        renderRich(ana, step.analogy);
        li.appendChild(ana);
      }
      ol.appendChild(li);
    });
    panel.appendChild(ol);
  } else if (data.method) {
    // 구버전 분석 결과(method 문자열) 호환
    const div = document.createElement("div");
    div.className = "method-plain";
    renderRich(div, data.method);
    panel.appendChild(div);
  }
}

// ---------- figure 렌더러 (flow / bar / line) ----------
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
    panel.appendChild(item);
  });
}

// ---------- 탭 ----------
document.getElementById("tabs").addEventListener("click", (e) => {
  if (e.target.classList.contains("tab")) switchTab(e.target.dataset.tab);
});

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("active", p.id === `panel-${name}`)
  );
  updateHash();
}

// ---------- 히스토리 ----------
// 현재 열린 논문을 사이드바에서 강조
function highlightActiveHistory() {
  document.querySelectorAll("#history-list li[data-hash]").forEach((li) =>
    li.classList.toggle("h-active", li.dataset.hash === currentHash)
  );
}

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/history`);
    const items = await res.json();
    if (!res.ok) throw new Error(items.error || "히스토리 조회 실패");

    historyList.innerHTML = "";
    if (!items.length) {
      historyList.innerHTML = `<li class="muted">아직 분석한 논문이 없습니다.</li>`;
      return;
    }
    items.forEach((it) => {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "h-title";
      title.textContent = it.title || "(제목 없음)";
      const line = document.createElement("div");
      line.className = "h-line";
      renderRich(line, it.one_liner || "");
      const date = document.createElement("div");
      date.className = "h-date";
      date.textContent = it.createdAt ? new Date(it.createdAt).toLocaleString("ko-KR") : "";
      li.dataset.hash = it.hash;
      if (it.hash === currentHash) li.classList.add("h-active");
      li.append(title, line, date);
      li.addEventListener("click", () => openHistory(it.hash));

      const re = document.createElement("button");
      re.type = "button";
      re.className = "h-del h-re";
      re.title = "최신 분석 방식으로 재분석";
      re.textContent = "🔄";
      re.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`'${it.title}'을(를) 최신 분석 방식으로 재분석할까요?\n(몇 분 걸리며, 기존 결과는 대체됩니다)`)) return;
        hideError();
        // 지금 보고 있는 논문이면 화면을 비우지 않고 배너만 띄운다(읽던 내용 유지)
        const inline = it.hash === currentHash && !workspaceEl.classList.contains("hidden");
        if (inline) {
          showReanalyzeBanner();
        } else {
          workspaceEl.classList.add("hidden");
          loadingEl.classList.remove("hidden");
          setLoadingProgress("재분석을 시작하는 중…", 0);
        }
        setActiveAnalysis(it.title || "재분석");
        const ac = beginCancellable();
        try {
          const res = await fetch(`${API_BASE}/api/reanalyze/${it.hash}`, {
            method: "POST", signal: ac.signal,
          });
          if (!res.ok) {
            const d = await safeJson(res);
            throw new Error((d && d.error) || `HTTP ${res.status}`);
          }
          const data = await consumeAnalysisStream(res);
          renderResult(data);
          loadHistory();
          if (!inline) window.scrollTo({ top: 0, behavior: "smooth" });
        } catch (err) {
          if (err.name !== "AbortError") showError(err.message); // 취소는 조용히
        } finally {
          // 새 흐름으로 대체됐으면(두 번째 재분석 등) UI 정리를 건너뛴다 — 새 흐름의 배너/표시 유지
          if (endCancellable(ac)) {
            hideReanalyzeBanner();
            loadingEl.classList.add("hidden");
            setActiveAnalysis(null);
            setLoadingText("논문을 분석하고 있습니다…");
          }
        }
      });
      li.appendChild(re);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "h-del";
      del.title = "이 분석 기록 삭제";
      del.textContent = "×";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`'${it.title}' 분석 기록을 삭제할까요?\n(같은 PDF를 다시 올리면 재분석됩니다)`)) return;
        try {
          const r = await fetch(`${API_BASE}/api/history/${it.hash}`, { method: "DELETE" });
          if (!r.ok) {
            const d = await safeJson(r);
            throw new Error((d && d.error) || "삭제 실패");
          }
          loadHistory();
        } catch (err) {
          showError(err.message);
        }
      });
      li.appendChild(del);
      historyList.appendChild(li);
    });
    applyHistoryFilter(); // 재로드 후에도 검색어 유지
  } catch (e) {
    historyList.innerHTML = `<li class="muted">히스토리를 불러오지 못했습니다: ${e.message}</li>`;
  }
}

async function openHistory(hash) {
  hideError();
  // 저장된 결과 열람은 취소 대상이 아니다. 진행 중이던 분석이 있으면 취소하고(사용자가 다른 글로 이동),
  // 취소 버튼은 숨긴다 — 이 fetch는 취소 버튼이 제어하지 않으므로 엉뚱한 중단을 막는다.
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  cancelBtn.classList.add("hidden");
  hideReanalyzeBanner();
  loadingEl.classList.remove("hidden");
  document.getElementById("loading-text").textContent = "저장된 분석 결과를 불러오는 중…";
  let ok = false;
  try {
    const res = await fetch(`${API_BASE}/api/history/${hash}`);
    const data = await safeJson(res);
    if (!res.ok) throw new Error(formatApiError(data, res.status));
    renderResult(data);
    window.scrollTo({ top: 0, behavior: "smooth" });
    ok = true;
  } catch (e) {
    showError(e.message);
  } finally {
    loadingEl.classList.add("hidden");
    document.getElementById("loading-text").textContent = "논문을 분석하고 있습니다…";
  }
  return ok;
}

loadHistory();
restoreFromHash(); // URL에 #p=<hash>가 있으면 그 논문·탭을 복원
