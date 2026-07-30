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

// ── 설정: 구독 계정 상태 + 재로그인 전환 ─────────────────────────────────────
// 자격증명은 다루지 않는다 — 서버가 `claude` CLI에 위임한다. 전환 = 다시 로그인(직렬).
let _settingsPoll = null;
function stopSettingsPoll() { if (_settingsPoll) { clearInterval(_settingsPoll); _settingsPoll = null; } }
async function fetchSettings() {
  const r = await fetch(`${API_BASE}/settings/status`);
  if (!r.ok) throw new Error(`상태 조회 실패 (HTTP ${r.status})`);
  return r.json();
}
async function openSettings() {
  document.getElementById("settings-overlay")?.remove();
  stopSettingsPoll();
  const ov = document.createElement("div");
  ov.className = "mode-overlay";
  ov.id = "settings-overlay";
  ov.innerHTML =
    '<div class="settings-box" role="dialog" aria-label="설정">' +
    '<div class="settings-head"><span class="settings-title">⚙️ 설정 · 구독 계정</span>' +
    '<button type="button" class="settings-close" title="닫기 (Esc)">✕</button></div>' +
    '<div class="settings-body"><div class="muted">불러오는 중…</div></div></div>';
  const close = () => { stopSettingsPoll(); document.removeEventListener("keydown", onKey, true); ov.remove(); };
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".settings-polling")) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("click", (e) => {
    if (document.querySelector(".settings-polling")) return; // 전환 중엔 바깥클릭 무시
    if (e.target === ov || e.target.closest(".settings-close")) close();
  });
  document.body.appendChild(ov);
  try { renderSettings(ov, await fetchSettings()); }
  catch (e) { ov.querySelector(".settings-body").innerHTML = `<div class="settings-warn">⚠️ ${e.message}</div>`; }
}
function renderSettings(ov, data) {
  const body = ov.querySelector(".settings-body");
  const a = data.auth || {};
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const isSub = a.loggedIn && a.apiProvider === "firstParty";
  body.innerHTML = "";

  // 현재 계정 카드
  const card = document.createElement("div");
  card.className = "settings-card";
  if (!a.loggedIn) {
    card.innerHTML = '<div class="settings-card-label">현재 계정</div><div class="settings-warn">로그인되어 있지 않습니다. 아래에서 구독 계정으로 로그인하세요.</div>';
  } else {
    card.innerHTML =
      '<div class="settings-card-label">현재 로그인 계정</div>' +
      `<div class="settings-email">${(a.email || "(이메일 없음)").replace(/</g, "&lt;")}</div>` +
      `<div class="settings-sub">${isSub ? "구독" : "⚠️ 구독 아님"}${a.subscriptionType ? " · " + a.subscriptionType : ""}${a.orgName ? " · " + String(a.orgName).replace(/</g, "&lt;").slice(0, 40) : ""}</div>` +
      (isSub ? "" : '<div class="settings-warn">API 과금 계정으로 보입니다 — 구독(claude.ai) 계정으로 전환하세요.</div>');
  }
  body.appendChild(card);

  // 전환 안내
  const note = document.createElement("p");
  note.className = "settings-note muted";
  note.innerHTML = "계정 전환은 <b>다시 로그인</b>입니다(키체인은 한 계정만 저장 — 기존 계정은 로그아웃). " +
    "로그인 창은 <b>이 앱이 실행 중인 컴퓨터(서버 Mac) 화면</b>에 열립니다 — 폰·다른 기기로 접속 중이어도 그 Mac에서 승인해야 합니다.";
  body.appendChild(note);

  // 저장된 바로가기
  if (accounts.length) {
    const list = document.createElement("div");
    list.className = "settings-accts";
    accounts.forEach((ac) => {
      const row = document.createElement("div");
      row.className = "settings-acct";
      const isCur = a.email && ac.email === a.email;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "settings-acct-go";
      go.innerHTML = `<b>${(ac.label || ac.email).replace(/</g, "&lt;")}</b><span class="muted">${ac.email.replace(/</g, "&lt;")}</span>`;
      go.disabled = isCur;
      go.title = isCur ? "현재 이 계정입니다" : `${ac.email}로 전환`;
      go.addEventListener("click", () => startSwitch(ov, ac.email, a.email));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "settings-acct-del";
      del.textContent = "✕";
      del.title = "바로가기 삭제";
      del.addEventListener("click", async () => {
        await fetch(`${API_BASE}/settings/accounts/${ac.id}`, { method: "DELETE" });
        renderSettings(ov, await fetchSettings());
      });
      row.append(go, del);
      if (isCur) row.classList.add("on");
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  // 이메일 입력 + 전환/저장
  const form = document.createElement("div");
  form.className = "settings-switch";
  form.innerHTML =
    '<input type="email" class="settings-input" placeholder="전환할 계정 이메일 (선택 — 로그인 페이지에 미리 채움)" autocomplete="off" />' +
    '<div class="settings-btns">' +
    '<button type="button" class="rtool settings-do">🔄 이 계정으로 전환 (다시 로그인)</button>' +
    '<button type="button" class="rtool settings-save">➕ 바로가기 저장</button>' +
    '</div>';
  const input = form.querySelector(".settings-input");
  form.querySelector(".settings-do").addEventListener("click", () => startSwitch(ov, input.value.trim(), a.email));
  form.querySelector(".settings-save").addEventListener("click", async () => {
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError("바로가기로 저장할 유효한 이메일을 입력하세요.");
    await fetch(`${API_BASE}/settings/accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    input.value = "";
    renderSettings(ov, await fetchSettings());
  });
  body.appendChild(form);
}
async function startSwitch(ov, targetEmail, prevEmail) {
  const body = ov.querySelector(".settings-body");
  // 전환 진행 오버레이(닫기 차단)
  const poll = document.createElement("div");
  poll.className = "settings-polling";
  poll.innerHTML =
    '<div class="settings-spin"></div>' +
    '<div class="settings-poll-title">브라우저에서 로그인을 승인해 주세요</div>' +
    '<div class="settings-poll-note muted">로그인 창은 <b>이 앱이 도는 컴퓨터(서버 Mac) 화면</b>에 열립니다.<br>' +
    (targetEmail ? `대상: ${targetEmail.replace(/</g, "&lt;")}<br>` : "") +
    '승인이 끝나면 자동으로 새 계정이 반영됩니다.</div>' +
    '<button type="button" class="rtool settings-poll-cancel">취소</button>';
  body.appendChild(poll);
  poll.querySelector(".settings-poll-cancel").addEventListener("click", async () => {
    stopSettingsPoll();
    try { renderSettings(ov, await fetchSettings()); } catch {}
  });

  try {
    const r = await fetch(`${API_BASE}/settings/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: targetEmail || "" }) });
    if (!r.ok) throw new Error(`로그인 시작 실패 (HTTP ${r.status})`);
  } catch (e) {
    poll.querySelector(".settings-poll-title").textContent = "⚠️ " + e.message;
    return;
  }

  // 완료 감지: email이 이전과 달라지거나 목표 이메일과 같아지면 완료 (~3분 타임아웃)
  const t0 = Date.now();
  stopSettingsPoll();
  _settingsPoll = setInterval(async () => {
    if (Date.now() - t0 > 180000) {
      stopSettingsPoll();
      poll.querySelector(".settings-poll-title").textContent = "시간이 초과됐어요 — 승인 창을 확인하거나 다시 시도하세요.";
      poll.querySelector(".settings-poll-cancel").textContent = "닫기";
      return;
    }
    let s;
    try { s = await fetchSettings(); } catch { return; }
    const cur = s.auth && s.auth.email;
    const done = s.auth && s.auth.loggedIn && cur &&
      ((targetEmail && cur.toLowerCase() === targetEmail.toLowerCase()) || (prevEmail && cur !== prevEmail) || (!prevEmail));
    if (done) {
      stopSettingsPoll();
      renderSettings(ov, s);
      hideError();
    }
  }, 2000);
}
document.getElementById("settings-btn").addEventListener("click", openSettings);

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
  fileInput.value = "";
  // 진행 중인 분석이 있으면 취소하지 않고 대기열에 붙는다(순서대로 자동 진행)
  enqueueJobs([{ kind: "file", file, title: file.name.replace(/\.pdf$/i, ""), mode }]);
}

