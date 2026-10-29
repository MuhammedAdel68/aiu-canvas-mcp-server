$ErrorActionPreference = "Stop"

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  throw "Google Chrome was not found in the standard install locations."
}

$profileDir = Resolve-Path (New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "..\.chrome-profile"))
$canvasUrl = if ($env:CANVAS_BASE_URL) { $env:CANVAS_BASE_URL } else { "https://aiu.instructure.com/" }

Write-Host "Starting Chrome with a dedicated MCP profile:"
Write-Host "  $profileDir"
Write-Host "Opening Canvas URL:"
Write-Host "  $canvasUrl"
Write-Host ""
Write-Host "Security note: while this Chrome window is open, local apps can control it through port 9222."
Write-Host "Close the Chrome window when you are done using the MCP server."

$arguments = "--remote-debugging-port=9222 --user-data-dir=""$profileDir"" --no-first-run ""$canvasUrl"""
Start-Process -FilePath $chrome -ArgumentList $arguments
