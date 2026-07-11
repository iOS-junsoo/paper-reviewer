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
  stopEta(false); // ETA 티커·탭 타이틀 카운트다운 정지
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
  stopEta(false); // ETA 티커·탭 타이틀 카운트다운 정지
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
let historySearchTimer = 0;
// ── 히스토리 필터 칩: 모드(전체→정밀→간단 순환) + 연도 셀렉트 ──────────────────
let historyModeFilter = "all"; // all | full | simple
let historyYearFilter = ""; // "" = 전체
const hfMode = document.getElementById("hf-mode");
const hfYear = document.getElementById("hf-year");
hfMode.addEventListener("click", () => {
  historyModeFilter = historyModeFilter === "all" ? "full" : historyModeFilter === "full" ? "simple" : "all";
  hfMode.textContent = historyModeFilter === "all" ? "모드: 전체" : historyModeFilter === "full" ? "모드: 🔬 정밀" : "모드: ⚡ 간단";
  hfMode.classList.toggle("hf-on", historyModeFilter !== "all");
  renderHistory();
});
hfYear.addEventListener("change", () => {
  historyYearFilter = hfYear.value;
  hfYear.classList.toggle("hf-on", !!historyYearFilter);
  renderHistory();
});
// 목록의 실제 연도들로 셀렉트 옵션 재구성(선택 유지)
function refreshYearOptions() {
  const years = [...new Set(historyItems.map((it) => it.year).filter(Boolean))].sort((a, b) => b - a);
  const cur = historyYearFilter;
  hfYear.innerHTML = `<option value="">연도: 전체</option>` + years.map((y) => `<option value="${y}">${y}</option>`).join("");
  hfYear.value = years.includes(Number(cur)) ? cur : "";
  historyYearFilter = hfYear.value;
}

