// Plain Node, assert-based — same convention as epistemicPolicy.test.js.
// No HTTP server needed: both middlewares only inspect plain req/res-shaped
// objects, so every case is a direct function call: `node auth.test.js`.
// (Requiring auth.js creates server/data/token.txt when it doesn't exist yet
// — identical first-start behavior to the server itself.)
const assert = require("assert");
const { TOKEN, requireAuth, requireLoopback, isLoopback } = require("./auth");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function fakeReq(remoteAddress, authHeader) {
  return { socket: { remoteAddress }, headers: authHeader ? { authorization: authHeader } : {} };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function run(middleware, req) {
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test("isLoopback: the whole 127/8 range, ::1 and mapped-IPv4 loopback", () => {
  assert.strictEqual(isLoopback(fakeReq("127.0.0.1")), true);
  assert.strictEqual(isLoopback(fakeReq("127.0.0.2")), true);
  assert.strictEqual(isLoopback(fakeReq("::1")), true);
  assert.strictEqual(isLoopback(fakeReq("::ffff:127.0.0.1")), true);
});

test("isLoopback: tailnet and LAN addresses are not loopback", () => {
  assert.strictEqual(isLoopback(fakeReq("100.65.0.15")), false);
  assert.strictEqual(isLoopback(fakeReq("192.168.1.50")), false);
  assert.strictEqual(isLoopback(fakeReq("::ffff:100.65.0.15")), false);
});

test("isLoopback: missing socket/address fails closed", () => {
  assert.strictEqual(isLoopback({}), false);
  assert.strictEqual(isLoopback({ socket: {} }), false);
});

test("requireAuth: correct bearer token passes through", () => {
  const { res, nextCalled } = run(requireAuth, fakeReq("100.65.0.15", `Bearer ${TOKEN}`));
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test("requireAuth: wrong or missing token → 401, also from loopback", () => {
  assert.strictEqual(run(requireAuth, fakeReq("100.65.0.15", "Bearer no")).res.statusCode, 401);
  assert.strictEqual(run(requireAuth, fakeReq("127.0.0.1")).res.statusCode, 401);
});

test("requireAuth: Bearer prefix is case-insensitive", () => {
  assert.strictEqual(run(requireAuth, fakeReq("127.0.0.1", `bearer ${TOKEN}`)).nextCalled, true);
});

test("requireLoopback: localhost passes, every other address 403 with a paste hint", () => {
  assert.strictEqual(run(requireLoopback, fakeReq("127.0.0.1")).nextCalled, true);
  assert.strictEqual(run(requireLoopback, fakeReq("::1")).nextCalled, true);
  const tailnet = run(requireLoopback, fakeReq("100.65.0.15"));
  assert.strictEqual(tailnet.nextCalled, false);
  assert.strictEqual(tailnet.res.statusCode, 403);
  assert.ok(/localhost|handmatig/i.test(tailnet.res.body.error));
});

test("requireLoopback gates on address only: a valid token from the tailnet still 403s", () => {
  const { res, nextCalled } = run(requireLoopback, fakeReq("100.65.0.15", `Bearer ${TOKEN}`));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

(async () => {
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
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} auth tests passed`);
})();
