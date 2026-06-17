# Persistent launcher for the **DEVELOPMENT** Agent Browser Runtime worker (port 17336).
#
# ===========================================================================
#  THIS IS THE DEV WORKER. IT IS FULLY ISOLATED FROM PRODUCTION.
#  Production worker:  17335 / browser CDP 9222 / cloak-browser-identities /
#                      profiles.json / browser-profiles.json
#                      (started by start-agent-server.ps1, used by agents for
#                       live work — NEVER restart it for dev).
#  Dev worker (here):  17336 / browser CDP 9223 / cloak-DEV-identities /
#                      profiles-dev.json / browser-profiles-dev.json
#
#  A developer editing agent-cdp-server.mjs can start / kill / restart THIS
#  worker as much as they like to test changes. Doing so spins up its own
#  separate CloakBrowser window (CDP 9223, headful — that extra window is
#  expected) and touches only the dev profile dir + dev registry + dev config.
#  It does NOT share a port, a browser process, a user-data-dir, or a registry
#  file with production, so it can never interrupt an agent doing live work.
#
#  To apply a tested change to production: pick a moment when no agent is busy,
#  then restart the PRODUCTION worker once via start-agent-server.ps1.
# ===========================================================================
#
# Run manually:
#   pwsh -File scripts/start-dev-server.ps1
#
# The dev/prod separation workflow is documented in the header block above.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $HOME '.agent-browser-runtime/logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "dev-server-$stamp.log"

# Dev worker binds localhost only — keep it off any private network so nothing
# routes agent traffic to it by accident. (Prod binds all interfaces for remote
# access; dev deliberately does not.)
$serverHost = if ($env:CDP_DEV_SERVER_HOST) { $env:CDP_DEV_SERVER_HOST } else { '127.0.0.1' }
$devPort = 17336

# Skip launch if a DEV worker is already healthy on 17336.
# (Mirrors start-agent-server.ps1's skip logic, but checks 17336 — this is the
#  exact reason start-agent-server.ps1 can't be reused as-is: its health probe
#  and its env are all wired to 17335/9222/production paths.)
try {
    $response = Invoke-RestMethod -Uri "http://$($serverHost):$($devPort)/health" -TimeoutSec 2 -ErrorAction Stop
    if ($response.ok -eq $true) {
        "[$(Get-Date -Format o)] dev worker already running on $($serverHost):$($devPort); skipping launch" |
            Out-File -FilePath $logFile -Encoding utf8
        Write-Host "Dev worker already healthy on $($serverHost):$($devPort) (cdpPort=$($response.cdpPort)); skipping launch."
        exit 0
    }
} catch {
    # not running yet, continue
}

# --- Isolated DEV worker + browser configuration -----------------------------
$env:CDP_LAUNCH_BROWSER = '1'
$env:CDP_AGENT_SERVER_HOST = $serverHost
$env:CDP_AGENT_SERVER_PORT = "$devPort"          # 17336 (prod: 17335)

# Pin the dev browser to ONE FIXED, KNOWN CDP port — same fixed-mode discipline
# as production (avoid agent-cdp-server.mjs ephemeral discarding the port and
# landing on a random one), but on 9223 so it never collides with prod's 9222.
$env:CDP_BROWSER_PORT_MODE = 'fixed'
$env:CDP_BROWSER_PORT = '9223'                   # dev browser CDP (prod: 9222)

# Isolated profile dir / registry / profile-port config. All three default
# into ~/.agent-browser-runtime and would otherwise be SHARED with production:
#   - CDP_BROWSER_USER_DATA_DIR   : the browser user-data-dir (cookies/login/profiles)
#   - CDP_PROFILE_REGISTRY_FILE   : profiles.json the worker maintains
#   - CDP_BROWSER_PROFILE_CONFIG  : browser-profiles.json the worker REWRITES on
#                                   startup (sharing prod's file would let the dev
#                                   worker clobber it, so it is isolated here).
$env:CDP_BROWSER_USER_DATA_DIR  = Join-Path $HOME '.agent-browser-runtime\cloak-dev-identities\default'
$env:CDP_PROFILE_REGISTRY_FILE  = Join-Path $HOME '.agent-browser-runtime\profiles-dev.json'
$env:CDP_BROWSER_PROFILE_CONFIG = Join-Path $HOME '.agent-browser-runtime\browser-profiles-dev.json'

