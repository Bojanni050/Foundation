// PM2-processfile voor VPS-deployment (zie DEPLOYMENT.md).
//
// Eén applicatie: server/index.js start het memory-proces zelf als
// subprocess (startMemoryProcess) en herstart het bij crash — dus één
// pm2-entry volstaat; het memory-proces niet apart pm2-en (anders draait
// het dubbel).
module.exports = {
  apps: [
    {
      name: "chronicle",
      script: "index.js",
      cwd: "./server",
      // De server bindt zelf op 127.0.0.1 (index.js: "localhost-only —
      // never 0.0.0.0"). Externe toegang uitsluitend via een reverse
      // proxy met TLS op de VPS (zie DEPLOYMENT.md) — nooit de bind
      // verruimen.
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Chronische crash-loops moeten niet eeuwig doorgaan.
      max_memory_restart: "1G",
      time: true,
    },
  ],
};