// 업로드→SSE→렌더 코어 (단일/일괄 큐 공용). label: 큐 진행 표시("(2/5) 제목").
// 반환: { ok, error?, aborted? } — 큐가 이어갈지/멈출지 판단하는 데 쓴다.
async function runUpload(file, mode, label) {
  clearResume(); // 새 분석 시작 = 대기 중이던 자동 재개 예약 취소(수동 조작 우선)
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
    // 대기열 진행 중 사용자가 수동으로 다른 논문을 열었으면 읽고 있는 화면을 가로채지 않는다
    if (queueNavigated) {
      loadHistory();
      return { ok: true };
    }
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
    // 세션 한도: 호출부(단일/큐)가 리셋 후 재개를 예약하도록 표식만 얹어 반환(빨간 에러는 표시 안 함)
    if (e.limit) return { ok: false, limit: e.limit, error: e.message };
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

// 단일 업로드 + 세션 한도 시 자동 재개(리셋 후 스스로 다시 시도). analyzeFile이 사용.

// ── 분석 대기열 ────────────────────────────────────────────────────────────
// 분석 중에 새 논문을 주면 진행 중인 것을 취소하지 않고 대기열에 넣어 '추가된 순서대로' 잇는다.
// 한 번에 여러 개를 드롭한 경우도 같은 대기열로 흘려보내 경로를 하나로 통일한다.
// jobQueue[0]은 '지금 돌고 있는 편'(진행 중에는 shift하지 않고 peek) — 사이드바는 그 뒤부터 보여준다.
const jobQueue = []; // { kind:"file"|"url", file?, url?, title, mode }
let queueRunning = false;
let queueDone = 0; // 이번 대기열에서 끝낸 편 수(라벨 "(2/5)"용) — 비면 0으로 초기화
let queueNavigated = false; // 대기열 진행 중 사용자가 수동으로 다른 논문을 열었나(화면 가로채기 방지)
const queueFailures = [];

function enqueueJobs(jobs) {
  if (!jobs.length) return;
  jobQueue.push(...jobs);
  renderQueue();
  if (!queueRunning) drainQueue();
}
function renderQueue() {
  const box = document.getElementById("sb-queue");
  if (!box) return;
  const pending = queueRunning ? jobQueue.slice(1) : jobQueue.slice(0);
  box.innerHTML = "";
  box.classList.toggle("hidden", !pending.length);
  if (!pending.length) return;
  const head = document.createElement("li");
  head.className = "sb-queue-head";
  head.textContent = `대기 중 ${pending.length}편 — 순서대로 진행`;
  box.appendChild(head);
  pending.forEach((job) => {
    const li = document.createElement("li");
    li.className = "sb-queue-item";
    const t = document.createElement("span");
    t.className = "sb-queue-title";
    t.textContent = job.title;
    t.title = job.title;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sb-queue-x";
    x.textContent = "×";
    x.title = "대기 취소";
    x.addEventListener("click", () => {
      const i = jobQueue.indexOf(job);
      if (i >= 0) { jobQueue.splice(i, 1); renderQueue(); }
    });
    li.append(t, x);
    box.appendChild(li);
  });
}
// 대기열을 순서대로 비운다. 개별 취소는 그 편만 건너뛰고 계속, 세션 한도는 남은 전체를 리셋 후 재개.
async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  queueNavigated = false;
  try {
    while (jobQueue.length) {
      const job = jobQueue[0]; // 진행 중 표시를 위해 아직 빼지 않는다
      renderQueue();
      const total = queueDone + jobQueue.length;
      const label = total > 1 ? `(${queueDone + 1}/${total}) ${job.title}` : job.title;
      const r =
        job.kind === "url"
          ? await runAnalyzeUrl(job.url, job.title, job.mode, label)
          : await runUpload(job.file, job.mode, label);
      // 세션 한도: 이 편을 대기열 맨 앞에 남긴 채 리셋 시각에 자동 재개
      if (r && r.limit) {
        renderQueue();
        scheduleResume(r.limit, () => drainQueue(), `대기 ${jobQueue.length}편`);
        return;
      }
      jobQueue.shift();
      queueDone++;
      if (r && !r.ok && !r.aborted) {
        queueFailures.push(job.title);
        appendLoadingLog(`✗ ${job.title}: ${(r.error || "실패").slice(0, 80)}`);
      }
      renderQueue();
    }
    if (queueFailures.length) {
      showError(`대기열 완료 — ${queueFailures.length}편 실패: ${queueFailures.join(", ")}`);
      queueFailures.length = 0;
    }
    queueDone = 0;
    loadHistory();
  } finally {
    queueRunning = false;
    renderQueue();
  }
}