# Seed the dev profile-port config if it doesn't exist yet.
# WHY: setting CDP_BROWSER_PROFILE_CONFIG puts agent-cdp-server.mjs into
# "externally-managed" mode (resolveProfileConfigPath: externallyManaged =
# Boolean of the env override). In that mode the worker treats the file as
# owned by an external system and NEVER writes/seeds it. Production's file
# already exists so this is invisible there — but a from-scratch dev worker
# would leave the file missing, the /health profile-port summary
# would read "config-unreadable", and health would report ok:false with a
# "profile-port-drift" blocker forever. Seeding a minimal config with the dev
# default profile pinned to 9223 matches exactly what ensureProfile() writes,
# so the worker stays externally-managed (won't touch prod's file) AND reports
# clean. We seed only if absent, to avoid clobbering a dev profile set the
# developer may have built up.
if (-not (Test-Path $env:CDP_BROWSER_PROFILE_CONFIG)) {
    $devConfigDir = Split-Path -Parent $env:CDP_BROWSER_PROFILE_CONFIG
    if (-not (Test-Path $devConfigDir)) { New-Item -ItemType Directory -Force -Path $devConfigDir | Out-Null }
    @{ browser = @{ profiles = @{ default = @{ cdpPort = 9223 } } } } |
        ConvertTo-Json -Depth 6 |
        Out-File -FilePath $env:CDP_BROWSER_PROFILE_CONFIG -Encoding utf8
}

# --- CloakBrowser default browser binary (same detection as start-agent-server.ps1) ---
# Resolve the binary from `python -m cloakbrowser info` so version upgrades take
# effect automatically — no hard-coded version string. If detection fails the
# script silently falls back to system Edge; dev startup never blocks on cloak.
$useCloak = if ($env:CDP_BROWSER_USE_CLOAK -eq '0') { $false } else { $true }
if ($useCloak) {
    try {
        $cloakInfo = & python -m cloakbrowser info 2>$null
        $binaryLine = $cloakInfo | Select-String -Pattern '^Binary:\s+(.+)$' | Select-Object -First 1
        if ($binaryLine) {
            $cloakBinary = $binaryLine.Matches[0].Groups[1].Value.Trim()
            if ($cloakBinary -and (Test-Path $cloakBinary)) {
                $env:CDP_BROWSER_EXECUTABLE = $cloakBinary
                "[$(Get-Date -Format o)] [DEV] CloakBrowser engine: $cloakBinary (CDP :$env:CDP_BROWSER_PORT, profile $env:CDP_BROWSER_USER_DATA_DIR)" |
                    Out-File -FilePath (Join-Path $logDir 'dev-server.launcher.log') -Encoding utf8 -Append
            } else {
                "[$(Get-Date -Format o)] [DEV] CloakBrowser binary path not found ($cloakBinary); falling back to system Edge" |
                    Out-File -FilePath (Join-Path $logDir 'dev-server.launcher.log') -Encoding utf8 -Append
            }
        } else {
            "[$(Get-Date -Format o)] [DEV] CloakBrowser info did not yield a binary path; falling back to system Edge" |
                Out-File -FilePath (Join-Path $logDir 'dev-server.launcher.log') -Encoding utf8 -Append
        }
    } catch {
        "[$(Get-Date -Format o)] [DEV] CloakBrowser detection failed ($_); falling back to system Edge" |
            Out-File -FilePath (Join-Path $logDir 'dev-server.launcher.log') -Encoding utf8 -Append
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
$arguments = '/c "' + $npmCmd + '" run agent:server'
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError ($logFile + '.err') `
    -PassThru

"[$(Get-Date -Format o)] [DEV] launched npm run agent:server PID=$($proc.Id) port=$devPort cdp=9223 log=$logFile" |
    Out-File -FilePath (Join-Path $logDir 'dev-server.launcher.log') -Encoding utf8 -Append

Write-Host "Dev worker launching: http://$($serverHost):$($devPort)  (browser CDP 9223, headful CloakBrowser)"
Write-Host "  registry: $env:CDP_PROFILE_REGISTRY_FILE"
Write-Host "  profile : $env:CDP_BROWSER_USER_DATA_DIR"
Write-Host "  config  : $env:CDP_BROWSER_PROFILE_CONFIG"
Write-Host "  log     : $logFile"
Write-Host "Give it ~20-40s to build (tsc) + launch, then probe http://$($serverHost):$($devPort)/health"
