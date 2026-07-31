#!/usr/bin/env node
"use strict";
/**
 * 기기 간 원문 PDF 동기화 — 상대 기기에만 있는 PDF를 받아온다.
 *
 *   node scripts/sync-pdfs.js <상대_주소> [--password PW] [--dry-run] [--quiet]
 *
 *   예) 맥스튜디오에서:  node scripts/sync-pdfs.js http://100.99.40.60:3000
 *       맥북에어에서:    node scripts/sync-pdfs.js http://100.124.186.12:3000
 *
 * 왜 필요한가
 *   분석 결과·채팅·메모·폴더는 Firestore로 자동 공유되지만 원문 PDF는 로컬 디스크에만
 *   있다. 그래서 A기기에서 올린 논문을 B기기에서 열면 내용은 보여도 뷰어·그림 크롭·
 *   재분석이 동작하지 않는다.
 *
 * 왜 안전한가
 *   파일명이 sha256(PDF 내용)이다. 따라서
 *     · 같은 논문은 어느 기기에서 올렸든 같은 파일명 → 중복도 충돌도 없다
 *     · 받은 내용을 다시 해시해 파일명과 대조하면 손상·잘림을 확실히 잡는다
 *   덮어쓰기가 없으므로 어느 쪽을 먼저 돌리든 결과가 같다.
 *
 * 양방향으로 맞추려면 두 기기에서 각각 한 번씩 실행한다(각자 없는 것만 받아온다).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..");
const PDF_DIR = path.join(DATA_DIR, "pdfs");

const args = process.argv.slice(2);
const peerRaw = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
// 예약 실행(launchd)용 — 실제로 받은 게 있을 때만 로그를 남겨 로그가 불어나지 않게 한다
const quiet = args.includes("--quiet");
const say = (...m) => { if (!quiet) console.log(...m); };
const pwIdx = args.indexOf("--password");
const password = pwIdx >= 0 ? args[pwIdx + 1] : process.env.APP_PASSWORD || "";

if (!peerRaw) {
  console.error("사용법: node scripts/sync-pdfs.js <상대_주소> [--password PW] [--dry-run]");
  console.error("예:     node scripts/sync-pdfs.js http://100.99.40.60:3000");
  process.exit(1);
}
const peer = peerRaw.replace(/\/+$/, "");

// 상대가 로그인 게이트를 켜 둔 경우에만 쓰인다. 세션 쿠키를 받아 이후 요청에 붙인다.
// 비밀번호는 이 프로세스 밖으로 나가지 않으며 파일에 남기지 않는다.
async function login() {
  if (!password) return "";
  const res = await fetch(`${peer}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /pr_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`상대 서버 로그인 실패 (HTTP ${res.status}) — 비밀번호를 확인하세요`);
  return `pr_session=${m[1]}`;
}

async function main() {
  fs.mkdirSync(PDF_DIR, { recursive: true });

  const local = new Set(
    fs.readdirSync(PDF_DIR).filter((f) => f.endsWith(".pdf")).map((f) => f.slice(0, -4))
  );
  say(`이 기기: ${local.size}편`);

  let cookie = "";
  try {
    cookie = await login();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  const headers = cookie ? { Cookie: cookie } : {};

  let manifest;
  try {
    const res = await fetch(`${peer}/api/pdf-manifest`, { headers });
    if (res.status === 401) throw new Error("인증 필요 — --password 로 비밀번호를 넘기세요");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    // 상대 기기가 꺼져 있는 것은 정상 상황이다(노트북을 덮어두는 등).
    // 예약 실행에서 이걸 실패로 남기면 로그만 지저분해지므로 조용히 넘어간다.
    if (quiet) process.exit(0);
    console.error(`❌ 상대(${peer}) 조회 실패: ${e.message}`);
    console.error("   상대 기기가 켜져 있고 같은 테일넷에 있는지 확인하세요.");
    process.exit(1);
  }

  const remote = manifest.hashes || [];
  const missing = remote.filter((h) => !local.has(h));
  say(`상대   : ${remote.length}편`);
  say(`받을 것: ${missing.length}편`);

  if (!missing.length) {
    say("\n✅ 이미 최신입니다 — 받을 것이 없습니다.");
    return;
  }
  if (dryRun) {
    missing.forEach((h) => console.log(`  (dry-run) ${h.slice(0, 12)}…`));
    return;
  }

  let done = 0, failed = 0, bytes = 0;
  for (const h of missing) {
    const label = `${h.slice(0, 12)}…`;
    try {
      const res = await fetch(`${peer}/api/pdf/${h}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      // 내용 주소 지정의 이점 — 받은 바이트를 해시해 파일명과 대조하면 손상을 확실히 잡는다
      const got = crypto.createHash("sha256").update(buf).digest("hex");
      if (got !== h) throw new Error(`해시 불일치 (손상됐거나 잘렸습니다)`);

      // 임시 파일에 쓴 뒤 rename — 중간에 끊겨도 반쪽짜리 PDF가 남지 않는다
      const tmp = path.join(PDF_DIR, `.${h}.part`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(PDF_DIR, `${h}.pdf`));

      done++; bytes += buf.length;
      console.log(`  ✅ ${label} (${(buf.length / 1048576).toFixed(1)}MB)  [${done}/${missing.length}]`);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — ${e.message}`);
    }
  }

  const stamp = new Date().toLocaleString("ko-KR", { hour12: false });
  console.log(`\n[${stamp}] 완료: ${done}편 받음 (${(bytes / 1048576).toFixed(0)}MB)${failed ? ` · 실패 ${failed}편` : ""}`);
  if (failed) process.exit(1);
  say("반대 방향도 맞추려면 상대 기기에서 이 명령을 실행하세요:");
  say(`  node scripts/sync-pdfs.js <이 기기 주소>`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