// 여러 논문을 한 번에 드롭/선택 — 모드 한 번만 물어 전부 대기열에 넣는다.
async function analyzeQueue(files) {
  const pdfs = [...files].filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return showError("PDF 파일만 업로드할 수 있습니다.");
  if (pdfs.length === 1) return analyzeFile(pdfs[0]);
  hideError();
  const mode = await showModeDialog(`${pdfs.length}편 일괄 분석`, null);
  if (!mode) { fileInput.value = ""; return; }
  ensureNotifyPermission();
  fileInput.value = "";
  enqueueJobs(pdfs.map((f) => ({ kind: "file", file: f, title: f.name.replace(/\.pdf$/i, ""), mode })));
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

// ── 세션 한도 자동 재개 ─────────────────────────────────────────────────
// 구독 사용량 한도에 걸리면 서버가 보낸 리셋 시각까지 기다렸다 자동으로 다시 분석한다.
// 클라이언트 구동(탭이 열려 있어야 함) — "밤에 여러 편 걸어두고 자기"를 지원.
const _resume = { timer: null, fireAt: 0, fn: null };
function fmtRemain(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function clearResume() {
  if (_resume.timer) clearInterval(_resume.timer);
  _resume.timer = null;
  _resume.fn = null;
  document.getElementById("limit-banner").classList.add("hidden");
}
function scheduleResume(info, resumeFn, contextLabel) {
  clearResume();
  const RESET_BUFFER = 60 * 1000;      // 리셋 직후 여유 60초 (경계에서 재실패 방지)
  const UNKNOWN_WAIT = 20 * 60 * 1000; // 리셋 시각 미상이면 20분 후 재시도
  _resume.fireAt = info && info.resetAt ? info.resetAt + RESET_BUFFER : Date.now() + UNKNOWN_WAIT;
  _resume.fn = resumeFn;
  const when = info && info.resetText ? `${info.resetText}에 자동 재개` : "잠시 후 자동 재개";
  document.getElementById("limit-when").textContent = (contextLabel ? contextLabel + " · " : "") + when;
  document.getElementById("limit-banner").classList.remove("hidden");
  const tick = () => {
    const rem = _resume.fireAt - Date.now();
    if (rem <= 0) { fireResumeNow(); return; }
    document.getElementById("limit-countdown").textContent = `${fmtRemain(rem)} 후`;
  };
  _resume.timer = setInterval(tick, 1000);
  tick();
  notifyLimit(when); // 백그라운드 탭이면 데스크톱 알림
}
function fireResumeNow() {
  const fn = _resume.fn;
  clearResume();
  if (fn) { notifyResumeStart(); fn(); }
}
// limit 에러면 자동 재개를 예약하고 true 반환. 아니면 false(호출부가 기존 에러 처리).
function maybeScheduleResume(err, resumeFn, contextLabel) {
  if (err && err.limit) { scheduleResume(err.limit, resumeFn, contextLabel); return true; }
  return false;
}
function notifyLimit(when) {
  if (!document.hidden) return;
  try {
    if ("Notification" in window && Notification.permission === "granted")
      new Notification("⏳ 구독 한도 도달", { body: `${when} 예정`, tag: "paper-reviewer-limit" });
  } catch {}
}
function notifyResumeStart() {
  try {
    if ("Notification" in window && Notification.permission === "granted")
      new Notification("▶️ 분석 자동 재개", { body: "구독 한도가 풀려 분석을 다시 시작합니다.", tag: "paper-reviewer-limit" });
  } catch {}
}
document.getElementById("limit-resume-now").addEventListener("click", fireResumeNow);
document.getElementById("limit-cancel").addEventListener("click", () => {
  clearResume();
  showError("자동 재개를 취소했습니다. 한도가 풀린 뒤 다시 분석해 주세요.");
});

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
      } else if (ev.type === "limit") {
        // 구독 세션 한도 — 리셋 시각을 error에 실어 던지면 호출부가 자동 재개를 예약한다
        stopEta(false);
        const err = new Error(ev.error || "구독 세션 한도에 도달했습니다.");
        err.limit = { resetAt: ev.resetAt || null, resetText: ev.resetText || null };
        throw err;
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
let pdfCurrentPage = 1; // 스크롤 위치 기준 현재 페이지(헤더 표시·국소 탐색 시작점)
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
  pdfCurrentPage = 1;
  document.getElementById("pdf-page-total").textContent = "–";
  setCurrentPageLabel("–");
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
    pdfCurrentPage = 1;
    document.getElementById("pdf-page-total").textContent = doc.numPages;
    setCurrentPageLabel(1);
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

// ── 트랙패드 핀치 줌 ─────────────────────────────────────────────────────
// macOS 크롬/엣지의 핀치는 ctrlKey+wheel로 들어온다(마우스 Ctrl+휠도 동일 경로).
// 커서 아래 지점이 고정되도록 줌 후 스크롤을 보정하고, 캔버스 재렌더 비용 제어를 위해
// 90ms 간격으로 커밋(그 사이 델타는 누적). 기존 setPdfZoom 재사용 — 점프/체크/검색 무영향.
function zoomAtPoint(targetZoom, clientX, clientY) {
  if (!pdfDoc || !pdfBaseW) return;
  const rect = pdfScroll.getBoundingClientRect();
  const offX = clientX - rect.left;
  const offY = clientY - rect.top;
  const prevTop = pdfScroll.scrollTop;
  const prevLeft = pdfScroll.scrollLeft;
  const before = pdfZoom;
  setPdfZoom(targetZoom); // 내부에서 scrollTop을 top 기준 비례 보정
  const factor = pdfZoom / before;
  if (factor === 1) return;
  // top-left 비례 보정을 '커서 지점 고정'으로 재보정
  pdfScroll.scrollTop = (prevTop + offY) * factor - offY;
  pdfScroll.scrollLeft = (prevLeft + offX) * factor - offX;
}
let _pinchAccum = 1;
let _pinchLast = 0;
let _pinchTrail = 0;
function pinchZoomTo(scaleDelta, clientX, clientY) {
  _pinchAccum *= scaleDelta;
  const commit = () => {
    if (_pinchAccum === 1) return;
    const t = pdfZoom * _pinchAccum;
    _pinchAccum = 1;
    _pinchLast = performance.now();
    zoomAtPoint(t, clientX, clientY);
  };
  clearTimeout(_pinchTrail);
  if (performance.now() - _pinchLast > 90) commit();
  else _pinchTrail = setTimeout(commit, 100); // 마지막 델타 유실 방지(트레일링 커밋)
}
pdfScroll.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !pdfDoc) return; // 일반 스크롤·두 손가락 팬은 그대로
  e.preventDefault(); // 브라우저 페이지 줌 방지
  // 트랙패드 핀치는 작은 델타 연속(±1~10), 마우스 Ctrl+휠은 틱당 ±100+ —
  // 이벤트당 배율을 [0.85, 1.18]로 클램프해 마우스에서도 과격하게 튀지 않게.
  const factor = Math.min(1.18, Math.max(0.85, Math.exp(-e.deltaY * 0.012)));
  pinchZoomTo(factor, e.clientX, e.clientY);
}, { passive: false });
// Safari는 핀치를 gesture* 이벤트로 준다
let _gestureBaseZoom = null;
pdfScroll.addEventListener("gesturestart", (e) => { if (!pdfDoc) return; e.preventDefault(); _gestureBaseZoom = pdfZoom; });
pdfScroll.addEventListener("gesturechange", (e) => {
  if (_gestureBaseZoom == null) return;
  e.preventDefault();
  pinchZoomTo((_gestureBaseZoom * e.scale) / (pdfZoom * _pinchAccum), e.clientX, e.clientY);
});
pdfScroll.addEventListener("gestureend", (e) => { if (_gestureBaseZoom == null) return; e.preventDefault(); _gestureBaseZoom = null; });
document.getElementById("pdf-zoom-reset").addEventListener("click", () => setPdfZoom(1));

