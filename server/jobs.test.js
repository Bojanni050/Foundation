// Plain Node, assert-based — same convention as epistemicPolicy.test.js.
// guard() is zuivere scheduler-logica: geen DB, geen timers — alleen een
// vertragende fn en een teller. `node jobs.test.js`.
// (jobs.js requires ./db; the pg Pool is lazy — nothing connects at import.)
const assert = require("assert");
const { guard } = require("./jobs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("guard: overlappende tick wordt overgeslagen, daarna draait de job weer", async () => {
  let calls = 0;
  const d = deferred();
  const g = guard("testjob", () => { calls++; return d.promise; });

  const eerste = g();
  await g(); // val while the first run is still busy
  assert.strictEqual(calls, 1, "tweede tick mag de job niet nog een keer starten");

  d.resolve();
  await eerste;
  await g();
  assert.strictEqual(calls, 2, "na afloop is de single-flight weer vrij");
});

test("guard: een gooiende run laat de borg niet vastzitten", async () => {
  let calls = 0;
  const g = guard("testjob", async () => { calls++; throw new Error("job crasht"); });

  await g().catch(() => {});
  assert.strictEqual(calls, 1);
  await g().catch(() => {});
  assert.strictEqual(calls, 2, "fout van vorige run mag volgende tick niet blokkeren");
});

test("guard: watches are independent per guarded job", async () => {
  let a = 0, b = 0;
  const d = deferred();
  const ga = guard("a", () => { a++; return d.promise; });
  const gb = guard("b", async () => { b++; });

  const bezet = ga();
  await gb(); // same tick, other job — must still run
  assert.strictEqual(b, 1, "job b mag niet geblokkeerd worden door bezette job a");

  d.resolve();
  await bezet;
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
      console.error(`    ${err.message}`);
    }
  }
  if (failed > 0) { console.error(`${failed} test(s) failed`); process.exit(1); }
  console.log(`${tests.length} tests geslaagd`);
})();
