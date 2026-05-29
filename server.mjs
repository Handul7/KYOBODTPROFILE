import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = process.cwd();
loadDotEnv();

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const provider = process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "local");
const openaiModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
const openaiVisionModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const localEndpoint = process.env.LOCAL_AI_ENDPOINT || "";
const localValidateEndpoint = process.env.LOCAL_AI_VALIDATE_ENDPOINT || "";
const appPassword = process.env.APP_PASSWORD || "kyobo";

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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/config") {
      return sendJson(response, 200, getConfig());
    }

    if (request.method === "POST" && url.pathname === "/api/auth") {
      const body = await readJson(request);
      if (isAuthorized(body)) return sendJson(response, 200, { ok: true });
      return sendJson(response, 401, { ok: false, error: "비밀번호가 맞지 않습니다." });
    }

    if (request.method === "POST" && url.pathname === "/api/portrait") {
      const body = await readJson(request);
      requireAuthorized(body);
      const result = await transformPortrait(body);
      return sendJson(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/validate") {
      const body = await readJson(request);
      requireAuthorized(body);
      const result = await validatePortraitInput(body);
      return sendJson(response, 200, result);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "지원하지 않는 요청입니다." });
    }

    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    console.error(`[${request.method} ${request.url}]`, error.status || 500, error.message || error);
    sendJson(response, error.status || 500, { error: error.message || "서버 오류가 발생했습니다." });
  }
});

server.listen(port, host, () => {
  console.log(`KYOBODT running at http://${host}:${port}`);
  console.log(`AI_PROVIDER=${provider}`);
});

function getConfig() {
  if (provider === "openai") {
    return {
      provider: "OpenAI",
      ready: Boolean(process.env.OPENAI_API_KEY),
      message: process.env.OPENAI_API_KEY
        ? "OpenAI 사용 가능"
        : "OPENAI_API_KEY가 필요합니다.",
    };
  }

  if (provider === "local") {
    return {
      provider: "Local AI",
      ready: Boolean(localEndpoint),
      message: localEndpoint
        ? "로컬 AI 사용 가능"
        : "LOCAL_AI_ENDPOINT가 필요합니다.",
    };
  }

  return { provider: "Mock", ready: true, message: "목업 AI 사용 중" };
}

function isAuthorized(body) {
  return typeof body?.password === "string" && body.password === appPassword;
}

function requireAuthorized(body) {
  if (!isAuthorized(body)) throw httpError(401, "비밀번호가 필요합니다.");
}

async function transformPortrait(body) {
  if (!body?.imageDataUrl) throw httpError(400, "imageDataUrl이 필요합니다.");

  if (provider === "openai") return transformWithOpenAI(body);
  if (provider === "local") return transformWithLocal(body);
  if (provider === "mock") return { provider: "Mock", imageDataUrl: body.imageDataUrl };

  throw httpError(400, `지원하지 않는 AI_PROVIDER입니다: ${provider}`);
}

async function validatePortraitInput(body) {
  if (!body?.imageDataUrl) throw httpError(400, "imageDataUrl이 필요합니다.");

  if (provider === "openai") return validateWithOpenAI(body.imageDataUrl);
  if (provider === "local") return validateWithLocal(body.imageDataUrl);
  if (provider === "mock") {
    return {
      ok: true,
      message: "목업 모드에서는 모든 사진을 허용합니다.",
      reason: "mock",
    };
  }

  throw httpError(400, `지원하지 않는 AI_PROVIDER입니다: ${provider}`);
}

async function validateWithOpenAI(imageDataUrl) {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(503, "OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiVisionModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Judge whether this uploaded image is suitable as input for converting into a Korean ID photo.",
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

  const payload = await apiResponse.json();
  if (!apiResponse.ok) {
    throw httpError(apiResponse.status, payload.error?.message || "OpenAI 사진 판별 실패");
  }

  const text = extractResponseText(payload);
  const parsed = parseJsonObject(text);
  return {
    ok: Boolean(parsed.ok),
    message: parsed.message || (parsed.ok ? "변환 가능합니다." : "얼굴이 잘 보이는 사람 사진을 다시 등록하세요."),
    reason: parsed.reason || "vision_check",
  };
}

async function validateWithLocal(imageDataUrl) {
  const endpoint = localValidateEndpoint || localEndpoint;
  if (!endpoint) {
    throw httpError(503, "LOCAL_AI_VALIDATE_ENDPOINT 또는 LOCAL_AI_ENDPOINT를 설정하세요.");
  }

  const localResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "validate_portrait_input",
      imageDataUrl,
    }),
  });

  const payload = await localResponse.json();
  if (!localResponse.ok) {
    throw httpError(localResponse.status, payload.error || "로컬 AI 사진 판별 실패");
  }

  return {
    ok: Boolean(payload.ok),
    message: payload.message || (payload.ok ? "변환 가능합니다." : "얼굴이 잘 보이는 사람 사진을 다시 등록하세요."),
    reason: payload.reason || "local_check",
  };
}

