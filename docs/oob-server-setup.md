# OOB Server Setup

The OOB (out-of-band) server catches blind callbacks from SSRF / XXE / SSTI / log4j payloads. It runs as a standalone Node process on your OOB host, not mixed with the browser worker or personal bridge.

## Why a dedicated host

- Your OOB host should have a stable address reachable from your test targets.
- Port 17338 is dedicated to OOB — clear of the browser worker (17335) and personal bridge (17337).
- Never expose the OOB server directly on the public internet without authentication; restrict access to your test network.

## Port assignment

| Port  | Service               |
|-------|-----------------------|
| 17335 | agent-browser-runtime worker (CDP) |
| 17336 | personal Chrome bridge WS |
| 17337 | personal Chrome bridge HTTP |
| **17338** | **OOB callback server** |

## Starting oob-server (manual / nohup)

```bash
# On your OOB host:
cd ~/agent-browser-runtime          # or wherever the repo lives
OOB_LISTEN_PORT=17338 nohup node scripts/oob-server.mjs \
  >> ~/.agent-browser-runtime/logs/oob-server.log 2>&1 &
echo $! > ~/.agent-browser-runtime/oob-server.pid
```

Verify it is up:

```bash
curl http://YOUR-HOST-IP:17338/__oob/health
# expected: {"ok":true,"bufferSize":0,"uptimeMs":...}
```

## Starting via systemd (preferred for persistence)

Add a `agent-browser-oob.service` unit alongside the existing worker/bridge units.
Run `install-systemd-units.sh` and add the section below, or create the file manually:

```ini
[Unit]
Description=Agent Browser Runtime OOB Server (port 17338)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/your-app/agent-browser-runtime
Environment=OOB_LISTEN_PORT=17338
ExecStart=/usr/bin/node scripts/oob-server.mjs
Restart=on-failure
RestartSec=5
StandardOutput=append:~/.agent-browser-runtime/logs/oob-server.log
StandardError=append:~/.agent-browser-runtime/logs/oob-server.err.log

[Install]
WantedBy=default.target
```

Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-browser-oob.service
systemctl --user status agent-browser-oob.service
```

## Client configuration

The `oob-client.mjs` default is a placeholder — you must configure your collector before use.

Set the server base:

```bash
export OOB_SERVER_BASE=http://YOUR-HOST-IP:17338
# or per-call:
profile_oob_alloc { "serverBase": "http://YOUR-HOST-IP:17338" }
```

## Security notes

- The OOB server **must not** be exposed on the public internet without authentication. It records raw HTTP requests including headers and bodies from callback targets.
- Use a firewall rule or reverse proxy with auth to restrict access to your test network.
- The in-memory ring buffer (`OOB_BUFFER_MAX`, default 1000) is deliberately ephemeral — not a system of record. If durable storage is needed, redirect stdout to a persistent log and parse it separately.

## Example deployment

- **Path**: `/opt/your-app/agent-browser-runtime/scripts/oob-server.mjs`
- **systemd unit**: `/etc/systemd/system/agent-browser-oob.service`
- **Log path**: `~/.agent-browser-runtime/logs/oob-server.{log,err.log}`
- **Health check**: `curl http://YOUR-HOST-IP:17338/__oob/health` → `{"ok":true,"bufferSize":0,"uptimeMs":...}`
- **oob_alloc result example**:
  ```json
  {
    "schema": "agent-browser-runtime.oob-alloc.v1",
    "token": "...",
    "url": "http://YOUR-HOST-IP:17338/...",
    "serverBase": "http://YOUR-HOST-IP:17338",
    "ok": true
  }
  ```
