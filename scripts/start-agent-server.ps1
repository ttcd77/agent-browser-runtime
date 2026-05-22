# Persistent launcher for Agent Browser Runtime worker (port 17335).
#
# Started by the Windows Scheduled Task "AgentBrowserRuntime-AgentServer" at user
# logon. The task wraps this script so that:
#   1) the worker runs with CDP_LAUNCH_BROWSER=1 so it brings up its own Edge/
#      Chrome session on port 9222 without needing the user to launch one;
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

# Skip launch if a worker is already healthy.
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:17335/health' -TimeoutSec 2 -ErrorAction Stop
    if ($response.ok -eq $true) {
        "[$(Get-Date -Format o)] worker already running on 17335; skipping launch" |
            Out-File -FilePath $logFile -Encoding utf8
        exit 0
    }
} catch {
    # not running yet, continue
}

$env:CDP_LAUNCH_BROWSER = '1'
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

"[$(Get-Date -Format o)] launched npm run agent:server PID=$($proc.Id) log=$logFile" |
    Out-File -FilePath (Join-Path $logDir 'agent-server.launcher.log') -Encoding utf8 -Append
