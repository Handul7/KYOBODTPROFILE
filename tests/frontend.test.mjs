import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// A controlled image decoder lets us reproduce the interval between selecting
// a replacement file and finishing its decode without real photos or AI calls.
function browser() {
  const nodes = new Map();
  const images = [];
  const requests = [];
  const context2d = { fillRect() {}, drawImage() {}, clearRect() {} };
  const element = () => ({
    hidden: false, disabled: false, value: "", textContent: "", dataset: {}, width: 708, height: 944,
    classList: { add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, focus() {}, click() {},
    getContext: () => context2d,
    toDataURL: () => "data:image/jpeg;base64,/9j/2Q==",
  });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [],
    querySelector: () => ({ value: "#d9dce1" }),
    createElement: element,
  };
  class Image {
    constructor() { this.width = 100; this.height = 200; images.push(this); }
    set src(value) { this.source = value; }
  }
  const sandbox = {
    document, Image, AbortController, AbortSignal, console,
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
  vm.runInContext(readFileSync(new URL("../app.js", import.meta.url), "utf8") + "\nglobalThis.app = { state, loadFile, convert, reset, render };", sandbox);
  return { ...sandbox.app, nodes, images, requests };
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
