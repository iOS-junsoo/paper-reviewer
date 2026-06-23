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
let currentAnalysis = null; // 현재 표시 중인 분석 데이터(내보내기·섹션 재생성용)
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
  renderHistory(); // 폴더 그룹 + 검색 필터를 함께 반영
});

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
  // 모델이 문자열 자리에 객체·숫자 등을 보내도 .replace 크래시로 화면 전체가 깨지지 않게 강제 변환
  if (typeof text !== "string") text = text == null ? "" : String(text);
  // 1) $...$ 인라인 수식을 플레이스홀더로 추출 (이스케이프/마크업 처리와 충돌 방지)
  const mathParts = [];
  const src = text.replace(/\$([^$\n]+?)\$/g, (match, tex) => {
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
  const prevHash = currentHash;
  currentHash = data.hash || null;
  // 같은 논문을 다시 렌더(섹션 재생성·전체 재분석)하는 경우 PDF·채팅·메모는 그대로라
  // 다시 로드하지 않는다 — 무거운 PDF 재다운로드/스크롤 리셋·미저장 메모 유실 방지.
  const sameHash = !!prevHash && prevHash === currentHash;
  currentAnalysis = data; // 마크다운 내보내기·섹션 재생성에서 사용
  // 추천 질문은 객체({q,category,why}) 또는 옛 문자열 — 채팅 칩용으로 문자열만 추림
  currentSuggested = (Array.isArray(data.suggested_questions) ? data.suggested_questions : [])
    .map((x) => (typeof x === "string" ? x : (x && x.q) || ""))
    .filter(Boolean);
  if (!sameHash) loadChat(currentHash); // 저장된 채팅 기록 비동기 로드

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
  renderFigureGuide(data.figure_guide); // 그림 해설 탭 (실제 그림 크롭 + 해설)
  renderSeminar(data.seminar); // 세미나 정리 탭 (논문 섹션 구조 그대로)
  renderRelated(data.related_papers);
  renderQaPrep(data.suggested_questions); // 예상 Q&A 준비 패널
  renderGlossary(data.glossary); // 용어집
  if (!sameHash) loadNotes(currentHash); // 개인 메모·북마크
  if (!sameHash) loadPdf(currentHash);

  workspaceEl.classList.remove("hidden");
  chatFab.classList.remove("hidden"); // 분석 결과가 있어야 질문 가능
  document.body.classList.add("reading"); // 상단 헤더·드롭존 축소
  highlightActiveHistory(); // 사이드바에서 현재 논문 강조
  // 발표 준비가 기본 목적이므로 세미나 정리가 있으면 그 탭으로, 없으면(옛 분석) 연구 배경으로.
  // (딥링크/재생성은 이후 restoreFromHash·keepTab이 다시 덮어쓴다.)
  switchTab(Array.isArray(data.seminar) && data.seminar.length ? "seminar" : "background");
}

// ---------- 세미나 정리 탭 (논문의 실제 섹션 구조 그대로 · 출처 정직성) ----------
// 섹션 제목: 번호가 인덱스 형태('1','3.2','A','A.1')이고 제목과 다를 때만 'N. 제목'으로
function seminarHeading(section, title) {
  const sec = section != null ? String(section).trim() : "";
  const t = (title || "").trim();
  const isIndex = /^[0-9]+(\.[0-9]+)*$/.test(sec) || /^[A-Z](\.[0-9]+)*$/.test(sec);
  // 제목이 이미 그 번호로 시작하면(예: title "1 Introduction", sec "1") 중복 표기 방지
  const titleHasNum = sec && new RegExp(`^${sec.replace(/[.]/g, "\\.")}[.\\s]`).test(t);
  if (sec && isIndex && sec.toLowerCase() !== t.toLowerCase() && !titleHasNum) return `${sec}. ${t}`.trim();
  return t || sec;
}
function renderSeminar(sections) {
  const panel = document.getElementById("panel-seminar");
  panel.innerHTML = "";
  const arr = Array.isArray(sections) ? sections.filter((s) => s && typeof s === "object") : [];
  if (!arr.length) {
    panel.innerHTML =
      `<p class="muted res-empty">이 분석에는 세미나 정리가 없습니다.<br />` +
      `예전에 분석한 논문이면 이 탭의 "이 섹션 다시 생성"(또는 히스토리 🔄)으로 채울 수 있어요.</p>`;
    return;
  }
  const hasAdded = arr.some((s) => Array.isArray(s.points) && s.points.some((p) => p && p.kind === "added"));
  const intro = document.createElement("p");
  intro.className = "sem-intro muted";
  intro.innerHTML =
    "논문의 실제 섹션 구조를 그대로 따른 발표용 정리입니다. 페이지 칩(p.N)을 누르면 원문으로 이동합니다." +
    (hasAdded ? ' <span class="sem-tag sem-tag-added">추가</span> 표시는 논문에 없어 논문 근거로 보완한 내용입니다.' : "");
  panel.appendChild(intro);
  arr.forEach((s) => panel.appendChild(buildSeminarSection(s)));
}

function buildSeminarSection(s) {
  const sec = document.createElement("section");
  sec.className = "sem-section";
  const head = document.createElement("h3");
  head.className = "sem-title";
  head.textContent = seminarHeading(s.section, s.title) || "(제목 없음)";
  sec.appendChild(head);

  const points = Array.isArray(s.points) ? s.points.filter((p) => p && typeof p === "object") : [];
  let lastSub = null;
  points.forEach((p) => {
    const sub = p.subhead && String(p.subhead).trim();
    if (sub && sub !== lastSub) {
      const sh = document.createElement("div");
      sh.className = "sem-subhead";
      sh.textContent = sub;
      sec.appendChild(sh);
      lastSub = sub;
    }
    sec.appendChild(buildSeminarPoint(p));
  });
  return sec;
}

function buildSeminarPoint(p) {
  const row = document.createElement("div");
  row.className = "sem-point" + (p.kind === "added" ? " sem-added" : "");
  const id = document.createElement("span");
  id.className = "sem-id";
  id.textContent = p.id || "•";
  row.appendChild(id);

  const body = document.createElement("div");
  body.className = "sem-body";
  const txt = document.createElement("div");
  txt.className = "sem-text";
  renderRich(txt, p.text || "");
  if (p.kind === "added") {
    const tag = document.createElement("span");
    tag.className = "sem-tag sem-tag-added";
    tag.textContent = "추가";
    tag.title = "논문에 명시되지 않은, 논문 근거로 보완한 내용";
    txt.appendChild(document.createTextNode(" "));
    txt.appendChild(tag);
  }
  body.appendChild(txt);

  const pages = Array.isArray(p.pages)
    ? [...new Set(p.pages.map(Number).filter((n) => Number.isFinite(n) && n >= 1))]
    : [];
  if (pages.length) {
    const pg = document.createElement("span");
    pg.className = "sem-pages";
    pages.forEach((n) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "sem-page";
      chip.textContent = `p.${n}`;
      chip.title = `원문 ${n}쪽으로 이동`;
      chip.addEventListener("click", () => jumpToPdfPage(n));
      pg.appendChild(chip);
    });
    body.appendChild(pg);
  }
  row.appendChild(body);
  return row;
}

