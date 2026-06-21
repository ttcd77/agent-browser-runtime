# Persistent launcher for Agent Browser Runtime worker (port 17335).
#
# v0.5 (2026-06-21) — slim refactor: worker runs in personal-only mode.
# No more managed-Playwright Edge launch; the worker is a routing layer that
# forwards every browser-op call to the personal Chrome bridge (port 17337),
# and exposes attack-harness primitives via subprocess proxy. The managed
# backend (Playwright wrapper) is now a stub that throws on call — so we
# MUST NOT route browser ops to it.
#
# Started by the Windows Scheduled Task "AgentBrowserRuntime-AgentServer" at
# user logon. The task wraps this script so that:
#   1) the worker runs with CDP_LAUNCH_BROWSER=0 (personal-only mode) — does
#      NOT launch a managed Edge on port 9222, instead the routing layer
#      directs every browser-op tool through the personal Chrome extension
#      bridge at 17337 (which the user-installed extension auto-connects);
#   2) stdout / stderr stream into a rotating log file under
#      $HOME/.agent-browser-runtime/logs/;
#   3) if a worker is already listening on 17335 we exit early instead of
#      double-starting.
#
# Run manually for ad-hoc starts:
#   pwsh -File scripts/start-agent-server.ps1
#
# Install / uninstall the scheduled task:
#   pwsh -File scripts/install-agent-server-task.ps1
#   pwsh -File scripts/install-agent-server-task.ps1 -Uninstall

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $HOME '.agent-browser-runtime/logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "agent-server-$stamp.log"

# Bind 0.0.0.0 so both localhost and any private-network clients can reach the
# worker. Local clients connect to 127.0.0.1:17335; remote agents (over your
# private network) connect to <host-private-ip>:17335. Binding only the loopback
# would block all remote callers. The health check below uses 127.0.0.1
# (reachable once 0.0.0.0 is bound).
$bindHost = if ($env:CDP_AGENT_SERVER_HOST) { $env:CDP_AGENT_SERVER_HOST } else { '0.0.0.0' }
$healthHost = '127.0.0.1'

# Skip launch if a worker is already healthy.
try {
    $response = Invoke-RestMethod -Uri "http://$($healthHost):17335/health" -TimeoutSec 2 -ErrorAction Stop
    if ($response.ok -eq $true) {
        "[$(Get-Date -Format o)] worker already running on $($healthHost):17335; skipping launch" |
            Out-File -FilePath $logFile -Encoding utf8
        exit 0
    }
} catch {
    # not running yet, continue
}

# v0.5 slim: personal-only mode. The managed Playwright driver is now a stub
# that throws on every call (commit 8832fd7 — managed backend removed). With
# CDP_LAUNCH_BROWSER=0 the worker boots its stub CDP server on port 9222
# (so health probes / cdpJson / targetWatcher satisfy without an actual
# Chrome) and the routing layer (maybeRoutePersonal / resolveBackendForCall)
# defaults every fall-through to "personal" (commit d6d393c). Browser-op
# tools route to the personal bridge; attack primitives subprocess to the
# helloworld attack-harness CLI. No managed browser is ever launched.
#
# To run with the old managed Edge (incompatible with the v0.5 stub driver —
# managed routes all throw), explicitly export CDP_LAUNCH_BROWSER=1 before
# invoking this script — but you will hit the "managed backend removed"
# stub for ~65 tools. Don't.
if (-not $env:CDP_LAUNCH_BROWSER) { $env:CDP_LAUNCH_BROWSER = '0' }
$env:CDP_AGENT_SERVER_HOST = $bindHost

# CDP port is now satisfied by the stub server (in personal-only mode the
# stub listens on $env:CDP_BROWSER_PORT and answers GET /json/version etc).
# Keep 9222 as the convention so legacy clients still find an endpoint.
if (-not $env:CDP_BROWSER_PORT_MODE) { $env:CDP_BROWSER_PORT_MODE = 'fixed' }
if (-not $env:CDP_BROWSER_PORT) { $env:CDP_BROWSER_PORT = '9222' }

# --- Interaction driver: Playwright over the SAME real Edge (default) ---
# ManagedPlaywrightDriver drives the same real system Edge (channel=msedge,
# --disable-blink-features=AutomationControlled). It has an identical
# anti-detection fingerprint to the CDP-launched Edge (navigator.webdriver=false,
# real Edge UA/vendor/plugins/window.chrome), interaction works, and evidence still
# flows through newCDPSession. Playwright actionability fixes SPA-click-stall and
# hardened-form (e.g. Auth0) submit gaps agents reported via browser_feedback.
#   Escape hatch: set CDP_BROWSER_DRIVER=cdp to fall back to the raw-CDP driver.
#   Known limit: the Playwright driver does not yet wrap the CloakBrowser opt-in,
#   so when CloakBrowser is requested we keep the CDP driver (which launches Cloak).
if (-not $env:CDP_BROWSER_DRIVER) {
    if ($env:CDP_BROWSER_USE_CLOAK -eq '1') { $env:CDP_BROWSER_DRIVER = 'cdp' }
    else { $env:CDP_BROWSER_DRIVER = 'playwright' }
}

