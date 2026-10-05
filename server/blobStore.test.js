// Plain Node, assert-based — same convention as attachmentsStore.test.js.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LocalBlobStore, sha256, HASH_RE } = require("./blobStore");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blobstore-"));
const store = new LocalBlobStore(tmp);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("put stores bytes content-addressed by sha256", () => {
  const bytes = Buffer.from("hoi wereld");
  const meta = store.put(bytes, { filename: "export.json", mimeType: "application/json" });
  assert.strictEqual(meta.hash, sha256(bytes));
  assert.ok(HASH_RE.test(meta.hash));
  assert.strictEqual(meta.size, bytes.length);
  assert.strictEqual(meta.reused, false);
  assert.deepStrictEqual(store.get(meta.hash), bytes);
});

test("put is idempotent: identical bytes reuse the same blob, never rewrite", () => {
  const bytes = Buffer.from("same content");
  const first = store.put(bytes);
  const second = store.put(bytes);
  assert.strictEqual(second.hash, first.hash);
  assert.strictEqual(second.reused, true);
  assert.strictEqual(first.reused, false);
});

test("different bytes get different hashes and separate blobs", () => {
  const a = store.put(Buffer.from("aaa"));
  const b = store.put(Buffer.from("bbb"));
  assert.notStrictEqual(a.hash, b.hash);
  assert.deepStrictEqual(store.get(a.hash), Buffer.from("aaa"));
  assert.deepStrictEqual(store.get(b.hash), Buffer.from("bbb"));
});

test("empty or non-buffer input is refused", () => {
  assert.throws(() => store.put(Buffer.alloc(0)), /non-empty/);
  assert.throws(() => store.put("nope"), /non-empty/);
});

test("get / getMeta return null for unknown or malformed hashes", () => {
  assert.strictEqual(store.get("not-a-hash"), null);
  assert.strictEqual(store.getMeta("a".repeat(63)), null);
  assert.strictEqual(store.getMeta("f".repeat(64)), null);
  assert.strictEqual(store.has("f".repeat(64)), false);
});

test("meta keeps provenance without using it to locate bytes", () => {
  const meta = store.put(Buffer.from("provenance"), { filename: "../evil/../x.json", mimeType: "text/plain" });
  assert.strictEqual(meta.filename, "x.json"); // basename only, path stripped
  assert.strictEqual(store.getMeta(meta.hash).mimeType, "text/plain");
  assert.ok(store.has(meta.hash));
});

(async () => {
  // Keep the default local dir out of the repo: point a second store at tmp.
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(`      ${err.message}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} blob store tests passed`);
})();
