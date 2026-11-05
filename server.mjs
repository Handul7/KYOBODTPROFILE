import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
loadDotEnv();

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const provider = process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "local");
const openaiModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
const openaiVisionModel = process.env.OPENAI_VISION_MODEL || "gpt-6-luna";
const geminiModel = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";
const localEndpoint = process.env.LOCAL_AI_ENDPOINT || "";
const localValidateEndpoint = process.env.LOCAL_AI_VALIDATE_ENDPOINT || derivedLocalEndpoint("/validate");
const localHealthEndpoint = process.env.LOCAL_AI_HEALTH_ENDPOINT || derivedLocalEndpoint("/health");
const appPassword = process.env.APP_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "kyobo");
const maxImageBytes = 8 * 1024 * 1024;
const sessions = new Map();
const loginAttempts = new Map();
const sessionDuration = 8 * 60 * 60 * 1000;
const timeoutMs = Math.max(100, Number(process.env.AI_TIMEOUT_MS) || 120_000);
const cookieName = "kyobodt_session";
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function createAppServer() {
  return createServer(async (request, response) => {
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        return sendJson(response, 200, { ...await getConfig(), maxImageBytes });
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        return sendJson(response, 200, { authenticated: Boolean(getSession(request)) });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        checkRequestOrigin(request);
        if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
          throw httpError(415, "JSON 형식으로 요청해 주세요.");
        }
        if (url.pathname === "/api/auth") {
          if (!appPassword) throw httpError(503, "관리자가 이용 비밀번호를 설정해야 합니다.");
          const address = request.socket.remoteAddress || "unknown";
          const now = Date.now();
          for (const [key, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(key);
          let attempt = loginAttempts.get(address);
          if (attempt?.count >= 10) {
            response.setHeader("Retry-After", String(Math.ceil((attempt.until - now) / 1000)));
            throw httpError(429, "비밀번호를 여러 번 틀렸습니다. 15분 후 다시 시도해 주세요.");
          }
          const body = await readJson(request, 4096);
          // Re-read after the await: concurrent attempts may have exhausted the limit.
          attempt = loginAttempts.get(address);
          if (attempt?.until <= Date.now()) attempt = undefined;
          if (attempt?.count >= 10) {
            response.setHeader("Retry-After", String(Math.ceil((attempt.until - Date.now()) / 1000)));
            throw httpError(429, "비밀번호를 여러 번 틀렸습니다. 15분 후 다시 시도해 주세요.");
          }
          if (!passwordMatches(body.password)) {
            if (loginAttempts.size >= 1000) loginAttempts.delete(loginAttempts.keys().next().value);
            loginAttempts.set(address, { count: (attempt?.count || 0) + 1, until: attempt?.until || now + 15 * 60_000 });
            throw httpError(401, "비밀번호가 맞지 않습니다.");
          }
          loginAttempts.delete(address);
          for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
          if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
          const previous = getSession(request);
          if (previous) sessions.delete(previous.token);
          const token = randomBytes(32).toString("hex");
          sessions.set(token, { token, expires: now + sessionDuration, busy: false });
          response.setHeader("Set-Cookie", sessionCookie(request, token, sessionDuration / 1000));
          return sendJson(response, 200, { ok: true });
        }
        if (url.pathname === "/api/logout") {
          const session = getSession(request);
          if (session) sessions.delete(session.token);
          response.setHeader("Set-Cookie", sessionCookie(request, "", 0));
          return sendJson(response, 200, { ok: true });
        }
        if (["/api/portrait", "/api/validate"].includes(url.pathname)) {
          const session = getSession(request);
          if (!session) throw httpError(401, "이용 시간이 만료되었습니다. 비밀번호를 다시 입력해 주세요.");
          if (session.busy) throw httpError(429, "이전 사진을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.");
          const body = await readJson(request);
          validateImageInput(body);
          // Check again after reading the body: two requests may arrive together.
          if (session.busy) throw httpError(429, "이전 사진을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.");
          session.busy = true;
          try {
            const result = url.pathname === "/api/portrait"
              ? await transformPortrait(body, controller.signal)
              : await validatePortraitInput(body, controller.signal);
            return sendJson(response, 200, result);
          } finally { session.busy = false; }
        }
        throw httpError(404, "요청한 경로를 찾을 수 없습니다.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD, POST");
        throw httpError(405, "지원하지 않는 요청입니다.");
      }
      await serveStatic(url.pathname, response, request.method === "HEAD");
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const status = error.status || 500;
      if (status >= 500) console.error(`Request failed: ${status} ${error.name || "Error"}`);
      sendJson(response, status, { error: error.status ? error.message : "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`KYOBODT running at http://${host}:${server.address().port}`);
    console.log(`AI_PROVIDER=${provider}`);
  });
}

function passwordMatches(password) {
  if (typeof password !== "string" || !password || password.length > 1024) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(password), digest(appPassword));
}

function getSession(request) {
  const token = (request.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
}

function sessionCookie(request, token, maxAge) {
  const secure = process.env.NODE_ENV === "production" || request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function checkRequestOrigin(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") throw httpError(403, "허용되지 않은 요청입니다.");
  if (!request.headers.origin) return;
  try {
    if (new URL(request.headers.origin).host === request.headers.host) return;
  } catch { /* Invalid origins are rejected. */ }
  throw httpError(403, "허용되지 않은 요청입니다.");
}

function configurationWarnings() {
  const warnings = [];
  if (provider === "openai" && /^gpt-image-1(?:\.5|-mini)?(?:-|$)/.test(openaiModel)) warnings.push("기존 GPT Image 모델의 종료 일정을 확인하고 OPENAI_IMAGE_MODEL을 갱신하세요 (1.5/mini: 2026-12-01).");
  if (provider === "openai" && /^gpt-4\.1-mini(?:-|$)/.test(openaiVisionModel)) warnings.push("gpt-4.1-mini 종료 예정: 2027-01-14. OPENAI_VISION_MODEL을 갱신하세요.");
  if (provider === "gemini" && geminiModel.includes("preview")) warnings.push("Gemini preview 모델의 종료 일정을 확인하세요. 안정 버전 사용을 권장합니다.");
  return warnings;
}

function derivedLocalEndpoint(pathname) {
  try { return new URL(pathname, localEndpoint).href; } catch { return ""; }
}

export async function getConfig() {
  const base = { provider: provider === "openai" ? "OpenAI" : provider === "gemini" ? "Gemini" : provider === "local" ? "Local AI" : "Mock", ready: false,
    model: provider === "openai" ? openaiModel : provider === "gemini" ? geminiModel : null,
    status: "missing_configuration", warnings: configurationWarnings(), checkedAt: new Date().toISOString() };
  if (!appPassword) return { ...base, message: "관리자가 APP_PASSWORD를 설정해야 합니다." };
  if (provider === "mock") return { ...base, ready: true, status: "mock", message: "체험 모드 · AI 변환 없이 저장 흐름만 확인합니다." };
  if (!["openai", "gemini", "local"].includes(provider)) return { ...base, provider, message: "지원하지 않는 AI 설정입니다. 관리자에게 문의해 주세요." };
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) return { ...base, message: "OPENAI_API_KEY가 필요합니다." };
    return { ...base, ready: true, status: "configured", message: `${openaiModel} 설정됨 · API 연결과 이용 한도는 변환 시 확인합니다.` };
  }
  if (provider === "gemini" && !process.env.GEMINI_API_KEY) return { ...base, message: "GEMINI_API_KEY가 필요합니다." };
  if (!localEndpoint || !localHealthEndpoint || !localValidateEndpoint) return { ...base, message: "로컬 AI 주소를 설정해야 합니다." };
  try {
    const response = await fetch(localHealthEndpoint, { signal: AbortSignal.timeout(2500), headers: { Accept: "application/json" } });
    const health = await response.json();
    if (!response.ok || typeof health.ready !== "boolean") throw new Error("Invalid local health response");
    if (!health.ready) {
      const loading = health.state === "loading";
      return { ...base, status: loading ? "loading" : "unavailable", localReady: false,
        message: loading ? "로컬 AI 모델을 준비하고 있습니다. 잠시 후 다시 연결해 주세요." : health.code === "missing_models" ? "로컬 AI 모델 준비가 필요합니다. 관리자에게 문의해 주세요." : "로컬 AI 모델을 사용할 수 없습니다. 관리자에게 문의해 주세요." };
    }
    return { ...base, ready: true, status: provider === "local" ? "ready" : "configured", localReady: true,
      message: provider === "local" ? "로컬 얼굴 판별·사진 보정 준비 완료" : `${geminiModel} 설정됨 · 로컬 보정 준비 완료 · 외부 API는 변환 시 확인합니다.` };
  } catch {
    return { ...base, status: "unavailable", localReady: false, message: "로컬 AI 서버에 연결되지 않습니다. 실행 상태와 주소를 확인해 주세요." };
  }
}

async function transformPortrait(body, signal) {
  if (!body?.imageDataUrl) throw httpError(400, "imageDataUrl이 필요합니다.");

  if (provider === "openai") return transformWithOpenAI(body, signal);
  if (provider === "gemini") return transformWithGemini(body, signal);
  if (provider === "local") return transformWithLocal(body, signal);
  if (provider === "mock") return { provider: "Mock", imageDataUrl: body.imageDataUrl };

  throw httpError(400, `지원하지 않는 AI_PROVIDER입니다: ${provider}`);
}

async function validatePortraitInput(body, signal) {
  if (!body?.imageDataUrl) throw httpError(400, "imageDataUrl이 필요합니다.");

  if (provider === "openai") return validateWithOpenAI(body.imageDataUrl, signal);
  if (provider === "gemini") return validateWithLocal(body.imageDataUrl, signal);
  if (provider === "local") return validateWithLocal(body.imageDataUrl, signal);
  if (provider === "mock") {
    return {
      ok: true,
      message: "목업 모드에서는 모든 사진을 허용합니다.",
      reason: "mock",
    };
  }

  throw httpError(400, `지원하지 않는 AI_PROVIDER입니다: ${provider}`);
}

async function validateWithOpenAI(imageDataUrl, signal) {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(503, "OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const apiResponse = await providerFetch("https://api.openai.com/v1/responses", {
    signal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiVisionModel,
      store: false,
      max_output_tokens: 800,
      ...(/^gpt-6-luna(?:-|$)/.test(openaiVisionModel) ? { reasoning: { effort: "none" } }
        : /^gpt-5-nano(?:-|$)/.test(openaiVisionModel) ? { reasoning: { effort: "low" } } : {}),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Judge whether this uploaded image is suitable as input for converting into a professional profile photo.",
                "Return only compact JSON with keys: ok(boolean), message(string), reason(string).",
                "ok should be true only when there is exactly one real human face, the face is clearly visible, not too small, not heavily obscured, not a pet/object/cartoon, and image quality is sufficient.",
                "If not suitable, message must be a short Korean instruction telling the user what better photo to upload.",
              ].join(" "),
            },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    }),
  });

  const payload = await providerJson(apiResponse);
  if (!apiResponse.ok) {
    throw httpError(502, "사진 판별 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const text = extractResponseText(payload);
  const parsed = parseJsonObject(text);
  requireBooleanResult(parsed);
  return {
    ok: parsed.ok,
    message: parsed.message || (parsed.ok ? "변환 가능합니다." : "얼굴이 잘 보이는 사람 사진을 다시 등록하세요."),
    reason: parsed.reason || "vision_check",
  };
}

async function validateWithLocal(imageDataUrl, signal) {
  const endpoint = localValidateEndpoint || localEndpoint;
  if (!endpoint) {
    throw httpError(503, "LOCAL_AI_VALIDATE_ENDPOINT 또는 LOCAL_AI_ENDPOINT를 설정하세요.");
  }

  const localResponse = await providerFetch(endpoint, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "validate_portrait_input",
      imageDataUrl,
    }),
  });

  const payload = await providerJson(localResponse);
  if (!localResponse.ok) {
    throw httpError(502, "사진 판별 서비스가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
  }

  requireBooleanResult(payload);
  return {
    ok: payload.ok,
    message: payload.message || (payload.ok ? "변환 가능합니다." : "얼굴이 잘 보이는 사람 사진을 다시 등록하세요."),
    reason: payload.reason || "local_check",
  };
}

