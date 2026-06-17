#!/usr/bin/env bash
# Install launchd LaunchAgent plists for Agent Browser Runtime on macOS.
#
#   bash scripts/install-launchd-plists.sh           # install
#   bash scripts/install-launchd-plists.sh --remove  # remove plists
#
# Notes:
# * User LaunchAgents (~/Library/LaunchAgents/) — no sudo required.
# * Plists start the worker (port 17335) and personal Chrome bridge (port 17337)
#   on user login, mirroring install-agent-server-task.ps1 / install-personal-bridge-task.ps1.
# * The script writes the plist files and prints the next steps; it does NOT
#   run launchctl load automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

WORKER_LABEL="com.agent-browser-runtime.worker"
BRIDGE_LABEL="com.agent-browser-runtime.bridge"
WORKER_PLIST="$LAUNCH_AGENTS_DIR/$WORKER_LABEL.plist"
BRIDGE_PLIST="$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist"

LOG_DIR="$HOME/.agent-browser-runtime/logs"

remove_plists() {
  echo "Unloading and removing Agent Browser Runtime launchd plists..."
  launchctl unload -w "$WORKER_PLIST" 2>/dev/null || true
  launchctl unload -w "$BRIDGE_PLIST" 2>/dev/null || true
  rm -f "$WORKER_PLIST" "$BRIDGE_PLIST"
  echo "Removed $WORKER_LABEL and $BRIDGE_LABEL."
  exit 0
}

if [[ "${1:-}" == "--remove" ]]; then
  remove_plists
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: This script is for macOS only. Use install-systemd-units.sh on Linux." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH." >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$LOG_DIR"

# ── Agent Browser Worker (port 17335) ────────────────────────────────────────
cat > "$WORKER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$WORKER_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_ROOT/scripts/agent-cdp-server.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_ROOT</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>CDP_LAUNCH_BROWSER</key>
    <string>1</string>
    <key>CDP_AGENT_SERVER_HOST</key>
    <string>0.0.0.0</string>
    <key>CDP_BROWSER_PORT_MODE</key>
    <string>fixed</string>
    <key>CDP_BROWSER_PORT</key>
    <string>9222</string>
    <key>CDP_BROWSER_DRIVER</key>
    <string>playwright</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/agent-server.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/agent-server.err.log</string>
</dict>
</plist>
EOF

# ── Personal Chrome Bridge (port 17337) ──────────────────────────────────────
cat > "$BRIDGE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$BRIDGE_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_ROOT/scripts/personal-chrome-bridge.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_ROOT</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/personal-bridge.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/personal-bridge.err.log</string>
</dict>
</plist>
EOF

echo ""
echo "Plist files written to $LAUNCH_AGENTS_DIR"
echo ""
echo "next: load the agents"
echo "  launchctl load -w \"$WORKER_PLIST\""
echo "  launchctl load -w \"$BRIDGE_PLIST\""
echo ""
echo "To check status:"
echo "  launchctl list | grep agent-browser-runtime"
echo ""
echo "To remove:"
echo "  bash scripts/install-launchd-plists.sh --remove"