// ── 현재 페이지 표시 + 페이지 점프 ───────────────────────────────────────
// 헤더의 "N / 전체" 입력에 스크롤 위치 기준 현재 페이지를 표시하고, 숫자 입력→Enter로 이동.
const pdfPageCurEl = document.getElementById("pdf-page-cur");
function setCurrentPageLabel(n) {
  if (typeof n === "number") pdfCurrentPage = n;
  // 사용자가 입력 중(포커스)일 땐 덮어쓰지 않는다
  if (pdfPageCurEl && document.activeElement !== pdfPageCurEl) pdfPageCurEl.value = String(n);
}
// 스크롤 위치의 '읽는 줄'(상단에서 ~30%)에 걸린 페이지를 이전 현재값 주변에서 국소 탐색
// (600p 논문에서도 매 스크롤마다 전체 순회하지 않도록).
function updateCurrentPage() {
  if (!pdfDoc || !pdfPageEls.size) return;
  const sr = pdfScroll.getBoundingClientRect();
  const anchorY = sr.top + Math.min(140, sr.height * 0.3);
  const topOf = (k) => { const w = pdfPageEls.get(k); return w ? w.getBoundingClientRect().top : Infinity; };
  let n = Math.min(pdfDoc.numPages, Math.max(1, pdfCurrentPage));
  while (n > 1 && topOf(n) > anchorY) n--;
  while (n < pdfDoc.numPages && topOf(n + 1) <= anchorY) n++;
  setCurrentPageLabel(n);
}
let _pdfPageRaf = 0;
function updateCurrentPageSoon() {
  if (_pdfPageRaf) return;
  _pdfPageRaf = requestAnimationFrame(() => { _pdfPageRaf = 0; updateCurrentPage(); });
}
function scrollToPdfPage(n) {
  if (!pdfDoc) return;
  n = Math.max(1, Math.min(pdfDoc.numPages, Math.round(n)));
  const wrap = pdfPageEls.get(n);
  if (!wrap) return;
  const sr = pdfScroll.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  pdfScroll.scrollTop = pdfScroll.scrollTop + (wr.top - sr.top) - 8;
  setCurrentPageLabel(n);
}
pdfScroll.addEventListener("scroll", updateCurrentPageSoon, { passive: true });
if (pdfPageCurEl) {
  pdfPageCurEl.addEventListener("focus", () => pdfPageCurEl.select());
  pdfPageCurEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = parseInt(pdfPageCurEl.value, 10);
      if (Number.isFinite(v)) scrollToPdfPage(v);
      pdfPageCurEl.blur();
    } else if (e.key === "Escape") {
      pdfPageCurEl.blur();
    }
  });
  pdfPageCurEl.addEventListener("blur", () => setCurrentPageLabel(pdfCurrentPage)); // 표시 복원
}

// ── 더블클릭 줌 토글 ────────────────────────────────────────────────────
// PDF를 더블클릭하면 폭 맞춤(100%) ↔ 150%를 커서 지점 기준으로 오간다. 핀치 줌과 세트.
pdfScroll.addEventListener("dblclick", (e) => {
  if (!pdfDoc || !pdfBaseW) return;
  e.preventDefault();
  const target = pdfZoom > 1.05 ? 1 : 1.5;
  zoomAtPoint(target, e.clientX, e.clientY);
});

// ── PDF 다크 모드 토글 ──────────────────────────────────────────────────
// 저장된 설정이 없으면 앱 읽기 테마가 다크일 때 PDF도 다크로 시작.
let pdfDark = (() => {
  const saved = localStorage.getItem("pdfDark");
  if (saved === "1") return true;
  if (saved === "0") return false;
  return document.documentElement.dataset.theme === "dark";
})();
function applyPdfDark() {
  pdfScroll.classList.toggle("pdf-dark", pdfDark);
  const btn = document.getElementById("pdf-dark-toggle");
  if (btn) {
    btn.textContent = pdfDark ? "☀️" : "🌙";
    btn.title = pdfDark ? "PDF 밝게 (기본 배경)" : "PDF 다크 모드 (야간 읽기)";
    btn.setAttribute("aria-pressed", pdfDark ? "true" : "false");
  }
}
document.getElementById("pdf-dark-toggle").addEventListener("click", () => {
  pdfDark = !pdfDark;
  localStorage.setItem("pdfDark", pdfDark ? "1" : "0");
  applyPdfDark();
});
applyPdfDark();

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

// 사이드바 열기/접기 — 데스크톱은 폭 접기(localStorage 저장), 모바일(≤820px)은 오버레이 드로어
let closeMobileSidebar = () => {};
(() => {
  const app = document.querySelector(".app");
  const mq = window.matchMedia("(max-width: 820px)");
  const isMobile = () => mq.matches;
  const setCollapsed = (c) => {
    app.classList.toggle("sb-collapsed", c);
    localStorage.setItem("sbCollapsed", c ? "1" : "0");
  };
  const openMobile = (o) => app.classList.toggle("sb-mobile-open", o);
  closeMobileSidebar = () => openMobile(false);
  document.getElementById("sb-collapse").addEventListener("click", () => {
    if (isMobile()) openMobile(false); else setCollapsed(true);
  });
  document.getElementById("sb-open").addEventListener("click", () => {
    if (isMobile()) openMobile(true); else setCollapsed(false);
  });
  document.getElementById("sb-overlay").addEventListener("click", () => openMobile(false));
  // 데스크톱↔모바일 뷰포트 전환 시 드로어 상태 리셋(모바일 드로어가 데스크톱에 남지 않게)
  const onMq = () => openMobile(false);
  if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
  setCollapsed(localStorage.getItem("sbCollapsed") === "1"); // 데스크톱 저장 상태(모바일에선 시각적으로 무시)
})();

