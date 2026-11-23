# Starts a Cloudflare quick tunnel to the local Silfab Procure server and points the
# GitHub Pages site at it.
#
# A quick tunnel gets a new random https://<words>.trycloudflare.com address every time it
# starts, so this script writes that address into config.js, commits it and pushes it to
# GitHub. GitHub Pages then redeploys (about a minute), and the live page uses the new tunnel.
#
# Run the server first (npm start), then this script. Leave this window open; closing it
# (or Ctrl+C) stops the tunnel, and the live site shows "Can't reach the server".
$ErrorActionPreference = 'Stop'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$root = Split-Path $PSScriptRoot -Parent
$port = 8490
$log = Join-Path $env:TEMP 'silfabprocure-tunnel.log'

try { Invoke-WebRequest "http://localhost:$port/api/auth-config" -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch { throw "The Silfab Procure server is not running on port $port. Start it with 'npm start' first." }

Remove-Item $log -ErrorAction SilentlyContinue
Write-Host 'Starting the Cloudflare quick tunnel...' -ForegroundColor Cyan
$proc = Start-Process -FilePath $cloudflared -PassThru -NoNewWindow `
  -ArgumentList @('tunnel', '--no-autoupdate', '--logfile', $log, '--url', "http://localhost:$port")

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  if ($proc.HasExited) { throw "cloudflared stopped. See $log" }
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) { Stop-Process -Id $proc.Id -Force; throw "No tunnel address after 60 seconds. See $log" }
Write-Host "Tunnel address: $url" -ForegroundColor Green

# Point the live site at the new address.
$config = @"
// Where the page finds the Silfab Procure server (server/server.js).
// tools/start-tunnel.ps1 rewrites apiUrl with the current Cloudflare tunnel address each time it
// starts. On the PC itself (http://localhost:8490) the page ignores it and uses the local server.
window.SILFAB_CONFIG = {
  apiUrl: '$url',
};
"@
Set-Content -Path (Join-Path $root 'config.js') -Value $config -Encoding utf8 -NoNewline
Push-Location $root
try {
  git add config.js
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    # Same author as the previous commit (this repo has no git identity configured).
    $name = git log -1 --format=%an; $email = git log -1 --format=%ae
    git -c "user.name=$name" -c "user.email=$email" commit -q -m "Point site at current tunnel address" -- config.js
    git push -q origin HEAD
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Push failed: the live site still points at the old tunnel address.' }
    else { Write-Host 'Pushed config.js. GitHub Pages will pick it up in about a minute.' -ForegroundColor Green }
  }
} finally { Pop-Location }

Write-Host ''
Write-Host 'Tunnel running. Leave this window open. Press Ctrl+C to stop it.' -ForegroundColor Cyan
try { Wait-Process -Id $proc.Id } finally { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } }
