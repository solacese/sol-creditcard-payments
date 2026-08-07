@echo off
REM Stop all Payment Core Java microservices with a single command by
REM closing every window titled with a service name from start-services.bat.
setlocal
for %%A in (payment-initiator validator authorizer fraud-clearing error-handler settlement upsell insights risk-audit) do (
  taskkill /FI "WINDOWTITLE eq %%A*" /T /F >nul 2>&1
)
echo Stopped all Payment Core service windows (if any were running).
endlocal
