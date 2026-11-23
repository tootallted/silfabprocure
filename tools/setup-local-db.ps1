# One-time setup: creates the local database and copies the data out of Supabase.
# Run it yourself; it asks for two passwords that only you should type:
#   1. the local PostgreSQL "postgres" admin password (set when PostgreSQL was installed)
#   2. your Supabase database password
$ErrorActionPreference = 'Stop'
$bin  = 'C:\Program Files\PostgreSQL\17\bin'
$root = Split-Path $PSScriptRoot -Parent

$appPw = (Get-Content (Join-Path $root 'server\.env') | Where-Object { $_ -match '^PGPASSWORD=' }) -replace '^PGPASSWORD=', ''
if (-not $appPw) { throw 'server\.env has no PGPASSWORD line' }

Write-Host ''
Write-Host 'Step 1 of 2: create the local "silfabprocure" database.' -ForegroundColor Cyan
Write-Host 'Enter the password for the local "postgres" admin account when asked.'
& "$bin\psql.exe" -h localhost -U postgres -d postgres -v "app_pw=$appPw" -f (Join-Path $root 'db\local-setup.sql')
if ($LASTEXITCODE) { throw 'Local database setup failed.' }

Write-Host ''
Write-Host 'Step 2 of 2: copy the data out of Supabase.' -ForegroundColor Cyan
Write-Host 'In the Supabase dashboard, click "Connect" at the top, choose "Session pooler",'
Write-Host 'and copy the connection string (it starts with postgresql://postgres.).'
$uri = (Read-Host 'Paste it here').Trim()
# Leave the password out of the string; pg_dump asks for it instead.
$uri = $uri -replace ':\[YOUR-PASSWORD\]@', '@'
New-Item -ItemType Directory -Force (Join-Path $root 'local') | Out-Null
$out = Join-Path $root 'local\supabase-data.sql'
Write-Host 'Enter your Supabase database password when asked.'
& "$bin\pg_dump.exe" "--dbname=$uri" --data-only --schema=procure --no-owner --no-privileges "--file=$out"
if ($LASTEXITCODE) { throw 'Copying data from Supabase failed.' }

Write-Host ''
Write-Host "Done. Data saved to $out" -ForegroundColor Green
Write-Host 'Go back to Claude and say it finished.'
