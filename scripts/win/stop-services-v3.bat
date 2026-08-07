@echo off
REM Stop all Payment Core Java microservices (v3) EXCLUDING the original Validator with a single command by
REM closing every window titled with a service name from start-services-v3.bat.
setlocal
for %%A in (payment-initiator validator-credit validator-debit authorizer fraud-clearing error-handler settlement upsell insights risk-audit) do (
  taskkill /FI "WINDOWTITLE eq %%A*" /T /F >nul 2>&1
)
echo Stopped all Payment Core v3 service windows (if any were running).
endlocal
