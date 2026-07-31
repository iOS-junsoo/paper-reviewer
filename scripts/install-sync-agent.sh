#!/bin/bash
# 기기 간 PDF 자동 동기화를 launchd에 등록한다.
#
#   bash scripts/install-sync-agent.sh <상대_주소> [간격초]
#
#   예) 맥스튜디오에서:  bash scripts/install-sync-agent.sh http://100.99.40.60:3000
#       맥북에어에서:    bash scripts/install-sync-agent.sh http://100.124.186.12:3000
#
# 두 기기에서 각각 한 번씩 등록하면 양방향이 된다(각자 상대에게 없는 것만 받아온다).
# 상대가 꺼져 있으면 조용히 넘어가므로 노트북을 덮어둬도 로그가 지저분해지지 않는다.

set -eu
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
PEER="${1:-}"
INTERVAL="${2:-900}"   # 기본 15분. PDF는 논문을 새로 분석할 때만 늘어나 이 정도면 충분하다.
LABEL="com.kimjunsu.paper-reviewer-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/paper-reviewer-sync.log"

if [ -z "$PEER" ]; then
  echo "사용법: bash scripts/install-sync-agent.sh <상대_주소> [간격초]"
  echo "예:     bash scripts/install-sync-agent.sh http://100.99.40.60:3000"
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "❌ node를 찾을 수 없습니다.  brew install node"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/scripts/sync-pdfs.js</string>
    <string>$PEER</string>
    <string>--quiet</string>
  </array>
  <!-- .env를 cwd 기준으로 읽으므로 작업 디렉터리 고정 -->
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <!-- 로그인 직후에도 한 번 — 노트북을 열자마자 그동안 밀린 논문을 받아온다 -->
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "✅ 자동 동기화 등록 완료"
echo "   상대:   $PEER"
echo "   주기:   ${INTERVAL}초 ($((INTERVAL / 60))분) + 로그인 시"
echo "   로그:   tail -f $LOG"
echo ""
echo "지금 한 번 실행해 봅니다…"
launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 3
if [ -s "$LOG" ]; then tail -5 "$LOG"; else echo "(받을 것이 없어 조용히 끝났습니다 — 정상)"; fi