historySearch.addEventListener("input", () => {
  historyFilter = historySearch.value.trim().toLowerCase();
  // 목록 재구성(KaTeX 렌더 포함)이 키 입력마다 돌지 않게 잠깐 모아서 반영
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(renderHistory, 120);
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
  if (fileInput.files.length > 1) analyzeQueue(fileInput.files);
  else if (fileInput.files.length) analyzeFile(fileInput.files[0]);
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
  if (e.dataTransfer.files.length > 1) return analyzeQueue(e.dataTransfer.files);
  const file = e.dataTransfer.files[0];
  if (file) return analyzeFile(file);
  // 파일이 아니라 링크 텍스트를 끌어다 놓은 경우(브라우저 주소창·페이지의 arXiv 링크)
  const text = (e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list") || "").trim();
  if (/arxiv\.org\/(abs|pdf)\//i.test(text)) analyzeUrl(text, null);
});

// ── 분석 모드 선택 다이얼로그 (간단 ⚡ / 정밀 🔬) ──────────────────────────
// 페이지 수로 서버에 모드별 예상 시간을 물어 카드에 표시한다. 반환: "simple"|"full"|null(취소)
function fmtEtaMinutes(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "수 분";
  const m = Math.round(ms / 60000);
  return m < 1 ? "약 1분 미만" : `약 ${m}분`;
}
function showModeDialog(fileName, pages) {
  return new Promise((resolve) => {
    document.getElementById("mode-overlay")?.remove();
    const ov = document.createElement("div");
    ov.className = "mode-overlay";
    ov.id = "mode-overlay";
    const remembered = localStorage.getItem("analysisMode") === "simple" ? "simple" : "full";
    ov.innerHTML =
      `<div class="mode-box" role="dialog" aria-label="분석 모드 선택">` +
      `<div class="mode-file">「${fileName.replace(/</g, "&lt;")}」${pages ? ` · ${pages}페이지` : ""}</div>` +
      `<div class="mode-row">` +
      `<button type="button" class="mode-card" data-mode="simple"><span class="mode-name">⚡ 간단 분석</span>` +
      `<span class="mode-eta" id="mode-eta-simple">예상 시간 계산 중…</span>` +
      `<span class="mode-desc">배경 · 문제 · 방법론 · 수식<br />4개 섹션</span><kbd>1</kbd></button>` +
      `<button type="button" class="mode-card" data-mode="full"><span class="mode-name">🔬 정밀 분석</span>` +
      `<span class="mode-eta" id="mode-eta-full">예상 시간 계산 중…</span>` +
      `<span class="mode-desc">전체 7개 섹션 +<br />인터랙티브 시각화</span><kbd>2</kbd></button>` +
      `</div><div class="mode-foot"><button type="button" class="mode-cancel">취소 (Esc)</button></div></div>`;
    const done = (mode) => {
      document.removeEventListener("keydown", onKey, true);
      ov.remove();
      if (mode) { try { localStorage.setItem("analysisMode", mode); } catch {} }
      resolve(mode);
    };
    const onKey = (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === "1") { e.preventDefault(); done("simple"); }
      else if (e.key === "2") { e.preventDefault(); done("full"); }
    };
    document.addEventListener("keydown", onKey, true); // 전역 단축키(J/K 등)보다 먼저 잡는다
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return done(null); // 바깥 클릭 = 취소
      const card = e.target.closest(".mode-card");
      if (card) return done(card.dataset.mode);
      if (e.target.closest(".mode-cancel")) return done(null);
    });
    document.body.appendChild(ov);
    ov.querySelector(`.mode-card[data-mode="${remembered}"]`)?.focus(); // 마지막 선택에 기본 포커스
    // 모드별 예상 시간 (ETA 자가학습 통계 기반) — 실패해도 다이얼로그는 동작
    fetch(`${API_BASE}/api/eta?pages=${pages || 20}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !document.getElementById("mode-overlay")) return;
        document.getElementById("mode-eta-simple").textContent = fmtEtaMinutes(d.simple && d.simple.totalMs);
        document.getElementById("mode-eta-full").textContent = fmtEtaMinutes(d.full && d.full.totalMs);
      })
      .catch(() => {});
  });
}

async function analyzeFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return showError("PDF 파일만 업로드할 수 있습니다.");
  }
  hideError();

  // 업로드 전 클라 측 준비: (a) SHA-256으로 캐시 여부 확인 — 이미 분석된 논문이면
  // 다이얼로그 없이 바로 연다(서버가 캐시 즉시 반환). (b) pdf.js로 페이지 수 계산(ETA 표시용).
  // 어느 쪽이든 실패하면 그냥 다이얼로그로 진행한다 (crypto.subtle은 https/localhost 전용 —
  // Tailscale http 접속에선 없을 수 있음).
  let pages = null;
  let cachedRec = null;
  try {
    const buf = await file.arrayBuffer();
    if (window.crypto && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const r = await fetch(`${API_BASE}/api/history/${hex}`);
      if (r.ok) cachedRec = await r.json();
    }
    if (typeof pdfjsLib !== "undefined") {
      // getDocument가 버퍼 소유권을 가져가므로 사본을 넘긴다 (FormData의 file은 영향 없음)
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      pages = doc.numPages;
      destroyPdfDoc(doc);
    }
  } catch {}

  let mode;
  if (cachedRec) {
    // 캐시 히트: 그 기록의 모드 그대로 즉시 열기 — 간단 기록의 정밀 전환은
    // 결과 화면의 [정밀 분석으로 업그레이드] 버튼이 담당한다.
    mode = cachedRec.analysis_mode === "simple" ? "simple" : "full";
  } else {
    mode = await showModeDialog(file.name, pages);
    if (!mode) { fileInput.value = ""; return; } // 취소
  }
  ensureNotifyPermission(); // 모드 선택 제스처 직후 — 완료 데스크톱 알림 권한
  await runUpload(file, mode);
}

// 업로드→SSE→렌더 코어 (단일/일괄 큐 공용). label: 큐 진행 표시("(2/5) 제목").
// 반환: { ok, error?, aborted? } — 큐가 이어갈지/멈출지 판단하는 데 쓴다.
async function runUpload(file, mode, label) {
  workspaceEl.classList.add("hidden");
  loadingEl.classList.remove("hidden");
  setActiveAnalysis(label || file.name.replace(/\.pdf$/i, ""));
  resetLoadingProgress();
  setLoadingProgress("논문을 업로드하는 중…", 0);

  const form = new FormData();
  form.append("pdf", file);
  form.append("mode", mode);

  const ac = beginCancellable();
  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST", body: form, signal: ac.signal,
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error(formatApiError(data, res.status));
    }
    const data = await consumeAnalysisStream(res); // SSE: 진행 메시지 → (부분 렌더) → 최종 결과
    if (analysisPartialShown) {
      const keep = activeTab; // 부분 렌더 후 사용자가 읽던 탭 유지 — 시각화만 갈아끼움
      renderResult(data);
      switchTab(keep);
    } else {
      renderResult(data);
    }
    loadHistory();
    return { ok: true };
  } catch (e) {
    if (e.name === "AbortError") { loadHistory(); return { ok: false, aborted: true }; } // 사용자가 취소
    showError(e.message);
    return { ok: false, error: e.message };
  } finally {
    // 이 흐름이 다른 새 흐름으로 대체됐다면 UI 정리를 건너뛴다(새 흐름의 화면을 망치지 않게)
    if (endCancellable(ac)) {
      loadingEl.classList.add("hidden");
      hideReanalyzeBanner(); // 부분 렌더가 띄운 시각화 진행 배너 정리
      setActiveAnalysis(null);
      setLoadingText("논문을 분석하고 있습니다…");
    }
    fileInput.value = "";
  }
}

// ── 여러 논문 일괄(큐) 분석 — 모드 한 번 선택 후 순차 진행, 오류는 건너뛰고 계속 ──
async function analyzeQueue(files) {
  const pdfs = [...files].filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return showError("PDF 파일만 업로드할 수 있습니다.");
  if (pdfs.length === 1) return analyzeFile(pdfs[0]);
  hideError();
  const mode = await showModeDialog(`${pdfs.length}편 일괄 분석`, null);
  if (!mode) { fileInput.value = ""; return; }
  ensureNotifyPermission();
  const failures = [];
  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    const r = await runUpload(f, mode, `(${i + 1}/${pdfs.length}) ${f.name.replace(/\.pdf$/i, "")}`);
    if (r.aborted) break; // 취소 = 큐 전체 중단
    if (!r.ok) {
      failures.push(f.name);
      appendLoadingLog(`✗ ${f.name}: ${(r.error || "실패").slice(0, 80)}`);
      // 구독 세션 한도 도달 — 남은 파일을 돌려봐야 전부 실패하므로 멈춘다
      if (/한도|session limit|429/i.test(r.error || "")) {
        showError(`구독 세션 한도에 도달했습니다 — 남은 ${pdfs.length - i - 1}편은 한도 리셋 후 다시 올려 주세요. (실패: ${failures.join(", ")})`);
        return;
      }
    }
  }
  if (failures.length) showError(`일괄 분석 완료 — ${failures.length}편 실패: ${failures.join(", ")}`);
  loadHistory();
}

let lastLoadingPct = 0;
let lastLoadingMsg = "";

// ── ETA(예상 남은 시간) 기반 진행바 ─────────────────────────────────────────
// 서버가 보내는 eta 이벤트(구간별 예상 소요 estMs)와 클라 경과시간으로 바를 채운다.
// 실측 %(progress.pct)는 분석 구간에서 시간기반 진행을 '앞당기는' 보정 신호로만 쓴다.
const eta = {
  active: false, timer: null, phase: null,
  phaseStart: 0, phaseEstMs: 0, estTotalMs: 0,
  bandStart: 0, bandEnd: 1, runStart: 0, lastWidth: 0, eventFrac: 0,
};

// 로딩 화면과 재분석 배너의 바를 동시에 갱신(한쪽은 숨겨져 있어도 무해)
function setBarWidth(w) {
  const pct = Math.max(0, Math.min(100, w));
  document.getElementById("loading-fill").style.width = `${pct}%`;
  document.getElementById("rebar-fill").style.width = `${pct}%`;
}
function setBarLabel(txt) {
  document.getElementById("loading-pct").textContent = txt;
  document.getElementById("rebar-pct").textContent = txt;
}
function fmtRemaining(ms) {
  if (ms == null || ms <= 4000) return "곧 완료…";
  const s = Math.round(ms / 1000);
  if (s < 60) return `약 ${s}초 남음`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `약 ${m}분 ${r}초 남음` : `약 ${m}분 남음`;
}

function startEta(ev) {
  const now = performance.now();
  if (ev.phase === "viz") {
    eta.active = true;
    eta.phase = "viz";
    eta.phaseStart = now;
    eta.phaseEstMs = ev.estMs || 1;
    eta.estTotalMs = ev.estTotalMs || eta.estTotalMs;
    eta.bandStart = eta.bandEnd; // 분석 구간 끝에서 이어붙임
    eta.bandEnd = 1;
    eta.eventFrac = 0;
    eta.lastWidth = Math.max(eta.lastWidth, eta.bandStart * 100); // 분석 완료분 반영
  } else {
    // analysis (최초 시작 또는 재시도)
    if (!eta.active) { eta.runStart = now; eta.lastWidth = 0; }
    eta.active = true;
    eta.phase = "analysis";
    eta.phaseStart = now;
    eta.phaseEstMs = ev.estMs || 1;
    eta.estTotalMs = ev.estTotalMs || ev.estMs || 1;
    eta.bandStart = 0;
    eta.bandEnd = eta.estTotalMs > 0 ? Math.min(0.95, (ev.estMs || 1) / eta.estTotalMs) : 0.5;
    eta.eventFrac = 0;
  }
  if (!eta.timer) eta.timer = setInterval(tickEta, 250);
  tickEta();
}

function tickEta() {
  if (!eta.active) return;
  const now = performance.now();
  const elapsed = now - eta.phaseStart;
  const fRaw = eta.phaseEstMs > 0 ? elapsed / eta.phaseEstMs : 0;
  // 구간의 마지막 10%는 asymptote로 기어가 예상 초과에도 완료 이벤트 전엔 안 참
  let f = fRaw < 0.9 ? fRaw : 0.9 + 0.1 * (1 - Math.exp(-(fRaw - 0.9) * 2));
  f = Math.max(0, Math.min(0.999, f));
  let width = (eta.bandStart + f * (eta.bandEnd - eta.bandStart)) * 100;
  // 분석 구간: 실제 페이지-읽기 신호로 보정(시간 기반보다 앞서면 그쪽을 따른다)
  if (eta.phase === "analysis" && eta.eventFrac > 0) {
    const evWidth = (eta.bandStart + eta.eventFrac * (eta.bandEnd - eta.bandStart)) * 100;
    width = Math.max(width, evWidth);
  }
  width = Math.min(99, width);
  eta.lastWidth = Math.max(eta.lastWidth, width); // 단조 증가(뒤로 안 감)
  setBarWidth(eta.lastWidth);
  const remaining = eta.estTotalMs - (now - eta.runStart);
  const label = fmtRemaining(remaining);
  setBarLabel(label);
  const prog = document.getElementById("sb-active-prog");
  if (prog) prog.textContent = `${label}${lastLoadingMsg ? " · " + lastLoadingMsg : ""}`.trim();
  document.title = `⏳ ${label} — ${DOC_TITLE}`; // 다른 탭에서도 남은 시간이 보이게
}

// 분석 구간의 실측 %(0~92)를 진행 비율로 반영 — 92%를 분석 사실상 완료로 본다
function etaOnProgress(pct) {
  if (!eta.active || eta.phase !== "analysis") return;
  if (typeof pct !== "number" || Number.isNaN(pct)) return;
  eta.eventFrac = Math.max(eta.eventFrac, Math.min(1, pct / 92));
}

function stopEta(finalize) {
  if (eta.timer) { clearInterval(eta.timer); eta.timer = null; }
  eta.active = false;
  document.title = DOC_TITLE; // 탭 타이틀 카운트다운 원복
  if (finalize) {
    eta.lastWidth = 100;
    setBarWidth(100);
    setBarLabel("완료!");
    document.getElementById("loading-text").textContent = "완료!";
    document.getElementById("rebar-text").textContent = "완료!";
    const prog = document.getElementById("sb-active-prog");
    if (prog) prog.textContent = "완료!";
  }
}

// 상태 문구·로그만 갱신(바 너비·남은시간은 ETA 티커가 담당).
// ETA 비활성(서버가 eta 미전송) 시엔 폴백으로 pct를 바에 직접 반영한다.
function setLoadingProgress(msg, pct) {
  if (msg != null) {
    lastLoadingMsg = msg;
    document.getElementById("loading-text").textContent = msg;
    document.getElementById("rebar-text").textContent = msg;
  }
  if (!eta.active && typeof pct === "number" && !Number.isNaN(pct)) {
    lastLoadingPct = Math.max(0, Math.min(100, Math.round(pct)));
    setBarWidth(lastLoadingPct);
    setBarLabel(`${lastLoadingPct}%`);
  }
  if (!eta.active) {
    const prog = document.getElementById("sb-active-prog");
    if (prog) prog.textContent = `${msg || ""}`.trim();
  }
}

// 현재 보고 있는 논문을 재분석할 때: 로딩 화면으로 덮지 않고 기존 결과를 그대로 둔 채
// 상단에 진행 배너만 띄운다(읽던 내용 유지). 완료되면 renderResult가 내용을 교체한다.
function showReanalyzeBanner() {
  document.getElementById("rebar-text").textContent = "재분석을 시작하는 중…";
  eta.active = false; eta.lastWidth = 0;
  setBarWidth(0);
  setBarLabel("준비 중…");
  document.getElementById("reanalyze-banner").classList.remove("hidden");
}
function hideReanalyzeBanner() {
  document.getElementById("reanalyze-banner").classList.add("hidden");
}

// 메시지만 바꿀 때 (진행률 유지)
function setLoadingText(msg) {
  setLoadingProgress(msg, undefined);
}

// 분석 시작 시 0으로 초기화
function resetLoadingProgress() {
  if (eta.timer) { clearInterval(eta.timer); eta.timer = null; }
  eta.active = false; eta.lastWidth = 0; eta.eventFrac = 0;
  lastLoadingPct = 0; lastLoadingMsg = "";
  setBarWidth(0);
  setBarLabel("준비 중…");
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

// ── 분석 완료 데스크톱 알림 + 탭 타이틀 ETA ─────────────────────────────────
// 긴 분석(정밀 ~11분) 동안 다른 탭에 가 있어도 완료를 알 수 있게 한다.
const DOC_TITLE = document.title;
function ensureNotifyPermission() {
  // 사용자 제스처(모드 선택·재분석 클릭) 직후에만 호출 — 브라우저 정책상 이때만 프롬프트가 뜬다
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
}
function notifyDone(title, ok = true) {
  if (!document.hidden) return; // 보고 있는 탭이면 알림 불필요
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(ok ? "✅ 논문 분석 완료" : "⚠️ 논문 분석 실패", {
        body: (title || "Paper Reviewer").slice(0, 80),
        tag: "paper-reviewer-analysis", // 같은 태그 = 알림 중복 교체
      });
      n.onclick = () => { try { window.focus(); n.close(); } catch {} };
    }
  } catch {}
}

// 서버가 보내는 SSE 스트림(progress/partial/result/error)을 소비하고 최종 결과를 반환.
// partial(텍스트 분석 완료본)이 오면 즉시 렌더해 시각화(~5분)를 기다리지 않고 읽게 한다 —
// 호출자는 analysisPartialShown을 보고 최종 렌더 시 보던 탭을 유지한다.
let analysisPartialShown = false;
async function consumeAnalysisStream(res) {
  document.getElementById("loading-log").innerHTML = "";
  analysisPartialShown = false;
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
      if (ev.type === "eta") {
        startEta(ev); // 예상 소요 → 시간 기반 바 시작/구간 전환
      } else if (ev.type === "progress") {
        if (lastProgress && lastProgress !== ev.msg) appendLoadingLog(lastProgress);
        lastProgress = ev.msg;
        setLoadingProgress(ev.msg, ev.pct);
        etaOnProgress(ev.pct); // 실측 페이지% 로 바를 앞당김(분석 구간)
      } else if (ev.type === "partial") {
        // 텍스트 분석 완료 — 시각화가 구워지는 동안 먼저 읽는다. ETA 티커는 계속
        // 돌며 재분석 배너의 바(rebar)를 채운다(setBarWidth가 양쪽을 갱신).
        analysisPartialShown = true;
        renderResult(ev.data);
        loadingEl.classList.add("hidden");
        document.getElementById("reanalyze-banner").classList.remove("hidden");
        document.getElementById("rebar-text").textContent = "방법론 인터랙티브 시각화 생성 중 — 다른 탭은 먼저 읽을 수 있어요";
        loadHistory();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (ev.type === "result") {
        result = ev.data;
        stopEta(true); // 100% 스냅 + "완료!"
        notifyDone(result && result.title, true); // 백그라운드 탭이면 데스크톱 알림
      } else if (ev.type === "error") {
        stopEta(false);
        notifyDone(ev.error || "분석 실패", false);
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
  if (!sameHash && chatAbort) chatAbort.abort(); // 이전 논문의 답변 생성 중단 — 서버 에이전트도 함께 멈춰 사용량 절약
  currentAnalysis = data; // 마크다운 내보내기·섹션 재생성에서 사용
  // 저장 실패(Firestore 한도 등): 결과는 보이지만 캐시에 없음 — 새로고침 시 사라짐을 알린다
  if (data.save_failed) showError("⚠️ 분석은 완료됐지만 저장에 실패했습니다 — 이 화면을 벗어나면 결과가 사라질 수 있어요. 마크다운으로 내려받아 두거나 다시 분석해 주세요.");
  // 추천 질문은 객체({q,category,why}) 또는 옛 문자열 — 채팅 칩용으로 문자열만 추림
  currentSuggested = (Array.isArray(data.suggested_questions) ? data.suggested_questions : [])
    .map((x) => (typeof x === "string" ? x : (x && x.q) || ""))
    .filter(Boolean);
  if (!sameHash) loadChat(currentHash); // 저장된 채팅 기록 비동기 로드

  document.getElementById("paper-title").textContent = data.title || "(제목 없음)";
  renderRich(document.getElementById("one-liner"), data.one_liner || "");
  renderContributions(data.contributions);
  cacheBadge.classList.toggle("hidden", !data.cached);
  // 간단 분석 표시: 배지 + 업그레이드 버튼 + 생략 섹션 탭 잠금(정밀에서 제공)
  const isSimple = data.analysis_mode === "simple";
  document.getElementById("simple-badge").classList.toggle("hidden", !isSimple);
  document.getElementById("tool-upgrade").classList.toggle("hidden", !isSimple);

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
  updateTabLocks(data); // 간단 분석의 생략 섹션 탭을 잠금 표시(클릭하면 개별 생성/업그레이드 안내)
  renderRelated(data.related_papers);
  renderQaPrep(data.suggested_questions); // 예상 Q&A 준비 패널
  renderGlossary(data.glossary); // 용어집
  renderTldr(data); // P2: 30초 오리엔테이션 카드 (문제→방법→결과)
  decorateGlossaryTerms(); // P6: 본문 용어 점선 밑줄+툴팁 (renderGlossary 뒤 — glossaryItems 필요)
  if (!sameHash) loadNotes(currentHash); // 개인 메모·북마크
  if (!sameHash) loadPdf(currentHash);

  workspaceEl.classList.remove("hidden");
  chatFab.classList.remove("hidden"); // 분석 결과가 있어야 질문 가능
  document.body.classList.add("reading"); // 상단 헤더·드롭존 축소
  highlightActiveHistory(); // 사이드바에서 현재 논문 강조
  // P9: 전에 읽던 논문이면 마지막 탭·스크롤 위치 복원. 처음이면 세미나(발표 준비 기본
  // 목적) 또는 연구 배경. (딥링크/재생성은 이후 restoreFromHash·keepTab이 다시 덮어쓴다.)
  const pos = readPos(currentHash);
  paintSeenDots(new Set(Array.isArray(pos.seen) ? pos.seen : []));
  const defaultTab = Array.isArray(data.seminar) && data.seminar.length ? "seminar" : "background";
  switchTab(!sameHash && pos.tab && TAB_ORDER.includes(pos.tab) ? pos.tab : sameHash ? activeTab : defaultTab);
  if (!sameHash && pos.y > 80) setTimeout(() => window.scrollTo(0, pos.y), 60); // 렌더 안정 후 복원
}

// ---------- 간단 분석: 생략 섹션 탭 잠금 + 안내 패널 ----------
// 간단 분석에서 생략되는 탭들. 값 = 그 섹션 데이터가 실제로 있는지 판정(개별 재생성으로
// 채워졌으면 잠금 해제 — 업그레이드의 부분적 대안).
const SIMPLE_LOCKED_TABS = {
  seminar: (d) => Array.isArray(d.seminar) && d.seminar.length > 0,
  results: (d) => {
    const e = d.experiments;
    return !!(e && typeof e === "object" &&
      (e.takeaway || e.limitations || (Array.isArray(e.studies) && e.studies.length)));
  },
  figures: (d) => Array.isArray(d.figure_guide) && d.figure_guide.length > 0,
};
function updateTabLocks(data) {
  const simple = data && data.analysis_mode === "simple";
  document.querySelectorAll("#tabs .tab").forEach((t) => {
    const name = t.dataset.tab;
    const locked = !!(simple && SIMPLE_LOCKED_TABS[name] && !SIMPLE_LOCKED_TABS[name](data));
    t.classList.toggle("tab-locked", locked);
    t.title = locked ? "간단 분석에서는 생략된 섹션 — 정밀 분석에서 제공 (탭을 열면 개별 생성할 수 있어요)" : "";
    if (locked) buildSimplePlaceholder(name);
  });
}
// 잠긴 탭의 패널 내용: 왜 비었는지 + 채우는 두 가지 경로(섹션만 생성 / 전체 업그레이드)
function buildSimplePlaceholder(section) {
  const label = { seminar: "세미나 정리", results: "실험·결과", figures: "그림 해설" }[section] || section;
  const panel = document.getElementById(`panel-${section}`);
  if (!panel) return;
  panel.innerHTML = "";
  const box = document.createElement("div");
  box.className = "simple-missing";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = `⚡ 간단 분석에는 '${label}' 섹션이 없습니다.`;
  const row = document.createElement("div");
  row.className = "simple-missing-btns";
  const one = document.createElement("button");
  one.type = "button";
  one.className = "rtool";
  one.textContent = `🔄 이 섹션만 생성 (1~2분)`;
  one.addEventListener("click", () => regenSection(section));
  const up = document.createElement("button");
  up.type = "button";
  up.className = "rtool rtool-upgrade";
  up.textContent = "🔬 정밀 분석으로 업그레이드";
  up.addEventListener("click", upgradeToFull);
  row.append(one, up);
  box.append(p, row);
  panel.appendChild(box);
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
  // P4: 긴 세미나(섹션 4개↑)엔 sticky 미니 목차 — 현재 위치 표시 + 클릭 점프
  attachMiniToc(panel, [...panel.querySelectorAll(".sem-section")].map((el, i) => ({
    el,
    label: (arr[i] && (String(arr[i].section || "").trim() || (arr[i].title || "").slice(0, 10))) || String(i + 1),
    title: el.querySelector(".sem-title")?.textContent || "",
  })));
}

// ---------- P4: 긴 탭 미니 목차 (세미나 정리 · 정밀 강독 공용) ----------
// 섹션이 4개 이상일 때만 패널 상단에 sticky 칩 바를 붙인다. IntersectionObserver로
// 현재 읽는 섹션을 하이라이트, 클릭 시 그 섹션으로 스크롤.
function attachMiniToc(panel, targets) {
  panel.querySelector(".mini-toc")?.remove();
  const valid = (targets || []).filter((t) => t && t.el);
  if (valid.length < 4) return;
  const bar = document.createElement("nav");
  bar.className = "mini-toc";
  bar.setAttribute("aria-label", "섹션 목차");
  valid.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini-toc-item";
    b.textContent = t.label;
    b.title = t.title || t.label;
    b.addEventListener("click", () => {
      // sticky 바 높이만큼 여유를 두고 섹션 상단으로
      const y = t.el.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - 60;
      window.scrollTo({ top: y, behavior: "smooth" });
    });
    bar.appendChild(b);
  });
  panel.prepend(bar);
  const io = new IntersectionObserver((ents) => {
    // 화면 상단 1/3에 걸친 섹션을 현재로 표시
    for (const ent of ents) {
      if (!ent.isIntersecting) continue;
      const idx = valid.findIndex((t) => t.el === ent.target);
      if (idx < 0) continue;
      bar.querySelectorAll(".mini-toc-item").forEach((x, j) => x.classList.toggle("on", j === idx));
      const on = bar.children[idx];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, { rootMargin: "-15% 0px -65% 0px" });
  valid.forEach((t) => io.observe(t.el));
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
  // bbox가 없어도 label+page만 있으면 요청한다 — 서버의 실측 레이어(캡션·이미지·잉크)가
  // 모델 bbox 없이 위치를 찾는다(모델 bbox는 어차피 힌트일 뿐).
  const bbox =
    Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox.every((n) => Number.isFinite(Number(n)))
      ? f.bbox.map(Number)
      : f.label ? [0.05, 0.05, 0.95, 0.95] : null; // 페이지 전체를 힌트로 — 서버가 좁혀 잡는다
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

// PDF.js 문서 정리 — 워커가 쥔 이전 논문 데이터·폰트를 해제(논문 전환 시 메모리 누적 방지)
function destroyPdfDoc(doc) {
  if (!doc) return;
  try {
    const p = doc.destroy();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

async function loadPdf(hash) {
  pdfMissing.classList.add("hidden");
  pdfScroll.classList.add("hidden");
  pdfAvailable = false;
  destroyPdfDoc(pdfDoc); // 이전 논문 문서 해제
  pdfDoc = null;
  pdfPageEls.clear();
  pdfScroll.innerHTML = "";
  resetPdfSearch(); // 이전 논문 검색 인덱스·UI 초기화
  const token = ++pdfRenderToken;
  if (!hash) return pdfMissing.classList.remove("hidden");

  try {
    const head = await fetch(`${API_BASE}/api/pdf/${hash}`, { method: "HEAD" });
    if (!head.ok) throw new Error("no pdf");
    if (typeof pdfjsLib === "undefined") throw new Error("pdfjs 미로딩");

    const doc = await pdfjsLib.getDocument(`${API_BASE}/api/pdf/${hash}`).promise;
    if (token !== pdfRenderToken) { destroyPdfDoc(doc); return; } // 그 사이 다른 논문으로 전환됨
    pdfDoc = doc;
    pdfAvailable = true;
    pdfScroll.classList.remove("hidden");

    // 1페이지 크기로 폭에 맞춘 스케일 계산 + 모든 페이지 placeholder 생성(렌더는 지연)
    const first = await doc.getPage(1);
    if (token !== pdfRenderToken) { destroyPdfDoc(doc); return; } // getPage 대기 중 전환 — 옛 placeholder가 새 목록에 섞이지 않게
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
        const wrap = e.target;
        if (e.isIntersecting) {
          renderPdfPage(Number(wrap.dataset.page), token);
        } else if (wrap.dataset.rendered) {
          // 화면(±400px)을 벗어난 페이지의 캔버스 회수 — 긴 논문에서 페이지당 ~10MB씩
          // 무한히 쌓이는 것 방지. 다시 들어오면 observer가 재렌더한다.
          wrap.style.height = `${wrap.offsetHeight}px`; // 스크롤 위치 유지용 placeholder 높이
          wrap.innerHTML = "";
          delete wrap.dataset.rendered;
        }
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
    // 이 로드가 아직 최신일 때만 'PDF 없음' 표시 — 옛 로드의 실패가 새 논문 화면을 덮지 않게
    if (token === pdfRenderToken) pdfMissing.classList.remove("hidden");
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
// ---------- PDF 내 텍스트 검색 (🔍 / 단축키 S) ----------
// 페이지별 텍스트를 지연 캐시하고, 매치 목록(페이지+스니펫)을 보여준다.
// 클릭 시 jumpToPdfPageText 재사용(페이지 이동 + ✓ 표시).
let pdfTextCache = new Map(); // page -> 공백 정규화 텍스트
let pdfSearchToken = 0; // 논문 전환/재검색 시 진행 중 검색 무효화
function resetPdfSearch() {
  pdfTextCache = new Map();
  pdfSearchToken++;
  const bar = document.getElementById("pdf-search-bar");
  if (bar) {
    bar.classList.add("hidden");
    document.getElementById("pdf-search-input").value = "";
    document.getElementById("pdf-search-count").textContent = "";
    const list = document.getElementById("pdf-search-results");
    list.innerHTML = "";
    list.classList.add("hidden");
  }
}
async function pdfPageTextOf(n) {
  if (pdfTextCache.has(n)) return pdfTextCache.get(n);
  const page = await pdfDoc.getPage(n);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => it.str || "").join(" ").replace(/\s+/g, " ");
  pdfTextCache.set(n, text);
  return text;
}
async function runPdfSearch(q) {
  const token = ++pdfSearchToken;
  const list = document.getElementById("pdf-search-results");
  const count = document.getElementById("pdf-search-count");
  list.innerHTML = "";
  list.classList.add("hidden");
  if (!pdfDoc || !q || q.trim().length < 2) { count.textContent = q ? "2자 이상" : ""; return; }
  count.textContent = "검색 중…";
  const needle = q.trim().toLowerCase();
  const results = [];
  const MAXR = 60;
  for (let n = 1; n <= pdfDoc.numPages && results.length < MAXR; n++) {
    let text;
    try { text = await pdfPageTextOf(n); } catch { continue; }
    if (token !== pdfSearchToken) return; // 그 사이 새 검색/논문 전환
    const lower = text.toLowerCase();
    let from = 0, i;
    while ((i = lower.indexOf(needle, from)) >= 0 && results.length < MAXR) {
      results.push({
        page: n,
        // 매치 주변 문맥 스니펫 + 점프 앵커(매치 시작부터 40자 — findTextPos가 위치를 찾는다)
        pre: text.slice(Math.max(0, i - 26), i),
        hit: text.slice(i, i + needle.length),
        post: text.slice(i + needle.length, i + needle.length + 26),
        anchor: text.slice(i, i + 40),
      });
      from = i + needle.length;
    }
  }
  if (token !== pdfSearchToken) return;
  count.textContent = results.length ? `${results.length}건${results.length >= MAXR ? "+" : ""}` : "결과 없음";
  if (!results.length) return;
  results.forEach((r) => {
    const li = document.createElement("li");
    const pg = document.createElement("span");
    pg.className = "psr-page";
    pg.textContent = `p.${r.page}`;
    const tx = document.createElement("span");
    tx.className = "psr-text";
    tx.append(document.createTextNode(r.pre));
    const b = document.createElement("b");
    b.textContent = r.hit;
    tx.append(b, document.createTextNode(r.post));
    li.append(pg, tx);
    li.addEventListener("click", () => jumpToPdfPageText(r.page, r.anchor));
    list.appendChild(li);
  });
  list.classList.remove("hidden");
}
(function initPdfSearch() {
  const bar = document.getElementById("pdf-search-bar");
  const input = document.getElementById("pdf-search-input");
  let debounce = 0;
  const open = () => {
    if (!pdfAvailable) return showError("이 논문의 원문 PDF가 저장돼 있지 않아 검색할 수 없습니다.");
    workspaceEl.classList.remove("pdf-collapsed"); // 접힌 패널이면 펼친다
    document.getElementById("pdf-toggle").textContent = "접기 ◀";
    bar.classList.remove("hidden");
    input.focus();
    input.select();
  };
  document.getElementById("pdf-search-toggle").addEventListener("click", () => {
    if (bar.classList.contains("hidden")) open();
    else bar.classList.add("hidden");
  });
  document.getElementById("pdf-search-close").addEventListener("click", () => bar.classList.add("hidden"));
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runPdfSearch(input.value), 350);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounce); runPdfSearch(input.value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); bar.classList.add("hidden"); }
  });
  window.openPdfSearch = open; // 단축키(S)에서 호출
})();

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
  // 진행 중이던 분석/재생성/채팅 답변을 중단(N 단축키로도 호출되므로 사용량 누수 방지)
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; }
  if (chatAbort) chatAbort.abort();
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
    // arXiv 링크가 있으면 원클릭 분석 — 선행 논문 따라 읽기 흐름을 잇는다
    if (p.link && /arxiv\.org\/(abs|pdf)\//i.test(p.link)) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "rel-analyze";
      go.textContent = "📥 이 논문도 분석";
      go.title = "arXiv에서 PDF를 받아 바로 분석합니다";
      go.addEventListener("click", () => analyzeUrl(p.link, p.title));
      li.appendChild(go);
    }
    list.appendChild(li);
  });
  box.classList.remove("hidden");
}

// ── arXiv URL로 바로 분석 (관련 논문 버튼·랜딩 화면 URL 붙여넣기 공용) ──────────
async function analyzeUrl(url, title) {
  hideError();
  const mode = await showModeDialog(title || url.replace(/^https?:\/\//, ""), null);
  if (!mode) return;
  ensureNotifyPermission();

  workspaceEl.classList.add("hidden");
  loadingEl.classList.remove("hidden");
  setActiveAnalysis(title || "arXiv 논문");
  resetLoadingProgress();
  setLoadingProgress("arXiv에서 PDF를 내려받는 중…", 0);

  const ac = beginCancellable();
  try {
    const res = await fetch(`${API_BASE}/api/analyze-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error(formatApiError(data, res.status));
    }
    const data = await consumeAnalysisStream(res);
    if (analysisPartialShown) {
      const keep = activeTab;
      renderResult(data);
      switchTab(keep);
    } else {
      renderResult(data);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    loadHistory();
  } catch (e) {
    if (e.name !== "AbortError") showError(e.message);
    workspaceEl.classList.toggle("hidden", !currentHash);
  } finally {
    if (endCancellable(ac)) {
      loadingEl.classList.add("hidden");
      hideReanalyzeBanner();
      setActiveAnalysis(null);
    }
  }
}

// 랜딩 화면(드롭존 표시 중)에서 arXiv URL 붙여넣기 → 바로 분석 제안
document.addEventListener("paste", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "") ||
    document.activeElement?.isContentEditable;
  if (typing) return; // 입력창 붙여넣기는 그대로 둔다
  const text = (e.clipboardData?.getData("text/plain") || "").trim();
  if (!/arxiv\.org\/(abs|pdf)\//i.test(text)) return;
  e.preventDefault();
  analyzeUrl(text, null);
});

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

