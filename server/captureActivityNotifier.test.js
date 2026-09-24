// Plain Node, assert-based — same convention as ingestPolicy.test.js.
// captureActivityNotifier.js is a pure factory around an injected fetchImpl,
// so every case here is a plain function call: `node captureActivityNotifier.test.js`.

const assert = require("assert");
const { makeCaptureActivityNotifier } = require("./captureActivityNotifier");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("notifies the memory-process with the event payload", async () => {
  const calls = [];
  const notify = makeCaptureActivityNotifier({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });
  await notify({ title: "Chat met Gaia", sourceProvider: "chatgpt", type: "chat" });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "http://127.0.0.1:4578/api/settings/capture-activity");
  assert.strictEqual(calls[0].init.method, "POST");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    title: "Chat met Gaia",
    sourceProvider: "chatgpt",
    type: "chat",
  });
});

test("a rejected fetch resolves instead of throwing — visibility never fails the request", async () => {
  const notify = makeCaptureActivityNotifier({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  // Must not reject: a down memory-process is swallowed by design.
  await notify({ title: "x", sourceProvider: null, type: "capture" });
});

test("empty payload fields serialize to {} — the ring buffer applies its own defaults", async () => {
  const calls = [];
  const notify = makeCaptureActivityNotifier({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });
  await notify({});
  // JSON.stringify drops undefined fields, so the body is {} — the ring
  // buffer's own defaults ((untitled), null, null) apply server-side.
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {});
});

test("custom port is honored for test setups", async () => {
  const calls = [];
  const notify = makeCaptureActivityNotifier({
    port: 4599,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });
  await notify({ title: "x" });
  assert.strictEqual(calls[0].url, "http://127.0.0.1:4599/api/settings/capture-activity");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${t.name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed > 0) process.exit(1);
})();
