# Restart only the backend (port 3001), leave frontend untouched
$backendPid = (netstat -ano | findstr "0.0.0.0:3001 " | Select-Object -First 1) -replace '.*LISTENING\s+', '' -replace '\s.*', ''
if ($backendPid) {
  Stop-Process -Id $backendPid -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped backend PID $backendPid"
}
Start-Sleep -Seconds 1
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "src/index.js" -WorkingDirectory "C:\Users\Tasleem\perf-studio\backend"
Start-Sleep -Seconds 3

# Verify both services
$listening = netstat -ano | findstr "LISTENING" | findstr ":3001 :5173"
$backendOk = $listening -like "*3001*"
$frontendOk = $listening -like "*5173*"

if ($backendOk)  { Write-Host "Backend  OK :3001" } else { Write-Host "Backend  DOWN" }
if ($frontendOk) { Write-Host "Frontend OK :5173" } else {
  Write-Host "Frontend was down - restarting..."
  Start-Process -WindowStyle Hidden -FilePath "C:\Program Files\nodejs\npm.cmd" -ArgumentList "run","dev" -WorkingDirectory "C:\Users\Tasleem\perf-studio\frontend"
  Start-Sleep -Seconds 4
  Write-Host "Frontend restarted"
}