// 워크스페이스 패널 폭 조절 (PDF ↔ 결과 드래그). --pdf-w(px)를 workspace에 설정, localStorage 저장.
// HTML 시각화 iframe·JSON 렌더러 모두 width:100%라 이 폭 변화를 자동으로 따라간다.
(() => {
  const handle = document.getElementById("ws-resize");
  const workspace = document.getElementById("workspace");
  if (!handle || !workspace) return;
  const MIN_PDF = 220, HANDLE = 24, MIN_RESULT = 300, PAD = 48; // padding 0 24px 양쪽
  const maxPdf = () => Math.max(MIN_PDF, workspace.clientWidth - PAD - HANDLE - MIN_RESULT);
  const apply = (px) => workspace.style.setProperty("--pdf-w", Math.round(px) + "px");
  // 로드 시 복원 — 현재 폭 대비 클램프
  const saved = Number(localStorage.getItem("wsPdfWidth"));
  if (saved >= MIN_PDF) { const m = maxPdf(); if (saved <= m) apply(saved); }
  handle.addEventListener("pointerdown", (e) => {
    if (workspace.classList.contains("pdf-collapsed")) return; // 접힘 상태에선 비활성
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("ws-resizing");
    const onMove = (ev) => {
      const wsRect = workspace.getBoundingClientRect();
      const px = Math.min(maxPdf(), Math.max(MIN_PDF, ev.clientX - (wsRect.left + 24)));
      apply(px);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("ws-resizing");
      const cur = getComputedStyle(workspace).getPropertyValue("--pdf-w").trim();
      if (cur.endsWith("px")) localStorage.setItem("wsPdfWidth", String(parseInt(cur, 10)));
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
  div.dataset.text = typeof text === "string" ? text : String(text == null ? "" : text);
  renderRich(div, text);
  // P10: 답변 버블에 [📌 메모] — 좋은 답변을 개인 메모로 스크랩 (hover 시 표시)
  if (role === "a" && typeof text === "string" && text.trim()) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "chat-pin";
    pin.textContent = "📌";
    pin.title = "이 답변을 개인 메모에 저장";
    pin.addEventListener("click", async () => {
      if (!currentHash) return;
      try {
        if (notesHashLoaded !== currentHash) await loadNotes(currentHash); // 다른 논문 메모 오염 방지
        const raw = div.dataset.text.trim();
        notesState.notes = (notesState.notes ? notesState.notes + "\n\n" : "") + `📌 [챗 답변] ${raw}`;
        document.getElementById("notes-text").value = notesState.notes;
        await saveNotes(currentHash, notesState);
        pin.textContent = "✓";
        setTimeout(() => { pin.textContent = "📌"; }, 1500);
      } catch (e) {
        pin.textContent = "⚠️";
        setTimeout(() => { pin.textContent = "📌"; }, 1500);
      }
    });
    div.appendChild(pin);
  }
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
  // 시작 시점의 논문·기록을 고정 — 답변 대기 중 다른 논문으로 전환해도
  // 답변이 '원래 논문'의 기록에 남고, 새 논문의 화면·기록을 오염시키지 않는다.
  const startedHash = currentHash;
  const hist = chatHistory;
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
    const res = await fetch(`${API_BASE}/api/ask/${startedHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 서버는 최근 몇 개만 컨텍스트로 쓰므로 전체 기록을 매번 보내지 않는다
      body: JSON.stringify({ question: q, history: hist.slice(-8) }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    const answer = await consumeChatStream(res, thinking); // 진행 단계 표시 → 최종 답변
    thinking.remove(); // 논문이 바뀌어 DOM에서 이미 사라졌어도 무해
    hist.push({ q, a: answer });
    if (hist.length > 50) hist.splice(0, hist.length - 50); // 서버 저장 한도와 동일하게 유지
    if (currentHash === startedHash) appendChat("a", answer); // 같은 논문을 보고 있을 때만 화면에 표시
  } catch (err) {
    thinking.remove();
    if (currentHash === startedHash) {
      if (err.name === "AbortError") {
        const note = document.createElement("div");
        note.className = "chat-note";
        note.textContent = "⏹ 답변 생성을 멈췄어요.";
        chatMessages.appendChild(note);
      } else {
        appendChat("a", "⚠️ " + err.message);
      }
    }
  } finally {
    chatAbort = null;
    setChatBusy(false);
    if (currentHash === startedHash) {
      refreshQuestionActions(); // 마지막 질문 아래에 수정·복사·다시 보내기 부착
      chatInput.focus();
    }
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

// 채팅 SSE 소비: delta(답변 토큰)를 타자기처럼 라이브 렌더, step(진행 단계)은
// 라이브 텍스트를 비우고 '생각 중' 표시로 전환(도구 사용 전 중간 코멘트 정리),
// 최종 answer(권위본)를 반환한다.
async function consumeChatStream(res, thinkingEl) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let answer = null;
  let live = ""; // 현재 턴에서 흘러온 답변 텍스트
  let lastPaint = 0;
  const paintLive = (force) => {
    const now = performance.now();
    if (!force && now - lastPaint < 120) return; // 렌더 스로틀(KaTeX 비용)
    lastPaint = now;
    const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 60;
    renderRich(thinkingEl, live + " ▍");
    if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
  };
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
      if (ev.type === "delta") { live += ev.text; paintLive(false); }
      else if (ev.type === "step") { live = ""; setThinking(thinkingEl, ev.msg); } // 도구 사용 = 그 전 텍스트는 중간 코멘트
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
/* method_viz_html: 논문당 독립 실행형 HTML 시각화(viz_guideline.md 산출물)를
   sandboxed iframe(srcdoc)으로 격리 렌더. CSS/JS 충돌 없이, §2.8 리사이즈 호환
   (width:100% + 내부 SVG viewBox)을 만족한다. 높이는 부모가 내부 문서를 실측해 맞춘다. */
// 시각화 HTML(iframe 콘텐츠)에 내부 리사이즈 핸들을 주입한다 — 생성물 재생성 없이
// 서비스 레벨에서 일괄 적용. (1) .cols의 좌↔우(구조도↔여정) 세로 분할, (2) .lab/.compare
// 실험실의 상하 높이 조절. 클래스명이 타입별로 달라 .cols의 자식 기준으로 견고하게 건다.
function injectMvizResizers(html) {
  const inject =
    "<style>" +
    ".__mvz-vdiv{flex:0 0 20px;align-self:stretch;cursor:col-resize;display:flex;align-items:center;justify-content:center;touch-action:none;}" +
    ".__mvz-vdiv::after{content:'';width:3px;height:46px;border-radius:2px;background:#e8ddd4;transition:background .12s,height .12s;}" +
    ".__mvz-vdiv:hover::after{background:#8c2f39;height:70px;}" +
    ".__mvz-hdiv{height:14px;cursor:row-resize;display:flex;align-items:center;justify-content:center;touch-action:none;margin:6px 0 2px;}" +
    ".__mvz-hdiv::after{content:'';height:3px;width:66px;border-radius:2px;background:#e8ddd4;transition:background .12s,width .12s;}" +
    ".__mvz-hdiv:hover::after{background:#8c2f39;width:100px;}" +
    "body.__mvz-rz{user-select:none;}" +
    "</style>" +
    "<script>(function(){function ready(f){if(document.readyState!=='loading')f();else document.addEventListener('DOMContentLoaded',f);}" +
    "function drag(handle,onMove){handle.addEventListener('pointerdown',function(e){e.preventDefault();try{handle.setPointerCapture(e.pointerId);}catch(_){}" +
    "document.body.classList.add('__mvz-rz');var mv=function(ev){onMove(ev);};" +
    "var up=function(){try{handle.releasePointerCapture(e.pointerId);}catch(_){}handle.removeEventListener('pointermove',mv);handle.removeEventListener('pointerup',up);document.body.classList.remove('__mvz-rz');};" +
    "handle.addEventListener('pointermove',mv);handle.addEventListener('pointerup',up);});}" +
    "ready(function(){" +
    "var cols=document.querySelector('.cols');" +
    "if(cols){var kids=[].slice.call(cols.children).filter(function(c){return c.nodeType===1;});" +
    "if(kids.length>=2){var left=kids[0];cols.style.gap='0';var vd=document.createElement('div');vd.className='__mvz-vdiv';cols.insertBefore(vd,kids[1]);" +
    "var sx,sw,cw;vd.addEventListener('pointerdown',function(e){sx=e.clientX;sw=left.getBoundingClientRect().width;cw=cols.getBoundingClientRect().width;});" +
    "drag(vd,function(ev){var w=Math.max(200,Math.min(cw-220,sw+(ev.clientX-sx)));left.style.flex='0 0 '+w+'px';});}}" +
    "var lab=document.querySelector('.lab, .compare');" +
    "if(lab){lab.style.overflow='auto';var hd=document.createElement('div');hd.className='__mvz-hdiv';if(lab.parentNode)lab.parentNode.insertBefore(hd,lab.nextSibling);" +
    "var sy,sh;hd.addEventListener('pointerdown',function(e){sy=e.clientY;sh=lab.getBoundingClientRect().height;});" +
    "drag(hd,function(ev){var h=Math.max(120,sh+(ev.clientY-sy));lab.style.height=h+'px';});}" +
    "});})();<\/script>";
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, inject + "</body>") : html + inject;
}

function buildMethodVizFrame(html) {
  const frame = document.createElement("iframe");
  frame.className = "method-viz-frame";
  frame.title = "연구 방법론 인터랙티브 시각화";
  // allow-scripts + allow-same-origin: 콘텐츠는 외부 요청 없는 1st-party 자체완결 HTML이라
  // 높이 실측(contentDocument 접근)을 위해 동일출처를 허용한다. 정적 서빙되는 우리 산출물만 들어온다.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("scrolling", "no");
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.display = "block";
  frame.style.height = "620px"; // 초기값 — 로드 후 실측 높이로 교체
  frame.srcdoc = injectMvizResizers(html);
  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      // 축소도 반영하려면 먼저 높이를 줄여 뷰포트 클램프를 없앤 뒤 body 실제 콘텐츠 높이를 잰다.
      // (높이만 0으로 — 폭은 100% 유지되므로 리플로우 없음.)
      frame.style.height = "0px";
      const raw = doc.body.scrollHeight;
      frame.style.height = (raw > 0 ? Math.max(280, Math.min(6000, raw)) : 620) + "px";
    } catch (e) {}
  };
  let innerRO = null, ro = null;
  frame.addEventListener("load", () => {
    fit();
    [120, 400, 900, 1800].forEach((t) => setTimeout(fit, t)); // 폰트·rAF·2단계 애니메이션 정착 후 재측정
    // 내부 body 크기 변화(폭 리플로우·애니메이션)를 내부 window의 ResizeObserver로 관측해 높이 반영.
    // (부모 RO로 자식 문서 요소를 관측하면 문서 경계에서 불안정 — 내부 생성자를 쓴다.)
    try {
      const win = frame.contentWindow, doc = frame.contentDocument;
      if (win && win.ResizeObserver && doc && doc.body) { innerRO = new win.ResizeObserver(fit); innerRO.observe(doc.body); }
    } catch (e) {}
  });
  // iframe 박스 폭이 바뀌면(패널 리사이즈) 재측정 — 리플로우 정착을 위해 지연 재측정도 건다.
  try {
    if (window.ResizeObserver) {
      let lastW = 0;
      ro = new ResizeObserver(() => { const w = frame.clientWidth; if (w && w !== lastW) { lastW = w; fit(); setTimeout(fit, 160); setTimeout(fit, 520); } });
      ro.observe(frame);
    }
  } catch (e) {}
  _mvizHtmlCleanup = () => { if (ro) { try { ro.disconnect(); } catch (e) {} } if (innerRO) { try { innerRO.disconnect(); } catch (e) {} } };
  return frame;
}

function renderMethod(data) {
  const panel = document.getElementById("panel-method");
  if (activeMethodViz) { activeMethodViz.destroy(); activeMethodViz = null; } // 이전 애니메이션·타이머 정리
  if (_mvizHtmlCleanup) { try { _mvizHtmlCleanup(); } catch (e) {} _mvizHtmlCleanup = null; } // 이전 iframe 높이 리스너 정리
  panel.innerHTML = "";

  // 최우선: 타입별 독립 HTML 시각화(method_viz_html) — 있으면 iframe으로 렌더
  let vizEl = null;
  if (data.method_viz_html && typeof data.method_viz_html === "string" && data.method_viz_html.trim()) {
    try { vizEl = buildMethodVizFrame(data.method_viz_html); } catch (e) { console.error("[method viz HTML 렌더 실패 — 폴백]", e); vizEl = null; }
  }
  // 차선: 인터랙티브 2.5D 파이프라인 (method_visualization) JSON 렌더러
  if (!vizEl && data.method_visualization) {
    try { vizEl = buildMethodViz(data.method_visualization); } catch (e) { console.error("[method viz 렌더 실패 — 폴백]", e); vizEl = null; }
  }
  if (vizEl) {
    panel.appendChild(vizEl);
  } else {
    // 구버전 분석(figures/architecture) 호환 폴백
    const figures = Array.isArray(data.figures)
      ? data.figures
      : data.architecture && Array.isArray(data.architecture.flow)
        ? [{ type: "flow", ...data.architecture, title: "모델 아키텍처" }]
        : [];
    figures.forEach((f) => {
      const el = buildFigure(f);
      if (el) panel.appendChild(el);
    });
    // 부분 선렌더: 시각화가 아직 구워지는 중 — 완료되면 자동으로 이 자리에 나타남
    if (data.viz_pending) {
      const note = document.createElement("p");
      note.className = "muted simple-viz-note";
      note.textContent = "⏳ 인터랙티브 시각화를 생성하는 중입니다 (약 5분) — 완료되면 자동으로 여기에 표시돼요. 다른 탭은 지금 읽을 수 있습니다.";
      panel.appendChild(note);
    } else if (!figures.length && data.analysis_mode === "simple") {
      // 간단 분석: 시각화가 원래 없음을 알리고 채우는 경로를 안내
      const note = document.createElement("p");
      note.className = "muted simple-viz-note";
      note.textContent = "⚡ 간단 분석에는 인터랙티브 시각화가 없습니다 — 정밀 분석으로 업그레이드하거나, 이 탭의 \"이 섹션 다시 생성\"으로 시각화만 만들 수 있어요.";
      panel.appendChild(note);
    }
  }

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

  // 🔬 정밀 강독 — 원문 방법 섹션을 서브섹션 구조 그대로 따라가는 주해식 해설 (온디맨드)
  panel.appendChild(buildMethodDeepBlock(data));
}

// ---------- 방법론 정밀 강독 (method_deep) ----------
// 있으면 렌더(접이식·원문 점프), 없으면 [생성] 버튼. 생성은 SSE로 진행 표시 후
// 서버가 analysis.method_deep에 영구 저장 → 이 블록만 다시 그린다.
let methodDeepBusy = false;
function buildMethodDeepBlock(data) {
  const wrap = document.createElement("section");
  wrap.className = "mdeep";
  wrap.id = "mdeep-block";
  const deep = data.method_deep;

  const head = document.createElement("div");
  head.className = "mdeep-head";
  const title = document.createElement("h3");
  title.className = "mdeep-title";
  title.textContent = "🔬 정밀 강독";
  const sub = document.createElement("span");
  sub.className = "mdeep-sub muted";
  sub.textContent = "원문 방법 섹션을 강독하듯 문단 요지 + 주해로 풀어냅니다";
  head.append(title, sub);
  wrap.appendChild(head);

  if (deep && Array.isArray(deep.sections) && deep.sections.length) {
    const secEls = []; // P4 미니 목차용
    deep.sections.forEach((s) => {
      const det = document.createElement("details");
      det.className = "mdeep-sec";
      secEls.push(det);
      det.open = true; // 기본 펼침 — "읽은 것처럼" 이어지는 흐름
      const sum = document.createElement("summary");
      sum.className = "mdeep-ref";
      sum.textContent = s.ref || "(제목 없음)";
      if (s.page) {
        const pg = document.createElement("button");
        pg.type = "button";
        pg.className = "mdeep-page";
        pg.textContent = `p.${s.page} ↗`;
        pg.title = "원문의 이 섹션으로 이동";
        pg.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation(); // summary 접힘 방지
          jumpToPdfPageText(s.page, (s.ref || "").replace(/^[\d.\s]+/, "").slice(0, 30));
        });
        sum.appendChild(pg);
      }
      const body = document.createElement("div");
      body.className = "mdeep-body";
      renderRich(body, s.body || "");
      det.append(sum, body);
      wrap.appendChild(det);
    });
    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "rtool mdeep-btn";
    regen.textContent = "🔄 강독 다시 생성";
    regen.addEventListener("click", () => generateMethodDeep(wrap, true));
    wrap.appendChild(regen);
    // P4: 서브섹션 4개↑면 미니 목차 (제목 줄 바로 아래로 이동)
    attachMiniToc(wrap, deep.sections.map((s, i) => ({
      el: secEls[i],
      label: String(s.ref || i + 1).split(/\s+/)[0].slice(0, 8) || String(i + 1),
      title: s.ref || "",
    })));
    const tocBar = wrap.querySelector(".mini-toc");
    if (tocBar) wrap.insertBefore(tocBar, head.nextSibling);
  } else {
    const desc = document.createElement("p");
    desc.className = "muted mdeep-desc";
    desc.textContent = "단계 요약보다 깊게 — 원문 3.1→3.2 구조를 그대로 따라가며 수식 풀이·기호 정의·설계 의도까지 해설합니다. 원문에서 방법 섹션만 다시 읽어 생성해요.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rtool mdeep-btn";
    btn.textContent = "🔬 정밀 강독 생성 (2~3분)";
    btn.addEventListener("click", () => generateMethodDeep(wrap, false));
    wrap.append(desc, btn);
  }
  return wrap;
}
async function generateMethodDeep(wrap, force) {
  if (!currentHash || methodDeepBusy) return;
  if (force && !confirm("정밀 강독을 다시 생성할까요? (2~3분, 기존 강독을 교체)")) return;
  methodDeepBusy = true;
  const startedHash = currentHash;
  // 진행 표시: 버튼 자리에 상태줄
  wrap.querySelectorAll(".mdeep-btn, .mdeep-desc").forEach((el) => el.remove());
  const stat = document.createElement("p");
  stat.className = "mdeep-stat";
  stat.textContent = "⏳ 준비 중…";
  wrap.appendChild(stat);
  try {
    const res = await fetch(`${API_BASE}/api/method-deep/${startedHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      const d = await safeJson(res);
      throw new Error((d && d.error) || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", chars = 0, data = null, lastStep = "생성 중";
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
        if (ev.type === "step") { lastStep = ev.msg; stat.textContent = `⏳ ${lastStep}`; }
        else if (ev.type === "delta") { chars += ev.text.length; stat.textContent = `⏳ ${lastStep} (${chars.toLocaleString()}자 작성)`; }
        else if (ev.type === "result") data = ev.data;
        else if (ev.type === "error") throw new Error(ev.error);
      }
    }
    if (!data) throw new Error("서버 연결이 중간에 끊어졌습니다.");
    if (currentHash !== startedHash) return; // 그 사이 다른 논문으로 이동
    currentAnalysis.method_deep = data;
    const fresh = buildMethodDeepBlock(currentAnalysis);
    wrap.replaceWith(fresh);
  } catch (e) {
    stat.textContent = `⚠️ ${e.message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "rtool mdeep-btn";
    retry.textContent = "🔬 다시 시도";
    retry.addEventListener("click", () => { stat.remove(); retry.remove(); generateMethodDeep(wrap, force); });
    wrap.appendChild(retry);
  } finally {
    methodDeepBusy = false;
  }
}

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
  markTabSeen(name); // P9: 읽음 점 + 마지막 탭 기억
}

// ---------- P9: 읽던 자리 복원 + 읽음 표시 ----------
// 논문별로 {tab(마지막 탭), y(스크롤), seen(방문 탭)}을 localStorage에 남겨,
// 다시 열면 읽던 곳부터. 방문한 탭 버튼엔 작은 점(·)이 붙는다.
function readPos(hash) {
  try { return JSON.parse(localStorage.getItem(`read-pos:${hash}`) || "null") || {}; } catch { return {}; }
}
function saveReadPos(hash, patch) {
  if (!hash) return;
  try {
    const cur = readPos(hash);
    localStorage.setItem(`read-pos:${hash}`, JSON.stringify({ ...cur, ...patch }));
  } catch {}
}
function markTabSeen(name) {
  if (!currentHash) return;
  const cur = readPos(currentHash);
  const seen = new Set(Array.isArray(cur.seen) ? cur.seen : []);
  seen.add(name);
  saveReadPos(currentHash, { tab: name, seen: [...seen] });
  paintSeenDots(seen);
}
function paintSeenDots(seenSet) {
  document.querySelectorAll("#tabs .tab").forEach((t) =>
    t.classList.toggle("tab-seen", seenSet.has(t.dataset.tab))
  );
}
// 스크롤 위치 저장(디바운스) — 읽는 중에만
let _readScrollTimer = 0;
window.addEventListener("scroll", () => {
  if (!currentHash || !document.body.classList.contains("reading")) return;
  clearTimeout(_readScrollTimer);
  _readScrollTimer = setTimeout(() => saveReadPos(currentHash, { y: Math.round(window.scrollY) }), 400);
}, { passive: true });

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
    refreshYearOptions(); // 연도 필터 옵션을 목록 데이터로 갱신
    renderHistory();
    if (typeof refreshCompareButton === "function") refreshCompareButton(); // 비교 대상 유무 반영
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
  const matches = (it) =>
    (!f || ((it.title || "") + " " + (it.one_liner || "")).toLowerCase().includes(f)) &&
    (historyModeFilter === "all" || (it.analysis_mode || "full") === historyModeFilter) &&
    (!historyYearFilter || String(it.year) === String(historyYearFilter));
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
  if (it.analysis_mode === "simple") {
    const b = document.createElement("span");
    b.className = "h-mode";
    b.title = "간단 분석 (4개 섹션)";
    b.textContent = "⚡ 간단";
    title.appendChild(b);
  }
  const line = document.createElement("div");
  line.className = "h-line";
  renderRich(line, it.one_liner || "");
  const date = document.createElement("div");
  date.className = "h-date";
  date.textContent = it.createdAt ? new Date(it.createdAt).toLocaleString("ko-KR") : "";
  // 제목 아래: 학회/저널 · 연도 (있을 때만)
  const venueText = [it.venue, it.year].filter((v) => v != null && String(v).trim() !== "").join(" · ");
  const parts = [title, line];
  if (venueText) {
    const venue = document.createElement("div");
    venue.className = "h-venue";
    venue.textContent = venueText;
    parts.push(venue);
  }
  parts.push(date);
  li.append(...parts);
  li.addEventListener("click", () => openHistory(it.hash));
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", it.hash);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  // 원문 PDF 파일 열기 (새 탭)
  const pdf = document.createElement("button");
  pdf.type = "button";
  pdf.className = "h-del h-pdf";
  pdf.title = "원문 PDF 파일 열기";
  pdf.textContent = "📄";
  pdf.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open(`${API_BASE}/api/pdf/${it.hash}`, "_blank", "noopener");
  });
  li.appendChild(pdf);

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
  re.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`'${it.title}'을(를) 최신 분석 방식으로 재분석할까요?\n(몇 분 걸리며, 기존 결과는 대체됩니다)`)) return;
    reanalyzePaper(it.hash, it.title); // 기본 정밀(full) — 기존 🔄 동작 그대로
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

// 재분석 공용 흐름 — 히스토리 🔄(정밀 기본)와 [정밀 분석으로 업그레이드]가 공유.
// 보고 있는 논문이면 화면을 비우지 않고 상단 배너만(읽던 내용 유지), 아니면 로딩 화면.
async function reanalyzePaper(hash, title, opts = {}) {
  const mode = opts.mode === "simple" ? "simple" : "full";
  hideError();
  ensureNotifyPermission(); // 재분석/업그레이드 클릭 제스처 직후 — 완료 알림 권한
  const inline = hash === currentHash && !workspaceEl.classList.contains("hidden");
  if (inline) {
    showReanalyzeBanner();
    if (opts.bannerText) document.getElementById("rebar-text").textContent = opts.bannerText;
  } else {
    workspaceEl.classList.add("hidden");
    loadingEl.classList.remove("hidden");
    setLoadingProgress(opts.bannerText || "재분석을 시작하는 중…", 0);
  }
  setActiveAnalysis(title || "재분석");
  const ac = beginCancellable();
  try {
    const res = await fetch(`${API_BASE}/api/reanalyze/${hash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const d = await safeJson(res);
      throw new Error((d && d.error) || `HTTP ${res.status}`);
    }
    const data = await consumeAnalysisStream(res);
    if (analysisPartialShown) {
      const keep = activeTab;
      renderResult(data);
      switchTab(keep);
    } else {
      renderResult(data);
    }
    loadHistory();
    if (!inline && !analysisPartialShown) window.scrollTo({ top: 0, behavior: "smooth" });
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
}

// 간단 → 정밀 업그레이드 (v1: 전체 재분석 — 서버가 간단 기록의 분석 시각을 보존한다)
function upgradeToFull() {
  if (!currentHash || !currentAnalysis) return;
  if (!confirm("정밀 분석으로 업그레이드할까요?\n(전체 7개 섹션 + 인터랙티브 시각화를 새로 생성 — 몇 분 걸립니다)")) return;
  reanalyzePaper(currentHash, currentAnalysis.title || "업그레이드", {
    mode: "full",
    bannerText: "정밀 분석으로 업그레이드 중…",
  });
}
document.getElementById("tool-upgrade").addEventListener("click", upgradeToFull);

async function openHistory(hash) {
  hideError();
  // 저장된 결과 열람은 취소 대상이 아니다. 진행 중이던 분석이 있으면 취소하고(사용자가 다른 글로 이동),
  // 취소 버튼은 숨긴다 — 이 fetch는 취소 버튼이 제어하지 않으므로 엉뚱한 중단을 막는다.
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; } // 진행 중 섹션 재생성 중단
  cancelBtn.classList.add("hidden");
  setActiveAnalysis(null); // 취소된 흐름의 '분석 중' 표시 정리 — 여기서 컨트롤러를 비웠으므로 그쪽 finally는 건너뜀
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
// ── P7: 채팅 진입 시 '지금 보던 탭' 맥락 추천 칩 ─────────────────────────────
// 기록이 비어 있을 때만, 추천 질문 칩 줄(.chat-chips — renderChatLog가 생성)에
// activeTab에 맞는 질문 1개를 덧붙인다. 첫 질문 전송 시 askQuestion이 칩 줄을 통째로 지운다.
const CHAT_CTX_QUESTIONS = {
  seminar: "발표에서 이 논문을 3문장으로 요약한다면 어떻게 말해야 할까?",
  background: "이 논문 직전까지 이 분야의 흐름을 한 단락으로 정리해줘",
  problem: "기존 방법들이 못 풀던 문제가 정확히 뭐야?",
  method: "이 방법의 핵심 아이디어를 한 문장으로 말하면?",
  results: "가장 중요한 실험 결과 하나만 꼽으면 뭐고, 왜 그게 중요해?",
  equations: "핵심 수식의 유도 과정을 차근차근 설명해줘",
  figures: "가장 중요한 그림 하나를 골라 어떻게 읽는지 설명해줘",
};
function ensureChatContextChip() {
  if (!currentHash || chatHistory.length) return; // 이미 대화가 있으면 안 띄움
  const q = CHAT_CTX_QUESTIONS[activeTab];
  if (!q) return;
  let chips = chatMessages.querySelector(".chat-chips");
  if (!chips) {
    chips = document.createElement("div");
    chips.className = "chat-chips";
    chatMessages.appendChild(chips);
  }
  // 탭을 오가며 여러 번 열어도 맥락 칩은 항상 1개 — 이전 것을 교체
  chips.querySelector(".chat-chip-ctx")?.remove();
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chat-chip chat-chip-ctx";
  b.title = "지금 보던 탭에 대한 추천 질문";
  b.textContent = `📎 ${q}`;
  b.addEventListener("click", () => {
    chatInput.value = q;
    chatForm.requestSubmit();
  });
  chips.prepend(b);
}

function openChat() {
  chatDrawer.classList.add("open");
  chatDrawer.setAttribute("aria-hidden", "false");
  ensureChatContextChip(); // P7: 빈 대화면 지금 탭 맥락 질문 칩 제시
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

// ── P5: 드래그한 구절 바로 질문 ──────────────────────────────────────────────
// 분석 본문(#result)에서 텍스트를 선택하면 선택 위에 [💬 이 부분 질문] 버튼을 띄운다.
// 클릭 → 채팅을 열고 인용을 프리필(자동 전송 안 함 — 사용자가 다듬어 보내게).
// 메모 카드(선택 구절 북마크 bm-add)와 공존: 버튼 mousedown을 preventDefault해
// 선택이 지워지지 않으므로 북마크 추가도 그대로 동작한다.
let selAskBtn = null;
let selAskText = "";
function hideSelAsk() {
  if (selAskBtn) selAskBtn.remove();
  selAskBtn = null;
}
function maybeShowSelAsk() {
  hideSelAsk();
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) return;
  const text = String(sel.toString() || "").replace(/\s+/g, " ").trim();
  if (text.length < 8) return; // 더블클릭 단어 선택 같은 오탐 방지
  // 분석 결과 영역 안에서의 선택만 (PDF 패널은 canvas라 선택 불가, 채팅 드로어·메모 입력 제외)
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const resultEl = document.getElementById("result");
  if (!el || !resultEl || !resultEl.contains(el)) return;
  if (el.closest("#notes-card, textarea, input")) return;
  let rect;
  try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { return; }
  if (!rect || (!rect.width && !rect.height)) return;

  selAskText = text;
  const b = document.createElement("button");
  b.type = "button";
  b.id = "sel-ask";
  b.className = "sel-ask";
  b.textContent = "💬 이 부분 질문";
  b.title = "선택한 구절을 인용해 질문 입력란에 채웁니다";
  b.addEventListener("mousedown", (e) => e.preventDefault()); // 클릭해도 선택 유지
  b.addEventListener("click", () => {
    const quote = selAskText.length > 120 ? selAskText.slice(0, 120) + "…" : selAskText;
    hideSelAsk();
    openChat();
    if (chatBusy) return; // 답변 생성 중이면 입력을 덮어쓰지 않고 드로어만 연다
    chatInput.value = `"${quote}" — 이 부분이 무슨 뜻이야?`;
    autoGrowChat();
    // 커서를 질문 부분에 두어 바로 다듬을 수 있게
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  });
  document.body.appendChild(b);
  const bw = b.offsetWidth || 120, bh = b.offsetHeight || 30;
  b.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 8))}px`;
  b.style.top = `${Math.max(8, rect.top - bh - 8)}px`;
  selAskBtn = b;
}
document.addEventListener("mouseup", (e) => {
  if (e.target && e.target.closest && e.target.closest("#sel-ask")) return; // 버튼 자체 클릭
  setTimeout(maybeShowSelAsk, 0); // mouseup 직후 선택이 확정된 뒤 판정
});
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) hideSelAsk(); // 선택 해제 → 버튼 제거
});
window.addEventListener("scroll", hideSelAsk, true); // 스크롤로 위치가 어긋나면 숨김

// ---------- P2: 30초 오리엔테이션 카드 (문제→방법→결과) ----------
// 기존 분석 데이터를 재조합(LLM 0원) — 3칸만 읽으면 논문 파악, 클릭 시 해당 탭.
function firstSentences(t, max = 110) {
  const s = cmdkStrip(t || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  // 문장 경계(마침표류)에서 끊기 — 없으면 단어 경계 즈음에서 자르고 말줄임
  const lastEnd = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf(". "), cut.lastIndexOf("음."));
  return lastEnd > 40 ? cut.slice(0, lastEnd + 2).trim() : cut.trim() + "…";
}
function renderTldr(data) {
  document.getElementById("tldr3")?.remove();
  const cards = [];
  const prob = firstSentences(data.problem);
  if (prob) cards.push({ icon: "❓", label: "무엇이 문제", text: prob, tab: "problem" });
  // 방법: 스테퍼 1단계(제목+설명) 우선, 없으면 한 줄 요약(위에 이미 보이지만 폴백으로만)
  const s0 = Array.isArray(data.method_steps) && data.method_steps[0];
  const meth = s0 ? firstSentences(`${cmdkStrip(s0.title || "")} — ${s0.description || ""}`) : firstSentences(data.one_liner);
  if (meth) cards.push({ icon: "🛠", label: "어떻게 풀었나", text: meth, tab: "method" });
  const resu = firstSentences(data.experiments && data.experiments.takeaway);
  if (resu) cards.push({ icon: "📊", label: "무엇을 얻었나", text: resu, tab: "results" });
  if (cards.length < 2) return; // 재료가 부족하면(구버전 분석 등) 표시하지 않음
  const row = document.createElement("div");
  row.id = "tldr3";
  row.className = "tldr3";
  cards.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tldr-card";
    b.title = "클릭하면 해당 탭으로 이동";
    const h = document.createElement("div");
    h.className = "tldr-label";
    h.textContent = `${c.icon} ${c.label}`;
    const p = document.createElement("div");
    p.className = "tldr-text";
    p.textContent = c.text;
    b.append(h, p);
    b.addEventListener("click", () => switchTab(c.tab));
    row.appendChild(b);
  });
  const anchor = document.getElementById("contributions");
  anchor.parentNode.insertBefore(row, anchor.nextSibling);
}

// ---------- P6: 본문 용어 자동 툴팁 ----------
// 용어집 용어가 탭 본문에 처음 나타나는 자리에 점선 밑줄 + hover 툴팁(뜻),
// 클릭 시 용어집 카드를 열어 그 용어로 필터. 수식·코드·버튼·링크 내부는 제외.
function decorateGlossaryTerms() {
  if (!glossaryItems.length) return;
  const terms = glossaryItems
    .filter((g) => g && g.term && String(g.term).length >= 3 && g.meaning)
    .sort((a, b) => String(b.term).length - String(a.term).length); // 긴 용어 우선(부분 겹침 방지)
  if (!terms.length) return;
  TAB_ORDER.forEach((tab) => {
    const panel = document.getElementById(`panel-${tab}`);
    if (!panel) return;
    const seen = new Set(); // 탭당 용어별 첫 등장만 (과도한 밑줄 방지)
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.textContent || n.textContent.length < 3) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(".katex, code, pre, button, a, input, textarea, svg, iframe, .gloss-term, .eqflow-node, .tldr3")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (seen.size >= terms.length) break;
      const text = node.textContent;
      for (const g of terms) {
        const term = String(g.term);
        if (seen.has(term)) continue;
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 영문 용어는 단어 경계(attention ⊄ attentions 방지), 한글 포함이면 단순 포함
        const re = new RegExp(/^[\x20-\x7e]+$/.test(term) ? `\\b${esc}\\b` : esc, "i");
        const m = re.exec(text);
        if (!m) continue;
        seen.add(term);
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const span = document.createElement("span");
        span.className = "gloss-term";
        span.title = `${g.meaning}\n(클릭: 용어집에서 보기)`;
        try { range.surroundContents(span); } catch (e) { seen.delete(term); break; } // 노드 경계 걸침 등 — 이 노드는 건너뜀
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          const card = document.getElementById("glossary-card");
          if (card.classList.contains("hidden")) toggleSideCard("glossary-card");
          const gs = document.getElementById("glossary-search");
          gs.value = term;
          paintGlossary(term);
        });
        break; // surroundContents가 노드를 분할 — 다음 텍스트노드로 진행
      }
    }
  });
}

// ---------- 용어집 (#6) ----------
function renderGlossary(items) {
  glossaryItems = Array.isArray(items) ? items.filter((g) => g && (g.term || g.latex)) : [];
  document.getElementById("tool-glossary").style.display = glossaryItems.length ? "" : "none";
  if (!glossaryItems.length) document.getElementById("glossary-card").classList.add("hidden");
  document.getElementById("glossary-search").value = "";
  paintGlossary("");
  refreshCardsButton(); // 카드(플래시카드) 버튼 표시 여부 갱신
}

// ---------- 복습 플래시카드 (예상 Q&A + 용어집 재활용 — LLM 호출 없음) ----------
// '어려움' 표시는 localStorage(fc-hard:<hash>)에 남겨 다음에 그 카드부터 보여준다.
function buildFlashcards() {
  const cards = [];
  const a = currentAnalysis || {};
  (Array.isArray(a.suggested_questions) ? a.suggested_questions : []).forEach((it, i) => {
    const q = typeof it === "string" ? it : (it && it.q) || "";
    if (!q) return;
    cards.push({
      key: `q${i}`,
      cat: (it && it.category) || "예상 질문",
      front: q,
      back: (it && it.why) || "(답변 가이드 없음 — 예상 Q&A 탭 참고)",
    });
  });
  glossaryItems.forEach((g, i) => {
    if (!g.term || !g.meaning) return;
    cards.push({ key: `g${i}`, cat: "용어", front: g.term, back: g.meaning });
  });
  return cards;
}
function refreshCardsButton() {
  const btn = document.getElementById("tool-cards");
  if (btn) btn.style.display = buildFlashcards().length ? "" : "none";
}
function openFlashcards() {
  const all = buildFlashcards();
  if (!all.length) return;
  const hardKey = `fc-hard:${currentHash}`;
  let hardSet;
  try { hardSet = new Set(JSON.parse(localStorage.getItem(hardKey) || "[]")); } catch { hardSet = new Set(); }
  // 어려움 표시 카드 먼저, 나머지는 원래 순서
  const deck = [...all.filter((c) => hardSet.has(c.key)), ...all.filter((c) => !hardSet.has(c.key))];
  let idx = 0, flipped = false;

  document.getElementById("fc-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "mode-overlay"; // 모드 다이얼로그와 같은 딤 배경 재사용
  ov.id = "fc-overlay";
  ov.innerHTML =
    `<div class="fc-box" role="dialog" aria-label="복습 카드">` +
    `<div class="fc-top"><span id="fc-count"></span><span id="fc-cat" class="fc-cat"></span>` +
    `<button type="button" class="fc-close" title="닫기 (Esc)">✕</button></div>` +
    `<button type="button" id="fc-card" class="fc-card" title="클릭하면 뒤집힘 (Space)"><div id="fc-text"></div>` +
    `<div class="fc-hint" id="fc-hint">클릭해서 답 보기</div></button>` +
    `<div class="fc-nav">` +
    `<button type="button" id="fc-prev" class="rtool" title="이전 (←)">← 이전</button>` +
    `<button type="button" id="fc-hard" class="rtool" title="다음에 이 카드부터">😅 어려움</button>` +
    `<button type="button" id="fc-easy" class="rtool" title="어려움 표시 해제">👍 쉬움</button>` +
    `<button type="button" id="fc-next" class="rtool" title="다음 (→)">다음 →</button>` +
    `</div></div>`;
  const paint = () => {
    const c = deck[idx];
    document.getElementById("fc-count").textContent = `${idx + 1} / ${deck.length}`;
    document.getElementById("fc-cat").textContent = `${c.cat}${hardSet.has(c.key) ? " · 😅" : ""}`;
    renderRich(document.getElementById("fc-text"), flipped ? c.back : `**${c.front}**`);
    document.getElementById("fc-hint").textContent = flipped ? "클릭하면 질문으로" : "클릭해서 답 보기";
    document.getElementById("fc-card").classList.toggle("fc-flipped", flipped);
  };
  const move = (d) => { idx = (idx + d + deck.length) % deck.length; flipped = false; paint(); };
  const saveHard = () => { try { localStorage.setItem(hardKey, JSON.stringify([...hardSet])); } catch {} };
  const close = () => { document.removeEventListener("keydown", onKey, true); ov.remove(); };
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipped = !flipped; paint(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) return close();
    if (e.target.closest(".fc-close")) return close();
    if (e.target.closest("#fc-card")) { flipped = !flipped; paint(); return; }
    if (e.target.closest("#fc-prev")) return move(-1);
    if (e.target.closest("#fc-next")) return move(1);
    if (e.target.closest("#fc-hard")) { hardSet.add(deck[idx].key); saveHard(); paint(); return; }
    if (e.target.closest("#fc-easy")) { hardSet.delete(deck[idx].key); saveHard(); paint(); return; }
  });
  document.body.appendChild(ov);
  paint();
}
document.getElementById("tool-cards").addEventListener("click", openFlashcards);

// ---------- 파생 생성 공용 오버레이 (⚖️ 논문 비교 · 🎤 발표 대본) ----------
// runFetch(force, signal) → fetch Response(SSE: step/delta/result). 결과는 서버가 캐시.
// renderData(el, data)가 있으면 구조화 모드: 스트리밍 중엔 글자수만 보여주고(원시 JSON 노출 방지)
// 완료 시 전용 렌더러로 그린다. toMarkdown(data)는 복사/.md용 텍스트 변환.
function openGenOverlay({ title, filename, runFetch, renderData, toMarkdown }) {
  document.getElementById("gen-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "mode-overlay";
  ov.id = "gen-overlay";
  ov.innerHTML =
    `<div class="gen-box" role="dialog" aria-label="${title.replace(/"/g, "&quot;")}">` +
    `<div class="gen-head"><span class="gen-title"></span><span class="gen-status muted"></span>` +
    `<button type="button" class="gen-close" title="닫기 (Esc)">✕</button></div>` +
    `<div class="gen-body"><div class="gen-text"></div></div>` +
    `<div class="gen-foot">` +
    `<button type="button" class="rtool gen-regen" disabled>🔄 다시 생성</button>` +
    `<button type="button" class="rtool gen-copy" disabled>📋 복사</button>` +
    `<button type="button" class="rtool gen-dl" disabled>⬇︎ .md</button>` +
    `</div></div>`;
  ov.querySelector(".gen-title").textContent = title;
  const body = ov.querySelector(".gen-body");
  const textEl = ov.querySelector(".gen-text");
  const statusEl = ov.querySelector(".gen-status");
  const btnRegen = ov.querySelector(".gen-regen");
  const btnCopy = ov.querySelector(".gen-copy");
  const btnDl = ov.querySelector(".gen-dl");
  let finalText = "";
  let ac = null;

  const start = async (force) => {
    ac?.abort();
    ac = new AbortController();
    finalText = "";
    btnRegen.disabled = btnCopy.disabled = btnDl.disabled = true;
    statusEl.textContent = "생성 중…";
    textEl.textContent = "준비 중…";
    try {
      const res = await runFetch(force, ac.signal);
      if (!res.ok) {
        const d = await safeJson(res);
        throw new Error((d && d.error) || `HTTP ${res.status}`);
      }
      // SSE 소비: delta를 타자기 렌더(스로틀), step은 상태줄, result가 권위본.
      // 구조화 모드(renderData)에선 delta 동안 진행 글자수만 표시(원시 JSON 노출 방지).
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", live = "", lastPaint = 0, cached = false, text = null, data = null;
      const paint = (forcePaint) => {
        const now = performance.now();
        if (!forcePaint && now - lastPaint < 150) return;
        lastPaint = now;
        if (renderData) {
          textEl.textContent = `생성 중… (${live.length.toLocaleString()}자)`;
          return;
        }
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        renderRich(textEl, live + " ▍");
        if (atBottom) body.scrollTop = body.scrollHeight;
      };
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
          if (ev.type === "delta") { live += ev.text; paint(false); }
          else if (ev.type === "step") statusEl.textContent = ev.msg;
          else if (ev.type === "result") { text = ev.text ?? null; data = ev.data ?? null; cached = !!ev.cached; }
          else if (ev.type === "error") throw new Error(ev.error);
        }
      }
      if (text == null && data == null) throw new Error("서버 연결이 중간에 끊어졌습니다. 다시 시도해 주세요.");
      if (renderData && data && !data.fallback_text) {
        renderData(textEl, data);
        finalText = toMarkdown ? toMarkdown(data) : JSON.stringify(data, null, 2);
      } else {
        finalText = text ?? (data && data.fallback_text) ?? "";
        renderRich(textEl, finalText);
      }
      statusEl.textContent = cached ? "저장된 결과 (다시 생성 가능)" : "완료";
      btnRegen.disabled = btnCopy.disabled = btnDl.disabled = false;
    } catch (e) {
      if (e.name === "AbortError") return;
      statusEl.textContent = "";
      textEl.textContent = `⚠️ ${e.message}`;
      btnRegen.disabled = false;
    }
  };

  const close = () => { ac?.abort(); document.removeEventListener("keydown", onKey, true); ov.remove(); };
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest(".gen-close")) return close();
  });
  btnRegen.addEventListener("click", () => start(true));
  btnCopy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(finalText); } catch {
      const ta = document.createElement("textarea");
      ta.value = finalText; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    btnCopy.textContent = "✓ 복사됨";
    setTimeout(() => { btnCopy.textContent = "📋 복사"; }, 1500);
  });
  btnDl.addEventListener("click", () => {
    const blob = new Blob([`# ${title}\n\n${finalText}\n`], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "paper-reviewer.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  document.body.appendChild(ov);
  start(false);
}

// ── ⚖️ 비교 결과 렌더러: 축별 나란히 그리드 (산문 대신 훑어보는 표) ────────────
function buildCompareView(el, d) {
  el.innerHTML = "";
  const frag = document.createDocumentFragment();
  // 결정적 차이 한 줄 (맨 위, 가장 크게)
  if (d.verdict) {
    const v = document.createElement("p");
    v.className = "cvw-verdict";
    renderRich(v, d.verdict);
    frag.appendChild(v);
  }
  // 축별 그리드: [축 | 논문1 | 논문2]
  const grid = document.createElement("div");
  grid.className = "cvw-grid";
  const head = (txt, cls, title) => {
    const h = document.createElement("div");
    h.className = `cvw-h ${cls || ""}`;
    h.textContent = txt;
    if (title) h.title = title;
    return h;
  };
  grid.append(head("", "cvw-axis"), head(d.name_a || "논문 1", "cvw-a", d.title_a), head(d.name_b || "논문 2", "cvw-b", d.title_b));
  (Array.isArray(d.rows) ? d.rows : []).forEach((r) => {
    if (!r || !r.axis) return;
    const ax = document.createElement("div");
    ax.className = "cvw-cell cvw-axis";
    ax.textContent = r.axis;
    const ca = document.createElement("div");
    ca.className = "cvw-cell cvw-a";
    renderRich(ca, r.a || "—");
    const cb = document.createElement("div");
    cb.className = "cvw-cell cvw-b";
    renderRich(cb, r.b || "—");
    grid.append(ax, ca, cb);
  });
  frag.appendChild(grid);
  // 언제 무엇을 — 두 장의 카드
  if (d.when_a || d.when_b) {
    const row = document.createElement("div");
    row.className = "cvw-when";
    [[d.name_a, d.when_a, "cvw-a"], [d.name_b, d.when_b, "cvw-b"]].forEach(([name, when, cls]) => {
      if (!when) return;
      const card = document.createElement("div");
      card.className = `cvw-when-card ${cls}`;
      const t = document.createElement("div");
      t.className = "cvw-when-name";
      t.textContent = `👉 ${name || ""}`;
      const b = document.createElement("div");
      renderRich(b, when);
      card.append(t, b);
      row.appendChild(card);
    });
    frag.appendChild(row);
  }
  // 세미나 모범 답변 (유일한 문단 — 접이식)
  if (d.qa) {
    const det = document.createElement("details");
    det.className = "cvw-qa";
    const sum = document.createElement("summary");
    sum.textContent = "🎓 \"두 논문 차이가 뭐죠?\" — 30초 모범 답변";
    const p = document.createElement("p");
    renderRich(p, d.qa);
    det.append(sum, p);
    frag.appendChild(det);
  }
  el.appendChild(frag);
}
// 비교 데이터 → 복사/.md용 마크다운
function compareToMarkdown(d) {
  const L = [];
  if (d.verdict) L.push(`**${d.verdict}**`, "");
  L.push(`| | ${d.name_a || "논문 1"} | ${d.name_b || "논문 2"} |`, "|---|---|---|");
  (d.rows || []).forEach((r) => L.push(`| **${r.axis}** | ${r.a || "—"} | ${r.b || "—"} |`));
  L.push("");
  if (d.when_a) L.push(`- **${d.name_a}이 맞을 때**: ${d.when_a}`);
  if (d.when_b) L.push(`- **${d.name_b}이 맞을 때**: ${d.when_b}`);
  if (d.qa) L.push("", `> ${d.qa}`);
  return L.join("\n");
}

// ── ⚖️ 논문 비교: 분석된 다른 논문 선택 → 비교 생성 ──────────────────────────
function openComparePicker() {
  if (!currentHash || !currentAnalysis) return;
  const candidates = historyItems.filter((it) => it.hash !== currentHash);
  if (!candidates.length) return showError("비교하려면 분석된 다른 논문이 하나 이상 필요합니다.");
  document.getElementById("cmp-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "mode-overlay";
  ov.id = "cmp-overlay";
  ov.innerHTML =
    `<div class="gen-box cmp-box" role="dialog" aria-label="비교할 논문 선택">` +
    `<div class="gen-head"><span class="gen-title">⚖️ 어떤 논문과 비교할까요?</span>` +
    `<button type="button" class="gen-close" title="닫기 (Esc)">✕</button></div>` +
    `<input class="cmp-search sb-search" type="search" placeholder="제목 검색…" autocomplete="off" />` +
    `<ul class="cmp-list"></ul></div>`;
  const list = ov.querySelector(".cmp-list");
  const paint = (filter) => {
    list.innerHTML = "";
    const f = (filter || "").trim().toLowerCase();
    candidates
      .filter((it) => !f || (it.title || "").toLowerCase().includes(f))
      .forEach((it) => {
        const li = document.createElement("li");
        const t = document.createElement("span");
        t.className = "cmp-title";
        t.textContent = it.title || "(제목 없음)";
        const meta = document.createElement("span");
        meta.className = "cmp-meta muted";
        meta.textContent = [it.year, it.analysis_mode === "simple" ? "⚡간단" : null].filter(Boolean).join(" · ");
        li.append(t, meta);
        li.addEventListener("click", () => {
          close();
          const myTitle = (currentAnalysis.title || "").slice(0, 30);
          openGenOverlay({
            title: `⚖️ ${myTitle} ↔ ${(it.title || "").slice(0, 30)}`,
            filename: `compare_${(it.title || "paper").slice(0, 24).replace(/[^\w가-힣]+/g, "_")}.md`,
            renderData: buildCompareView, // 산문 대신 축별 그리드로 렌더
            toMarkdown: compareToMarkdown,
            runFetch: (force, signal) =>
              fetch(`${API_BASE}/api/compare`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ a: currentHash, b: it.hash, force }),
                signal,
              }),
          });
        });
        list.appendChild(li);
      });
    if (!list.children.length) list.innerHTML = `<li class="muted" style="cursor:default">검색 결과가 없습니다.</li>`;
  };
  const close = () => { document.removeEventListener("keydown", onKey, true); ov.remove(); };
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest(".gen-close")) close(); });
  ov.querySelector(".cmp-search").addEventListener("input", (e) => paint(e.target.value));
  document.body.appendChild(ov);
  paint("");
  ov.querySelector(".cmp-search").focus();
}
document.getElementById("tool-compare").addEventListener("click", openComparePicker);

