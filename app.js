const canvas = document.querySelector("#photoCanvas");
const ctx = canvas.getContext("2d");
const galleryInput = document.querySelector("#galleryInput");
const uploadDrop = document.querySelector("#uploadDrop");
const downloadBtn = document.querySelector("#downloadBtn");
const providerStatus = document.querySelector("#providerStatus");
const validationStatus = document.querySelector("#validationStatus");
const passwordDialog = document.querySelector("#passwordDialog");
const passwordForm = document.querySelector("#passwordForm");
const passwordInput = document.querySelector("#passwordInput");
const passwordError = document.querySelector("#passwordError");
const passwordCancel = document.querySelector("#passwordCancel");

// 사진관 프로필 바스트샷: 3×4 비율, 300dpi 인쇄 기준 2배 해상도
const preset = { width: 708, height: 944, name: "kyobodt-profile.png" };
const profileSpec = "profile";
const profileBackground = "#d9dce1"; // 비즈니스 그레이

const state = {
  image: null,
  originalDataUrl: "",
  objectUrl: "",
  appPassword: sessionStorage.getItem("kyobodt_password") || "",
  passwordResolve: null,
  transforming: false,
  aiReady: false,
};

function setCanvasSize() {
  canvas.width = preset.width;
  canvas.height = preset.height;
  canvas.style.aspectRatio = `${preset.width} / ${preset.height}`;
}

function drawGuide() {
  // 바스트샷 구도: 정수리~턱 = 세로의 58%, 정수리 위 여백 12%
  const { width, height } = canvas;
  ctx.save();
  ctx.strokeStyle = "rgba(31, 111, 235, 0.32)";
  ctx.lineWidth = Math.max(3, width * 0.004);
  ctx.setLineDash([14, 14]);
  ctx.strokeRect(width * 0.31, height * 0.12, width * 0.38, height * 0.44);
  ctx.beginPath();
  ctx.moveTo(width * 0.12, height * 0.88);
  ctx.quadraticCurveTo(width * 0.5, height * 0.66, width * 0.88, height * 0.88);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  setCanvasSize();
  ctx.fillStyle = profileBackground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!state.image) {
    drawGuide();
    return;
  }

  const scale = Math.max(canvas.width / state.image.width, canvas.height / state.image.height);
  const drawW = state.image.width * scale;
  const drawH = state.image.height * scale;
  ctx.drawImage(state.image, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
}

function loadFile(file) {
  if (!file) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);

  downloadBtn.disabled = true;
  downloadBtn.classList.add("hidden");
  state.transforming = false;

  const reader = new FileReader();
  const image = new Image();
  const url = URL.createObjectURL(file);

  image.onload = () => {
    state.image = image;
    state.objectUrl = url;
    uploadDrop.classList.add("hidden");
    draw();
  };

  reader.onload = async () => {
    state.originalDataUrl = String(reader.result || "");
    await validateAndTransform();
  };

  reader.readAsDataURL(file);
  image.src = url;
  galleryInput.value = "";
}

galleryInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
uploadDrop.addEventListener("click", openDevicePicker);
canvas.addEventListener("click", openDevicePicker);

downloadBtn.addEventListener("click", () => {
  draw();
  const link = document.createElement("a");
  link.download = preset.name;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = passwordInput.value.trim();
  passwordError.textContent = "";

  try {
    await authenticate(password);
    state.appPassword = password;
    sessionStorage.setItem("kyobodt_password", password);
    closePasswordDialog(true);
  } catch (error) {
    passwordError.textContent = error.message;
  }
});

passwordCancel.addEventListener("click", () => closePasswordDialog(false));

async function validateAndTransform() {
  if (!state.originalDataUrl || state.transforming) return;
  if (!state.aiReady) {
    validationStatus.textContent = "AI 설정이 완료된 뒤 다시 시도하세요.";
    validationStatus.className = "invalid";
    return;
  }
  if (!(await ensurePassword())) return;

  state.transforming = true;
  validationStatus.textContent = "사진을 확인하는 중입니다.";
  validationStatus.className = "";

  try {
    const validation = await postJson("/api/validate", {
      imageDataUrl: state.originalDataUrl,
      password: state.appPassword,
    });

    if (!validation.ok) {
      validationStatus.textContent = validation.message || "얼굴이 잘 보이는 사람 사진을 다시 올려주세요.";
      validationStatus.className = "invalid";
      return;
    }

    validationStatus.textContent = "증명사진으로 변환하는 중입니다.";
    validationStatus.className = "";

    const result = await postJson("/api/portrait", {
      imageDataUrl: state.originalDataUrl,
      spec: profileSpec,
      background: profileBackground,
      password: state.appPassword,
    });

    await loadGeneratedImage(result.imageDataUrl || result.imageUrl);
    providerStatus.textContent = `${result.provider} 변환 완료`;
    validationStatus.textContent = "완료되었습니다. 사진을 누르면 다시 선택할 수 있습니다.";
    validationStatus.className = "valid";
    downloadBtn.disabled = false;
    downloadBtn.classList.remove("hidden");
  } catch (error) {
    validationStatus.textContent = error.message;
    validationStatus.className = "invalid";
  } finally {
    state.transforming = false;
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청에 실패했습니다.");
  return payload;
}

async function authenticate(password) {
  const payload = await postJson("/api/auth", { password });
  if (!payload.ok) throw new Error(payload.error || "비밀번호가 맞지 않습니다.");
  return payload;
}

async function loadGeneratedImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      state.image = image;
      draw();
      resolve();
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    state.aiReady = Boolean(config.ready);
    providerStatus.textContent = config.ready ? `${config.provider} 사용 가능` : config.message;
  } catch {
    state.aiReady = false;
    providerStatus.textContent = "AI 서버가 실행되지 않았습니다.";
  }
}

async function openDevicePicker() {
  if (state.transforming) return;
  if (await ensurePassword()) galleryInput.click();
}

async function ensurePassword() {
  if (state.appPassword && (await verifyPassword(state.appPassword))) return true;
  state.appPassword = "";
  sessionStorage.removeItem("kyobodt_password");
  return openPasswordDialog();
}

async function verifyPassword(password) {
  try {
    await authenticate(password);
    return true;
  } catch {
    return false;
  }
}

function openPasswordDialog() {
  passwordInput.value = "";
  passwordError.textContent = "";
  passwordDialog.showModal();
  passwordInput.focus();
  return new Promise((resolve) => {
    state.passwordResolve = resolve;
  });
}

function closePasswordDialog(allowed) {
  passwordDialog.close();
  if (state.passwordResolve) state.passwordResolve(allowed);
  state.passwordResolve = null;
}

draw();
loadConfig();
