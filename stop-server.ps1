$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "Kein Server auf Port $port aktiv."
  exit 0
}

foreach ($processId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
  if ($process.Name -ne "node.exe") {
    Write-Warning "Port $port wird von $($process.Name) (PID $processId) belegt, kein Node-Prozess. Wird nicht beendet."
    continue
  }
  Stop-Process -Id $processId -Force
  Write-Host "Server beendet (PID $processId)."
}

Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Warning "Port $port ist weiterhin belegt."
  exit 1
}
Write-Host "Port $port ist frei."
