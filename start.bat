@echo off
echo Starting PerfStudio...
echo.

cd /d "%~dp0backend"
echo [1/2] Installing backend dependencies...
call npm install --silent
echo [2/2] Starting backend on port 3001...
start "PerfStudio Backend" cmd /k "node src/index.js"

cd /d "%~dp0frontend"
echo [3/4] Installing frontend dependencies...
call npm install --silent
echo [4/4] Starting frontend on port 5173...
start "PerfStudio Frontend" cmd /k "npm run dev"

timeout /t 3 /nobreak >nul
echo.
echo PerfStudio is running!
echo   App:  http://localhost:5173
echo   API:  http://localhost:3001
echo.
start http://localhost:5173
