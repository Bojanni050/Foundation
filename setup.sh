#!/usr/bin/env bash
# Foundation setup: database op, wachten tot Postgres klaar is, migraties, tests.
# Gebruik: ./setup.sh   (Git Bash of WSL)
set -e

cd "$(dirname "$0")/db"
export DATABASE_URL="${DATABASE_URL:-postgres://chronicle:chronicle@localhost:5434/chronicle}"

echo "==> Start chronicle-db (host-poort 5434)"
docker compose up -d

echo "==> Wachten tot Postgres verbindingen accepteert..."
until docker compose exec -T chronicle-db pg_isready -U chronicle -d chronicle -q; do
  sleep 1
done

echo "==> db-dependencies installeren (drizzle-kit, dotenv, pg)"
npm install

echo "==> Migraties toepassen (drizzle-kit migrate)"
npx drizzle-kit migrate

echo "==> Server-dependencies installeren"
cd ../server
npm install

echo "==> Ingest-policy-tests draaien"
node ingestPolicy.test.js

echo "==> Ingest-bridge-tests draaien"
node ingestBridge.test.js

echo ""
echo "Setup compleet. Start de server met: cd server && npm start"
