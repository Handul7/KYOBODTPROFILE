const $ = (id) => document.getElementById(id);
const canvas = $("photoCanvas");
const context = canvas.getContext("2d");
const state = { source: null, result: null, dataUrl: "", fileName: "", ready: false, authenticated: false, busy: false, loading: false, showingResult: true, version: 0, controller: null, passwordResolve: null, maxBytes: 8 * 1024 * 1024 };
// Remove the plaintext password left by previous versions of this app.
try { sessionStorage.removeItem("kyobodt_password"); } catch { /* Storage may be disabled. */ }

function status(message, tone = "neutral") {
  $("statusText").textContent = message;
  $("statusPanel").dataset.tone = tone;
}
function render() {
  const hasSource = Boolean(state.source);
  const hasResult = Boolean(state.result);
  $("uploadButton").hidden = hasSource;
  canvas.hidden = !hasSource;
  $("changeButton").hidden = !hasSource;
  $("changeButton").disabled = state.busy || state.loading;
  $("uploadButton").disabled = state.loading;
  $("galleryInput").disabled = state.busy || state.loading;
  $("convertButton").hidden = hasResult;
  $("convertButton").disabled = !hasSource || !state.ready || state.busy || state.loading;
  $("convertButton").textContent = state.busy ? "프로필을 만들고 있어요…" : "프로필 만들기 ↗";
  $("downloadButton").hidden = !hasResult;
  $("downloadButton").disabled = state.loading;
  $("cancelButton").hidden = !state.busy;
  $("resetButton").hidden = !hasSource || state.busy;
  $("compareControls").hidden = !hasResult;
  $("fileInfo").hidden = hasResult;
  $("fileInfo").textContent = hasSource ? state.fileName : "나만의 프로필을 시작해 보세요";
  $("previewBadge").textContent = hasResult ? (state.showingResult ? "완성된 프로필" : "선택한 원본") : hasSource ? "선택한 원본" : "사진을 기다리고 있어요";
  $("originalButton").setAttribute("aria-pressed", String(!state.showingResult));
  $("resultButton").setAttribute("aria-pressed", String(state.showingResult));
  $("logoutButton").hidden = !state.authenticated;
  document.querySelectorAll('input[name="background"]').forEach((input) => { input.disabled = state.busy || hasResult; });
  $("stepUpload").className = `step ${hasSource ? "done" : "current"}`;
  $("stepConvert").className = `step ${hasResult ? "done" : hasSource ? "current" : ""}`;
  $("stepSave").className = `step ${hasResult ? "current" : ""}`;
  $("workspace").setAttribute("aria-busy", String(state.busy || state.loading));
  if (hasSource) drawPreview();
}
function drawImage(image, target, contain = false) {
  const ctx = target.getContext("2d");
  ctx.fillStyle = "#f0f3f4";
  ctx.fillRect(0, 0, target.width, target.height);
  const scale = (contain ? Math.min : Math.max)(target.width / image.width, target.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, (target.width - width) / 2, (target.height - height) / 2, width, height);
}
function drawPreview() {
  const resultVisible = state.result && state.showingResult;
  drawImage(resultVisible ? state.result : state.source, canvas, !resultVisible);
  canvas.setAttribute("aria-label", resultVisible ? "완성된 프로필 사진 미리보기" : "선택한 원본 사진 미리보기");
}
function decodeImage(src, crossOrigin = false) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("사진을 읽지 못했습니다. JPG 또는 PNG 파일로 다시 선택해 주세요."));
    image.src = src;
  });
}
async function loadFile(file) {
  if (!file || state.busy) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return status("JPG, PNG, WebP 사진을 선택해 주세요. HEIC 사진은 JPG로 변환한 후 사용할 수 있어요.", "error");
  if (!file.size || file.size > state.maxBytes) return status("파일 용량은 8MB까지 가능합니다. 사진 크기를 줄여 다시 선택해 주세요.", "error");
  const version = ++state.version;
  state.loading = true;
  status("사진을 읽고 미리보기를 준비하고 있어요.", "busy");
  render();
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(objectUrl);
    if (version !== state.version) return;
    if (image.width * image.height > 40_000_000) throw new Error("사진 해상도가 너무 큽니다. 4,000만 화소 이하의 사진을 선택해 주세요.");
    // Normalize orientation, bound processing cost, and omit source EXIF metadata.
    const normalized = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    normalized.width = Math.round(image.width * scale);
    normalized.height = Math.round(image.height * scale);
    const ctx = normalized.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, normalized.width, normalized.height);
    ctx.drawImage(image, 0, 0, normalized.width, normalized.height);
    const dataUrl = normalized.toDataURL("image/jpeg", 0.92);
    if (dataUrl.length > state.maxBytes * 4 / 3) throw new Error("사진 용량이 너무 큽니다. 더 작은 사진을 선택해 주세요.");
    state.source = image;
    state.dataUrl = dataUrl;
    state.result = null;
    state.fileName = file.name;
    state.showingResult = false;
    status(state.ready ? "사진을 준비했어요. 배경을 고르고 ‘프로필 만들기’를 눌러 주세요." : "사진을 준비했어요. 서비스 연결 상태를 확인해 주세요.");
    render();
  } catch (error) { if (version === state.version) status(error.message, "error"); }
  finally {
    URL.revokeObjectURL(objectUrl);
    if (version === state.version) { state.loading = false; render(); }
  }
}
async function requestJson(path, body, signal) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요."); }
  if (!response.ok) {
    if (response.status === 401) { state.authenticated = false; render(); }
    const error = new Error(payload.error || "요청을 처리하지 못했습니다. 다시 시도해 주세요.");
    error.status = response.status;
    throw error;
  }
  return payload;
}
async function convert() {
  if (!state.source || state.busy || state.loading || !state.ready) return;
  const version = state.version;
  if (!state.authenticated && !(await askPassword())) return;
  if (version !== state.version || !state.source || state.busy || state.loading) return;
  const controller = new AbortController();
  state.controller = controller;
  state.busy = true;
  render();
  const body = { imageDataUrl: state.dataUrl, spec: "profile", background: document.querySelector('input[name="background"]:checked').value };
  try {
    status("1/2 · 얼굴과 사진 품질을 확인하고 있어요.", "busy");
    const verdict = await requestJson("/api/validate", { imageDataUrl: body.imageDataUrl }, controller.signal);
    if (controller.signal.aborted || version !== state.version) return;
    if (verdict.ok !== true) throw new Error(verdict.message || "얼굴이 선명한 1인 사진을 선택해 주세요.");
    status("2/2 · 배경과 구도를 정리하고 있어요. 잠시만 기다려 주세요.", "busy");
    const result = await requestJson("/api/portrait", body, controller.signal);
    if (controller.signal.aborted || version !== state.version) return;
    const imageSource = result.imageDataUrl || result.imageUrl;
    if (!imageSource || !(imageSource.startsWith("data:image/") || imageSource.startsWith("https://"))) throw new Error("변환 결과에 사진이 없습니다. 다시 시도해 주세요.");
    const image = await decodeImage(imageSource, !imageSource.startsWith("data:"));
    if (controller.signal.aborted || version !== state.version) return;
    state.result = image;
    state.showingResult = true;
    status(result.provider === "Mock" ? "체험 모드 결과입니다. AI 보정 없이 원본을 3:4 비율로 저장할 수 있어요." : "프로필이 완성됐어요. 원본과 비교하고 얼굴과 세부 표현을 확인해 주세요.", "success");
  } catch (error) {
    if (version === state.version && !controller.signal.aborted) status(error.message || "연결이 끊겼습니다. 다시 시도해 주세요.", "error");
  } finally {
    if (version === state.version) { state.busy = false; state.controller = null; render(); }
  }
}
function cancel() {
  state.controller?.abort();
  state.version += 1;
  state.busy = false;
  state.controller = null;
  status("처리를 취소했어요. 다시 시작할 수 있습니다. 이미 시작된 외부 AI 처리는 계속될 수 있어요.");
  render();
}
function reset() {
  state.controller?.abort();
  state.version += 1;
  Object.assign(state, { source: null, result: null, dataUrl: "", fileName: "", busy: false, loading: false, controller: null });
  context.clearRect(0, 0, canvas.width, canvas.height);
  $("galleryInput").value = "";
  status("새로운 사진으로 다시 시작해 보세요.");
  render();
  $("uploadButton").focus();
}
function askPassword() {
  if (state.passwordResolve) return Promise.resolve(false);
  $("passwordInput").value = "";
  $("passwordError").textContent = "";
  $("passwordDialog").showModal();
  $("passwordInput").focus();
  return new Promise((resolve) => { state.passwordResolve = resolve; });
}
function closePassword(accepted) {
  const resolve = state.passwordResolve;
  state.passwordResolve = null;
  $("passwordDialog").close();
  $("passwordInput").value = "";
  resolve?.(accepted);
}
$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("passwordSubmit").disabled) return;
  $("passwordSubmit").disabled = true;
  $("passwordCancel").disabled = true;
  $("passwordError").textContent = "";
  try {
    await requestJson("/api/auth", { password: $("passwordInput").value }, AbortSignal.timeout(15_000));
    state.authenticated = true;
    closePassword(true);
    render();
  } catch (error) { $("passwordError").textContent = error.message || "연결을 확인하고 다시 시도해 주세요."; $("passwordInput").focus(); }
  finally { $("passwordSubmit").disabled = false; $("passwordCancel").disabled = false; }
});
$("passwordCancel").addEventListener("click", () => closePassword(false));
$("passwordDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!$("passwordSubmit").disabled) closePassword(false); });
$("passwordDialog").addEventListener("close", () => { if (state.passwordResolve) { const resolve = state.passwordResolve; state.passwordResolve = null; resolve(false); } });
async function loadConfig() {
  $("retryConfigButton").hidden = true;
  $("providerStatus").textContent = "서비스 연결 확인 중…";
  try {
    const config = await requestJson("/api/config", undefined, AbortSignal.timeout(10_000));
    state.ready = config.ready === true;
    state.maxBytes = config.maxImageBytes || state.maxBytes;
    $("providerStatus").textContent = `${config.provider} · ${config.message}`;
    $("retryConfigButton").hidden = state.ready;
    if (["OpenAI", "Gemini"].includes(config.provider)) $("privacyNote").textContent = `‘프로필 만들기’를 누르면 사진을 ${config.provider}${config.provider === "Gemini" ? "와 로컬 보정 서비스" : ""}에 전송해 판별·변환합니다. 사진 선택만으로는 전송되지 않아요.`;
    if (!state.ready) status("현재 변환 서비스를 준비 중입니다. 사진을 미리 선택하거나 잠시 후 다시 연결해 주세요.", "error");
    else if (state.source && !state.result && !state.busy) status("사진을 준비했어요. 배경을 고르고 ‘프로필 만들기’를 눌러 주세요.");
  } catch { state.ready = false; $("providerStatus").textContent = "서버 연결을 확인해 주세요."; $("retryConfigButton").hidden = false; }
  render();
}
$("uploadButton").addEventListener("click", () => $("galleryInput").click());
$("changeButton").addEventListener("click", () => $("galleryInput").click());
$("galleryInput").addEventListener("change", (event) => { loadFile(event.target.files[0]); event.target.value = ""; });
$("dropZone").addEventListener("dragover", (event) => { event.preventDefault(); if (!state.busy) $("dropZone").classList.add("dragover"); });
$("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("dragover"));
$("dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("dragover"); if (event.dataTransfer.files.length > 1) return status("사진은 한 장씩 선택해 주세요.", "error"); loadFile(event.dataTransfer.files[0]); });
$("convertButton").addEventListener("click", convert);
$("cancelButton").addEventListener("click", cancel);
$("resetButton").addEventListener("click", reset);
$("retryConfigButton").addEventListener("click", loadConfig);
$("originalButton").addEventListener("click", () => { state.showingResult = false; render(); });
$("resultButton").addEventListener("click", () => { state.showingResult = true; render(); });
$("downloadButton").addEventListener("click", () => {
  if (!state.result) return;
  try {
    const output = document.createElement("canvas"); output.width = 708; output.height = 944;
    drawImage(state.result, output);
    const link = document.createElement("a"); link.download = "kyobodt-profile.png"; link.href = output.toDataURL("image/png"); link.click();
    status("저장을 요청했어요. 기기의 다운로드 폴더를 확인해 주세요.", "success");
  } catch { status("이미지를 저장하지 못했습니다. 다시 변환한 뒤 저장해 주세요.", "error"); }
});
$("logoutButton").addEventListener("click", async () => {
  if (state.busy) cancel();
  try { await requestJson("/api/logout", {}, AbortSignal.timeout(10_000)); state.authenticated = false; reset(); status("이용을 종료했어요. 사진 미리보기를 비웠습니다."); }
  catch { status("이용을 종료하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.", "error"); }
  render();
});
requestJson("/api/session", undefined, AbortSignal.timeout(10_000)).then((session) => { state.authenticated = session.authenticated === true; render(); }).catch(() => {});
render();
loadConfig();
