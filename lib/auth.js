"use strict";
// ── 앱 레벨 인증 ────────────────────────────────────────────────────────────
// 이 서비스를 공개 인터넷(VPS)에 올리면 네트워크 경계(로컬/Tailscale)가 더 이상
// 보호막이 되지 못한다. 로그인 없이 노출하면 아무나 이 서버의 Claude 구독으로
// 분석을 돌릴 수 있으므로, 배포 시 앱 자체가 인증을 강제해야 한다.
//
// 설계
// - 단일 사용자 비밀번호(APP_PASSWORD) + HMAC 서명 쿠키(무상태 세션).
// - 비밀번호는 저장하지 않고 timingSafeEqual로만 비교한다. 쿠키에도 넣지 않는다.
// - APP_PASSWORD가 없으면 로컬·Tailscale 요청만 통과시킨다(fail-closed) — isTrustedLocal 참고.
//   → 기존 로컬/테일넷 사용은 그대로, 공개 노출은 비밀번호 없이는 아예 불가능.
// - 무차별 대입은 IP별 실패 카운트로 잠금.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "pr_session";
const TTL_MS = 30 * 24 * 3600 * 1000; // 30일 — 개인용이라 길게, 만료는 토큰에 서명해 넣는다
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;

// ── 세션 서명키 ──────────────────────────────────────────────────────────────
// env가 우선. 없으면 데이터 디렉터리에 만들어 재사용한다(재시작해도 로그인 유지).
// 파일에 못 쓰는 환경이면 메모리 키로 동작 → 재시작 시 재로그인만 필요하고 안전은 유지.
function loadSecret(dataDir) {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const f = path.join(dataDir, "session_secret");
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    if (s.length >= 32) return s;
  } catch (e) {}
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
  } catch (e) {
    console.warn("[인증] 세션키를 저장하지 못해 메모리 키를 씁니다 — 재시작 시 재로그인 필요");
  }
  return s;
}

function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}
function makeToken(secret) {
  const payload = `${Date.now() + TTL_MS}.${crypto.randomBytes(8).toString("base64url")}`;
  return `${payload}.${sign(secret, payload)}`;
}
function verifyToken(secret, token) {
  if (typeof token !== "string" || token.length > 300) return false;
  const i = token.lastIndexOf(".");
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expect = Buffer.from(sign(secret, payload));
  if (mac.length !== expect.length) return false; // 길이 다르면 timingSafeEqual이 던진다
  if (!crypto.timingSafeEqual(mac, expect)) return false;
  const exp = Number(payload.split(".")[0]);
  return Number.isFinite(exp) && Date.now() < exp;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

// 비밀번호가 없을 때 통과시킬 출처 — 이 프로젝트가 원래 의존하던 네트워크 경계
// (로컬 + Tailscale 전용, 공개 인터넷 미노출)를 그대로 재현한다.
//  · 루프백
//  · Tailscale 테일넷 100.64.0.0/10 (CGNAT). 구조상 공개 인터넷에서 닿을 수 없다.
// 사설망 전체(10/172.16/192.168)를 열지 않는 이유: 리버스 프록시(Caddy)는 도커 브리지
// 172.x에서 오므로, 그걸 신뢰하면 공개 배포에서 비밀번호가 통째로 우회된다.
// X-Forwarded-For가 아니라 실제 소켓 주소로 판단하므로 헤더 위조로는 뚫을 수 없다.
function isTrustedLocal(req) {
  const raw = (req.socket && req.socket.remoteAddress) || "";
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw; // IPv4-mapped IPv6 정규화
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127) return true;
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 — Tailscale
}

// 요청이 HTTPS로 들어왔는지 — 리버스 프록시(Caddy 등) 뒤에서는 헤더로 판단.
// Secure 쿠키를 HTTP에 붙이면 브라우저가 버려서 로그인 루프가 되므로 실제로 확인한다.
function isSecureReq(req) {
  if (req.secure) return true;
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return xf === "https";
}

