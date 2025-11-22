@echo off
echo Checking for dependencies...
if not exist "node_modules" (
    echo Node modules not found. Installing dependencies...
    call npm install
) else (
    echo Dependencies found. Skipping installation.
)

echo Starting the server...
start http://localhost:3000
start cmd /k "node server.js"

echo Server is running at http://localhost:3000
echo Press any key to stop the server...
pause >nul