async function transformWithOpenAI({ imageDataUrl, spec, background }, signal) {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(503, "OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const { buffer, mime } = parseDataUrl(imageDataUrl);
  const form = new FormData();
  form.append("model", openaiModel);
  form.append("image", new Blob([buffer], { type: mime }), `portrait-input.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`);
  // Newer GPT Image models always use high fidelity and reject this legacy option.
  if (["gpt-image-1", "gpt-image-1.5"].includes(openaiModel)) form.append("input_fidelity", "high");
  form.append("prompt", buildPrompt(spec, background));
  form.append("size", spec === "square" ? "1024x1024" : "1024x1536");
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
  form.append("output_format", "png");

  const apiResponse = await providerFetch("https://api.openai.com/v1/images/edits", {
    signal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  const payload = await providerJson(apiResponse);
  if (!apiResponse.ok) {
    throw httpError(502, "사진 변환 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const item = payload.data?.[0];
  if (item?.b64_json) {
    return generatedResult("OpenAI", `data:image/png;base64,${item.b64_json}`);
  }
  

  throw httpError(502, "OpenAI 응답에 이미지 데이터가 없습니다.");
}

async function transformWithGemini({ imageDataUrl, spec, background }, signal) {
  if (!process.env.GEMINI_API_KEY) {
    throw httpError(503, "GEMINI_API_KEY를 설정한 뒤 서버를 다시 실행하세요.");
  }
  if (!localEndpoint) {
    throw httpError(503, "규격 보정용 LOCAL_AI_ENDPOINT를 설정하세요.");
  }

  const { buffer, mime } = parseDataUrl(imageDataUrl);
  const apiResponse = await providerFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      signal,
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mime, data: buffer.toString("base64") } },
              { text: buildGeminiPrompt() },
            ],
          },
        ],
      }),
    }
  );

  const payload = await providerJson(apiResponse);
  if (!apiResponse.ok) {
    throw httpError(502, "사진 변환 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const parts = payload.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  if (!imagePart) {
    const refusal = parts.find((part) => part.text)?.text || "";
    throw httpError(502, refusal ? `Gemini가 이미지를 반환하지 않았습니다: ${refusal.slice(0, 120)}` : "Gemini 응답에 이미지 데이터가 없습니다.");
  }
  const inline = imagePart.inlineData || imagePart.inline_data;
  const generatedDataUrl = `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`;

  // 생성 결과를 로컬 파이프라인에 통과시켜 구도·배경색을 규격에 정확히 맞춘다 (색보정은 끔)
  const refined = await transformWithLocal({
    imageDataUrl: generatedDataUrl,
    spec,
    background,
    enhance: false,
  }, signal);
  return { provider: "Gemini", imageDataUrl: refined.imageDataUrl };
}

