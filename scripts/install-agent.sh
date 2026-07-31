#!/bin/bash
# Paper Reviewer를 launchd 서비스로 등록한다 — 로그인하면 자동 실행되고, 죽으면 되살아난다.
#
#   bash scripts/install-agent.sh
#
# 경로·사용자·node 위치를 실행 시점에 알아내므로 다른 맥에서도 그대로 쓸 수 있다.

set -eu
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
LABEL="com.kimjunsu.paper-reviewer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/paper-reviewer.log"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "❌ node를 찾을 수 없습니다.  brew install node"
  exit 1
fi
# launchd는 로그인 셸 PATH를 물려받지 않으므로 node가 있는 디렉터리를 명시적으로 넣는다
NODE_DIR="$(dirname "$NODE")"

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
    <string>$ROOT/server.js</string>
  </array>
  <!-- dotenv(.env)·serviceAccountKey.json을 cwd 기준으로 읽으므로 작업 디렉터리 고정 -->
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Desktop 안에 로그를 두면 TCC로 spawn이 EX_CONFIG(78) 실패 → Library/Logs로 -->
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "등록 완료: $PLIST"
printf "기동 대기"
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" 2>/dev/null; then
    echo ""
    echo "✅ 실행 중 — http://localhost:${PORT:-3000}"
    echo "   로그:  tail -f $LOG"
    exit 0
  fi
  printf "."
  sleep 0.5
done

echo ""
echo "⚠️  20초 안에 응답이 없습니다. 로그를 확인하세요:"
echo "   tail -30 $LOG"
exit 1
