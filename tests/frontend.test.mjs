import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// A controlled image decoder lets us reproduce the interval between selecting
// a replacement file and finishing its decode without real photos or AI calls.
function browser(options = {}) {
  const nodes = new Map();
  const images = [];
  const requests = [];
  const created = [];
  const shares = [];
  const context2d = { fillRect() {}, drawImage() {}, clearRect() {}, translate() {}, rotate() {} };
  const element = () => ({
    hidden: false, disabled: false, value: "", textContent: "", dataset: {}, width: 708, height: 944,
    classList: { add() {}, remove() {} },
    listeners: {}, setAttribute() {}, removeAttribute() {},
    addEventListener(name, callback) { this.listeners[name] = callback; }, focus() {}, click() { this.clicked = true; }, remove() {},
    getContext: () => context2d,
    toDataURL: () => "data:image/jpeg;base64,/9j/2Q==",
    toBlob(callback, type) { callback(new Blob(["image"], { type })); },
  });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [],
    querySelector: () => ({ value: "#d9dce1" }),
    createElement() { const node = element(); created.push(node); return node; },
    body: { appendChild() {} },
  };
  class Image {
    constructor() { this.width = 100; this.height = 200; images.push(this); }
    set src(value) { this.source = value; }
  }
  const sandbox = {
    document, Image, AbortController, AbortSignal: options.noNativeTimeout ? {} : AbortSignal, console, File, Blob,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    navigator: { onLine: true, canShare: ({ files }) => files.length === 1, share: (data) => { shares.push(data); return Promise.resolve(); } },
    URL: { createObjectURL: () => "blob:test-photo", revokeObjectURL() {} },
    sessionStorage: { removeItem() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const data = url === "/api/config" ? { ready: true, provider: "Mock", message: "test" }
        : url === "/api/session" ? { authenticated: true }
          : { ok: true, provider: "Mock", imageDataUrl: "data:image/png;base64,test" };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../app.js", import.meta.url), "utf8") + "\nglobalThis.app = { state, loadFile, convert, reset, render, timeoutSignal, imageMime, prepareExports };", sandbox);
  return { ...sandbox.app, nodes, images, requests, created, shares };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const replacement = { name: "replacement.png", type: "image/png", size: 100 };

async function preparedBrowser() {
  const app = browser();
  await flush();
  app.state.source = { width: 100, height: 100 };
  app.state.dataUrl = "old-photo-data";
  app.state.fileName = "old.png";
  app.render();
  return app;
}

test("a replacement image blocks conversion until its decode finishes", async () => {
  const app = await preparedBrowser();
  const loading = app.loadFile(replacement);
  assert.equal(app.state.loading, true);
  assert.equal(app.nodes.get("convertButton").disabled, true);
  await app.convert();
  assert.equal(app.requests.filter((request) => request.url === "/api/validate" || request.url === "/api/portrait").length, 0);
  app.images[0].onload();
  await loading;
  assert.equal(app.state.loading, false);
  assert.equal(app.state.fileName, "replacement.png");
  assert.notEqual(app.state.dataUrl, "old-photo-data");
  assert.equal(app.nodes.get("convertButton").disabled, false);
});

test("reset during file decode discards the late image and releases the controls", async () => {
  const app = await preparedBrowser();
  const loading = app.loadFile(replacement);
  app.reset();
  app.images[0].onload();
  await loading;
  assert.equal(app.state.source, null);
  assert.equal(app.state.dataUrl, "");
  assert.equal(app.state.loading, false);
  assert.equal(app.nodes.get("galleryInput").disabled, false);
  assert.equal(app.nodes.get("convertButton").disabled, true);
});

test("failed replacement decode retains the previous photo and allows retry", async () => {
  const app = await preparedBrowser();
  const loading = app.loadFile(replacement);
  app.images[0].onerror();
  await loading;
  assert.equal(app.state.loading, false);
  assert.equal(app.state.fileName, "old.png");
  assert.equal(app.state.dataUrl, "old-photo-data");
  assert.equal(app.nodes.get("changeButton").disabled, false);
  assert.equal(app.nodes.get("convertButton").disabled, false);
  assert.equal(app.nodes.get("statusPanel").dataset.tone, "error");
});


test("mobile files with empty MIME type are accepted only for supported extensions", async () => {
  const app = await preparedBrowser();
  assert.equal(app.imageMime({ name: "CAMERA.JPG", type: "" }), "image/jpeg");
  const loading = app.loadFile({ ...replacement, name: "CAMERA.JPG", type: "" });
  assert.equal(app.state.loading, true);
  app.images[0].onload(); await loading;
  assert.equal(app.state.fileName, "CAMERA.JPG");
  await app.loadFile({ ...replacement, name: "CAMERA.HEIC", type: "" });
  assert.equal(app.state.loading, false);
  assert.match(app.nodes.get("statusText").textContent, /HEIC/);
});

test("timeout cancellation works when AbortSignal.timeout is unavailable", async () => {
  const app = browser({ noNativeTimeout: true });
  await flush();
  const signal = app.timeoutSignal(5);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(signal.aborted, true);
  assert.equal(app.state.ready, true);
});

test("complete conversion pre-encodes 708x944 PNG and JPEG for download and native share", async () => {
  const app = await preparedBrowser();
  const conversion = app.convert();
  await flush();
  app.images[0].onload();
  await conversion;
  assert.equal(app.state.exports.png.type, "image/png");
  assert.equal(app.state.exports.jpeg.type, "image/jpeg");
  const output = app.created.find(node => node.width === 708 && node.height === 944);
  assert.ok(output);
  app.nodes.get("downloadFormat").value = "jpeg";
  app.nodes.get("downloadButton").listeners.click();
  const download = app.created.find(node => node.download === "kyobodt-profile.jpg");
  assert.equal(download.clicked, true);
  app.nodes.get("shareButton").listeners.click();
  assert.equal(app.shares.length, 1);
  assert.equal(app.shares[0].files[0].type, "image/jpeg");
  assert.equal(app.shares[0].files[0].name, "kyobodt-profile.jpg");
});

test("an offline browser blocks cloud conversion but retains local processing", async () => {
  const app = await preparedBrowser();
  app.state.online = false; app.state.offlineCapable = false; app.render();
  assert.equal(app.nodes.get("convertButton").disabled, true);
  await app.convert();
  assert.equal(app.requests.filter(request => request.url === "/api/validate").length, 0);
  app.state.offlineCapable = true; app.render();
  assert.equal(app.nodes.get("convertButton").disabled, false);
  assert.match(app.nodes.get("offlineNotice").textContent, /로컬 서버/);
});
