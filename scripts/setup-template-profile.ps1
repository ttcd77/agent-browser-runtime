# One-time setup for ABR slim worktree: create a template Chrome profile with
# the worktree extension pre-installed. Every profile_create from now on
# copies this template, so new spawned Chromes auto-have the extension.
#
# Run once:   powershell -File scripts/setup-template-profile.ps1
# Re-run:     deletes existing template and starts over

$ErrorActionPreference = 'Stop'

$ProfilesRoot = if ($env:ABR_PROFILES_ROOT) { $env:ABR_PROFILES_ROOT } else { Join-Path $env:USERPROFILE 'abr-chrome' }
$TemplateDir = Join-Path $ProfilesRoot '_template'
$ChromeExe = if ($env:ABR_CHROME_EXECUTABLE) { $env:ABR_CHROME_EXECUTABLE } else { 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
$WorktreeRoot = Split-Path -Parent $PSScriptRoot
$ExtensionDir = Join-Path $WorktreeRoot 'extension'

if (-not (Test-Path $ChromeExe)) { Write-Error "chrome.exe not found at $ChromeExe (set ABR_CHROME_EXECUTABLE to override)" }
if (-not (Test-Path $ExtensionDir)) { Write-Error "worktree extension not found at $ExtensionDir" }
if (-not (Test-Path $ProfilesRoot)) { New-Item -ItemType Directory -Force -Path $ProfilesRoot | Out-Null }

if (Test-Path $TemplateDir) {
    Write-Output "Existing template at: $TemplateDir"
    $resp = Read-Host "Recreate it from scratch? (y/N)"
    if ($resp -ne 'y' -and $resp -ne 'Y') { Write-Output "Keeping existing template."; exit 0 }
    Remove-Item -Recurse -Force $TemplateDir
}
New-Item -ItemType Directory -Force -Path $TemplateDir | Out-Null

Write-Output ""
Write-Output "============================================================"
Write-Output "  Setting up ABR template profile"
Write-Output "============================================================"
Write-Output "  template dir : $TemplateDir"
Write-Output "  extension    : $ExtensionDir"
Write-Output ""
Write-Output "A Chrome window will open at chrome://extensions/."
Write-Output ""
Write-Output "  Steps in that window:"
Write-Output "    1. Toggle 'Developer mode' (top-right)"
Write-Output "    2. Click 'Load unpacked'"
Write-Output "    3. Pick this folder: $ExtensionDir"
Write-Output "    4. Verify 'Agent Browser Runtime Bridge' appears enabled"
Write-Output "    5. Close the Chrome window (manually, x button)"
Write-Output ""
Write-Output "After you close it, every profile_create will copy this template"
Write-Output "and the new Chrome auto-has the extension."
Write-Output ""
Write-Output "Press Enter to launch Chrome..."
Read-Host | Out-Null

Start-Process -FilePath $ChromeExe -ArgumentList @(
    "--user-data-dir=$TemplateDir",
    '--no-first-run',
    '--no-default-browser-check',
    'chrome://extensions/'
)

Write-Output ""
Write-Output "Chrome launched. After you finish loading the extension and close the window,"
Write-Output "  test with:  POST http://127.0.0.1:17347/tool/profile_create  body: {\"name\":\"test\"}"
