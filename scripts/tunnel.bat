@echo off
REM Keep localtunnel alive — restarts if it dies
set PATH=C:\Program Files\nodejs;%PATH%
:Loop
echo Starting localtunnel...
npx localtunnel --port 3001 --subdomain yog-pdf-forms
echo Tunnel exited. Restarting in 5s...
timeout /t 5 /nobreak >nul
goto Loop
