const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const TOKEN_FILE = path.join(DATA_DIR, "token.txt");

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getToken() {
  ensureData();
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token);
    return token;
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

const TOKEN = getToken();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Het adres van de binnenkommende verbinding, niet van de binding: CHRONICLE_HOST
// kan de server op bijv. het Tailscale-IP zetten, maar een request van de
// machine zélf komt alsnog via 127.0.0.1/::1 binnen. Falt close: geen adres
// herkend = niet-loopback.
function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr.startsWith("127.") || addr === "::1" || addr.startsWith("::ffff:127.");
}

// Poortwachter van de token-bootstrap: /api/settings/token mag de token nooit
// aan een niet-loopback-verbinding geven — anders is de bearer-plicht overal
// else een deur met een sleutel die bij de deur hangt.
function requireLoopback(req, res, next) {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: "token is alleen via localhost opvraagbaar — plak hem handmatig in de client (server/data/token.txt)" });
  }
  next();
}

module.exports = { TOKEN, requireAuth, isLoopback, requireLoopback };
