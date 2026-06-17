# Install / uninstall the Windows Scheduled Task that keeps the Agent Browser
# Runtime worker running across logons.
#
#   pwsh -File scripts/install-agent-server-task.ps1            # install
#   pwsh -File scripts/install-agent-server-task.ps1 -Uninstall # remove
#
# Notes:
# * Runs at user logon, hidden, no elevation required.
# * The Action invokes start-agent-server.ps1 (in the same scripts/ folder),
#   which spawns `npm run agent:server` with CDP_LAUNCH_BROWSER=1 and logs to
#   $HOME/.agent-browser-runtime/logs/.
# * The task is registered with -RunLevel Limited so it stays inside the current
#   user's session; no admin prompt.

param(
    [switch]$Uninstall,
    [string]$TaskName = 'AgentBrowserRuntime-AgentServer'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $projectRoot 'scripts/start-agent-server.ps1'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task '$TaskName'."
    } else {
        Write-Output "No scheduled task named '$TaskName' to remove."
    }
    exit 0
}

if (-not (Test-Path $startScript)) {
    throw "Cannot find start script: $startScript"
}

# Prefer PowerShell 7+ if present, otherwise fall back to Windows PowerShell 5.
$pwsh = $null
$pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($pwshCmd) { $pwsh = $pwshCmd.Source }
if (-not $pwsh) {
    $winPsCmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($winPsCmd) { $pwsh = $winPsCmd.Source }
}
if (-not $pwsh) {
    throw 'No PowerShell executable found on PATH.'
}

$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:UserName

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

$principal = New-ScheduledTaskPrincipal -UserId $env:UserName -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Keep Agent Browser Runtime worker (port 17335) running across user logons.' `
    -Force | Out-Null

Write-Output "Installed scheduled task '$TaskName'. It will start the Agent Browser Runtime worker at logon."

# Kick the task once right now so port 17335 is up immediately — without this,
# a fresh install sits idle until the next logon (LastRunTime stays empty) and
# the server-managed Chrome never launches, even though the install reported
# success.
try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Output "Started the task now (port 17335 should come up within ~10s)."
} catch {
    Write-Warning "Could not start the task now: $_. It will still run at next logon."
}

Write-Output "Remove: pwsh -File scripts/install-agent-server-task.ps1 -Uninstall"