function buildGeminiPrompt() {
  return [
    "Retake this photo as a professional Korean studio profile portrait for a job application.",
    "Preserve the person's identity exactly: same face, same facial features, same hairstyle, and the same clothing they are wearing.",
    "Keep the original head pose, expression, facial proportions, skin texture and distinguishing details. Do not reshape the face, change age, or invent a smile.",
    "Recompose as a centered head-and-shoulders bust shot with the head upright.",
    "Replace the environment with a plain solid light gray studio background and soft, even, flattering studio lighting with no harsh shadows or color cast on the face.",
    "Remove any other people, hands, phones, or distracting objects.",
    "Photorealistic, sharp focus, high quality. Do not add text, watermark, or accessories.",
  ].join(" ");
}

async function transformWithLocal(body, signal) {
  if (!localEndpoint) {
    throw httpError(503, "LOCAL_AI_ENDPOINT를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const localResponse = await providerFetch(localEndpoint, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataUrl: body.imageDataUrl,
      prompt: buildPrompt(body.spec, body.background),
      spec: body.spec,
      background: body.background,
      enhance: body.enhance !== false,
    }),
  });

  const payload = await providerJson(localResponse);
  if (!localResponse.ok) {
    throw httpError(502, "사진 보정 서비스가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.");
  }

  if (payload.imageDataUrl) return generatedResult("Local AI", payload.imageDataUrl);
  if (payload.b64_json) return generatedResult("Local AI", `data:image/png;base64,${payload.b64_json}`);
  throw httpError(502, "로컬 AI 응답에 이미지 데이터가 없습니다.");
}

