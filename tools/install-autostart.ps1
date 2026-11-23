# Registers the "Silfab Procure" scheduled task, which starts the server and Cloudflare tunnel
# (tools/run-all.ps1) when Windows boots, before anyone signs in, and keeps them running.
#
# Run it yourself, as administrator (a boot-time task needs that). It asks for your Windows
# password: the task runs as you so that it can push config.js to GitHub with your saved
# GitHub sign-in. Windows stores the password for the task; Claude never sees it.
#
# To remove the task later:  Unregister-ScheduledTask -TaskName 'Silfab Procure'
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$taskName = 'Silfab Procure'
$user = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "This sets up '$taskName' to start at boot as $user." -ForegroundColor Cyan
Write-Host 'Enter your Windows password (not your PIN). If you sign in to Windows with a Microsoft account, use that account''s password.'
$cred = Get-Credential -UserName $user -Message "Windows password for $user (used to run Silfab Procure at startup)"
if (-not $cred) { throw 'Cancelled.' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\tools\run-all.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT1M'   # give the network and PostgreSQL a minute to come up
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

Write-Host ''
Write-Host "Done. '$taskName' will start at every boot." -ForegroundColor Green
Write-Host 'Go back to Claude and say it finished.'
