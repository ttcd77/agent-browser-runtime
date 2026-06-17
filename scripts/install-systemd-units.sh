#!/usr/bin/env bash
# Install systemd user units for Agent Browser Runtime on Linux.
#
#   bash scripts/install-systemd-units.sh           # install
#   bash scripts/install-systemd-units.sh --remove  # remove units
#
# Notes:
# * User-level units (~/.config/systemd/user/) — no sudo required.
# * Units start the worker (port 17335) and personal Chrome bridge (port 17337)
#   on user login, mirroring install-agent-server-task.ps1 / install-personal-bridge-task.ps1.
# * The script writes the unit files and prints the next steps; it does NOT
#   run systemctl enable/start automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

WORKER_SERVICE="agent-browser-worker.service"
BRIDGE_SERVICE="agent-browser-bridge.service"

remove_units() {
  echo "Stopping and removing Agent Browser Runtime systemd units..."
  systemctl --user stop "$WORKER_SERVICE" 2>/dev/null || true
  systemctl --user disable "$WORKER_SERVICE" 2>/dev/null || true
  systemctl --user stop "$BRIDGE_SERVICE" 2>/dev/null || true
  systemctl --user disable "$BRIDGE_SERVICE" 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/$WORKER_SERVICE" "$SYSTEMD_DIR/$BRIDGE_SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed $WORKER_SERVICE and $BRIDGE_SERVICE."
  exit 0
}

if [[ "${1:-}" == "--remove" ]]; then
  remove_units
fi

# Require systemd user session
if ! command -v systemctl &>/dev/null; then
  echo "error: systemctl not found. This script requires a systemd-based Linux distribution." >&2
  exit 1
fi

mkdir -p "$SYSTEMD_DIR"

# ── Agent Browser Worker (port 17335) ────────────────────────────────────────
cat > "$SYSTEMD_DIR/$WORKER_SERVICE" <<EOF
[Unit]
Description=Agent Browser Runtime Worker (port 17335)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_ROOT
Environment=CDP_LAUNCH_BROWSER=1
Environment=CDP_AGENT_SERVER_HOST=0.0.0.0
Environment=CDP_BROWSER_PORT_MODE=fixed
Environment=CDP_BROWSER_PORT=9222
Environment=CDP_BROWSER_DRIVER=playwright
ExecStart=$(command -v node) scripts/agent-cdp-server.mjs
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME/.agent-browser-runtime/logs/agent-server.log
StandardError=append:$HOME/.agent-browser-runtime/logs/agent-server.err.log

[Install]
WantedBy=default.target
EOF

# ── Personal Chrome Bridge (port 17337) ──────────────────────────────────────
cat > "$SYSTEMD_DIR/$BRIDGE_SERVICE" <<EOF
[Unit]
Description=Agent Browser Runtime Personal Chrome Bridge (port 17337)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_ROOT
ExecStart=$(command -v node) scripts/personal-chrome-bridge.mjs
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME/.agent-browser-runtime/logs/personal-bridge.log
StandardError=append:$HOME/.agent-browser-runtime/logs/personal-bridge.err.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

echo ""
echo "Unit files written to $SYSTEMD_DIR"
echo ""
echo "next: enable and start the services"
echo "  systemctl --user enable --now $WORKER_SERVICE"
echo "  systemctl --user enable --now $BRIDGE_SERVICE"
echo ""
echo "To check status:"
echo "  systemctl --user status $WORKER_SERVICE"
echo "  systemctl --user status $BRIDGE_SERVICE"
echo ""
echo "To remove:"
echo "  bash scripts/install-systemd-units.sh --remove"
