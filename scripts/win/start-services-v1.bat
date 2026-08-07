@echo off
REM Launch all Payment Core Java microservices (v1) EXCLUDING upsell with a single command, each
REM in its own titled window (synchronous chain, then the sale/cleared/>
REM fan-out consumers). Use stop-services-v1.bat to close them all at once.
setlocal
set ROOT=%~dp0..\..
set CORE=%ROOT%\payment-core

for %%A in (payment-initiator validator authorizer fraud-clearing error-handler settlement insights risk-audit) do (
  if not exist "%CORE%\%%A\target\%%A.jar" (
    echo missing %CORE%\%%A\target\%%A.jar - run "cd payment-core ^&^& mvn clean package" first
    exit /b 1
  )
  echo starting %%A...
  start "%%A" java -jar "%CORE%\%%A\target\%%A.jar"
  timeout /t 1 >nul
)
echo All 8 services started in separate windows ^(v1 - excluding upsell^).
endlocal