// ── 🐣 더 쉽게 (P8): 지금 보는 탭을 학부 신입생 수준으로 재설명 ────────────────
// 서버가 (hash, section)별로 캐시하므로 두 번째부터는 즉시. 원문 탭과 오버레이로 대조해 읽는다.
const ELI_TABS = { background: "연구 배경", problem: "해결하려는 것", method: "연구 방법론", results: "실험·결과", equations: "수식 정리" };
document.getElementById("tool-eli").addEventListener("click", () => {
  if (!currentHash || !currentAnalysis) return;
  const label = ELI_TABS[activeTab];
  if (!label) return showError("이 탭은 '더 쉽게'를 지원하지 않아요 — 배경·문제·방법론·실험·수식 탭에서 눌러 주세요.");
  openGenOverlay({
    title: `🐣 ${label} — 더 쉽게`,
    filename: `easy_${activeTab}_${(currentAnalysis.title || "paper").slice(0, 24).replace(/[^\w가-힣]+/g, "_")}.md`,
    runFetch: (force, signal) =>
      fetch(`${API_BASE}/api/explain/${currentHash}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: activeTab, force }),
        signal,
      }),
  });
});
// 비교할 다른 논문이 없으면 버튼 숨김 (loadHistory 후 호출)
function refreshCompareButton() {
  const btn = document.getElementById("tool-compare");
  if (btn) btn.style.display = historyItems.some((it) => it.hash !== currentHash) ? "" : "none";
}

// ── 🎤 발표 대본: 발표 시간 선택 → 대본 생성 ────────────────────────────────
function openScriptPicker() {
  if (!currentHash || !currentAnalysis) return;
  document.getElementById("scr-overlay")?.remove();
  const ov = document.createElement("div");
  ov.className = "mode-overlay";
  ov.id = "scr-overlay";
  ov.innerHTML =
    `<div class="gen-box scr-box" role="dialog" aria-label="발표 시간 선택">` +
    `<div class="gen-head"><span class="gen-title">🎤 몇 분 발표인가요?</span>` +
    `<button type="button" class="gen-close" title="닫기 (Esc)">✕</button></div>` +
    `<div class="scr-row">` +
    [10, 20, 30].map((m) => `<button type="button" class="mode-card scr-min" data-min="${m}"><span class="mode-name">${m}분</span><span class="mode-desc">${m === 10 ? "핵심만 압축" : m === 20 ? "표준 세미나" : "여유 있는 상세 발표"}</span></button>`).join("") +
    `</div></div>`;
  const close = () => { document.removeEventListener("keydown", onKey, true); ov.remove(); };
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest(".gen-close")) return close();
    const card = e.target.closest(".scr-min");
    if (!card) return;
    const minutes = Number(card.dataset.min);
    close();
    openGenOverlay({
      title: `🎤 ${(currentAnalysis.title || "").slice(0, 34)} — ${minutes}분 발표 대본`,
      filename: `script_${minutes}min_${(currentAnalysis.title || "paper").slice(0, 24).replace(/[^\w가-힣]+/g, "_")}.md`,
      runFetch: (force, signal) =>
        fetch(`${API_BASE}/api/script/${currentHash}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minutes, force }),
          signal,
        }),
    });
  });
  document.body.appendChild(ov);
}
document.getElementById("tool-script").addEventListener("click", openScriptPicker);
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
  if (data.analysis_mode === "simple") L.push(`> ⚡ 간단 분석 결과 (세미나 정리·실험·그림 해설 생략)`);
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
    // 로드가 끝나기 전에 사용자가 입력을 시작했으면 화면·상태 모두 입력이 우선
    // (input 핸들러가 이미 notesState를 갱신·저장 예약했으므로 서버 값으로 되돌리지 않는다)
    const ta = document.getElementById("notes-text");
    const typing = document.activeElement === ta && ta.value !== "";
    notesState = {
      notes: typing ? ta.value : (d.notes || ""),
      bookmarks: Array.isArray(d.bookmarks) ? d.bookmarks : [],
    };
    if (!typing) ta.value = notesState.notes;
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
  // 클라 전용 ETA(서버 스트림 없음): 섹션별 정적 추정으로 버튼 카운트다운 + 패널 상단 바.
  const SECTION_EST_MS = { method: 90000, figures: 40000, equations: 40000, results: 45000, background: 40000, problem: 35000, seminar: 45000 };
  const estMs = SECTION_EST_MS[section] || 40000;
  let regenBar = null, regenFill = null, regenTimer = null;
  if (panel && panel.parentNode) {
    regenBar = document.createElement("div");
    regenBar.className = "regen-bar";
    regenFill = document.createElement("div");
    regenFill.className = "regen-fill";
    regenBar.appendChild(regenFill);
    panel.parentNode.insertBefore(regenBar, panel); // 패널 바로 위(디밍 영향 없음)
  }
  const t0 = performance.now();
  const tickRegen = () => {
    const el = performance.now() - t0;
    const fRaw = el / estMs;
    const f = fRaw < 0.9 ? fRaw : 0.9 + 0.1 * (1 - Math.exp(-(fRaw - 0.9) * 2));
    if (regenFill) regenFill.style.width = `${Math.min(99, f * 100)}%`;
    btn.textContent = `재생성 중 · ${fmtRemaining(estMs - el)}`;
  };
  regenTimer = setInterval(tickRegen, 250);
  tickRegen();
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
    if (regenTimer) clearInterval(regenTimer);
    if (regenFill) regenFill.style.width = "100%";
    if (regenBar) setTimeout(() => regenBar.remove(), 250); // 100% 잠깐 보여주고 제거
    sectionRegenInFlight = false;
    sectionRegenAbort = null;
    btn.textContent = orig;
    btn.disabled = false;
    if (panel) panel.classList.remove("regenerating");
  }
}

