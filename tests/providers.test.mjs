import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const originalFetch = globalThis.fetch;
const servers = [];
const requests = [];
const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=";
let imageReply = imageDataUrl.split(",")[1];
let localReady = true;
let cloudFailure = false;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
  requests.push({ url: String(url), options });
  if (String(url).endsWith("/health")) return Response.json({ ready: localReady, state: localReady ? "ready" : "loading" });
  if (String(url).endsWith("/validate")) return Response.json({ ok: true, message: "ok" });
  if (String(url).endsWith("/transform")) return Response.json({ imageDataUrl });
  if (cloudFailure) return Response.json({ error: { message: "private-upstream-error" } }, { status: 403 });
  if (String(url).endsWith("/responses")) return Response.json({ output_text: JSON.stringify({ ok: true, message: "ok" }) });
  if (String(url).endsWith("/images/edits")) return Response.json({ data: [{ b64_json: imageReply }] });
  if (String(url).includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: imageReply } }] } }] });
  throw new Error(`Unexpected request: ${url}`);
};
async function app(provider, extra = {}) {
  Object.assign(process.env, { AI_PROVIDER: provider, APP_PASSWORD: "test", NODE_ENV: "test", OPENAI_API_KEY: "test-openai", GEMINI_API_KEY: "test-gemini", LOCAL_AI_ENDPOINT: "http://local-ai.test/transform", LOCAL_AI_VALIDATE_ENDPOINT: "", LOCAL_AI_HEALTH_ENDPOINT: "", ...extra });
  const { createAppServer } = await import(`../server.mjs?test=${provider}-${servers.length}`);
  const server = createAppServer(); servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await originalFetch(base + "/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { base, send: (path) => originalFetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ imageDataUrl, spec: "profile", background: "#ffffff" }) }) };
}
after(async () => {
  globalThis.fetch = originalFetch;
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("OpenAI requests preserve input fidelity without storing validation responses", async () => {
  const instance = await app("openai", { OPENAI_IMAGE_MODEL: "gpt-image-1.5" });
  assert.equal((await instance.send("/api/validate")).status, 200);
  const validation = JSON.parse(requests.find(request => request.url.endsWith("/responses")).options.body);
  assert.equal(validation.store, false);
  assert.equal(validation.max_output_tokens, 800);
  assert.deepEqual(validation.reasoning, { effort: "none" });
  assert.equal((await instance.send("/api/portrait")).status, 200);
  const editing = requests.find(request => request.url.endsWith("/images/edits")).options.body;
  assert.equal(editing.get("input_fidelity"), "high");
  assert.match(editing.get("prompt"), /original expression/);
  assert.equal(editing.get("image").type, "image/png");
  const config = await (await originalFetch(instance.base + "/api/config")).json();
  assert.equal(config.status, "configured");
  assert.match(config.message, /변환 시 확인/);
});

test("new GPT Image models omit the unsupported legacy fidelity option", async () => {
  const instance = await app("openai", { OPENAI_IMAGE_MODEL: "gpt-image-2.5-sunburst" });
  assert.equal((await instance.send("/api/portrait")).status, 200);
  const editing = requests.filter(request => request.url.endsWith("/images/edits")).at(-1).options.body;
  assert.equal(editing.get("input_fidelity"), null);
});

test("malformed cloud image data and private provider errors never reach the browser", async () => {
  const instance = await app("openai");
  imageReply = Buffer.from("not an image").toString("base64");
  assert.equal((await instance.send("/api/portrait")).status, 502);
  imageReply = imageDataUrl.split(",")[1];
  cloudFailure = true;
  const denied = await instance.send("/api/portrait");
  assert.equal(denied.status, 502);
  assert.doesNotMatch(await denied.text(), /private-upstream/);
  cloudFailure = false;
});

test("Gemini explicitly requests image output then preserves identity through local refinement", async () => {
  const instance = await app("gemini");
  assert.equal((await instance.send("/api/portrait")).status, 200);
  const generation = JSON.parse(requests.find(request => request.url.includes(":generateContent")).options.body);
  assert.deepEqual(generation.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.match(generation.contents[0].parts[1].text, /Keep the original head pose/);
  const refinement = JSON.parse(requests.filter(request => request.url.endsWith("/transform")).at(-1).options.body);
  assert.equal(refinement.enhance, false);
  assert.equal(refinement.background, "#ffffff");
});

test("local readiness is measured, and missing custom validation URLs derive /validate", async () => {
  const instance = await app("local");
  localReady = false;
  const loading = await (await originalFetch(instance.base + "/api/config")).json();
  assert.equal(loading.ready, false);
  assert.equal(loading.status, "loading");
  localReady = true;
  const ready = await (await originalFetch(instance.base + "/api/config")).json();
  assert.equal(ready.ready, true);
  assert.equal(ready.status, "ready");
  assert.equal((await instance.send("/api/validate")).status, 200);
  assert.ok(requests.some(request => request.url === "http://local-ai.test/validate"));
});


test("legacy GPT-5 Nano validation uses low reasoning instead of an unsupported none value", async () => {
  const instance = await app("openai", { OPENAI_VISION_MODEL: "gpt-5-nano" });
  assert.equal((await instance.send("/api/validate")).status, 200);
  const validation = JSON.parse(requests.filter(request => request.url.endsWith("/responses")).at(-1).options.body);
  assert.deepEqual(validation.reasoning, { effort: "low" });
  assert.equal(validation.max_output_tokens, 800);
});