# --- Browser binary: default real Edge, CloakBrowser opt-in ------------------
# DEFAULT = real system Edge. Under the same CDP integration, real Edge tends to
# pass reCAPTCHA challenges while CloakBrowser-over-CDP is more likely to be
# rejected by anti-bot checks; Edge also keeps full CDP capability.
# CloakBrowser (patched Chromium + fingerprint randomization) is OPT-IN — enabled
# only when CDP_BROWSER_USE_CLOAK=1, for fingerprint isolation across many
# profiles or hardened sites. The CDP wire protocol is unchanged either way.
#
# Binary path is resolved from `python -m cloakbrowser info` so version upgrades
# (`python -m cloakbrowser update`) take effect automatically — no hard-coded
# version string in this script.
#
# Profile dir + CDP port are isolated from the system Edge defaults:
#   - profile: ~/.agent-browser-runtime/cloak-browser-identities/  (not browser-identities/)
#     System Edge and CloakBrowser can be on different Chromium versions; sharing
#     a user-data-dir would risk a one-way Preferences schema migration. Keep
#     them apart. Cookies/login state can be migrated manually later if needed.
#   - port: 9222 (canonical). Do not move it to avoid a personal Edge instance:
#     that would split from other sessions using 9222 and cause collisions.
#
# Opt-in: set CDP_BROWSER_USE_CLOAK=1 to use CloakBrowser instead of Edge. If
# cloak detection fails (binary missing, python unavailable), the script falls
# back to Edge too — runtime startup never blocks on cloak.
$useCloak = if ($env:CDP_BROWSER_USE_CLOAK -eq '1') { $true } else { $false }
if ($useCloak) {
    try {
        $cloakInfo = & python -m cloakbrowser info 2>$null
        $binaryLine = $cloakInfo | Select-String -Pattern '^Binary:\s+(.+)$' | Select-Object -First 1
        if ($binaryLine) {
            $cloakBinary = $binaryLine.Matches[0].Groups[1].Value.Trim()
            if ($cloakBinary -and (Test-Path $cloakBinary)) {
                $env:CDP_BROWSER_EXECUTABLE = $cloakBinary
                if (-not $env:CDP_BROWSER_USER_DATA_DIR) {
                    $env:CDP_BROWSER_USER_DATA_DIR = Join-Path $HOME '.agent-browser-runtime\cloak-browser-identities\default'
                }
                if (-not $env:CDP_BROWSER_PORT) {
                    $env:CDP_BROWSER_PORT = '9222'
                }
                "[$(Get-Date -Format o)] CloakBrowser engine: $cloakBinary (CDP :$env:CDP_BROWSER_PORT, profile $env:CDP_BROWSER_USER_DATA_DIR)" |
                    Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
            } else {
                "[$(Get-Date -Format o)] CloakBrowser binary path not found ($cloakBinary); falling back to system Edge" |
                    Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
            }
        } else {
            "[$(Get-Date -Format o)] CloakBrowser info did not yield a binary path; falling back to system Edge" |
                Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
        }
    } catch {
        "[$(Get-Date -Format o)] CloakBrowser detection failed ($_); falling back to system Edge" |
            Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
    }
}
# -----------------------------------------------------------------------------

$npmCmd = $null
$npmCmdInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmdInfo) { $npmCmd = $npmCmdInfo.Source }
if (-not $npmCmd) {
    $npmCmd = 'npm.cmd'
}

# Run via cmd /c so npm.cmd resolves; redirect both streams into the log file.
# IMPORTANT: this launcher BLOCKS on the child via WaitForExit and forwards the
# child's exit code. The scheduled task's RestartCount=3 / RestartInterval=1m
# settings only trigger when the task action itself reports failure — if this
# script exited immediately after Start-Process, the task would always see
# "exit 0 (success)" and never restart the worker when it crashed (which is
# exactly what bit us on 2026-06-13 when Codex auto-updated and the network
# stack reset killed the npm child silently). With WaitForExit + matching exit
# code, a true crash propagates and the scheduler re-launches us.
$arguments = '/c "' + $npmCmd + '" run agent:server'
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError ($logFile + '.err') `
    -PassThru

"[$(Get-Date -Format o)] launched npm run agent:server PID=$($proc.Id) log=$logFile" |
    Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append

# Block until the worker exits. SIGINT/SIGTERM from the scheduler will
# propagate to the child via cmd.exe's job control.
$proc.WaitForExit()
"[$(Get-Date -Format o)] worker exited code=$($proc.ExitCode); scheduler will restart if non-zero" |
    Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
exit $proc.ExitCode