const LOGIN_PAGE = (msg) => `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper Reviewer — 로그인</title>
<style>
  :root{--paper:#faf6ef;--ink:#211d19;--ink-soft:#5c554b;--ink-faint:#9b9285;
        --line:#e3dccd;--accent:#8c2f39;--card:#fffdf9}
  @media (prefers-color-scheme: dark){
    :root{--paper:#17151a;--ink:#e9e4dc;--ink-soft:#b3aca0;--ink-faint:#837c70;
          --line:#353039;--accent:#e0808c;--card:#1f1c23}
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);
       color:var(--ink);font-family:"Pretendard Variable",Pretendard,-apple-system,sans-serif;padding:24px}
  .box{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);
       border-radius:14px;padding:32px 28px}
  h1{margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:600;letter-spacing:-.01em}
  p.sub{margin:0 0 22px;font-size:13px;color:var(--ink-faint)}
  label{display:block;font-size:12px;color:var(--ink-soft);margin-bottom:6px}
  input{width:100%;padding:11px 12px;font-size:15px;border:1px solid var(--line);border-radius:9px;
        background:var(--paper);color:var(--ink);font-family:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:14px;padding:11px;font-size:14px;font-weight:600;border:0;
         border-radius:9px;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit}
  button:hover{filter:brightness(1.08)}
  .err{margin-top:14px;font-size:13px;color:var(--accent);text-align:center}
</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>Paper Reviewer</h1>
    <p class="sub">논문 분석 서비스</p>
    <label for="pw">비밀번호</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">로그인</button>
    ${msg ? `<div class="err">${msg}</div>` : ""}
  </form>
</body></html>`;

const NO_PASSWORD_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>설정 필요</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;
line-height:1.7;color:#211d19}code{background:#f3ede1;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h2>APP_PASSWORD가 설정되지 않았습니다</h2>
<p>이 서버는 로컬·Tailscale 밖에서 오는 요청을 비밀번호 없이 처리하지 않습니다.
외부에서 쓰려면 서버의 <code>.env</code>에 <code>APP_PASSWORD</code>를 설정하고 재시작하세요.</p>
</body></html>`;

/**
 * 인증 미들웨어를 만든다. express.static보다 **앞에** 등록해야 정적 파일도 보호된다.
 * @param {object} opts
 * @param {string} opts.dataDir 세션키를 둘 디렉터리
 * @returns {{middleware:Function, enabled:boolean}}
 */
function createAuth(opts) {
  const dataDir = (opts && opts.dataDir) || __dirname;
  const password = String(process.env.APP_PASSWORD || "");
  const enabled = password.length > 0;
  const secret = loadSecret(dataDir);
  const fails = new Map(); // ip → {n, until}

  if (!enabled) {
    console.log("[인증] APP_PASSWORD 미설정 — 로컬·Tailscale(100.64/10) 요청만 허용합니다");
  } else if (password.length < 8) {
    console.warn("[인증] APP_PASSWORD가 8자 미만입니다 — 더 긴 비밀번호를 권장합니다");
  }

  function clientIp(req) {
    // trust proxy가 켜져 있으면 req.ip가 X-Forwarded-For를 반영한다.
    return req.ip || (req.socket && req.socket.remoteAddress) || "?";
  }

  function middleware(req, res, next) {
    // 헬스체크는 인증 없이 — 프록시/모니터링이 찌를 수 있어야 한다(정보 노출 없음)
    if (req.path === "/healthz") return res.type("text").send("ok");

    if (!enabled) {
      if (isTrustedLocal(req)) return next();
      return res.status(503).type("html").send(NO_PASSWORD_PAGE);
    }

    const ip = clientIp(req);
    const lock = fails.get(ip);
    const locked = lock && lock.until > Date.now();

    if (req.method === "POST" && req.path === "/login") {
      if (locked) {
        const min = Math.ceil((lock.until - Date.now()) / 60000);
        return res.status(429).type("html").send(LOGIN_PAGE(`시도가 너무 많습니다. ${min}분 후 다시 시도하세요.`));
      }
      const given = Buffer.from(String((req.body && req.body.password) || ""));
      const want = Buffer.from(password);
      const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!ok) {
        const n = (lock ? lock.n : 0) + 1;
        fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        console.warn(`[인증] 로그인 실패 (${ip}) ${n}/${MAX_FAILS}`);
        return res.status(401).type("html").send(LOGIN_PAGE("비밀번호가 올바르지 않습니다."));
      }
      fails.delete(ip);
      res.cookie(COOKIE, makeToken(secret), {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureReq(req),
        maxAge: TTL_MS,
        path: "/",
      });
      return res.redirect(303, "/");
    }

    if (req.method === "POST" && req.path === "/logout") {
      res.clearCookie(COOKIE, { path: "/" });
      return res.redirect(303, "/login");
    }

    if (verifyToken(secret, readCookie(req, COOKIE))) return next();

    if (req.path === "/login") return res.type("html").send(LOGIN_PAGE(""));

    // API는 리다이렉트 대신 401 JSON — 프론트가 파싱 오류 대신 상태를 보고 대응한다
    if (req.path.startsWith("/api/") || req.path.startsWith("/settings/")) {
      return res.status(401).json({ error: "로그인이 필요합니다.", needLogin: true });
    }
    return res.redirect(302, "/login");
  }

  return { middleware, enabled };
}

module.exports = { createAuth };
