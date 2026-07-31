#!/bin/bash
# Paper Reviewer — 다른 맥에 옮겨 세팅할 때 실행하는 점검·설치 스크립트.
#
#   bash scripts/setup-mac.sh
#
# 하는 일: 필수 요소를 순서대로 점검하고, 없는 것은 설치하거나 정확한 해결 방법을 알려준다.
# 아무것도 조용히 넘어가지 않는다 — poppler가 없으면 그림 크롭이, Chrome이 없으면
# 시각화 자가검증이 "에러 없이" 실패하기 때문이다.

set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

OK=0; WARN=0; FAIL=0
ok()   { echo "  ✅ $1"; OK=$((OK+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
hdr()  { echo ""; echo "── $1 ────────────────────────────────────"; }

echo "════════ Paper Reviewer 세팅 점검 ════════"
echo "위치: $ROOT"

# ── 1. Node ─────────────────────────────────────────────────────────────────
hdr "1. Node.js"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v); NMAJ=$(echo "$NV" | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$NMAJ" -ge 20 ] 2>/dev/null; then ok "node $NV"
  else bad "node $NV — 20 이상이 필요합니다.  brew install node"; fi
else
  bad "node 없음 →  brew install node"
fi

# ── 2. poppler (그림 크롭·텍스트 추출) ───────────────────────────────────────
hdr "2. poppler (그림 캡처에 필수)"
MISSING_POPPLER=""
for b in pdftoppm pdftotext pdftohtml pdfinfo; do
  command -v "$b" >/dev/null 2>&1 || MISSING_POPPLER="$MISSING_POPPLER $b"
done
if [ -z "$MISSING_POPPLER" ]; then
  ok "pdftoppm · pdftotext · pdftohtml 모두 있음"
else
  echo "     없는 것:$MISSING_POPPLER — 설치를 시도합니다…"
  if command -v brew >/dev/null 2>&1; then
    brew install poppler >/dev/null 2>&1 && ok "poppler 설치 완료" || bad "poppler 설치 실패 →  brew install poppler"
  else
    bad "Homebrew가 없습니다. https://brew.sh 설치 후  brew install poppler"
  fi
fi

# ── 3. Chrome (시각화 자가검증) ─────────────────────────────────────────────
hdr "3. Chrome (방법론 시각화 검증에 필요)"
CHROME_DEFAULT="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -n "${CHROME_PATH:-}" ] && [ -x "${CHROME_PATH:-}" ]; then
  ok "CHROME_PATH 지정됨: $CHROME_PATH"
elif [ -x "$CHROME_DEFAULT" ]; then
  ok "Google Chrome 있음"
else
  warn "Chrome 없음 — 시각화 자가검증이 실패합니다(분석 자체는 됩니다)."
  echo "     해결:  brew install --cask google-chrome"
  echo "     또는 .env에  CHROME_PATH=/Applications/<브라우저>.app/Contents/MacOS/<실행파일>"
fi

# ── 4. 의존성 ───────────────────────────────────────────────────────────────
hdr "4. npm 패키지"
if [ -d node_modules/@anthropic-ai/claude-agent-sdk ]; then
  ok "node_modules 있음 (설치 건너뜀)"
else
  echo "     node_modules가 없어 설치합니다 (네트워크 사용 ~385MB)…"
  npm install --omit=dev && ok "npm install 완료" || bad "npm install 실패"
fi
# 이 맥의 아키텍처용 SDK 바이너리가 실제로 있는지 (다른 맥에서 복사해 온 경우 불일치 가능)
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && SDKARCH="darwin-x64" || SDKARCH="darwin-arm64"
if [ -x "node_modules/@anthropic-ai/claude-agent-sdk-$SDKARCH/claude" ]; then
  ok "SDK 바이너리 일치 ($SDKARCH)"
else
  bad "SDK 바이너리 없음 ($SDKARCH) — 아키텍처가 다른 맥에서 복사했을 수 있습니다.
     해결:  rm -rf node_modules && npm install --omit=dev"
fi

# ── 5. 설정 파일 ────────────────────────────────────────────────────────────
hdr "5. 설정 파일"
[ -f .env ] && ok ".env 있음" || bad ".env 없음 →  cp .env.example .env  후 값 입력"
if [ -f serviceAccountKey.json ]; then
  ok "serviceAccountKey.json 있음 (분석 결과가 Firestore에 공유됩니다)"
elif grep -q "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env 2>/dev/null; then
  ok "Firebase 키가 .env에 있음"
else
  bad "Firebase 키 없음 — 이게 없으면 기존 논문 70편이 안 보이고 결과도 저장되지 않습니다."
fi

# ── 6. Claude 인증 ──────────────────────────────────────────────────────────
hdr "6. Claude 구독 인증"
if grep -q "^USE_ENV_TOKEN=1" .env 2>/dev/null; then
  if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=sk-ant" .env 2>/dev/null; then
    ok "토큰 방식 (USE_ENV_TOKEN=1) — 계정 전환 기능은 쓸 수 없습니다"
  else
    bad "USE_ENV_TOKEN=1인데 CLAUDE_CODE_OAUTH_TOKEN이 비어 있습니다"
  fi
elif command -v claude >/dev/null 2>&1; then
  ST=$(claude auth status --json 2>/dev/null)
  if echo "$ST" | grep -q '"loggedIn":[[:space:]]*true'; then
    EMAIL=$(echo "$ST" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    ok "키체인 로그인됨${EMAIL:+ ($EMAIL)}"
  else
    bad "claude CLI는 있으나 로그인되어 있지 않습니다 →  claude auth login --claudeai"
  fi
else
  bad "claude CLI 없음. 둘 중 하나로 해결하세요.
     ① 설치 후 로그인:  brew install --cask claude-code  &&  claude auth login --claudeai
     ② CLI 없이 토큰으로: 다른 맥에서  claude setup-token  실행 후 .env에
        CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
        USE_ENV_TOKEN=1"
fi

# ── 7. 데이터 ───────────────────────────────────────────────────────────────
hdr "7. 논문 원본 PDF"
if [ -d pdfs ]; then
  N=$(find pdfs -maxdepth 1 -name '*.pdf' 2>/dev/null | wc -l | tr -d ' ')
  ok "pdfs/ 있음 — ${N}개"
  [ "$N" -eq 0 ] && warn "PDF가 0개입니다. 분석 결과는 Firestore에서 보이지만 뷰어·그림·재분석은 원본이 필요합니다."
else
  warn "pdfs/ 없음 — 새 논문 분석은 되지만 기존 논문의 뷰어·그림 탭은 동작하지 않습니다."
fi

# ── 결과 ────────────────────────────────────────────────────────────────────
echo ""
echo "════════ 결과: 정상 $OK · 주의 $WARN · 실패 $FAIL ════════"
if [ "$FAIL" -gt 0 ]; then
  echo "❌ 위의 실패 항목을 먼저 해결하세요."
  exit 1
fi

echo ""
echo "실행:  npm start        (그다음 http://localhost:3000)"
echo "항상 켜두려면:  bash scripts/install-agent.sh"
[ "$WARN" -gt 0 ] && echo "주의 항목이 있지만 실행은 가능합니다."
exit 0