function buildPrompt(spec = "passport", background = "#f7f9fc") {
  const ratio = spec === "square" ? "1:1" : "3:4";
  return [
    "Transform the uploaded person photo into a professional profile photo.",
    "Preserve the person's identity, original expression, facial proportions, skin texture and distinguishing details exactly. Do not reshape or regenerate the face.",
    "Use a clean studio look, centered head and shoulders, original expression and head pose, natural skin tone, sharp focus, even lighting, no filters.",
    `Use a plain solid background close to ${background}.`,
    `Compose for a ${ratio} profile photo crop with enough headroom and visible shoulders.`,
    "Remove distracting background elements. Do not add text, watermark, accessories, or change the person into someone else.",
  ].join(" ");
}

async function serveStatic(pathname, response, headOnly) {
  let rawPath;
  try { rawPath = decodeURIComponent(pathname); } catch { throw httpError(400, "잘못된 주소입니다."); }
  const publicFiles = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
  if (!Object.hasOwn(publicFiles, rawPath)) throw httpError(404, "페이지를 찾을 수 없습니다.");
  const filePath = join(root, publicFiles[rawPath]);
  const data = await readFile(filePath);
  response.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[extname(filePath)], "Content-Length": data.length });
  response.end(headOnly ? undefined : data);
}