// ========== P3: 통합 검색 (⌘K / Ctrl+K) ==========
// 분석 결과(모든 탭 텍스트) + 용어집 + 원문 PDF를 한 입력으로 동시 검색하는 커맨드 팔레트.
// 분석·용어집은 클라 메모리라 즉시·무료, PDF는 기존 pdfPageTextOf 지연 캐시로 비동기 추가.
const cmdk = { el: null, items: [], active: -1, token: 0, index: null, indexHash: null };

// 원문 마크업(**볼드**/==형광==/$수식$/[[p7|…]])을 벗겨 화면 텍스트와 비교 가능하게
function cmdkStrip(t) {
  return String(t == null ? "" : t)
    .replace(/\[\[\s*p\.?\s*\d+\s*(?:\|[^\]]*)?\]\]/gi, "")
    .replace(/\*\*|==/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// currentAnalysis → 검색 항목 [{tab, where, text, lower}] — 논문이 바뀔 때만 재구축
function cmdkBuildIndex() {
  const a = currentAnalysis;
  if (!a) return [];
  if (cmdk.index && cmdk.indexHash === currentHash) return cmdk.index;
  const items = [];
  const add = (tab, where, text) => {
    const t = cmdkStrip(text);
    if (t.length >= 2) items.push({ tab, where, text: t, lower: t.toLowerCase() });
  };
  (Array.isArray(a.seminar) ? a.seminar : []).forEach((s) => {
    if (!s) return;
    (Array.isArray(s.points) ? s.points : []).forEach((p) => p && add("seminar", `세미나 ${s.section || ""} ${s.title || ""}`.trim(), p.text));
  });
  String(a.background || "").split("\n").forEach((line) => add("background", "연구 배경", line));
  (Array.isArray(a.timeline) ? a.timeline : []).forEach((t) => t && add("background", "타임라인", `${t.year ?? ""} ${t.label ?? ""} — ${t.note ?? ""}`));
  String(a.problem || "").split("\n").forEach((line) => add("problem", "해결하려는 것", line));
  (Array.isArray(a.method_steps) ? a.method_steps : []).forEach((s, i) => s && add("method", `방법론 ${i + 1}. ${cmdkStrip(s.title)}`, `${s.title || ""} ${s.description || ""} ${s.analogy || ""}`));
  const md = a.method_deep;
  (md && Array.isArray(md.sections) ? md.sections : []).forEach((s) => s && add("method", `정밀 강독 ${s.ref || ""}`.trim(), `${s.title || ""} ${s.body || s.text || ""}`));
  const e = a.experiments || {};
  add("results", "실험 결론", e.takeaway);
  (Array.isArray(e.metrics_explained) ? e.metrics_explained : []).forEach((m) => m && add("results", "측정 지표", `${m.name || ""} — ${m.meaning || ""}`));
  (Array.isArray(e.datasets) ? e.datasets : []).forEach((d) => d && add("results", "데이터셋", `${d.name || ""} — ${d.detail || ""}`));
  (Array.isArray(e.terms) ? e.terms : []).forEach((t) => t && add("results", "실험 용어", `${t.term || ""} — ${t.meaning || ""}`));
  (Array.isArray(e.studies) ? e.studies : []).forEach((s, i) => s && add("results", `실험 ${i + 1}`, `${s.title || ""} ${s.purpose || ""} ${s.setup || ""} ${s.result || ""}`));
  add("results", "한계", e.limitations);
  (Array.isArray(a.equations) ? a.equations : []).forEach((eq, i) => eq && add("equations", `수식 ${i + 1}${eq.paper_ref ? ` (${eq.paper_ref})` : ""}`,
    `${eq.explanation || ""} ${eq.analogy || ""} ${(Array.isArray(eq.variables) ? eq.variables : []).map((v) => v && `${v.symbol} ${v.meaning}`).join(" ")}`));
  (Array.isArray(a.figure_guide) ? a.figure_guide : []).forEach((f) => f && add("figures", f.label || "그림", `${f.caption_ko || ""} ${f.explanation || ""} ${f.takeaway || ""}`));
  cmdk.index = items;
  cmdk.indexHash = currentHash;
  return items;
}

// 매치 주변 문맥 스니펫 (<b>하이라이트)
function cmdkSnippet(text, needle) {
  const i = text.toLowerCase().indexOf(needle);
  const span = document.createElement("span");
  if (i < 0) { span.textContent = text.slice(0, 60); return span; }
  span.append(document.createTextNode((i > 26 ? "…" : "") + text.slice(Math.max(0, i - 26), i)));
  const b = document.createElement("b");
  b.textContent = text.slice(i, i + needle.length);
  span.append(b, document.createTextNode(text.slice(i + needle.length, i + needle.length + 40)));
  return span;
}

// 탭 패널에서 needle 위치를 찾아 스크롤 + 하이라이트.
// 1순위: 매치를 담은 텍스트 노드를 찾아 그 구간만 임시 <span>으로 감싸 플래시(끝나면 원복).
// 2순위: 마크업(<strong> 등)으로 쪼개져 단일 노드 매치가 없으면, 포함하는 가장 깊은 요소를 플래시.
function cmdkJump(tab, needles) {
  switchTab(tab);
  const panel = document.getElementById(`panel-${tab}`);
  if (!panel) return;
  const norm = (s) => String(s || "").replace(/\s+/g, " ").toLowerCase();
  for (const nd of needles) {
    const n = norm(nd);
    if (n.length < 2) continue;

    // 1) 단일 텍스트 노드 안의 매치 → 그 부분만 감싸 하이라이트
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!norm(node.textContent).includes(n)) continue;
      const raw = node.textContent;
      const ri = raw.toLowerCase().indexOf(nd.toLowerCase()); // 공백 차이로 못 찾으면 노드 전체
      const range = document.createRange();
      if (ri >= 0) {
        range.setStart(node, ri);
        range.setEnd(node, Math.min(raw.length, ri + nd.length));
      } else {
        range.selectNodeContents(node);
      }
      const mark = document.createElement("span");
      mark.className = "cmdk-flash";
      try { range.surroundContents(mark); } catch { break; } // 경계가 어긋나면 요소 폴백으로
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        const p = mark.parentNode;
        if (p) { p.replaceChild(document.createTextNode(mark.textContent), mark); p.normalize(); }
      }, 1900);
      return;
    }

    // 2) 포함하는 가장 깊은 요소로 폴백
    if (!norm(panel.textContent).includes(n)) continue;
    let el = panel;
    let child;
    while ((child = [...el.children].find((c) => c.tagName !== "IFRAME" && norm(c.textContent).includes(n)))) el = child;
    const target = el === panel ? panel : el.closest("p, li, h3, h4, td, .step-desc, div") || el;
    if (target !== panel) {
      target.classList.add("cmdk-flash");
      setTimeout(() => target.classList.remove("cmdk-flash"), 1900);
    }
    target.scrollIntoView({ behavior: "smooth", block: target === panel ? "start" : "center" });
    return;
  }
}

