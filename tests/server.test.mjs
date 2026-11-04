import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const appPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=";
const children = [];
let base, localBase, productionBase, upstream, cookie, localCookie;
let behavior = "valid";
let upstreamCalls = 0;

async function startApp(env = {}) {
  const child = spawn(process.execPath, [appPath], {
    // Static files and .env must resolve relative to the app, not the caller's cwd.
    cwd: tmpdir(),
    env: { ...process.env, AI_PROVIDER: "mock", APP_PASSWORD: "test password", HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Server did not start")), 8000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
  });
}
function post(baseUrl, path, body, session = "", options = {}) {
  return fetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: session, ...options.headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal: options.signal });
}
async function login(baseUrl) {
  const response = await post(baseUrl, "/api/auth", { password: "test password" });
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=28800/);
  assert.doesNotMatch(header, /test password/);
  return header.split(";")[0];
}

before(async () => {
  upstream = createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume the request before responding. */ }
    upstreamCalls += 1;
    if (behavior === "timeout") return;
    if (behavior === "body-timeout") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); return; }
    if (behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 70));
    res.setHeader("Content-Type", "application/json");
    if (behavior === "secret-error") { res.writeHead(500); res.end(JSON.stringify({ error: "secret-provider-key-do-not-expose" })); return; }
    if (behavior === "malformed") { res.end("not json"); return; }
    res.end(JSON.stringify(req.url === "/validate" ? { ok: behavior === "string-false" ? "false" : behavior !== "false", message: "사진을 확인해 주세요." } : { imageDataUrl }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  [base, localBase, productionBase] = await Promise.all([
    startApp(),
    startApp({ AI_PROVIDER: "local", LOCAL_AI_ENDPOINT: upstreamBase + "/transform", LOCAL_AI_VALIDATE_ENDPOINT: upstreamBase + "/validate", AI_TIMEOUT_MS: "500" }),
    startApp({ NODE_ENV: "production", APP_PASSWORD: "" }),
  ]);
  cookie = await login(base);
  localCookie = await login(localBase);
});
after(async () => {
  for (const child of children) child.kill("SIGTERM");
  upstream?.closeAllConnections();
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
});

test("only intended public assets are served, including from a different cwd", async () => {
  const response = await fetch(base + "/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /프로필 스튜디오/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const path of ["/server.mjs", "/package.json", "/.env", "/local-ai/server.py", "/missing", "/__proto__"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const head = await fetch(base + "/app.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(Number(head.headers.get("content-length")) > 100);
  assert.equal((await fetch(base + "/%ZZ")).status, 400);
  assert.equal((await fetch(base + "/healthz")).status, 200);
});

test("session cookies protect image endpoints; body passwords no longer grant access", async () => {
  assert.equal((await post(base, "/api/portrait", { imageDataUrl, password: "test password" })).status, 401);
  assert.deepEqual(await (await fetch(base + "/api/session")).json(), { authenticated: false });
  assert.deepEqual(await (await fetch(base + "/api/session", { headers: { Cookie: cookie } })).json(), { authenticated: true });
  assert.equal((await post(base, "/api/auth", { password: "incorrect" })).status, 401);
  const result = await post(base, "/api/portrait", { imageDataUrl, spec: "profile", background: "#d9dce1" }, cookie);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).imageDataUrl, imageDataUrl);
  assert.match(result.headers.get("cache-control"), /no-store/);
});

