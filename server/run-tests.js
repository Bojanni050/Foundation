// Eén poort voor de hele suite: draait elk *.test.js in deze dir, gesorteerd,
// elk in een eigen node-proces (de tests zijn standalone: plain assert + eigen
// runner, geen DB nodig). `npm test` en de CI-workflows gebruiken dit — dan
// kan geen enkel testbestand meer vergeten worden (zoals voorheen: setup.sh
// draaide er twee van de achttien).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
if (files.length === 0) {
  console.error("geen *.test.js gevonden in " + dir);
  process.exit(1);
}

const failed = [];
for (const file of files) {
  console.log(`\n== ${file} ==`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" });
  if (result.status !== 0) failed.push(file);
}

if (failed.length > 0) {
  console.error(`\nFAALDEN: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAlle ${files.length} testbestanden geslaagd`);
