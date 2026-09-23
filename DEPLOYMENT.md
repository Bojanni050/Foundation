# VPS-deployment

Chronicle draait op een VPS in drie lagen: de Postgres-container (docker
compose, host-poort 5434), het capture-proces (server/index.js, poort 4577)
en het memory-proces (poort 4578, door server/index.js zelf gespawnd).

## 0. Auto-deploy (aanbevolen)

Bij elke push naar `main` rolt GitHub Actions de VPS automatisch bij
(`.github/workflows/deploy.yml`): pull → deps → migraties → pm2 restart,
plus een smoke-check dat de API daarna antwoordt. Bij één keer instellen:

**Op de VPS — een deploy-key maken:**
```bash
ssh-keygen -t ed25519 -f ~/.ssh/chronicle_deploy -N "" -C "github-actions"
cat ~/.ssh/chronicle_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/chronicle_deploy    # ← deze private key, straks als secret
```

**In GitHub — repo → Settings → Secrets and variables → Actions:**
| Secret | Waarde |
|---|---|
| `SSH_HOST` | hostname/IP van de VPS |
| `SSH_USER` | bijv. `root` |
| `SSH_PRIVATE_KEY` | inhoud van `chronicle_deploy` (private key, inclusief BEGIN/END-regels) |

Daarna deployt elke merge naar `main` vanzelf (zie de Actions-tab), en kan
de workflow ook handmatig via "Run workflow".

## 1. Checkout + setup

```bash
git clone https://github.com/Bojanni050/Foundation.git
cd Foundation
./setup.sh        # compose up → wachten → migraties → npm install → tests
```

## 2. Processen onder PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup    # start mee na reboot
```

Eén pm2-entry (chronicle) volstaat: index.js start het memory-proces zelf
als subprocess en herstart het bij crash.

## 3. Toegang — wat bewust NIET open gaat

- **4577 en 4578 zijn loopback-only** (`127.0.0.1`, hardcoded in
  `server/index.js` en `server/memory-process/index.js`).
- De database op 5434 is wel op de host gebonden — zet de firewall dicht:
  ```bash
  sudo ufw deny 5434    # tenzij er een specifieke reden is (er is er geen:
                        # alles praat via localhost)
  ```
- Externe callers (extension, clients, Hindsight-bridge) komen binnen via
  een reverse proxy met TLS die naar `127.0.0.1:4577` proxiet. De
  bearer-token gaat over de lijn, dus TLS is geen optie maar een vereiste.

Voorbeeld (Caddy, automatisch Let's Encrypt):

```
chronicle.example.com {
    reverse_proxy 127.0.0.1:4577
}
```

## 4. Token

De token wordt bij de eerste start automatisch gegenereerd
(`server/data/token.txt`, `crypto.randomBytes`) en bij de startup-logging
getoond. Elke installatie krijgt dus zijn eigen token — nooit de token uit
een andere omgeving hergebruiken.

```bash
cat server/data/token.txt
```

## 5. Rook-test op de VPS

```bash
TOKEN=$(cat server/data/token.txt)
curl -X POST http://127.0.0.1:4577/api/ingest/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"vps smoke test","sourceProvider":"chatgpt","url":"https://chatgpt.com/c/vps-smoke-1","tags":["smoke"]}'
# verwacht: 201, status observation, insertedNew true

# en binnen ~60s (ingest-bridge) bestaat de episode:
docker compose -f db/docker-compose.yml exec chronicle-db \
  psql -U chronicle -d chronicle -c \
  "SELECT bron_object_id, left(fragment, 40) FROM episode ORDER BY captured_at DESC LIMIT 1"
# verwacht: bron_object_id = ingest:<uuid>
```

## 6. Een deploy verifiëren

- GitHub → Actions-tab: run "Deploy to VPS" groen, met "API reageert —
  deploy OK" in de laatste stap.
- Op de VPS: `pm2 ls` toont `chronicle` online, en
  `git log -1 --oneline` toont dezelfde commit als GitHub-main.
- In de UI (`/ui`): Instellingen → Systeem toont database en embeddings
  online.
