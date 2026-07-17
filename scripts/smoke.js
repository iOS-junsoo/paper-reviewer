#!/usr/bin/env node
/**
 * smoke.js — 서버 재기동 후 "다 사는지" 5분 만에 확인하는 스모크 테스트.
 * LLM 비용이 드는 엔드포인트(분석·비교·대본·강독·질문)는 호출하지 않는다 — 읽기·상태 GET만.
 * 사용: node scripts/smoke.js [--host http://localhost:3000]
 * 종료코드: 하나라도 실패하면 1.
 */
const HOST = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 ? process.argv[i + 1] : "http://localhost:3000";
})();

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  (cond ? pass++ : fail++);
  results.push(`${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  return cond;
}
async function getJson(path) {
  const r = await fetch(HOST + path, { signal: AbortSignal.timeout(20000) });
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body, ct };
}

(async () => {
  // 1) 루트(정적 HTML)
  try {
    const r = await fetch(HOST + "/", { signal: AbortSignal.timeout(10000) });
    ok("GET / (앱 로드)", r.status === 200);
  } catch (e) { ok("GET / (앱 로드)", false, e.message); }

  // 2) 히스토리 목록
  let firstHash = null;
  try {
    const { status, body } = await getJson("/api/history");
    ok("GET /api/history", status === 200 && Array.isArray(body), `${Array.isArray(body) ? body.length + "편" : "형식오류"}`);
    if (Array.isArray(body) && body.length) firstHash = body[0].hash;
  } catch (e) { ok("GET /api/history", false, e.message); }

  // 3) 히스토리 단건 + PDF HEAD + 채팅 + 메모 (첫 논문 기준)
  if (firstHash) {
    try {
      const { status, body } = await getJson(`/api/history/${firstHash}`);
      ok("GET /api/history/:hash", status === 200 && body && body.hash === firstHash, body && body.title ? body.title.slice(0, 30) : "");
    } catch (e) { ok("GET /api/history/:hash", false, e.message); }
    try {
      const r = await fetch(`${HOST}/api/pdf/${firstHash}`, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      ok("HEAD /api/pdf/:hash", r.status === 200 || r.status === 404, `HTTP ${r.status}`);
    } catch (e) { ok("HEAD /api/pdf/:hash", false, e.message); }
    try {
      const { status, body } = await getJson(`/api/chat/${firstHash}`);
      ok("GET /api/chat/:hash", status === 200 && Array.isArray(body.messages));
    } catch (e) { ok("GET /api/chat/:hash", false, e.message); }
    try {
      const { status, body } = await getJson(`/api/notes/${firstHash}`);
      ok("GET /api/notes/:hash", status === 200 && "notes" in body && Array.isArray(body.bookmarks));
    } catch (e) { ok("GET /api/notes/:hash", false, e.message); }
  } else {
    ok("단건 테스트", false, "히스토리가 비어 건너뜀(분석된 논문 필요)");
  }

  // 4) 라이브러리(폴더)
  try {
    const { status, body } = await getJson("/api/library");
    ok("GET /api/library", status === 200 && Array.isArray(body.folders) && typeof body.assignments === "object");
  } catch (e) { ok("GET /api/library", false, e.message); }

  // 5) ETA (분석 모드별 + 섹션별)
  try {
    const { status, body } = await getJson("/api/eta?pages=20");
    ok("GET /api/eta?pages", status === 200 && body.full && body.simple && body.full.totalMs > 0);
  } catch (e) { ok("GET /api/eta?pages", false, e.message); }
  try {
    const { status, body } = await getJson("/api/eta?section=method");
    ok("GET /api/eta?section", status === 200 && Number.isFinite(body.estMs) && body.estMs > 0, `${(body.estMs / 1000) | 0}초`);
  } catch (e) { ok("GET /api/eta?section", false, e.message); }

  // 6) 설정(구독 계정 상태)
  try {
    const { status, body } = await getJson("/settings/status");
    const loggedIn = body && body.auth && body.auth.loggedIn;
    ok("GET /settings/status", status === 200 && body.auth && Array.isArray(body.accounts), loggedIn ? `로그인: ${body.auth.email}` : "미로그인");
  } catch (e) { ok("GET /settings/status", false, e.message); }

  // 7) 잘못된 입력 방어 (400/404 정상 반환)
  try {
    const r = await fetch(`${HOST}/api/history/zzz-not-hex`, { signal: AbortSignal.timeout(10000) });
    ok("잘못된 hash 방어", r.status === 404 || r.status === 400, `HTTP ${r.status}`);
  } catch (e) { ok("잘못된 hash 방어", false, e.message); }

  console.log(`\n=== 스모크 테스트: ${HOST} ===`);
  results.forEach((r) => console.log("  " + r));
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("스모크 실행 오류:", e.message); process.exit(1); });
