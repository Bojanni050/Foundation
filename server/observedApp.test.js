// Plain Node, assert-based — same convention as ingestBridge.test.js.
// observedApp.js is pure (no DB, no clock), so every case here is a plain
// function call: `node observedApp.test.js`.
const assert = require("assert");
const {
  splitTitledApp,
  observedAppFromRow,
  decorateEpisodeWithApp,
} = require("./observedApp");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("splits the capture-rs 'app — window' title on the em-dash separator", () => {
  assert.deepStrictEqual(splitTitledApp("Outlook — Postvak IN"), {
    app: "Outlook",
    windowTitle: "Postvak IN",
  });
});

test("splits on the FIRST separator so a window title may contain one", () => {
  assert.deepStrictEqual(splitTitledApp("code — a — b"), {
    app: "code",
    windowTitle: "a — b",
  });
});

test("a title with no separator is all app, no window", () => {
  assert.deepStrictEqual(splitTitledApp("Outlook"), { app: "Outlook", windowTitle: null });
});

test("null/empty/non-string titles degrade to nulls, never a guess", () => {
  assert.deepStrictEqual(splitTitledApp(null), { app: null, windowTitle: null });
  assert.deepStrictEqual(splitTitledApp(""), { app: null, windowTitle: null });
  assert.deepStrictEqual(splitTitledApp("   "), { app: null, windowTitle: null });
  assert.deepStrictEqual(splitTitledApp(42), { app: null, windowTitle: null });
});

test("an explicit tag wins over the title-split (tag is not separator-dependent)", () => {
  assert.strictEqual(observedAppFromRow(["Outlook"], "ignored — title"), "Outlook");
});

test("falls back to the title-split when there is no usable tag", () => {
  assert.strictEqual(observedAppFromRow([], "Outlook — Postvak IN"), "Outlook");
  assert.strictEqual(observedAppFromRow(null, "Outlook — Postvak IN"), "Outlook");
  assert.strictEqual(observedAppFromRow(["  "], "Outlook"), "Outlook");
});

test("decorate derives app/window and strips the raw join columns", () => {
  const decorated = decorateEpisodeWithApp({
    id: "ep1",
    fragment: "[ocr]",
    source_title: "Outlook — Postvak IN",
    source_tags: ["Outlook"],
  });
  assert.strictEqual(decorated.observed_app, "Outlook");
  assert.strictEqual(decorated.observed_window, "Postvak IN");
  assert.strictEqual("source_title" in decorated, false);
  assert.strictEqual("source_tags" in decorated, false);
  // The frozen observation itself is untouched.
  assert.strictEqual(decorated.fragment, "[ocr]");
  assert.strictEqual(decorated.id, "ep1");
});

test("decorate is honest about a row with no linked ingest_object", () => {
  const decorated = decorateEpisodeWithApp({ id: "ep2", source_title: null, source_tags: null });
  assert.strictEqual(decorated.observed_app, null);
  assert.strictEqual(decorated.observed_window, null);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL  " + name + "\n      " + err.message);
  }
}
if (failed > 0) {
  console.error("\n" + failed + " observed-app test(s) failed");
  process.exit(1);
}
console.log("\nAll " + tests.length + " observed-app tests passed");