// 사이드바 "새 논문 분석" → 워크스페이스 닫고 드롭존으로
document.getElementById("sb-new").addEventListener("click", () => {
  // 진행 중이던 분석/재생성/채팅 답변을 중단(N 단축키로도 호출되므로 사용량 누수 방지)
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; }
  if (chatAbort) chatAbort.abort();
  clearResume(); // 대기 중이던 세션 한도 자동 재개 예약도 취소
  closeMobileSidebar(); // 모바일 드로어 닫기
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
  const label = title || url.replace(/^https?:\/\//, "");
  const mode = await showModeDialog(label, null);
  if (!mode) return;
  ensureNotifyPermission();
  // 업로드와 같은 대기열을 쓴다 — 진행 중이면 취소 대신 뒤에 붙는다
  enqueueJobs([{ kind: "url", url, title: label, mode }]);
}
// 반환값은 runUpload와 동일한 { ok, aborted?, limit?, error? } — 대기열이 한 방식으로 처리한다.
async function runAnalyzeUrl(url, title, mode, label) {
  clearResume(); // 새 분석 시작 = 대기 중이던 자동 재개 예약 취소
  workspaceEl.classList.add("hidden");
  loadingEl.classList.remove("hidden");
  setActiveAnalysis(label || title || "arXiv 논문");
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
    // 대기열 진행 중 사용자가 수동으로 다른 논문을 열었으면 화면을 가로채지 않는다(알림·히스토리로만)
    if (queueNavigated) {
      loadHistory();
      return { ok: true };
    }
    if (analysisPartialShown) {
      const keep = activeTab;
      renderResult(data);
      switchTab(keep);
    } else {
      renderResult(data);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    loadHistory();
    return { ok: true };
  } catch (e) {
    if (e.name === "AbortError") { loadHistory(); return { ok: false, aborted: true }; }
    // 세션 한도는 대기열이 리셋 후 재개하도록 표식만 얹어 반환(빨간 에러는 표시 안 함)
    if (e.limit) { workspaceEl.classList.toggle("hidden", !currentHash); return { ok: false, limit: e.limit, error: e.message }; }
    showError(e.message);
    workspaceEl.classList.toggle("hidden", !currentHash);
    return { ok: false, error: e.message };
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

  // 작업 A: 논문의 원본 방법 그림(architecture/method kind 크롭)을 접이식으로 대조 표시.
  // 재구성 시각화 ↔ 논문 실제 Figure를 오가며 볼 수 있게 — 세미나에선 결국 원문 그림으로 설명한다.
  const origBlock = buildMethodOrigFigures(data);
  if (origBlock) panel.appendChild(origBlock);

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
  attachStepDeepLinks(data); // 작업 C: 스테퍼 각 단계 → 강독 해당 절 점프 링크
  // 📎 부록 — 초기 분석은 본문까지만 다루므로, 필요할 때만 따로 생성한다(온디맨드).
  // 논문 전체의 부록이지만 '온디맨드 심화 분석'을 한자리에 모으려고 강독 아래에 둔다.
  panel.appendChild(buildAppendixBlock(data));
}

// ---------- 부록(Appendix) 온디맨드 분석 ----------
// 초기 분석(간단·정밀 모두)은 본문까지만 본다. 부록이 필요하면 여기서 생성 → analysis.appendix에
// 영구 저장되고 다음부터는 바로 렌더된다. 강독(mdeep-*)과 같은 스타일을 재사용한다.
let appendixBusy = false;
function buildAppendixBlock(data) {
  const wrap = document.createElement("section");
  wrap.className = "mdeep";
  wrap.id = "appendix-block";
  const ap = data.appendix;

  const head = document.createElement("div");
  head.className = "mdeep-head";
  const title = document.createElement("h3");
  title.className = "mdeep-title";
  title.textContent = "📎 부록 (Appendix)";
  const sub = document.createElement("span");
  sub.className = "mdeep-sub muted";
  sub.textContent = "본문 분석에는 포함되지 않는 부분 — 필요할 때만 따로 정리합니다";
  head.append(title, sub);
  wrap.appendChild(head);

  if (ap && Array.isArray(ap.sections) && ap.sections.length) {
    ap.sections.forEach((s) => {
      const det = document.createElement("details");
      det.className = "mdeep-sec";
      const sum = document.createElement("summary");
      sum.className = "mdeep-ref";
      sum.textContent = s.ref || "(제목 없음)";
      if (s.page) {
        const pg = document.createElement("button");
        pg.type = "button";
        pg.className = "mdeep-page";
        pg.textContent = `p.${s.page} ↗`;
        pg.title = "원문의 이 부록 절로 이동";
        pg.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          jumpToPdfPageText(s.page, (s.ref || "").replace(/^[\d.A-Z\s]+/, "").slice(0, 30));
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
    regen.textContent = "🔄 부록 다시 정리";
    regen.addEventListener("click", () => generateAppendix(wrap, true));
    wrap.appendChild(regen);
  } else if (ap && ap.none) {
    const p = document.createElement("p");
    p.className = "muted mdeep-desc";
    p.textContent = "이 논문에는 부록이 없습니다.";
    wrap.appendChild(p);
  } else {
    const desc = document.createElement("p");
    desc.className = "muted mdeep-desc";
    desc.textContent = "부록·보충자료(증명, 추가 실험, 하이퍼파라미터 표 등)를 절 구조대로 정리합니다. 원문에서 부록 부분만 읽어 생성해요.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rtool mdeep-btn";
    btn.textContent = "📎 부록 분석하기 (1~3분)";
    btn.addEventListener("click", () => generateAppendix(wrap, false));
    wrap.append(desc, btn);
  }
  return wrap;
}
async function generateAppendix(wrap, force) {
  if (!currentHash || appendixBusy) return;
  if (force && !confirm("부록을 다시 정리할까요? (1~3분, 기존 정리를 교체)")) return;
  appendixBusy = true;
  const startedHash = currentHash;
  wrap.querySelectorAll(".mdeep-btn, .mdeep-desc").forEach((el) => el.remove());
  const stat = document.createElement("p");
  stat.className = "mdeep-stat";
  stat.textContent = "⏳ 준비 중…";
  wrap.appendChild(stat);
  try {
    const res = await fetch(`${API_BASE}/api/appendix/${startedHash}`, {
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
    currentAnalysis.appendix = data;
    wrap.replaceWith(buildAppendixBlock(currentAnalysis));
  } catch (e) {
    stat.textContent = `⚠️ ${e.message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "rtool mdeep-btn";
    retry.textContent = "📎 다시 시도";
    retry.addEventListener("click", () => { stat.remove(); retry.remove(); generateAppendix(wrap, force); });
    wrap.appendChild(retry);
  } finally {
    appendixBusy = false;
  }
}

// ---------- 작업 C: 스테퍼 ↔ 정밀 강독 연동 ----------
// 각 단계에 [🔬 강독에서 자세히] 링크를 달아 강독의 해당 절로 점프한다.
// 매칭: 단계 title 토큰이 절(ref + body 앞부분)에 몇 개 등장하는지(부분 문자열 —
// 한국어 조사 결합 대응)로 최대 절 선택. 전부 0이면 순서 비례 폴백.
// 강독 생성/재생성 후에도 다시 불러 갱신할 수 있게 멱등으로 만든다.
function attachStepDeepLinks(data) {
  const panel = document.getElementById("panel-method");
  if (!panel) return;
  panel.querySelectorAll(".step-deep-link").forEach((el) => el.remove()); // 멱등
  const deep = data && data.method_deep;
  const sections = deep && Array.isArray(deep.sections) ? deep.sections : [];
  const steps = Array.isArray(data && data.method_steps) ? data.method_steps : [];
  if (!sections.length || !steps.length) return; // 강독이 없으면 링크도 없음

  // 절별 매칭용 텍스트 (ref + body 앞 200자, 소문자)
  const secText = sections.map((s) => `${(s && s.ref) || ""} ${String((s && s.body) || "").slice(0, 200)}`.toLowerCase());
  const tokensOf = (t) =>
    String(t || "").toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length >= 2);

  panel.querySelectorAll(".stepper > li").forEach((li, i) => {
    const step = steps[i];
    if (!step) return;
    // 토큰 겹침 최대 절
    const toks = tokensOf(step.title);
    let best = -1, bestScore = 0;
    secText.forEach((txt, si) => {
      const score = toks.reduce((n, w) => n + (txt.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = si; }
    });
    // 전부 실패 → 순서 비례 (i번째 단계 → ⌈(i+1)×절수/단계수⌉번째 절)
    const idx = best >= 0 ? best : Math.min(sections.length - 1, Math.ceil(((i + 1) * sections.length) / steps.length) - 1);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "step-deep-link";
    btn.textContent = "🔬 강독에서 자세히";
    btn.title = `정밀 강독 "${(sections[idx] && sections[idx].ref) || ""}" 절로 이동`;
    btn.addEventListener("click", () => {
      const det = panel.querySelectorAll(".mdeep-sec")[idx];
      if (!det) return;
      det.open = true;
      det.scrollIntoView({ behavior: "smooth", block: "start" });
      det.classList.remove("eq-flash");
      void det.offsetWidth; // 애니메이션 재시작
      det.classList.add("eq-flash");
      setTimeout(() => det.classList.remove("eq-flash"), 1300);
    });
    li.appendChild(btn);
  });
}

// ---------- 작업 A: 원본 방법 그림 대조 블록 ----------
// figure_guide에서 방법 관련 그림(kind architecture/method, 폴백: section_ref가 가리키는
// Figure 라벨)을 골라 접이식으로 표시. 이미지는 처음 펼칠 때만 로드(크롭 생성 비용 절약).
function buildMethodOrigFigures(data) {
  const figs = Array.isArray(data.figure_guide) ? data.figure_guide : [];
  let picks = figs.filter((f) => f && f.page && (f.kind === "architecture" || f.kind === "method"));
  if (!picks.length && data.method_visualization && data.method_visualization.section_ref) {
    // 폴백: section_ref 안의 "Fig. 2"/"Figure 2" 라벨을 figure_guide에서 찾는다
    const nums = [...String(data.method_visualization.section_ref).matchAll(/fig(?:ure)?\.?\s*(\d+)/gi)].map((m) => m[1]);
    picks = figs.filter((f) => {
      const n = ((f && f.label) || "").match(/\d+/);
      return f && f.page && n && nums.includes(n[0]) && /fig/i.test(f.label);
    });
  }
  if (!picks.length || !currentHash) return null;
  picks = picks.slice(0, 4); // 과밀 방지

  const det = document.createElement("details");
  det.className = "mviz-orig";
  const sum = document.createElement("summary");
  sum.textContent = `📄 논문의 원본 그림과 대조 (${picks.length}장)`;
  sum.title = "아래 재구성 시각화와 논문의 실제 Figure를 나란히 비교";
  det.appendChild(sum);
  const row = document.createElement("div");
  row.className = "mviz-orig-row";
  picks.forEach((f) => {
    const cell = document.createElement("figure");
    cell.className = "mviz-orig-cell";
    const img = document.createElement("img");
    img.alt = `${f.label} 원문 이미지`;
    img.title = "클릭하면 원문의 이 그림으로 이동";
    const bbox =
      Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox.every((n) => Number.isFinite(Number(n)))
        ? f.bbox.map(Number)
        : [0.05, 0.05, 0.95, 0.95]; // bbox 없으면 전면 힌트 — 서버 실측 레이어가 좁혀 잡는다
    img.dataset.src = `${API_BASE}/api/figure/${currentHash}?page=${f.page}&box=${bbox.join(",")}&label=${encodeURIComponent(f.label || "")}`;
    img.addEventListener("click", () => jumpToPdfPageText(f.page, f.label || ""));
    img.addEventListener("error", () => {
      cell.innerHTML = '<span class="muted">그림을 불러오지 못했습니다 — 원문에서 확인하세요.</span>';
    });
    const cap = document.createElement("figcaption");
    cap.textContent = `${f.label}${f.takeaway ? " — " + f.takeaway : ""}`;
    cell.append(img, cap);
    row.appendChild(cell);
  });
  det.appendChild(row);
  // 처음 펼칠 때만 크롭 로드 (안 보는 논문의 크롭을 만들지 않음 — 그림 탭과 동일 원칙)
  det.addEventListener("toggle", () => {
    if (!det.open) return;
    det.querySelectorAll("img[data-src]").forEach((im) => {
      im.src = im.dataset.src;
      im.removeAttribute("data-src");
    });
  }, { once: false });
  return det;
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
    attachStepDeepLinks(currentAnalysis); // 작업 C: 방금 생긴 강독으로 스테퍼 링크 갱신
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
  saveReadPos(currentHash, { tab: name }); // 마지막 탭만 기억 (읽음 점 표시는 제거됨)
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
  // 하위 폴더 지원: 부모별로 묶어 트리로 렌더한다. 카운트는 '자기 논문 + 모든 하위 폴더 논문'
  // 이라 접어둔 폴더의 총량이 보인다. 검색 중에는 매칭된 것이 하나도 없는 가지를 통째로 숨긴다.
  const childrenOf = (pid) => library.folders.filter((x) => (x.parent || null) === (pid || null));
  const visibleCountOf = (folder) => {
    const own = historyItems.filter((it) => folderOf(it.hash) === folder.id).filter(matches).length;
    return own + childrenOf(folder.id).reduce((n, c) => n + visibleCountOf(c), 0);
  };
  const totalCountOf = (folder) => {
    const own = historyItems.filter((it) => folderOf(it.hash) === folder.id).length;
    return own + childrenOf(folder.id).reduce((n, c) => n + totalCountOf(c), 0);
  };
  const renderGroup = (folder, depth) => {
    const fid = folder ? folder.id : null;
    const key = fid || UNFILED;
    const members = historyItems.filter((it) => folderOf(it.hash) === fid);
    const kids = folder ? childrenOf(folder.id) : [];
    if (!folder && !members.length) return; // 미분류는 비어 있으면 머리글 생략
    const visible = members.filter(matches);
    // 검색 중: 이 폴더도 하위 폴더도 매칭이 없으면 가지 전체를 숨긴다
    if (f && folder && visibleCountOf(folder) === 0) return;
    if (f && !folder && !visible.length) return;
    const collapsed = !f && collapsedFolders.has(key);
    const count = folder ? (f ? visibleCountOf(folder) : totalCountOf(folder)) : (f ? visible.length : members.length);
    historyList.appendChild(buildFolderHead(folder, count, collapsed, depth));
    if (collapsed) return;
    if (folder) kids.forEach((k) => renderGroup(k, depth + 1)); // 하위 폴더 먼저, 그 아래 논문
    if (!visible.length) {
      if (!kids.length) { // 하위 폴더도 논문도 없을 때만 '비어 있음'
        const empty = document.createElement("li");
        empty.className = "sb-folder-empty muted";
        empty.textContent = "(비어 있음 — 논문을 끌어다 놓거나 📁로 옮기세요)";
        empty.style.paddingLeft = `${10 + depth * 12}px`;
        historyList.appendChild(empty);
      }
    } else {
      visible.forEach((it) => {
        const li = buildHistoryItem(it);
        if (depth > 0) li.style.paddingLeft = `${10 + depth * 12}px`; // 하위 폴더의 논문도 들여쓴다
        historyList.appendChild(li);
      });
    }
  };
  childrenOf(null).forEach((folder) => renderGroup(folder, 0)); // 최상위 폴더부터 트리로
  renderGroup(null, 0); // 미분류
}

function buildFolderHead(folder, count, collapsed, depth = 0) {
  const fid = folder ? folder.id : null;
  const key = fid || UNFILED;
  const li = document.createElement("li");
  li.className = "sb-folder" + (collapsed ? " collapsed" : "");
  li.dataset.folderHead = key;
  if (depth > 0) li.style.paddingLeft = `${8 + depth * 12}px`; // 중첩 단계만큼 들여쓰기
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
    const depthOf = (fo) => { let d = 0, p = fo.parent; while (p) { const up = library.folders.find((x) => x.id === p); if (!up) break; d++; p = up.parent; } return d; };
    li.append(mk("✎", "폴더 이름 변경", () => renameFolder(folder)));
    // 깊이 상한(서버 MAX_FOLDER_DEPTH=3, 최대 4단계)에 닿으면 하위 폴더 버튼을 숨긴다
    if (depthOf(folder) < 3) li.append(mk("＋", "이 폴더 안에 하위 폴더 만들기", () => createFolder(folder.id)));
    li.append(
      mk("⤵", "이 폴더를 다른 폴더 안으로 이동", (e) => openFolderParentMenu(folder, li)),
      mk("×", "폴더 삭제(하위 폴더·논문은 한 단계 위로 이동)", () => deleteFolder(folder))
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
// parentId를 주면 그 폴더의 하위 폴더로 만든다(없으면 최상위).
function createFolder(parentId = null) {
  const parent = parentId ? library.folders.find((x) => x.id === parentId) : null;
  const name = (prompt(parent ? `'${parent.name}' 안에 만들 하위 폴더 이름` : "새 폴더 이름") || "").trim();
  if (!name) return;
  library.folders.push({ id: newFolderId(), name: name.slice(0, 60), parent: parent ? parent.id : null });
  if (parent) collapsedFolders.delete(parent.id), saveCollapsed(); // 새 하위 폴더가 보이게 부모를 펼친다
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
// 폴더만 지우고 내용물은 보존한다 — 하위 폴더와 논문을 '한 단계 위'로 승격(비파괴적).
function deleteFolder(folder) {
  const kids = library.folders.filter((x) => (x.parent || null) === folder.id);
  const papers = Object.values(library.assignments).filter((v) => v === folder.id).length;
  const up = folder.parent ? library.folders.find((x) => x.id === folder.parent) : null;
  const destName = up ? up.name : "미분류";
  // '으로/로' 조사 — 마지막 글자 종성 유무로 선택(ㄹ 받침은 '로'). 한글이 아니면 안전하게 '(으)로'.
  const ro = (() => {
    const ch = destName.trim().slice(-1).charCodeAt(0);
    if (!(ch >= 0xac00 && ch <= 0xd7a3)) return "(으)로";
    const jong = (ch - 0xac00) % 28;
    return jong === 0 || jong === 8 ? "로" : "으로";
  })();
  const parts = [];
  if (papers) parts.push(`논문 ${papers}편`);
  if (kids.length) parts.push(`하위 폴더 ${kids.length}개`);
  const msg =
    `'${folder.name}' 폴더를 삭제할까요?` +
    (parts.length ? `\n(안에 있던 ${parts.join("·")} → '${destName}'${ro} 이동, 삭제되지 않습니다)` : "");
  if (!confirm(msg)) return;
  const newParent = folder.parent || null;
  library.folders = library.folders.filter((x) => x.id !== folder.id);
  for (const k of library.folders) if ((k.parent || null) === folder.id) k.parent = newParent; // 하위 폴더 승격
  for (const h of Object.keys(library.assignments)) {
    if (library.assignments[h] === folder.id) {
      if (newParent) library.assignments[h] = newParent; // 부모 폴더로 이동
      else delete library.assignments[h]; // 최상위 폴더였으면 미분류
    }
  }
  collapsedFolders.delete(folder.id);
  saveCollapsed();
  saveLibrary();
  renderHistory();
}

// 폴더 자체를 다른 폴더 안으로 이동(또는 최상위로). 자기 자신·후손은 선택 대상에서 제외해
// 순환을 원천 차단하고, 깊이 상한을 넘는 대상도 막는다.
function openFolderParentMenu(folder, anchor) {
  closeFolderMenu();
  const descendants = new Set();
  const collect = (id) => library.folders.forEach((x) => { if ((x.parent || null) === id) { descendants.add(x.id); collect(x.id); } });
  collect(folder.id);
  const depthOf = (fo) => { let d = 0, p = fo.parent; while (p) { const u = library.folders.find((x) => x.id === p); if (!u) break; d++; p = u.parent; } return d; };
  const subtreeHeight = (id) => {
    const kids = library.folders.filter((x) => (x.parent || null) === id);
    return kids.length ? 1 + Math.max(...kids.map((k) => subtreeHeight(k.id))) : 0;
  };
  const height = subtreeHeight(folder.id); // 이 폴더 밑에 몇 단계가 딸려 있나
  const pathOf = (fo) => {
    const names = [fo.name];
    let p = fo.parent;
    while (p) { const u = library.folders.find((x) => x.id === p); if (!u) break; names.unshift(u.name); p = u.parent; }
    return names.join(" / ");
  };
  const menu = document.createElement("div");
  menu.className = "sb-foldermenu";
  menu.id = "sb-foldermenu";
  const row = (label, onClick, marked, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sb-fm-row" + (marked ? " marked" : "");
    b.textContent = (marked ? "✓ " : "") + label;
    if (disabled) { b.disabled = true; b.style.opacity = "0.4"; b.title = "깊이 제한(최대 4단계)을 넘습니다"; }
    else b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); closeFolderMenu(); });
    menu.appendChild(b);
  };
  const title = document.createElement("div");
  title.className = "sb-fm-title";
  title.textContent = `'${folder.name}'을(를) 옮길 위치`;
  menu.appendChild(title);
  row("📂 최상위", () => setFolderParent(folder, null), !folder.parent);
  library.folders
    .filter((fo) => fo.id !== folder.id && !descendants.has(fo.id))
    .forEach((fo) => row("📁 " + pathOf(fo), () => setFolderParent(folder, fo.id), folder.parent === fo.id, depthOf(fo) + 1 + height > 3));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 10)) + "px";
  menu.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 10)) + "px";
  setTimeout(() => document.addEventListener("click", closeFolderMenu, { once: true }), 0);
}
function setFolderParent(folder, parentId) {
  folder.parent = parentId || null;
  if (parentId) collapsedFolders.delete(parentId), saveCollapsed(); // 옮긴 결과가 보이게 부모 펼침
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
  // 하위 폴더는 "부모 / 자식" 경로로 보여 어디에 속한 폴더인지 알 수 있게 한다
  const pathOf = (fo) => {
    const names = [fo.name];
    let p = fo.parent;
    while (p) { const u = library.folders.find((x) => x.id === p); if (!u) break; names.unshift(u.name); p = u.parent; }
    return names.join(" / ");
  };
  library.folders.forEach((fo) => row("📁 " + pathOf(fo), () => moveToFolder(hash, fo.id), cur === fo.id));
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
    const folder = { id: newFolderId(), name: name.slice(0, 60), parent: null };
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
    // 세션 한도면 리셋 후 이 재분석을 자동 재개, 아니면 일반 에러 표시(취소는 조용히)
    if (!maybeScheduleResume(err, () => reanalyzePaper(hash, title, opts), title || "재분석")) {
      if (err.name !== "AbortError") showError(err.message);
    }
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
  closeMobileSidebar(); // 모바일: 히스토리에서 논문 선택 시 드로어 닫기
  // 저장된 결과 열람은 취소 대상이 아니다.
  // ⚠️ 대기열이 돌고 있으면 진행 중인 분석을 절대 건드리지 않는다 — 예전엔 히스토리를 열기만 해도
  // 분석이 취소됐다. 대신 '수동 이동' 표식을 남겨 완료 결과가 읽던 화면을 가로채지 않게 한다.
  if (queueRunning) {
    queueNavigated = true;
  } else if (analysisAbort) {
    analysisAbort.abort();
    analysisAbort = null;
    cancelBtn.classList.add("hidden");
    setActiveAnalysis(null);
  }
  if (sectionRegenAbort) { sectionRegenAbort.abort(); sectionRegenAbort = null; } // 진행 중 섹션 재생성 중단
  // 대기열이 돌고 있으면 '분석 중' 표시와 취소 버튼을 유지한다(분석이 계속되므로).
  if (!queueRunning) {
    cancelBtn.classList.add("hidden");
    setActiveAnalysis(null); // 취소된 흐름의 '분석 중' 표시 정리
    hideReanalyzeBanner();
  }
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
        if (!p || p.closest(".katex, code, pre, button, a, input, textarea, svg, iframe, .gloss-term, .eqflow-node")) {
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
}


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
  // 예상 소요: 서버 자가학습 예측(/api/eta?section= — 섹션별 실측 중앙값)을 우선 사용.
  // 응답 전·실패 시엔 현실화한 시드로 폴백(method는 시각화 자가검증 루프 포함이라 ~5분).
  const SECTION_EST_MS = { method: 300000, figures: 130000, equations: 90000, results: 90000, background: 90000, problem: 90000, seminar: 90000 };
  let estMs = SECTION_EST_MS[section] || 90000;
  fetch(`${API_BASE}/api/eta?section=${section}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && Number.isFinite(d.estMs) && d.estMs > 0) estMs = d.estMs; })
    .catch(() => {});
  // 진행 표시: [바 | 남은 시간] 한 줄 — 탭 바와 겹치지 않게 여백을 두고 패널 위에 삽입
  let regenBar = null, regenFill = null, regenEta = null, regenTimer = null;
  if (panel && panel.parentNode) {
    regenBar = document.createElement("div");
    regenBar.className = "regen-wrap";
    const track = document.createElement("div");
    track.className = "regen-bar";
    regenFill = document.createElement("div");
    regenFill.className = "regen-fill";
    track.appendChild(regenFill);
    regenEta = document.createElement("span");
    regenEta.className = "regen-eta";
    regenEta.textContent = "준비 중…";
    regenBar.append(track, regenEta);
    panel.parentNode.insertBefore(regenBar, panel); // 패널 바로 위(디밍 영향 없음)
  }
  const t0 = performance.now();
  const tickRegen = () => {
    const el = performance.now() - t0;
    const fRaw = el / estMs;
    const f = fRaw < 0.9 ? fRaw : 0.9 + 0.1 * (1 - Math.exp(-(fRaw - 0.9) * 2));
    if (regenFill) regenFill.style.width = `${Math.min(99, f * 100)}%`;
    if (regenEta) regenEta.textContent = fmtRemaining(estMs - el);
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