test("invalid JSON, cross-origin requests, and non-JSON requests fail clearly", async () => {
  assert.equal((await post(base, "/api/auth", "{")).status, 400);
  assert.equal((await post(base, "/api/auth", "null")).status, 400);
  assert.equal((await post(base, "/api/auth", { password: "test password" }, "", { headers: { Origin: "https://elsewhere.example" } })).status, 403);
  assert.equal((await post(base, "/api/auth", { password: "test password" }, "", { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(base, "/api/auth", { password: "x".repeat(5000) })).status, 413);
});

test("image validation rejects unsupported, mismatched, malformed, and oversized files", async () => {
  for (const value of [undefined, "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64,!!!!", "data:image/png;base64,a"] ) {
    assert.equal((await post(base, "/api/validate", { imageDataUrl: value }, cookie)).status, 400);
  }
  assert.equal((await post(base, "/api/portrait", { imageDataUrl, background: "red" }, cookie)).status, 400);
  assert.equal((await post(base, "/api/portrait", { imageDataUrl, spec: "unknown" }, cookie)).status, 400);
  const large = Buffer.alloc(8 * 1024 * 1024 + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(large);
  assert.equal((await post(base, "/api/validate", { imageDataUrl: `data:image/png;base64,${large.toString("base64")}` }, cookie)).status, 413);
});

test("a provider string 'false' cannot bypass suitability validation", async () => {
  behavior = "string-false";
  assert.equal((await post(localBase, "/api/validate", { imageDataUrl }, localCookie)).status, 502);
  behavior = "false";
  const response = await post(localBase, "/api/validate", { imageDataUrl }, localCookie);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, false);
  behavior = "valid";
  const accepted = await post(localBase, "/api/validate", { imageDataUrl }, localCookie);
  assert.equal((await accepted.json()).ok, true);
});

test("provider failures are sanitized and malformed responses are retryable", async () => {
  behavior = "secret-error";
  const response = await post(localBase, "/api/portrait", { imageDataUrl }, localCookie);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret-provider-key/);
  behavior = "malformed";
  assert.equal((await post(localBase, "/api/validate", { imageDataUrl }, localCookie)).status, 502);
  behavior = "valid";
  assert.equal((await post(localBase, "/api/portrait", { imageDataUrl }, localCookie)).status, 200);
});

test("upstream connection and response-body timeouts release the session for retry", async () => {
  for (const mode of ["timeout", "body-timeout"]) {
    behavior = mode;
    assert.equal((await post(localBase, "/api/validate", { imageDataUrl }, localCookie)).status, 504);
  }
  behavior = "valid";
  assert.equal((await post(localBase, "/api/validate", { imageDataUrl }, localCookie)).status, 200);
});

test("a session cannot trigger overlapping paid processing requests", async () => {
  behavior = "slow";
  const callsBefore = upstreamCalls;
  const responses = await Promise.all([post(localBase, "/api/portrait", { imageDataUrl }, localCookie), post(localBase, "/api/portrait", { imageDataUrl }, localCookie)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  assert.equal(upstreamCalls - callsBefore, 1);
  behavior = "valid";
});

test("logout revokes the token and a new login invalidates the previous session", async () => {
  const session = await login(base);
  const renewed = await post(base, "/api/auth", { password: "test password" }, session);
  const renewedCookie = renewed.headers.get("set-cookie").split(";")[0];
  assert.equal((await post(base, "/api/validate", { imageDataUrl }, session)).status, 401);
  assert.equal((await post(base, "/api/logout", {}, renewedCookie)).status, 200);
  assert.equal((await post(base, "/api/validate", { imageDataUrl }, renewedCookie)).status, 401);
});

test("production requires an explicit password instead of the development default", async () => {
  const config = await (await fetch(productionBase + "/api/config")).json();
  assert.equal(config.ready, false);
  assert.equal((await post(productionBase, "/api/auth", { password: "kyobo" })).status, 503);
});

test("repeated wrong passwords are limited without exposing credentials", async () => {
  for (let index = 0; index < 10; index += 1) assert.equal((await post(base, "/api/auth", { password: "wrong" })).status, 401);
  const response = await post(base, "/api/auth", { password: "test password" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});


test("concurrent failed logins cannot overwrite each other's failure count", async () => {
  const isolatedBase = await startApp();
  const attempts = await Promise.all(Array.from({ length: 20 }, () => post(isolatedBase, "/api/auth", { password: "wrong" })));
  assert.equal(attempts.filter((response) => response.status === 401).length, 10);
  assert.equal(attempts.filter((response) => response.status === 429).length, 10);
  const correct = await post(isolatedBase, "/api/auth", { password: "test password" });
  assert.equal(correct.status, 429);
  assert.ok(Number(correct.headers.get("retry-after")) > 0);
});