async function readJson(request, maxBytes = 12 * 1024 * 1024) {
  if (Number(request.headers["content-length"]) > maxBytes) throw httpError(413, "파일 용량은 8MB까지 가능합니다.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "파일 용량은 8MB까지 가능합니다.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw httpError(400, "요청 내용을 읽을 수 없습니다."); }
}

function validateImageInput(body) {
  parseDataUrl(body.imageDataUrl);
  if (body.spec && !["profile", "passport", "standard", "square"].includes(body.spec)) throw httpError(400, "지원하지 않는 사진 규격입니다.");
  if (body.background && !/^#[0-9a-f]{6}$/i.test(body.background)) throw httpError(400, "배경색 형식이 올바르지 않습니다.");
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw httpError(400, "사진을 먼저 선택해 주세요.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw httpError(400, "JPG, PNG, WebP 사진만 사용할 수 있습니다.");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > maxImageBytes) throw httpError(413, "파일 용량은 8MB까지 가능합니다.");
  const mime = match[1];
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const isWebp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (!(mime === "image/png" && isPng || mime === "image/jpeg" && isJpeg || mime === "image/webp" && isWebp)) throw httpError(400, "사진 파일 형식을 확인해 주세요.");
  return { mime, buffer };
}

function generatedResult(providerName, dataUrl) {
  try { parseDataUrl(dataUrl); }
  catch { throw httpError(502, "AI가 올바른 이미지 파일을 반환하지 않았습니다. 다시 시도해 주세요."); }
  return { provider: providerName, imageDataUrl: dataUrl };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function providerFetch(url, options) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try { return await fetch(url, { ...options, signal }); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw httpError(signal.aborted ? 504 : 502, signal.aborted ? "처리 시간이 길어졌습니다. 잠시 후 다시 시도해 주세요." : "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

async function providerJson(response) {
  try { return await response.json(); }
  catch (error) { throw httpError(error.name === "TimeoutError" || error.name === "AbortError" ? 504 : 502, "AI 응답을 읽지 못했습니다. 다시 시도해 주세요."); }
}

function requireBooleanResult(payload) {
  if (!payload || typeof payload.ok !== "boolean") throw httpError(502, "사진 판별 응답이 올바르지 않습니다. 다시 시도해 주세요.");
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonObject(text) {
  try { return JSON.parse(text); } catch { /* Some models wrap JSON in Markdown. */ }
  try {
    const match = /\{[\s\S]*\}/.exec(text || "");
    if (match) return JSON.parse(match[0]);
  } catch { /* A malformed provider response is an upstream error. */ }
  throw httpError(502, "사진 판별 응답을 해석하지 못했습니다.");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function loadDotEnv() {
  try {
    const env = readFileSync(join(root, ".env"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional for local development.
  }
}
