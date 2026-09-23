@echo off
rem Foundation setup: database op, wachten, migraties, tests.
rem Gebruik: setup.bat   (cmd of PowerShell)
cd db
set DATABASE_URL=postgres://chronicle:chronicle@localhost:5434/chronicle
docker compose up -d

:wait
docker compose exec -T chronicle-db pg_isready -U chronicle -d chronicle -q
if errorlevel 1 (
  timeout /t 1 >nul
  goto wait
)

call npm install
npx drizzle-kit migrate

cd ..\server
call npm install
node ingestPolicy.test.js
node ingestBridge.test.js

echo.
echo Setup compleet. Start de server met: cd server ^&^& npm start
