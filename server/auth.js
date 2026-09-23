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

module.exports = { TOKEN, requireAuth };
