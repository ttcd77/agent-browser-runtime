# Persistent launcher for the Personal Chrome Bridge (port 17337).
#
# Started by the Windows Scheduled Task "AgentBrowserRuntime-PersonalBridge" at
# user logon. The task wraps this script so that:
#   1) the bridge process runs detached and hidden, forwarding commands between
#      the HTTP tool API and the Chrome extension (WS port 17336);
#   2) stdout / stderr stream into a rotating log file under
#      $HOME/.agent-browser-runtime/logs/;
#   3) if a bridge is already listening on 17337 we exit early instead of
#      double-starting.
#
# Run manually for ad-hoc starts:
#   pwsh -File scripts/start-personal-bridge.ps1
#
# Install / uninstall the scheduled task:
#   pwsh -File scripts/install-personal-bridge-task.ps1
#   pwsh -File scripts/install-personal-bridge-task.ps1 -Uninstall

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $HOME '.agent-browser-runtime/logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "personal-bridge-$stamp.log"

$healthHost = '127.0.0.1'

# Skip launch if a bridge is already healthy.
try {
    $response = Invoke-RestMethod -Uri "http://$($healthHost):17337/health" -TimeoutSec 2 -ErrorAction Stop
    if ($response.ok -eq $true) {
        "[$(Get-Date -Format o)] personal-chrome-bridge already running on $($healthHost):17337; skipping launch" |
            Out-File -FilePath $logFile -Encoding utf8
        exit 0
    }
} catch {
    # not running yet, continue
}

$npmCmd = $null
$npmCmdInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmdInfo) { $npmCmd = $npmCmdInfo.Source }
if (-not $npmCmd) {
    $npmCmd = 'npm.cmd'
}

# Run via cmd /c so npm.cmd resolves; redirect both streams into the log file.
# IMPORTANT: this launcher BLOCKS on the child via WaitForExit so the scheduled
# task's RestartCount can actually trigger if the bridge crashes. See the same
# fix in start-agent-server.ps1 for the longer rationale.
$arguments = '/c "' + $npmCmd + '" run personal:chrome'
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError ($logFile + '.err') `
    -PassThru

"[$(Get-Date -Format o)] launched npm run personal:chrome PID=$($proc.Id) log=$logFile" |
    Out-File -FilePath (Join-Path $logDir 'personal-bridge.launcher.log') -Encoding utf8 -Append

$proc.WaitForExit()
"[$(Get-Date -Format o)] bridge exited code=$($proc.ExitCode); scheduler will restart if non-zero" |
    Out-File -FilePath (Join-Path $logDir 'personal-bridge.launcher.log') -Encoding utf8 -Append
exit $proc.ExitCode
