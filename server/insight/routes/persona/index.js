// Combines the persona sub-routers into a single router, so the mount point
// in server/index.js (app.use("/api/persona", personaRouter)) is unchanged.
// Split by responsibility: instelling (settings), pulse (cached digest),
// kenmerken (CRUD + dedup/heropstanding), reflectie (temporal reasoning).
const express = require("express");

const router = express.Router();

router.use(require("./instelling"));
router.use(require("./pulse"));
router.use(require("./kenmerken"));
router.use(require("./reflectie"));

module.exports = router;
