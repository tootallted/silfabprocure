# Keeps Silfab Procure running: starts the server, then the Cloudflare tunnel, and restarts
# either one if it stops. The "Silfab Procure" scheduled task (tools/install-autostart.ps1)
# runs this at boot, hidden. Logs go to local\logs (not committed).
#
# You can also run it by hand to test:  powershell -ExecutionPolicy Bypass -File tools\run-all.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logs = Join-Path $root 'local\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$node = 'C:\Program Files\nodejs\node.exe'
$port = 8490

function Log($msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
  Add-Content -Path (Join-Path $logs 'watcher.log') -Value $line
}

function Test-Server {
  try { Invoke-WebRequest "http://localhost:$port/api/auth-config" -UseBasicParsing -TimeoutSec 5 | Out-Null; $true } catch { $false }
}

function Start-Server {
  if (Test-Server) { Log 'Server already answering on port 8490; not starting another.'; return $null }
  Log 'Starting server.'
  Start-Process -FilePath $node -ArgumentList 'server/server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server-error.log')
}

function Start-Tunnel {
  Log 'Starting tunnel.'
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-tunnel.ps1')) `
    -RedirectStandardOutput (Join-Path $logs 'tunnel.log') -RedirectStandardError (Join-Path $logs 'tunnel-error.log')
}

Log 'Watcher started.'

# Stopping the scheduled task ends this watcher but not the processes it started. Clean up any
# server or tunnel left from an earlier run so there is exactly one of each.
$leftovers = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'server[\\/]server\.js') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match "localhost:$port")
}
foreach ($p in $leftovers) {
  Log "Stopping leftover $($p.Name) (process $($p.ProcessId))."
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($leftovers) { Start-Sleep -Seconds 2 }

$server = $null
$tunnel = $null
while ($true) {
  try {
    # Server: (re)start it if it is not answering. PostgreSQL is its own Windows service.
    if (-not (Test-Server)) {
      if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
      $server = Start-Server
      for ($i = 0; $i -lt 30 -and -not (Test-Server); $i++) { Start-Sleep -Seconds 1 }
      if (-not (Test-Server)) { Log 'Server did not answer within 30 seconds; see server-error.log. Retrying.'; Start-Sleep -Seconds 30; continue }
    }
    # Tunnel: (re)start it if its script has ended. Each start gets a new address and pushes config.js.
    if (-not $tunnel -or $tunnel.HasExited) {
      if ($tunnel) { Log "Tunnel stopped (exit code $($tunnel.ExitCode)); restarting." }
      $tunnel = Start-Tunnel
    }
  } catch {
    Log "Error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 15
}
