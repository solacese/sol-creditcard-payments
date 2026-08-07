@echo off
REM Stop all Payment Core Java microservices (v1) EXCLUDING upsell with a single command by
REM closing every window titled with a service name from start-services-v1.bat.
setlocal
for %%A in (payment-initiator validator authorizer fraud-clearing error-handler settlement insights risk-audit) do (
  taskkill /FI "WINDOWTITLE eq %%A*" /T /F >nul 2>&1
)
echo Stopped all Payment Core v1 service windows (if any were running).
endlocal