async function transformWithOpenAI({ imageDataUrl, spec, background }) {
  if (!process.env.OPENAI_API_KEY) {
    throw httpError(503, "OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const { buffer, mime } = parseDataUrl(imageDataUrl);
  const form = new FormData();
  form.append("model", openaiModel);
  form.append("image", new Blob([buffer], { type: mime }), "portrait-input.png");
  form.append("prompt", buildPrompt(spec, background));
  form.append("size", spec === "square" ? "1024x1024" : "1024x1536");
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
  form.append("output_format", "png");

  const apiResponse = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  const payload = await apiResponse.json();
  if (!apiResponse.ok) {
    throw httpError(apiResponse.status, payload.error?.message || "OpenAI 이미지 변환 실패");
  }

  const item = payload.data?.[0];
  if (item?.b64_json) {
    return { provider: "OpenAI", imageDataUrl: `data:image/png;base64,${item.b64_json}` };
  }
  if (item?.url) {
    return { provider: "OpenAI", imageUrl: item.url };
  }

  throw httpError(502, "OpenAI 응답에 이미지 데이터가 없습니다.");
}

async function transformWithLocal(body) {
  if (!localEndpoint) {
    throw httpError(503, "LOCAL_AI_ENDPOINT를 설정한 뒤 서버를 다시 실행하세요.");
  }

  const localResponse = await fetch(localEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataUrl: body.imageDataUrl,
      prompt: buildPrompt(body.spec, body.background),
      spec: body.spec,
      background: body.background,
    }),
  });

  const payload = await localResponse.json();
  if (!localResponse.ok) {
    throw httpError(localResponse.status, payload.error || "로컬 AI 변환 실패");
  }

  if (payload.imageDataUrl) return { provider: "Local AI", imageDataUrl: payload.imageDataUrl };
  if (payload.b64_json) return { provider: "Local AI", imageDataUrl: `data:image/png;base64,${payload.b64_json}` };
  throw httpError(502, "로컬 AI 응답에 이미지 데이터가 없습니다.");
}

function buildPrompt(spec = "passport", background = "#f7f9fc") {
  const ratio = spec === "square" ? "1:1" : "3:4";
  return [
    "Transform the uploaded person photo into a professional Korean ID photo.",
    "Preserve the person's identity and natural facial features.",
    "Use a clean studio look, centered head and shoulders, front-facing composition, neutral expression, natural skin tone, sharp focus, even lighting, no filters.",
    `Use a plain solid background close to ${background}.`,
    `Compose for a ${ratio} ID photo crop with enough headroom and visible shoulders.`,
    "Remove distracting background elements. Do not add text, watermark, accessories, or change the person into someone else.",
  ].join(" ");
}

async function serveStatic(pathname, response, headOnly) {
  const rawPath = decodeURIComponent(pathname.split("?")[0]);
  const safePath = normalize(rawPath).replace(/^[/\\]+/, "");
  if (safePath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
    throw httpError(403, "접근할 수 없는 경로입니다.");
  }
  const filePath = resolve(root, safePath === "" ? "index.html" : safePath);
  const rootPath = resolve(root);
  if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
    throw httpError(403, "접근할 수 없는 경로입니다.");
  }
  const data = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (!headOnly) response.end(data);
  else response.end();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 18 * 1024 * 1024) throw httpError(413, "이미지 용량이 너무 큽니다.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!match) throw httpError(400, "올바른 이미지 데이터가 아닙니다.");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text || "");
    if (match) return JSON.parse(match[0]);
    throw httpError(502, "사진 판별 응답을 해석하지 못했습니다.");
  }
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