// ---------- 분야 발전 타임라인 ----------
function buildTimeline(items) {
  const wrap = document.createElement("div");
  wrap.className = "timeline";
  items.forEach((it, i) => {
    if (!it || typeof it !== "object") return;
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
// 신규 구조: takeaway → 측정 지표 설명 / 데이터셋 / 용어 설명 → 번호별 실험(목적·세팅·결과) → 한계.
// 옛 분석(metrics·baselines·ablations)도 폴백으로 표시.
function renderResults(exp) {
  const panel = document.getElementById("panel-results");
  panel.innerHTML = "";
  const arr = (v) => (Array.isArray(v) ? v : []);
  const has =
    exp && typeof exp === "object" &&
    (exp.takeaway || exp.limitations ||
      arr(exp.studies).length || arr(exp.metrics_explained).length || arr(exp.terms).length ||
      arr(exp.datasets).length || arr(exp.baselines).length || arr(exp.metrics).length || arr(exp.ablations).length);
  if (!has) {
    panel.innerHTML =
      `<p class="muted res-empty">이 분석에는 실험·결과 정보가 없습니다.<br />` +
      `예전에 분석한 논문이면 히스토리에서 🔄(또는 이 탭의 "이 섹션 다시 생성")로 채울 수 있어요. (이론·서베이 논문은 결과가 적을 수 있어요.)</p>`;
    return;
  }
  // 1) 한 줄 결론
  if (exp.takeaway) {
    const t = document.createElement("div");
    t.className = "res-takeaway";
    renderRich(t, "📌 " + exp.takeaway);
    panel.appendChild(t);
  }
  // 2) 측정 지표 설명 (신규) — 없으면 옛 지표 카드로 폴백
  if (arr(exp.metrics_explained).length) panel.appendChild(buildExpDefs("측정 지표", exp.metrics_explained));
  else if (arr(exp.metrics).length) panel.appendChild(buildResultMetrics(exp.metrics));
  // 3) 데이터셋 (+ 옛 baselines)
  if (arr(exp.datasets).length || arr(exp.baselines).length) panel.appendChild(buildResultMeta(exp.datasets, exp.baselines));
  // 4) 용어 설명 (신규)
  if (arr(exp.terms).length) panel.appendChild(buildExpDefs("용어 설명", exp.terms));
  // 5) 번호별 실험 (신규) — 없으면 옛 ablations로 폴백
  if (arr(exp.studies).length) panel.appendChild(buildStudies(exp.studies));
  else if (arr(exp.ablations).length) panel.appendChild(buildResultList("주요 분석 (Ablation)", exp.ablations, "res-ablations"));
  // 6) 한계 · 향후 연구
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

// 정의 목록 (측정 지표 설명 / 용어 설명) — 항목은 {name|term, meaning} 또는 문자열
function buildExpDefs(title, items) {
  const sec = document.createElement("div");
  sec.className = "res-section";
  const h = document.createElement("h4");
  h.className = "res-h";
  h.textContent = title;
  sec.appendChild(h);
  const dl = document.createElement("dl");
  dl.className = "res-defs";
  items.forEach((it) => {
    if (!it) return;
    const name = typeof it === "string" ? it : (it.name || it.term || "");
    const mean = typeof it === "string" ? "" : (it.meaning || it.detail || "");
    if (!name && !mean) return;
    const dt = document.createElement("dt");
    dt.className = "res-def-t";
    renderRich(dt, name); // 지표/기호가 $수식$일 수 있어 richHtml 사용
    const dd = document.createElement("dd");
    dd.className = "res-def-d";
    renderRich(dd, mean);
    dl.append(dt, dd);
  });
  sec.appendChild(dl);
  return sec;
}

// 번호별 실험 카드 (목적 · 세팅 · 결과)
function buildStudies(studies) {
  const sec = document.createElement("div");
  sec.className = "res-section";
  const h = document.createElement("h4");
  h.className = "res-h";
  h.textContent = "실험";
  sec.appendChild(h);
  const wrap = document.createElement("div");
  wrap.className = "res-studies";
  let n = 0;
  studies.forEach((s) => {
    if (!s || typeof s !== "object") return;
    n++;
    const card = document.createElement("div");
    card.className = "study-card";
    const head = document.createElement("div");
    head.className = "study-head";
    const page = Number(s.paper_page) || 0;
    // 페이지를 알면 번호를 버튼으로 — 클릭 시 원문 PDF 그 페이지로 이동 + ✓ 체크 3초
    const num = document.createElement(page ? "button" : "span");
    num.className = "study-num" + (page ? " study-num-link" : "");
    num.textContent = n;
    if (page) {
      num.type = "button";
      num.title = `원문 ${page}페이지로 이동`;
      num.addEventListener("click", () => {
        showStudyCheck(num); // 분석 패널 번호 옆 ✓ (즉시 피드백)
        jumpToPdfPageText(page, s.anchor || studyAnchorFromTitle(s.title)); // 원문 PDF 그 실험 글 옆 ✓
      });
    }
    const title = document.createElement("span");
    title.className = "study-title";
    renderRich(title, s.title || `실험 ${n}`);
    head.append(num, title);
    card.appendChild(head);
    const row = (label, val) => {
      if (!val) return;
      const d = document.createElement("div");
      d.className = "study-row";
      const lab = document.createElement("span");
      lab.className = "study-label";
      lab.textContent = label;
      const body = document.createElement("div");
      body.className = "study-body";
      renderRich(body, val);
      d.append(lab, body);
      card.appendChild(d);
    };
    row("목적", s.purpose);
    row("세팅", s.setup);
    row("결과", s.result);
    wrap.appendChild(card);
  });
  sec.appendChild(wrap);
  return sec;
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

// ---------- 그림 해설 탭 (실제 그림 크롭 + 원문 캡션 번역 + 해설) ----------
const KIND_LABEL = {
  architecture: "구조도", results: "결과", ablation: "분석", qualitative: "정성 예시", table: "표", other: "그림",
};
function renderFigureGuide(items) {
  const panel = document.getElementById("panel-figures");
  panel.innerHTML = "";
  const arr = Array.isArray(items) ? items.filter((f) => f && typeof f === "object") : [];
  if (!arr.length) {
    panel.innerHTML =
      `<p class="muted res-empty">이 분석에는 그림 해설이 없습니다.<br />` +
      `예전에 분석한 논문이면 이 탭의 "이 섹션 다시 생성"(또는 히스토리 🔄)으로 채울 수 있어요.</p>`;
    return;
  }
  arr.forEach((f) => panel.appendChild(buildFigureCard(f)));
  if (activeTab === "figures") loadFigureImages(); // 이미 그림 탭을 보는 중이면 바로 로드
}
// 그림 탭을 열 때 data-src를 실제 src로 옮겨 크롭 이미지를 로드 (탭을 안 열면 생성 안 함)
function loadFigureImages() {
  document.querySelectorAll("#panel-figures .fig-img-el[data-src]").forEach((im) => {
    im.src = im.dataset.src;
    im.removeAttribute("data-src");
  });
}
function buildFigureCard(f) {
  const card = document.createElement("div");
  card.className = "fig-card";
  const page = Number(f.page) || 0;

  // 헤더: label + 유형칩 + (페이지면) 원문 보기 버튼
  const head = document.createElement("div");
  head.className = "fig-head";
  const label = document.createElement("span");
  label.className = "fig-label";
  label.textContent = f.label || "Figure";
  head.appendChild(label);
  if (f.kind && KIND_LABEL[f.kind]) {
    const k = document.createElement("span");
    k.className = "fig-kind";
    k.textContent = KIND_LABEL[f.kind];
    head.appendChild(k);
  }
  if (page) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "fig-jump";
    jump.textContent = `원문 ${page}쪽에서 보기 →`;
    jump.title = "원문 PDF의 이 그림으로 이동 + ✓";
    jump.addEventListener("click", () => jumpToPdfPageText(page, f.label || ""));
    head.appendChild(jump);
  }
  card.appendChild(head);

  // 실제 그림 이미지 — 서버(poppler)가 bbox 영역을 잘라 PNG로 제공 (src에 hash가 박혀 논문 전환 안전)
  const bbox =
    Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox.every((n) => Number.isFinite(Number(n)))
      ? f.bbox.map(Number)
      : null;
  if (page && bbox && currentHash) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "fig-img";
    const img = document.createElement("img");
    img.className = "fig-img-el";
    img.alt = `${f.label || "그림"} 원문 이미지`;
    // 그림 탭을 처음 열 때 로드한다(loadFigureImages) — 안 보는 논문은 크롭을 만들지 않음
    // label을 함께 보내 서버가 PDF 텍스트의 캡션 위치로 크롭을 보정한다
    img.dataset.src = `${API_BASE}/api/figure/${currentHash}?page=${page}&box=${bbox.join(",")}&label=${encodeURIComponent(f.label || "")}`;
    img.addEventListener("click", () => jumpToPdfPageText(page, f.label || ""));
    img.addEventListener("error", () => {
      imgWrap.innerHTML = '<span class="fig-img-ph">원문 그림을 불러오지 못했습니다 — "원문에서 보기"로 확인하세요.</span>';
    });
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  // 원문 캡션(번역)
  if (f.caption_ko) {
    const cap = document.createElement("div");
    cap.className = "fig-caption";
    const t = document.createElement("span");
    t.className = "fig-caption-tag";
    t.textContent = "원문 캡션";
    const body = document.createElement("span");
    renderRich(body, f.caption_ko);
    cap.append(t, body);
    card.appendChild(cap);
  }
  // 해설
  if (f.explanation) {
    const ex = document.createElement("div");
    ex.className = "fig-explain";
    renderRich(ex, f.explanation);
    card.appendChild(ex);
  }
  // 핵심
  if (f.takeaway) {
    const tk = document.createElement("div");
    tk.className = "fig-takeaway";
    renderRich(tk, "📌 " + f.takeaway);
    card.appendChild(tk);
  }
  return card;
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
let pdfZoom = 1; // 사용자 확대/축소 배율 (폭 맞춤 = 1.0)
let pdfFitScale = 1; // 패널 폭에 맞춘 기준 스케일
let pdfBaseW = 0, pdfBaseH = 0; // 1페이지 원본 크기(scale=1)
let pdfRenderToken = 0; // 논문 전환 시 이전 렌더 무효화
let pdfRenderSeq = 0; // 각 페이지 렌더 고유 마크 (줌 중 중복 캔버스 방지)
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
    pdfBaseW = baseVp.width;
    pdfBaseH = baseVp.height;
    pdfFitScale = Math.max(0.3, (pdfScroll.clientWidth - 18) / baseVp.width);
    pdfZoom = 1; // 새 논문은 폭 맞춤으로 시작
    pdfScale = pdfFitScale * pdfZoom;
    updatePdfZoomLabel();
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

function updatePdfZoomLabel() {
  const el = document.getElementById("pdf-zoom-reset");
  if (el) el.textContent = `${Math.round(pdfZoom * 100)}%`;
}
// 확대/축소: 배율을 바꾸고 모든 페이지를 placeholder로 되돌린 뒤 보이는 페이지만 다시 렌더
function setPdfZoom(z) {
  if (!pdfDoc || !pdfBaseW) return;
  const oldScale = pdfScale;
  pdfZoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
  pdfScale = pdfFitScale * pdfZoom;
  const factor = oldScale ? pdfScale / oldScale : 1;
  const prevTop = pdfScroll.scrollTop; // 줌 전 위치
  const phH = pdfBaseH * pdfScale;
  pdfPageEls.forEach((wrap) => {
    wrap.innerHTML = "";
    delete wrap.dataset.rendered;
    wrap.style.height = `${phH}px`;
  });
  pdfScroll.scrollTop = prevTop * factor; // 배율만큼 스크롤도 비례 이동 → 같은 위치 유지
  updatePdfZoomLabel();
  renderVisiblePdfPages();
}
function renderVisiblePdfPages() {
  const sr = pdfScroll.getBoundingClientRect();
  pdfPageEls.forEach((wrap, n) => {
    const r = wrap.getBoundingClientRect();
    if (r.bottom >= sr.top - 600 && r.top <= sr.bottom + 600) renderPdfPage(n, pdfRenderToken);
  });
}
document.getElementById("pdf-zoom-in").addEventListener("click", () => setPdfZoom(pdfZoom + 0.2));
document.getElementById("pdf-zoom-out").addEventListener("click", () => setPdfZoom(pdfZoom - 0.2));
document.getElementById("pdf-zoom-reset").addEventListener("click", () => setPdfZoom(1));

async function renderPdfPage(n, token) {
  const wrap = pdfPageEls.get(n);
  if (!wrap || wrap.dataset.rendered || !pdfDoc) return;
  const mark = String(++pdfRenderSeq); // 이 렌더의 고유 표식
  wrap.dataset.rendered = mark;
  try {
    const page = await pdfDoc.getPage(n);
    // 그 사이 논문이 바뀌었거나(token) 줌으로 이 wrap이 재설정됐으면(mark 불일치) 중단 — 캔버스 중복 방지
    if (token !== pdfRenderToken || wrap.dataset.rendered !== mark) return;
    const vp = page.getViewport({ scale: pdfScale });
    // 고DPI(레티나) 화면 선명도 — 백킹 스토어는 dpr배 해상도, 표시는 논리 px
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    if (wrap.dataset.rendered !== mark) return; // append 직전 재확인
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
  // pdf-scroll 컨테이너를 직접 스크롤한다 (중첩 컨테이너에서 scrollIntoView는 신뢰성이 낮음).
  // 체크가 찍혔으면 그 위치를 화면 중앙에, 아니면 페이지를 상단에 맞춘다.
  const target = marked ? wrap.querySelector(".pdf-eqcheck") : wrap;
  const sr = pdfScroll.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const offset = marked ? pdfScroll.clientHeight / 2 - tr.height / 2 : 8;
  // 즉시 스크롤(behavior:smooth는 일부 환경에서 무시됨 → 직접 대입으로 확실히 이동)
  pdfScroll.scrollTop = pdfScroll.scrollTop + (tr.top - sr.top) - offset;
  flagPdfJump(page);
}

// PDF 텍스트 레이어에서 임의 문구(query) 위치 찾기 — 아이템이 쪼개져 있어도 글자를 이어붙여 검색
async function findTextPos(pageNum, query) {
  if (!query || !pdfDoc || typeof pdfjsLib === "undefined") return null;
  const q = String(query).replace(/\s+/g, "").toLowerCase().slice(0, 40);
  if (q.length < 3) return null;
  try {
    const page = await pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: pdfScale });
    const tc = await page.getTextContent();
    const posOf = (it) => {
      const m = pdfjsLib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(m[2], m[3]) || 11;
      return { y: m[5] - h, h, left: m[4] };
    };
    // 1순위: 그 문구로 '시작하는' 아이템(=제목/소제목) — 본문 인라인 언급보다 헤딩을 우선
    const qHead = q.slice(0, 12);
    for (const it of tc.items) {
      const s = (it.str || "").replace(/\s+/g, "").toLowerCase();
      if (s.startsWith(qHead)) return posOf(it);
    }
    // 2순위: 아이템이 쪼개진 경우 — 글자를 이어붙여 검색하고 매치 시작 아이템 위치
    let concat = "";
    const owner = [];
    for (const it of tc.items) {
      for (const ch of it.str || "") {
        if (/\s/.test(ch)) continue;
        concat += ch.toLowerCase();
        owner.push(it);
      }
    }
    let idx = concat.indexOf(q);
    if (idx < 0 && q.length > 12) idx = concat.indexOf(q.slice(0, 12));
    if (idx < 0) return null;
    return posOf(owner[idx]);
  } catch {
    return null;
  }
}
// 찾은 글 '왼쪽'에 ✓ 체크 3초 (실험 점프용 — 수식은 번호 오른쪽, 실험은 제목 왼쪽)
function markTextCheck(wrap, pos) {
  wrap.querySelectorAll(".pdf-eqcheck").forEach((e) => e.remove());
  if (!pos) return false;
  const size = Math.max(15, pos.h * 1.4);
  const chk = document.createElement("div");
  chk.className = "pdf-eqcheck";
  chk.textContent = "✓";
  chk.style.width = chk.style.height = `${size}px`;
  chk.style.left = `${Math.max(2, pos.left - size - 4)}px`;
  chk.style.top = `${pos.y + pos.h / 2 - size / 2}px`;
  wrap.appendChild(chk);
  void chk.offsetWidth;
  chk.classList.add("show");
  setTimeout(() => chk.classList.add("fade"), 2600);
  setTimeout(() => chk.remove(), 3000);
  return true;
}
// 실험 클릭 → 해당 페이지로 + 원문 본문의 그 실험 제목 옆에 ✓ (수식 탭과 동일한 PDF 점프)
async function jumpToPdfPageText(page, anchor) {
  if (!currentHash) return;
  if (!pdfAvailable) {
    showError("이 논문의 원문 PDF가 저장돼 있지 않습니다. 같은 PDF를 다시 업로드하면 페이지 점프가 활성화됩니다.");
    return;
  }
  workspaceEl.classList.remove("pdf-collapsed");
  document.getElementById("pdf-toggle").textContent = "접기 ◀";
  document.querySelectorAll(".pdf-eqcheck").forEach((e) => e.remove());
  const wrap = pdfPageEls.get(page);
  if (!wrap) return;
  await renderPdfPage(page, pdfRenderToken);
  const pos = await findTextPos(page, anchor);
  const marked = markTextCheck(wrap, pos);
  const target = marked ? wrap.querySelector(".pdf-eqcheck") : wrap;
  const sr = pdfScroll.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const offset = marked ? pdfScroll.clientHeight / 2 - tr.height / 2 : 8;
  pdfScroll.scrollTop = pdfScroll.scrollTop + (tr.top - sr.top) - offset;
  flagPdfJump(page);
}
// 실험 제목에서 원문 검색용 앵커 추출 (anchor 필드가 없을 때 폴백) — "Experiment 1: ..." → "Experiment 1"
function studyAnchorFromTitle(title) {
  if (!title) return "";
  const t = String(title).replace(/\*\*|==|\$/g, "").trim();
  const beforeColon = t.split(/[:：]/)[0].trim();
  if (beforeColon.length >= 3 && beforeColon.length <= 28) return beforeColon;
  return t.split(/\s+/).slice(0, 4).join(" ");
}

// 실험 번호 배지 왼쪽에 ✓ 체크를 3초간 표시 (클릭 피드백). PDF 페이지 이동은 jumpToPdfPage가 담당.
function showStudyCheck(numEl) {
  const head = numEl.parentNode;
  if (!head) return;
  head.querySelectorAll(".study-check").forEach((e) => e.remove());
  const chk = document.createElement("span");
  chk.className = "study-check";
  chk.textContent = "✓";
  head.insertBefore(chk, numEl); // 번호 왼쪽
  void chk.offsetWidth;
  chk.classList.add("show");
  setTimeout(() => chk.classList.add("fade"), 2600);
  setTimeout(() => chk.remove(), 3000);
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
  // 진행 중이던 분석/재생성을 중단(N 단축키로도 호출되므로 사용량 누수 방지)
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; }
  cancelBtn.classList.add("hidden");
  hideReanalyzeBanner();
  loadingEl.classList.add("hidden");
  setActiveAnalysis(null);
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
    if (!p || typeof p !== "object") return;
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
let chatBusy = false; // 답변 생성 중 (보내기 버튼이 '멈춤'으로 바뀜)
let chatAbort = null; // 진행 중인 질문 fetch 취소용

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
  refreshQuestionActions(); // 불러온 기록의 마지막 질문에도 액션 줄 부착
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
  if (role === "q") div.dataset.text = typeof text === "string" ? text : String(text == null ? "" : text);
  renderRich(div, text);
  chatMessages.querySelector(".chat-hint")?.remove();
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// 가장 최근 '내 질문' 바로 아래에 수정·복사·다시 보내기 버튼 줄을 둔다 (직전 것은 제거)
function refreshQuestionActions() {
  chatMessages.querySelectorAll(".chat-q-actions").forEach((el) => el.remove());
  if (chatBusy) return; // 생성 중에는 표시하지 않음
  const qs = chatMessages.querySelectorAll(".chat-q");
  const lastQ = qs[qs.length - 1];
  const text = lastQ && lastQ.dataset.text;
  if (!text) return;
  const row = document.createElement("div");
  row.className = "chat-q-actions";
  const mk = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-act";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  row.appendChild(mk("✎ 수정", "이 질문을 입력란에 불러와 수정", () => {
    chatInput.value = text;
    autoGrowChat();
    chatInput.focus();
    chatInput.setSelectionRange(text.length, text.length);
  }));
  row.appendChild(mk("⧉ 복사", "이 질문 복사", (e) => copyText(text, e.currentTarget)));
  row.appendChild(mk("↻ 다시 보내기", "같은 질문을 모델에 다시 보내기", () => askQuestion(text)));
  lastQ.after(row);
}

// 입력란 자동 높이(문장 길이에 따라 아래로 늘어남, 최대 160px 후 내부 스크롤)
function autoGrowChat() {
  if (!chatInput.value) { chatInput.style.height = ""; return; } // 비었으면 CSS 기본(한 줄)
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
}
// 보내기 ↔ 멈춤 상태 전환 (생성 중에도 버튼은 활성 — 누르면 중단)
function setChatBusy(b) {
  chatBusy = b;
  chatSend.textContent = b ? "■" : "질문";
  chatSend.title = b ? "답변 생성 멈추기" : "질문 보내기";
  chatSend.classList.toggle("chat-stop", b);
}

async function askQuestion(q) {
  q = (q || "").trim();
  if (!q || !currentHash || chatBusy) return;
  chatMessages.querySelector(".chat-chips")?.remove(); // 첫 질문 후 추천 칩 제거
  chatMessages.querySelectorAll(".chat-note").forEach((el) => el.remove());
  refreshQuestionActions(); // 직전 질문의 액션 줄 먼저 제거(곧 새 질문이 마지막이 됨)
  appendChat("q", q);
  const thinking = appendChat("a", "");
  thinking.classList.add("chat-thinking");
  setThinking(thinking, "논문을 살펴보는 중…");
  setChatBusy(true);
  chatAbort = new AbortController();

  try {
    const res = await fetch(`${API_BASE}/api/ask/${currentHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, history: chatHistory }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    const answer = await consumeChatStream(res, thinking); // 진행 단계 표시 → 최종 답변
    thinking.remove();
    appendChat("a", answer);
    chatHistory.push({ q, a: answer });
  } catch (err) {
    thinking.remove();
    if (err.name === "AbortError") {
      const note = document.createElement("div");
      note.className = "chat-note";
      note.textContent = "⏹ 답변 생성을 멈췄어요.";
      chatMessages.appendChild(note);
    } else {
      appendChat("a", "⚠️ " + err.message);
    }
  } finally {
    chatAbort = null;
    setChatBusy(false);
    refreshQuestionActions(); // 마지막 질문 아래에 수정·복사·다시 보내기 부착
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (chatBusy) return;
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = "";
  autoGrowChat();
  askQuestion(q);
});
// 생성 중 보내기 버튼을 누르면 폼 제출 대신 중단
chatSend.addEventListener("click", (e) => {
  if (chatBusy) { e.preventDefault(); if (chatAbort) chatAbort.abort(); }
});
// 입력란: 자동 높이 + Enter 전송 / Shift+Enter 줄바꿈 (IME 조합 중엔 무시)
chatInput.addEventListener("input", autoGrowChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (chatForm.requestSubmit) chatForm.requestSubmit();
    else chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
  }
});

// 채팅 SSE 소비: step(진행 단계)으로 '생각 중' 표시를 갱신하고 최종 answer를 반환
async function consumeChatStream(res, thinkingEl) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let answer = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === "step") setThinking(thinkingEl, ev.msg);
      else if (ev.type === "result") answer = ev.answer;
      else if (ev.type === "error") throw new Error(ev.error);
    }
  }
  if (answer == null) throw new Error("답변을 받지 못했어요. 다시 시도해 주세요.");
  return answer;
}

// '생각 중' 버블: 통통 튀는 점 애니메이션 + 현재 진행 단계 메시지
function setThinking(el, msg) {
  // 사용자가 위로 올려 예전 대화를 읽는 중이면 끌어내리지 않는다 (바닥 근처일 때만 자동 스크롤)
  const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 60;
  el.innerHTML = '<span class="chat-dots"><i></i><i></i><i></i></span><span class="chat-step"></span>';
  el.querySelector(".chat-step").textContent = msg || "생각 중…";
  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
  if (!TAB_ORDER.includes(name)) name = "background"; // 잘못된 해시로 빈 화면 방지
  activeTab = name;
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("active", p.id === `panel-${name}`)
  );
  if (name === "figures") loadFigureImages(); // 그림 탭 열 때 크롭 이미지 로드
  updateHash();
}

// ---------- 히스토리 ----------
// 현재 열린 논문을 사이드바에서 강조
function highlightActiveHistory() {
  document.querySelectorAll("#history-list li[data-hash]").forEach((li) =>
    li.classList.toggle("h-active", li.dataset.hash === currentHash)
  );
}

// ── 라이브러리(폴더) 상태 ──────────────────────────────────────────────
let library = { folders: [], assignments: {} }; // {folders:[{id,name}], assignments:{hash:folderId}}
let historyItems = []; // 최근 불러온 히스토리 목록(렌더 재사용)
const collapsedFolders = new Set(JSON.parse(localStorage.getItem("collapsedFolders") || "[]")); // 접힌 폴더(기기별)
const UNFILED = "__unfiled__";
function saveCollapsed() { localStorage.setItem("collapsedFolders", JSON.stringify([...collapsedFolders])); }
function newFolderId() { return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
async function saveLibrary() {
  try {
    await fetch(`${API_BASE}/api/library`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(library),
    });
  } catch {}
}

async function loadHistory() {
  try {
    const [hRes, lRes] = await Promise.all([
      fetch(`${API_BASE}/api/history`),
      fetch(`${API_BASE}/api/library`).catch(() => null),
    ]);
    const items = await hRes.json();
    if (!hRes.ok) throw new Error(items.error || "히스토리 조회 실패");
    historyItems = Array.isArray(items) ? items : [];
    if (lRes && lRes.ok) {
      const lib = await lRes.json();
      library = {
        folders: Array.isArray(lib.folders) ? lib.folders : [],
        assignments: lib.assignments && typeof lib.assignments === "object" ? lib.assignments : {},
      };
    }
    renderHistory();
  } catch (e) {
    historyList.innerHTML = `<li class="muted">히스토리를 불러오지 못했습니다: ${e.message}</li>`;
  }
}

// 폴더 그룹 + 검색 필터를 반영해 사이드바 목록을 다시 그린다
function renderHistory() {
  closeFolderMenu();
  historyList.classList.toggle("has-folders", library.folders.length > 0);
  historyList.innerHTML = "";
  if (!historyItems.length) {
    historyList.innerHTML = `<li class="muted">아직 분석한 논문이 없습니다.</li>`;
    return;
  }
  const f = historyFilter;
  const matches = (it) => !f || ((it.title || "") + " " + (it.one_liner || "")).toLowerCase().includes(f);
  const folderOf = (hash) => {
    const fid = library.assignments[hash];
    return fid && library.folders.some((x) => x.id === fid) ? fid : null;
  };
  // 폴더가 하나도 없으면 평면 목록(기존 동작 유지)
  if (!library.folders.length) {
    historyItems.forEach((it) => { if (matches(it)) historyList.appendChild(buildHistoryItem(it)); });
    return;
  }
  const renderGroup = (folder) => {
    const fid = folder ? folder.id : null;
    const key = fid || UNFILED;
    const members = historyItems.filter((it) => folderOf(it.hash) === fid);
    if (!folder && !members.length) return; // 미분류는 비어 있으면 머리글 생략
    const visible = members.filter(matches);
    if (f && !visible.length) return; // 검색 중 매칭 없는 그룹 숨김
    const collapsed = !f && collapsedFolders.has(key);
    // 검색 중에는 '보이는 수', 평소엔 전체 멤버 수를 카운트로 표시
    historyList.appendChild(buildFolderHead(folder, f ? visible.length : members.length, collapsed));
    if (collapsed) return;
    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "sb-folder-empty muted";
      empty.textContent = "(비어 있음 — 논문을 끌어다 놓거나 📁로 옮기세요)";
      historyList.appendChild(empty);
    } else {
      visible.forEach((it) => historyList.appendChild(buildHistoryItem(it)));
    }
  };
  library.folders.forEach((folder) => renderGroup(folder));
  renderGroup(null); // 미분류
}

function buildFolderHead(folder, count, collapsed) {
  const fid = folder ? folder.id : null;
  const key = fid || UNFILED;
  const li = document.createElement("li");
  li.className = "sb-folder" + (collapsed ? " collapsed" : "");
  li.dataset.folderHead = key;
  const tw = document.createElement("span");
  tw.className = "sb-folder-tw";
  tw.textContent = collapsed ? "▸" : "▾";
  const name = document.createElement("span");
  name.className = "sb-folder-name";
  name.textContent = folder ? folder.name : "미분류";
  const cnt = document.createElement("span");
  cnt.className = "sb-folder-count";
  cnt.textContent = count;
  li.append(tw, name, cnt);
  li.addEventListener("click", () => {
    if (collapsedFolders.has(key)) collapsedFolders.delete(key);
    else collapsedFolders.add(key);
    saveCollapsed();
    renderHistory();
  });
  if (folder) {
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sb-folder-btn"; b.textContent = label; b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    li.append(
      mk("✎", "폴더 이름 변경", () => renameFolder(folder)),
      mk("×", "폴더 삭제(논문은 미분류로 이동)", () => deleteFolder(folder))
    );
  }
  // 드롭 타깃 — 논문을 끌어다 놓으면 이 폴더로 이동(미분류 머리글은 배정 해제)
  li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drop-over"); });
  li.addEventListener("dragleave", () => li.classList.remove("drop-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drop-over");
    const hash = e.dataTransfer.getData("text/plain");
    if (hash) moveToFolder(hash, fid);
  });
  return li;
}

function buildHistoryItem(it) {
  const li = document.createElement("li");
  li.dataset.hash = it.hash;
  li.draggable = true;
  if (it.hash === currentHash) li.classList.add("h-active");
  const title = document.createElement("div");
  title.className = "h-title";
  title.textContent = it.title || "(제목 없음)";
  const line = document.createElement("div");
  line.className = "h-line";
  renderRich(line, it.one_liner || "");
  const date = document.createElement("div");
  date.className = "h-date";
  date.textContent = it.createdAt ? new Date(it.createdAt).toLocaleString("ko-KR") : "";
  li.append(title, line, date);
  li.addEventListener("click", () => openHistory(it.hash));
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", it.hash);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  // 폴더로 옮기기(메뉴) — 드래그가 어려운 경우의 대체 경로
  const mv = document.createElement("button");
  mv.type = "button";
  mv.className = "h-del h-move";
  mv.title = "폴더로 옮기기";
  mv.textContent = "📁";
  mv.addEventListener("click", (e) => { e.stopPropagation(); openFolderMenu(it.hash, mv); });
  li.appendChild(mv);

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
      // 폴더 배정 정리는 서버 DELETE가 처리한다 — 여기서 PUT하지 않아 GET과의 경합을 피한다
      loadHistory();
    } catch (err) {
      showError(err.message);
    }
  });
  li.appendChild(del);
  return li;
}

// ── 폴더 동작 (생성·이름변경·삭제·이동) ────────────────────────────────
function createFolder() {
  const name = (prompt("새 폴더 이름") || "").trim();
  if (!name) return;
  library.folders.push({ id: newFolderId(), name: name.slice(0, 60) });
  saveLibrary();
  renderHistory();
}
function renameFolder(folder) {
  const name = (prompt("폴더 이름 변경", folder.name) || "").trim();
  if (!name || name === folder.name) return;
  folder.name = name.slice(0, 60);
  saveLibrary();
  renderHistory();
}
function deleteFolder(folder) {
  if (!confirm(`'${folder.name}' 폴더를 삭제할까요?\n(폴더 안 논문은 삭제되지 않고 '미분류'로 이동합니다)`)) return;
  library.folders = library.folders.filter((x) => x.id !== folder.id);
  for (const h of Object.keys(library.assignments)) {
    if (library.assignments[h] === folder.id) delete library.assignments[h];
  }
  collapsedFolders.delete(folder.id);
  saveCollapsed();
  saveLibrary();
  renderHistory();
}
function moveToFolder(hash, fid) {
  if (fid) library.assignments[hash] = fid;
  else delete library.assignments[hash];
  saveLibrary();
  renderHistory();
}

// 논문을 옮길 폴더 선택 메뉴 (📁 버튼 클릭 시)
function closeFolderMenu() { document.getElementById("sb-foldermenu")?.remove(); }
function openFolderMenu(hash, anchor) {
  closeFolderMenu();
  const menu = document.createElement("div");
  menu.className = "sb-foldermenu";
  menu.id = "sb-foldermenu";
  const cur = library.assignments[hash] || null;
  const row = (label, onClick, marked) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sb-fm-row" + (marked ? " marked" : "");
    b.textContent = (marked ? "✓ " : "") + label;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); closeFolderMenu(); });
    menu.appendChild(b);
  };
  library.folders.forEach((fo) => row("📁 " + fo.name, () => moveToFolder(hash, fo.id), cur === fo.id));
  row("미분류", () => moveToFolder(hash, null), !cur);
  const nf = document.createElement("button");
  nf.type = "button";
  nf.className = "sb-fm-row sb-fm-new";
  nf.textContent = "＋ 새 폴더로…";
  nf.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFolderMenu();
    const name = (prompt("새 폴더 이름") || "").trim();
    if (!name) return;
    const folder = { id: newFolderId(), name: name.slice(0, 60) };
    library.folders.push(folder);
    moveToFolder(hash, folder.id); // 저장 + 재렌더
  });
  menu.appendChild(nf);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 10)) + "px";
  menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 10)) + "px";
  // 바깥 클릭 시 닫기 (이번 클릭 이벤트가 끝난 뒤 등록)
  setTimeout(() => document.addEventListener("click", closeFolderMenu, { once: true }), 0);
}
document.getElementById("folder-new").addEventListener("click", createFolder);

async function openHistory(hash) {
  hideError();
  // 저장된 결과 열람은 취소 대상이 아니다. 진행 중이던 분석이 있으면 취소하고(사용자가 다른 글로 이동),
  // 취소 버튼은 숨긴다 — 이 fetch는 취소 버튼이 제어하지 않으므로 엉뚱한 중단을 막는다.
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; } // 진행 중 섹션 재생성 중단
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

// ========== 도구: 예상 Q&A · 용어집 · 마크다운 내보내기 · 메모 · 섹션 재생성 · 단축키 ==========
let glossaryItems = [];
let notesState = { notes: "", bookmarks: [] };
let notesSaveTimer = null;
let notesHashLoaded = null;
let sectionRegenInFlight = false;
let sectionRegenAbort = null; // 진행 중인 섹션 재생성 fetch (이탈 시 중단·사용량 절약)

// ---------- 예상 Q&A 준비 (#1) ----------
function renderQaPrep(items) {
  const list = document.getElementById("qa-list");
  list.innerHTML = "";
  let n = 0;
  (Array.isArray(items) ? items : []).forEach((it) => {
    const q = typeof it === "string" ? it : (it && it.q) || "";
    if (!q) return;
    n++;
    const li = document.createElement("li");
    li.className = "qa-item";
    const head = document.createElement("div");
    head.className = "qa-head";
    if (it && it.category) {
      const c = document.createElement("span");
      c.className = "qa-cat";
      c.textContent = it.category;
      head.appendChild(c);
    }
    const qd = document.createElement("span");
    qd.className = "qa-q";
    renderRich(qd, q);
    head.appendChild(qd);
    li.appendChild(head);
    if (it && it.why) {
      const w = document.createElement("div");
      w.className = "qa-why";
      renderRich(w, it.why);
      li.appendChild(w);
    }
    const ask = document.createElement("button");
    ask.type = "button";
    ask.className = "qa-ask";
    ask.textContent = "이 질문 물어보기 →";
    ask.addEventListener("click", () => askSuggested(q));
    li.appendChild(ask);
    list.appendChild(li);
  });
  document.getElementById("qa-prep").classList.toggle("hidden", n === 0);
}
function openChat() {
  chatDrawer.classList.add("open");
  chatDrawer.setAttribute("aria-hidden", "false");
  chatInput.focus();
}
function askSuggested(q) {
  if (!currentHash) return;
  openChat();
  if (chatBusy) return; // 이미 답변 생성 중 — 입력을 덮어쓰지 않고 드로어만 연다
  chatInput.value = q;
  autoGrowChat();
  if (chatForm.requestSubmit) chatForm.requestSubmit();
  else chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
}

// ---------- 용어집 (#6) ----------
function renderGlossary(items) {
  glossaryItems = Array.isArray(items) ? items.filter((g) => g && (g.term || g.latex)) : [];
  document.getElementById("tool-glossary").style.display = glossaryItems.length ? "" : "none";
  if (!glossaryItems.length) document.getElementById("glossary-card").classList.add("hidden");
  document.getElementById("glossary-search").value = "";
  paintGlossary("");
}
function paintGlossary(filter) {
  const list = document.getElementById("glossary-list");
  list.innerHTML = "";
  const q = (filter || "").toLowerCase();
  glossaryItems
    .filter((g) => !q || `${g.term || ""} ${g.meaning || ""}`.toLowerCase().includes(q))
    .forEach((g) => {
      const li = document.createElement("li");
      li.className = "glossary-item";
      const term = document.createElement("span");
      term.className = "glossary-term";
      // 모델이 latex를 이미 $...$로 감싸 줄 수 있어 앞뒤 $를 벗긴 뒤 한 번만 감싼다
      const tex = g.latex ? String(g.latex).trim().replace(/^\$+|\$+$/g, "") : "";
      if (tex) renderRich(term, `$${tex}$`);
      else term.textContent = g.term || "";
      const mean = document.createElement("span");
      mean.className = "glossary-mean";
      renderRich(mean, g.meaning || "");
      li.append(term, mean);
      list.appendChild(li);
    });
}

// ---------- 마크다운 직렬화 + 복사/저장 (#2) ----------
function mdInline(text) {
  return String(text || "")
    .replace(/\[\[\s*p\.?\s*(\d+)\s*(?:\|\s*([^\]]+?))?\s*\]\]/gi, (m, p, qt) => (qt ? `(p.${p}: ${qt.trim()})` : `(p.${p})`))
    .replace(/==([^=\n][^=]*?)==/g, "**$1**");
}
// 표 셀용: 인라인 처리 + 파이프 이스케이프 + 줄바꿈 제거 (한 칸이 표 전체를 밀지 않게)
function mdCell(text) {
  return mdInline(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}
function sectionMd(name, data) {
  data = data || currentAnalysis || {};
  const L = [];
  if (name === "background") {
    L.push("## 연구 배경", mdInline(data.background));
    if (Array.isArray(data.timeline) && data.timeline.length) {
      L.push("\n### 분야 타임라인");
      data.timeline.forEach((t) => { if (t) L.push(`- **${t.year ?? ""} ${mdInline(t.label)}** — ${mdInline(t.note)}`); });
    }
  } else if (name === "problem") {
    L.push("## 해결하려는 것", mdInline(data.problem));
  } else if (name === "method") {
    L.push("## 연구 방법론");
    (data.method_steps || []).forEach((s, i) => {
      if (!s || typeof s !== "object") return;
      L.push(`\n### ${i + 1}. ${mdInline(s.title)}`);
      if (s.description) L.push(mdInline(s.description));
      if (s.analogy) L.push(`> 💡 ${mdInline(s.analogy)}`);
    });
  } else if (name === "results") {
    L.push("## 실험·결과");
    const e = data.experiments || {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const defLine = (it, kName, kAlt) => {
      const nm = typeof it === "string" ? it : (it[kName] || it[kAlt] || "");
      const mn = typeof it === "string" ? "" : (it.meaning || it.detail || "");
      return `- **${mdInline(nm)}**${mn ? ` — ${mdInline(mn)}` : ""}`;
    };
    if (e.takeaway) L.push(`**${mdInline(e.takeaway)}**`);
    if (arr(e.metrics_explained).length) {
      L.push("\n### 측정 지표");
      e.metrics_explained.forEach((m) => { if (m) L.push(defLine(m, "name", "term")); });
    } else if (arr(e.metrics).length) {
      L.push("\n| 지표 | 값 | 비고 |", "|---|---|---|");
      e.metrics.forEach((m) => {
        if (m && typeof m === "object") L.push(`| ${mdCell(m.label)} | ${mdCell(String(m.value ?? "") + (m.unit ? " " + m.unit : ""))} | ${mdCell(m.note || "")} |`);
      });
    }
    if (arr(e.datasets).length) L.push(`\n**데이터셋:** ${e.datasets.map((d) => (d && d.name) || (typeof d === "string" ? d : "")).filter(Boolean).join(", ")}`);
    if (arr(e.baselines).length) L.push(`**비교 대상:** ${e.baselines.map((b) => (typeof b === "string" ? b : (b && b.name) || "")).filter(Boolean).join(", ")}`);
    if (arr(e.terms).length) {
      L.push("\n### 용어 설명");
      e.terms.forEach((t) => { if (t) L.push(defLine(t, "term", "name")); });
    }
    if (arr(e.studies).length) {
      L.push("\n### 실험");
      let i = 0;
      e.studies.forEach((s) => {
        if (!s || typeof s !== "object") return;
        i++;
        L.push(`\n**${i}. ${mdInline(s.title || "실험 " + i)}**`);
        if (s.purpose) L.push(`- 목적: ${mdInline(s.purpose)}`);
        if (s.setup) L.push(`- 세팅: ${mdInline(s.setup)}`);
        if (s.result) L.push(`- 결과: ${mdInline(s.result)}`);
      });
    } else if (arr(e.ablations).length) {
      L.push("\n**주요 분석:**");
      e.ablations.forEach((a) => L.push(`- ${mdInline(typeof a === "string" ? a : a && a.text)}`));
    }
    if (e.limitations) L.push("\n### 한계·향후 연구", mdInline(e.limitations));
  } else if (name === "equations") {
    L.push("## 수식 정리");
    (data.equations || []).forEach((eq, i) => {
      if (!eq || typeof eq !== "object") return;
      L.push(`\n**(${i + 1})** ${eq.paper_ref ? "`" + eq.paper_ref + "`" : ""}`.trim(), `$$${eq.latex || ""}$$`);
      if (eq.explanation) L.push(mdInline(eq.explanation));
      if (eq.analogy) L.push(`> 💡 ${mdInline(eq.analogy)}`);
    });
  } else if (name === "figures") {
    L.push("## 그림 해설");
    (data.figure_guide || []).forEach((f) => {
      if (!f || typeof f !== "object") return;
      L.push(`\n### ${mdInline(f.label || "Figure")}${f.page ? ` (p.${f.page})` : ""}`);
      if (f.caption_ko) L.push(`- 원문 캡션: ${mdInline(f.caption_ko)}`);
      if (f.explanation) L.push(mdInline(f.explanation));
      if (f.takeaway) L.push(`> 📌 ${mdInline(f.takeaway)}`);
    });
  } else if (name === "seminar") {
    L.push("## 세미나 정리");
    (data.seminar || []).forEach((s) => {
      if (!s || typeof s !== "object") return;
      L.push(`\n### ${mdInline(seminarHeading(s.section, s.title))}`.trimEnd());
      let lastSub = null;
      (Array.isArray(s.points) ? s.points : []).forEach((p) => {
        if (!p || typeof p !== "object") return;
        const sub = p.subhead && String(p.subhead).trim();
        if (sub && sub !== lastSub) { L.push(`\n**${mdInline(sub)}**`); lastSub = sub; }
        const pages = Array.isArray(p.pages) ? p.pages.map(Number).filter((n) => Number.isFinite(n) && n >= 1) : [];
        const pg = pages.length ? ` (${[...new Set(pages)].map((n) => "p." + n).join(", ")})` : "";
        const add = p.kind === "added" ? " _[추가]_" : "";
        L.push(`- **${p.id || "•"}** ${mdInline(p.text)}${pg}${add}`);
      });
    });
  }
  return L.join("\n").trim();
}
function cheatSheetMd(data) {
  data = data || currentAnalysis || {};
  const L = [`# ${data.title || "논문"}`];
  if (data.one_liner) L.push(`> ${mdInline(data.one_liner)}`);
  if (Array.isArray(data.contributions) && data.contributions.length) {
    L.push("\n## 핵심 기여");
    data.contributions.forEach((c) => { if (c) L.push(`- ${mdInline(typeof c === "string" ? c : c.text)}`); });
  }
  if (Array.isArray(data.equations) && data.equations.length) {
    L.push("\n## 핵심 수식");
    data.equations.slice(0, 6).forEach((eq, i) => { if (eq && typeof eq === "object") L.push(`- **(${i + 1})** $${eq.latex || ""}$ — ${mdInline((eq.explanation || "").split("\n")[0])}`); });
  }
  const e = data.experiments || {};
  if (e.takeaway) L.push(`\n## 결과 한 줄\n${mdInline(e.takeaway)}`);
  if (Array.isArray(data.timeline) && data.timeline.length) {
    L.push("\n## 분야 타임라인");
    data.timeline.forEach((t) => { if (t) L.push(`- ${t.year ?? ""} ${mdInline(t.label)} — ${mdInline(t.note)}`); });
  }
  if (Array.isArray(data.suggested_questions) && data.suggested_questions.length) {
    L.push("\n## 예상 Q&A");
    data.suggested_questions.forEach((it) => {
      const q = typeof it === "string" ? it : it && it.q;
      if (q) L.push(`- ${mdInline(q)}${it && it.why ? ` — ${mdInline(it.why)}` : ""}`);
    });
  }
  if (Array.isArray(data.related_papers) && data.related_papers.length) {
    L.push("\n## 먼저 보면 좋은 논문");
    data.related_papers.forEach((p) => {
      if (!p) return;
      const t = typeof p === "string" ? p : p.title;
      if (!t) return;
      L.push(`- ${t}${p.year ? ` (${p.year})` : ""}${p.link ? ` — ${p.link}` : ""}`);
    });
  }
  if (notesState.notes) L.push(`\n## 내 메모\n${notesState.notes}`);
  if (Array.isArray(notesState.bookmarks) && notesState.bookmarks.length) {
    L.push("\n## 핵심 구절");
    notesState.bookmarks.forEach((b) => L.push(`- "${b.text}"${b.page ? ` (p.${b.page})` : ""}`));
  }
  return L.join("\n").trim();
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashTool(btn, "복사됨 ✓");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); flashTool(btn, "복사됨 ✓"); } catch { flashTool(btn, "복사 실패"); }
    ta.remove();
  }
}
function flashTool(btn, msg) {
  if (!btn) return;
  const orig = btn.dataset.orig || btn.textContent;
  btn.dataset.orig = orig;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1400);
}
function downloadMd(text, filename) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById("tool-copy").addEventListener("click", (e) => {
  if (!currentAnalysis) return;
  copyText(sectionMd(activeTab, currentAnalysis) || "(이 섹션은 비어 있습니다)", e.currentTarget);
});
document.getElementById("tool-cheatsheet").addEventListener("click", (e) => {
  if (currentAnalysis) copyText(cheatSheetMd(currentAnalysis), e.currentTarget);
});
document.getElementById("tool-download").addEventListener("click", () => {
  if (!currentAnalysis) return;
  const name = (currentAnalysis.title || "paper").replace(/[^\w가-힣 -]/g, "").slice(0, 60).trim() || "paper";
  // 다운로드 파일은 한 장 요약 + 발표용 '세미나 정리' 전문을 함께 담는다(전체 내보내기).
  let md = cheatSheetMd(currentAnalysis);
  const sem = sectionMd("seminar", currentAnalysis);
  if (sem) md += "\n\n---\n\n" + sem;
  downloadMd(md, `${name}.md`);
});
document.getElementById("tool-notes").addEventListener("click", () => toggleSideCard("notes-card"));
document.getElementById("tool-glossary").addEventListener("click", () => toggleSideCard("glossary-card"));
document.getElementById("glossary-close").addEventListener("click", () => document.getElementById("glossary-card").classList.add("hidden"));
document.getElementById("notes-close").addEventListener("click", () => document.getElementById("notes-card").classList.add("hidden"));
document.getElementById("glossary-search").addEventListener("input", (e) => paintGlossary(e.target.value.trim()));
function toggleSideCard(id) {
  const el = document.getElementById(id);
  const willShow = el.classList.contains("hidden");
  document.getElementById("notes-card").classList.add("hidden");
  document.getElementById("glossary-card").classList.add("hidden");
  if (willShow) {
    el.classList.remove("hidden");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ---------- 메모 & 북마크 (#3) ----------
async function loadNotes(hash) {
  notesState = { notes: "", bookmarks: [] };
  notesHashLoaded = hash;
  document.getElementById("notes-text").value = "";
  document.getElementById("notes-status").textContent = "";
  renderBookmarks();
  if (!hash) return;
  try {
    const r = await fetch(`${API_BASE}/api/notes/${hash}`);
    if (!r.ok) return;
    const d = await r.json();
    if (notesHashLoaded !== hash) return; // 그 사이 다른 논문으로 이동
    notesState = { notes: d.notes || "", bookmarks: Array.isArray(d.bookmarks) ? d.bookmarks : [] };
    document.getElementById("notes-text").value = notesState.notes;
    renderBookmarks();
  } catch {}
}
function scheduleNotesSave() {
  document.getElementById("notes-status").textContent = "저장 중…";
  clearTimeout(notesSaveTimer);
  // 예약 시점의 hash·내용을 고정 — 700ms 안에 다른 논문으로 넘어가도
  // 그 사이 친 메모가 '원래 논문'에 저장되고, 다른 논문을 덮어쓰지 않는다.
  const hash = currentHash;
  const snapshot = { notes: notesState.notes, bookmarks: notesState.bookmarks.slice() };
  notesSaveTimer = setTimeout(() => saveNotes(hash, snapshot), 700);
}
async function saveNotes(hash, data) {
  if (!hash) return;
  const s = document.getElementById("notes-status");
  try {
    const r = await fetch(`${API_BASE}/api/notes/${hash}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (hash !== currentHash) return; // 다른 논문으로 넘어갔으면 상태표시 안 함(저장은 위에서 끝남)
    if (!r.ok) { s.textContent = "저장 실패"; return; }
    s.textContent = "저장됨 ✓";
    setTimeout(() => { if (s.textContent === "저장됨 ✓") s.textContent = ""; }, 1500);
  } catch {
    if (hash === currentHash) s.textContent = "저장 실패";
  }
}
document.getElementById("notes-text").addEventListener("input", (e) => {
  notesState.notes = e.target.value;
  scheduleNotesSave();
});
document.getElementById("bm-add").addEventListener("click", (e) => {
  const sel = String(window.getSelection ? window.getSelection().toString() : "").trim();
  if (!sel) { flashTool(e.currentTarget, "먼저 텍스트 선택"); return; }
  notesState.bookmarks.push({ text: sel.slice(0, 400), t: Date.now() });
  renderBookmarks();
  scheduleNotesSave();
});
function renderBookmarks() {
  const ul = document.getElementById("notes-bookmarks");
  ul.innerHTML = "";
  const arr = notesState.bookmarks || [];
  if (!arr.length) {
    ul.innerHTML = '<li class="muted bm-empty">분석이나 원문에서 구절을 드래그한 뒤 "선택 구절 추가"를 누르세요.</li>';
    return;
  }
  arr.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "bm-item";
    const q = document.createElement("span");
    q.className = "bm-text";
    q.textContent = `"${b.text}"`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bm-del";
    del.textContent = "×";
    del.title = "삭제";
    del.addEventListener("click", () => { notesState.bookmarks.splice(i, 1); renderBookmarks(); scheduleNotesSave(); });
    li.append(q, del);
    ul.appendChild(li);
  });
}

// ---------- 섹션별 재생성 (#5) ----------
document.getElementById("tool-regen").addEventListener("click", () => regenSection(activeTab));
async function regenSection(section) {
  if (!currentHash || sectionRegenInFlight) return;
  const map = { seminar: "세미나 정리", background: "연구 배경", problem: "해결하려는 것", method: "연구 방법론", results: "실험·결과", equations: "수식 정리", figures: "그림 해설" };
  if (!map[section]) return;
  if (!confirm(`'${map[section]}' 섹션만 다시 생성할까요?\n(원문에서 해당 부분만 다시 읽습니다 — 1~2분, 다른 섹션은 그대로 유지)`)) return;
  const startedHash = currentHash;
  sectionRegenInFlight = true;
  sectionRegenAbort = new AbortController();
  const btn = document.getElementById("tool-regen");
  const orig = btn.textContent;
  btn.textContent = "재생성 중…";
  btn.disabled = true;
  const panel = document.getElementById(`panel-${section}`);
  if (panel) panel.classList.add("regenerating");
  try {
    const r = await fetch(`${API_BASE}/api/reanalyze-section/${startedHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section }),
      signal: sectionRegenAbort.signal,
    });
    const d = await safeJson(r);
    if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
    if (currentHash !== startedHash) return; // 그 사이 다른 논문으로 이동 → 옛 결과로 화면 덮지 않음
    const keepTab = activeTab;
    renderResult(d.analysis); // 갱신된 전체 분석으로 재렌더 (같은 hash라 PDF·메모는 유지)
    switchTab(keepTab); // 보던 탭 유지
    loadHistory();
  } catch (e) {
    if (e.name !== "AbortError" && currentHash === startedHash) showError(e.message);
  } finally {
    sectionRegenInFlight = false;
    sectionRegenAbort = null;
    btn.textContent = orig;
    btn.disabled = false;
    if (panel) panel.classList.remove("regenerating");
  }
}

// ---------- 키보드 단축키 (#8) ----------
const TAB_ORDER = ["seminar", "background", "problem", "method", "results", "equations", "figures"];
document.addEventListener("keydown", (e) => {
  const help = document.getElementById("kbd-help");
  if (e.key === "Escape") {
    if (!help.classList.contains("hidden")) { help.classList.add("hidden"); return; }
    let closed = false;
    ["glossary-card", "notes-card"].forEach((id) => {
      const el = document.getElementById(id);
      // 그 카드 안에서 입력 중이면(메모·검색) Esc로 닫지 않는다 (실수 닫힘 방지)
      if (!el.classList.contains("hidden") && !el.contains(e.target)) { el.classList.add("hidden"); closed = true; }
    });
    if (chatDrawer.classList.contains("open")) {
      chatDrawer.classList.remove("open");
      chatDrawer.setAttribute("aria-hidden", "true");
      closed = true;
    }
    if (closed) return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || e.target.isContentEditable;
  if (e.key === "/" && !typing) { e.preventDefault(); historySearch.focus(); return; }
  if (typing) return;
  if (e.key === "?") { e.preventDefault(); help.classList.toggle("hidden"); return; }
  const reading = document.body.classList.contains("reading");
  if ((e.key === "j" || e.key === "J") && reading) { e.preventDefault(); const i = TAB_ORDER.indexOf(activeTab); switchTab(TAB_ORDER[Math.min(TAB_ORDER.length - 1, i + 1)]); }
  else if ((e.key === "k" || e.key === "K") && reading) { e.preventDefault(); const i = TAB_ORDER.indexOf(activeTab); switchTab(TAB_ORDER[Math.max(0, i - 1)]); }
  else if (e.key >= "1" && e.key <= "7" && reading) { e.preventDefault(); switchTab(TAB_ORDER[+e.key - 1]); }
  else if ((e.key === "f" || e.key === "F") && reading) { e.preventDefault(); document.getElementById("pdf-toggle").click(); }
  else if ((e.key === "q" || e.key === "Q") && reading) { e.preventDefault(); openChat(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); document.getElementById("sb-new").click(); }
  else if (e.key === "t" || e.key === "T") { e.preventDefault(); document.getElementById("theme-toggle").click(); }
});
document.getElementById("kbd-help-close").addEventListener("click", () => document.getElementById("kbd-help").classList.add("hidden"));
document.getElementById("kbd-help").addEventListener("click", (e) => { if (e.target.id === "kbd-help") e.target.classList.add("hidden"); });

loadHistory();
restoreFromHash(); // URL에 #p=<hash>가 있으면 그 논문·탭을 복원