function closeCmdk() {
  if (cmdk.el) cmdk.el.remove();
  cmdk.el = null;
  cmdk.items = [];
  cmdk.active = -1;
  cmdk.token++;
}

function cmdkSetActive(i) {
  if (!cmdk.items.length) { cmdk.active = -1; return; }
  cmdk.active = (i + cmdk.items.length) % cmdk.items.length;
  cmdk.items.forEach((el, j) => el.classList.toggle("active", j === cmdk.active));
  cmdk.items[cmdk.active].scrollIntoView({ block: "nearest" });
}

function cmdkRun(q) {
  const token = ++cmdk.token;
  const box = document.getElementById("cmdk-results");
  box.innerHTML = "";
  cmdk.items = [];
  cmdk.active = -1;
  const needle = q.trim().toLowerCase();
  if (!currentAnalysis) {
    box.innerHTML = '<p class="cmdk-hint">먼저 논문을 열어주세요 — 히스토리에서 선택하거나 PDF를 드롭하면 검색할 수 있어요.</p>';
    return;
  }
  if (needle.length < 2) {
    box.innerHTML = '<p class="cmdk-hint">2자 이상 입력하면 분석 내용 · 용어집 · 원문 PDF를 한 번에 검색합니다.</p>';
    return;
  }
  const group = (label) => {
    const h = document.createElement("div");
    h.className = "cmdk-group";
    h.textContent = label;
    box.appendChild(h);
    return h;
  };
  const addItem = (whereText, snippetEl, onPick) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "cmdk-item";
    const w = document.createElement("span");
    w.className = "cmdk-where";
    w.textContent = whereText;
    const s = document.createElement("span");
    s.className = "cmdk-snippet";
    s.appendChild(snippetEl);
    it.append(w, s);
    it.addEventListener("click", () => { closeCmdk(); onPick(); });
    it.addEventListener("mousemove", () => cmdkSetActive(cmdk.items.indexOf(it)));
    box.appendChild(it);
    cmdk.items.push(it);
  };

  // ── 1) 분석 섹션 (즉시) ──
  const TAB_KO = { seminar: "Ⅰ", background: "Ⅱ", problem: "Ⅲ", method: "Ⅳ", results: "Ⅴ", equations: "Ⅵ", figures: "Ⅶ" };
  const hits = cmdkBuildIndex().filter((it) => it.lower.includes(needle)).slice(0, 8);
  if (hits.length) {
    group("📑 분석 내용");
    hits.forEach((h) => addItem(`${TAB_KO[h.tab] || ""} ${h.where}`, cmdkSnippet(h.text, needle), () => cmdkJump(h.tab, [q.trim(), h.text.slice(0, 30)])));
  }

  // ── 2) 용어집 (즉시) ──
  const gHits = (glossaryItems || []).filter((g) => g && `${g.term || ""} ${g.meaning || ""}`.toLowerCase().includes(needle)).slice(0, 5);
  if (gHits.length) {
    group("📖 용어집");
    gHits.forEach((g) => addItem(g.term || g.latex || "용어", cmdkSnippet(`${g.term || ""} — ${g.meaning || ""}`, needle), () => {
      document.getElementById("notes-card").classList.add("hidden");
      const card = document.getElementById("glossary-card");
      card.classList.remove("hidden");
      const gs = document.getElementById("glossary-search");
      gs.value = g.term || "";
      paintGlossary(gs.value);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
  }

  if (!hits.length && !gHits.length) {
    const none = document.createElement("p");
    none.className = "cmdk-hint";
    none.textContent = "분석 내용·용어집에는 없어요. 원문 PDF를 찾는 중…";
    box.appendChild(none);
  }

  // ── 3) 원문 PDF (비동기 — 기존 페이지 텍스트 캐시 재사용) ──
  if (pdfDoc && pdfAvailable) {
    const ph = document.createElement("div");
    ph.className = "cmdk-group";
    ph.textContent = "📄 원문 PDF — 검색 중…";
    box.appendChild(ph);
    (async () => {
      const found = [];
      for (let n = 1; n <= pdfDoc.numPages && found.length < 6; n++) {
        let text;
        try { text = await pdfPageTextOf(n); } catch { continue; }
        if (token !== cmdk.token) return; // 그 사이 재입력/닫힘
        const i = text.toLowerCase().indexOf(needle);
        if (i >= 0) found.push({ page: n, text, anchor: text.slice(i, i + 40) });
      }
      if (token !== cmdk.token) return;
      ph.textContent = found.length ? "📄 원문 PDF" : "📄 원문 PDF — 결과 없음";
      found.forEach((r) => addItem(`p.${r.page}`, cmdkSnippet(r.text, needle), () => {
        workspaceEl.classList.remove("pdf-collapsed"); // 접힌 PDF 패널 펼치기
        document.getElementById("pdf-toggle").textContent = "접기 ◀";
        jumpToPdfPageText(r.page, r.anchor);
      }));
      if (cmdk.active < 0 && cmdk.items.length) cmdkSetActive(0);
    })();
  }
  if (cmdk.items.length) cmdkSetActive(0);
}

function openCmdk() {
  if (cmdk.el) { cmdk.el.querySelector("input").focus(); return; }
  const ov = document.createElement("div");
  ov.className = "cmdk-overlay";
  ov.id = "cmdk-overlay";
  ov.innerHTML =
    '<div class="cmdk-box" role="dialog" aria-label="통합 검색">' +
    '<input id="cmdk-input" type="text" placeholder="분석 내용 · 용어집 · 원문 PDF 통합 검색…" autocomplete="off" spellcheck="false" />' +
    '<div id="cmdk-results" class="cmdk-results"></div>' +
    '<div class="cmdk-foot">↑↓ 이동 · Enter 열기 · Esc 닫기</div></div>';
  ov.addEventListener("click", (e) => { if (e.target === ov) closeCmdk(); });
  document.body.appendChild(ov);
  cmdk.el = ov;
  const input = ov.querySelector("input");
  let debounce = 0;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => cmdkRun(input.value), 140);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCmdk(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); cmdkSetActive(cmdk.active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkSetActive(cmdk.active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (cmdk.active >= 0 && cmdk.items[cmdk.active]) cmdk.items[cmdk.active].click(); }
  });
  cmdkRun("");
  input.focus();
}
// ⌘K(맥)/Ctrl+K — 다른 수식키 검사보다 먼저 잡아야 해서 별도 리스너
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (cmdk.el) closeCmdk();
    else openCmdk();
  }
});
document.getElementById("tool-cmdk")?.addEventListener("click", openCmdk);

// ---------- 키보드 단축키 (#8) ----------
const TAB_ORDER = ["seminar", "background", "problem", "method", "results", "equations", "figures"];
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return; // 한글 IME 조합 중 Esc(조합 취소)가 패널을 닫지 않게
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
  else if ((e.key === "s" || e.key === "S") && reading) { e.preventDefault(); window.openPdfSearch && window.openPdfSearch(); }
  else if ((e.key === "q" || e.key === "Q") && reading) { e.preventDefault(); openChat(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); document.getElementById("sb-new").click(); }
  else if (e.key === "t" || e.key === "T") { e.preventDefault(); document.getElementById("theme-toggle").click(); }
});
document.getElementById("kbd-help-close").addEventListener("click", () => document.getElementById("kbd-help").classList.add("hidden"));
document.getElementById("kbd-help").addEventListener("click", (e) => { if (e.target.id === "kbd-help") e.target.classList.add("hidden"); });

loadHistory();
restoreFromHash(); // URL에 #p=<hash>가 있으면 그 논문·탭을 복원
