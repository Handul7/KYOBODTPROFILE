"""KYOBODT 로컬 AI 서버.

server.mjs 의 LOCAL_AI_VALIDATE_ENDPOINT / LOCAL_AI_ENDPOINT 규격을 구현한다.

- POST /validate : MediaPipe 얼굴 감지 + 조명/선명도 수치 검사 → {ok, message, reason}
- POST /transform: 자동 화이트밸런스 + CLAHE 보정 + rembg 배경 제거 + 규격 크롭
                   → {imageDataUrl}
"""

import base64
import io
import re
import threading
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel

import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision
from rembg import new_session, remove

app = FastAPI(title="KYOBODT Local AI")

# 사람 전신/상반신 분리에 특화된 세그멘테이션 모델 (최초 1회 자동 다운로드, ~170MB)
REMBG_SESSION = new_session("u2net_human_seg")

# MediaPipe Tasks 얼굴 감지 모델 (최초 1회 자동 다운로드, ~230KB)
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
FACE_MODEL_PATH = Path(__file__).parent / "models" / "blaze_face_short_range.tflite"
if not FACE_MODEL_PATH.exists():
    import ssl

    import certifi

    FACE_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(FACE_MODEL_URL, context=context) as response:
        FACE_MODEL_PATH.write_bytes(response.read())

FACE_DETECTOR = mp_vision.FaceDetector.create_from_options(
    mp_vision.FaceDetectorOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=str(FACE_MODEL_PATH)),
        min_detection_confidence=0.6,
    )
)
FACE_DETECTOR_LOCK = threading.Lock()

# 판별 기준값
MIN_FACE_AREA_RATIO = 0.03   # 얼굴이 사진 면적의 3% 미만이면 너무 작음
MIN_FACE_BRIGHTNESS = 60     # 얼굴 평균 밝기 (0~255)
MAX_FACE_BRIGHTNESS = 232    # 과노출
MAX_SIDE_BRIGHTNESS_GAP = 48 # 얼굴 좌우 밝기 차 (한쪽 그림자)
MIN_SHARPNESS = 35           # 라플라시안 분산 (흐림 검사)

SKIN_SMOOTH_STRENGTH = 0.65  # 피부 보정 강도 (0=끔 ~ 1=최대)
BRIGHTEN_GAMMA = 0.88        # 전체 조명 밝기 (1=원본, 낮을수록 밝게. 0.85~0.95 권장)

# 300dpi 기준 2배 해상도. 프로필은 3×4 비율
OUTPUT_SIZES = {"profile": (708, 944), "passport": (826, 1062), "standard": (708, 944), "square": (1000, 1000)}

# 사진관 프로필 바스트샷 구도: 정수리~턱이 세로의 55~60%, 어깨·가슴까지 여유
HEAD_PER_BBOX = 1.45      # 정수리~턱 길이 ≈ 얼굴 감지 bbox(눈썹~턱)의 1.45배
HEAD_HEIGHT_RATIO = 0.58  # 머리 길이 / 사진 세로 목표값
CROWN_MARGIN = 0.12       # 정수리 위 여백 / 사진 세로


class ValidateBody(BaseModel):
    imageDataUrl: str
    task: str | None = None


class TransformBody(BaseModel):
    imageDataUrl: str
    prompt: str | None = None
    spec: str | None = "passport"
    background: str | None = "#f7f9fc"
    # False면 색·조명·피부 보정을 건너뛰고 배경 교체와 규격 크롭만 수행
    # (생성형 모델 결과물을 규격에 맞출 때 사용)
    enhance: bool = True


def decode_data_url(data_url: str) -> np.ndarray:
    match = re.match(r"^data:image/[\w.+-]+;base64,(.+)$", data_url, re.DOTALL)
    if not match:
        raise ValueError("올바른 이미지 데이터가 아닙니다.")
    raw = base64.b64decode(match.group(1))
    image = Image.open(io.BytesIO(raw))
    # 폰 카메라의 EXIF 회전 정보를 반영해 사진을 바로 세운다
    image = ImageOps.exif_transpose(image).convert("RGB")
    # 폰카 원본은 매우 클 수 있으므로 처리 속도를 위해 긴 변 1600px로 제한
    image.thumbnail((1600, 1600), Image.LANCZOS)
    return np.array(image)


def encode_png_data_url(rgb: np.ndarray) -> str:
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def parse_hex_color(value: str | None) -> tuple[int, int, int]:
    match = re.match(r"^#?([0-9a-fA-F]{6})$", (value or "").strip())
    if not match:
        return (247, 249, 252)  # 기본 배경 #f7f9fc
    code = match.group(1)
    return tuple(int(code[i : i + 2], 16) for i in (0, 2, 4))


def detect_faces(rgb: np.ndarray) -> list[dict]:
    """얼굴 목록을 픽셀 좌표 bbox로 반환한다."""
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    with FACE_DETECTOR_LOCK:
        result = FACE_DETECTOR.detect(image)
    faces = []
    for detection in result.detections:
        box = detection.bounding_box
        faces.append(
            {
                "x": max(0, int(box.origin_x)),
                "y": max(0, int(box.origin_y)),
                "w": int(box.width),
                "h": int(box.height),
                "score": detection.categories[0].score if detection.categories else 1.0,
            }
        )
    return faces


def check_quality(rgb: np.ndarray, face: dict) -> tuple[bool, str, str]:
    """조명·선명도 수치 검사. (ok, message, reason)"""
    height, width = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    x, y, w, h = face["x"], face["y"], face["w"], face["h"]
    face_gray = gray[y : min(y + h, height), x : min(x + w, width)]
    if face_gray.size == 0:
        return False, "얼굴 영역을 읽지 못했습니다. 다른 사진을 올려주세요.", "face_region"

    area_ratio = (w * h) / (width * height)
    if area_ratio < MIN_FACE_AREA_RATIO:
        return False, "얼굴이 너무 작습니다. 카메라에 더 가까이서 찍어주세요.", "face_too_small"

    brightness = float(face_gray.mean())
    if brightness < MIN_FACE_BRIGHTNESS:
        return False, "사진이 너무 어둡습니다. 창문이나 조명을 정면으로 바라보고 다시 찍어주세요.", "too_dark"
    if brightness > MAX_FACE_BRIGHTNESS:
        return False, "빛이 너무 강해 얼굴이 하얗게 날아갔습니다. 직사광을 피해 다시 찍어주세요.", "overexposed"

    half = face_gray.shape[1] // 2
    if half > 0:
        gap = abs(float(face_gray[:, :half].mean()) - float(face_gray[:, half:].mean()))
        if gap > MAX_SIDE_BRIGHTNESS_GAP:
            return False, "얼굴 한쪽에 그림자가 짙습니다. 빛을 정면에서 받도록 다시 찍어주세요.", "uneven_lighting"

    sharpness = float(cv2.Laplacian(face_gray, cv2.CV_64F).var())
    if sharpness < MIN_SHARPNESS:
        return False, "사진이 흐릿합니다. 초점을 맞춰 흔들리지 않게 다시 찍어주세요.", "blurry"

    return True, "변환 가능합니다.", "ok"


def auto_white_balance(rgb: np.ndarray) -> np.ndarray:
    """그레이월드 화이트밸런스를 약하게 적용해 색조(노란 형광등 등)만 완화한다."""
    result = rgb.astype(np.float32)
    means = result.reshape(-1, 3).mean(axis=0)
    overall = means.mean()
    scales = np.clip(overall / np.maximum(means, 1e-6), 0.94, 1.06)  # 과교정 방지
    scales = 1.0 + (scales - 1.0) * 0.6  # 60% 강도로만 적용
    return np.clip(result * scales, 0, 255).astype(np.uint8)


def enhance_lighting(rgb: np.ndarray) -> np.ndarray:
    """LAB L채널에 약한 CLAHE를 적용해 어두운 부분을 자연스럽게 밝힌다."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    clahe = cv2.createCLAHE(clipLimit=1.2, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    # 원본과 절반씩 섞어 인위적인 느낌을 줄인다
    blended = cv2.addWeighted(enhanced, 0.5, rgb, 0.5, 0)
    # 감마 보정으로 스튜디오 조명처럼 전체를 한 단계 밝힌다 (하이라이트는 보존)
    lut = ((np.arange(256) / 255.0) ** BRIGHTEN_GAMMA * 255).astype(np.uint8)
    return cv2.LUT(blended, lut)


def smooth_skin(rgb: np.ndarray, face: dict | None, strength: float = SKIN_SMOOTH_STRENGTH) -> np.ndarray:
    """얼굴 주변 피부색 영역에만 경계 보존 스무딩을 적용해 잡티를 완화한다.

    눈·눈썹·머리카락·윤곽선은 피부색 마스크에서 제외되어 선명하게 유지된다.
    """
    if not face or strength <= 0:
        return rgb

    height, width = rgb.shape[:2]

    # 얼굴 bbox를 1.7배로 넓힌 타원 (이마·목까지 포함)
    cx = face["x"] + face["w"] / 2
    cy = face["y"] + face["h"] / 2
    ax = int(face["w"] * 0.85 * 1.7)
    ay = int(face["h"] * 0.85 * 1.9)
    region_mask = np.zeros((height, width), dtype=np.uint8)
    cv2.ellipse(region_mask, (int(cx), int(cy)), (ax, ay), 0, 0, 360, 255, -1)

    # YCrCb 피부색 범위 마스크
    ycrcb = cv2.cvtColor(rgb, cv2.COLOR_RGB2YCrCb)
    skin_mask = cv2.inRange(ycrcb, (40, 135, 85), (255, 180, 135))
    skin_mask = cv2.bitwise_and(skin_mask, region_mask)

    # 작은 구멍 메우고 가장자리를 부드럽게
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    skin_mask = cv2.morphologyEx(skin_mask, cv2.MORPH_CLOSE, kernel)
    skin_mask = cv2.GaussianBlur(skin_mask, (21, 21), 0)

    smoothed = cv2.bilateralFilter(rgb, d=9, sigmaColor=45, sigmaSpace=9)
    # 스무딩 후에도 미세 질감을 약간 되살려 플라스틱 느낌을 방지
    detail = cv2.addWeighted(rgb, 0.25, smoothed, 0.75, 0)

    alpha = (skin_mask.astype(np.float32) / 255.0 * strength)[:, :, None]
    result = rgb.astype(np.float32) * (1 - alpha) + detail.astype(np.float32) * alpha
    return result.astype(np.uint8)


def replace_background(rgb: np.ndarray, bg_color: tuple[int, int, int]) -> np.ndarray:
    """rembg로 사람만 분리해 단색 배경 위에 합성한다."""
    rgba = remove(
        Image.fromarray(rgb),
        session=REMBG_SESSION,
        post_process_mask=True,
    )
    person = np.array(rgba).astype(np.float32)
    alpha = person[:, :, 3:4] / 255.0
    background = np.full_like(person[:, :, :3], bg_color, dtype=np.float32)
    composed = person[:, :, :3] * alpha + background * (1.0 - alpha)
    return composed.astype(np.uint8)


def crop_to_spec(
    rgb: np.ndarray, face: dict | None, spec: str, bg_color: tuple[int, int, int]
) -> np.ndarray:
    """얼굴 위치 기준으로 증명사진 구도로 크롭한다. 부족한 영역은 배경색으로 채운다."""
    out_w, out_h = OUTPUT_SIZES.get(spec or "passport", OUTPUT_SIZES["passport"])
    ratio = out_w / out_h
    height, width = rgb.shape[:2]

    if face:
        # 바스트샷 구도: 정수리~턱 = 세로의 58%, 정수리 위 여백 12%, 얼굴 가로 중앙
        head_len = face["h"] * HEAD_PER_BBOX
        crop_h = int(head_len / HEAD_HEIGHT_RATIO)
        crop_w = int(crop_h * ratio)
        center_x = face["x"] + face["w"] // 2
        crown_y = face["y"] - 0.45 * face["h"]  # bbox 위(눈썹)에서 정수리까지 추정
        top = int(crown_y - CROWN_MARGIN * crop_h)
        left = center_x - crop_w // 2
    else:
        crop_h = height
        crop_w = int(crop_h * ratio)
        if crop_w > width:
            crop_w = width
            crop_h = int(crop_w / ratio)
        top = (height - crop_h) // 2
        left = (width - crop_w) // 2

    # 아래쪽(어깨)은 가능한 한 원본 안에 머물도록 위치를 보정
    if top + crop_h > height:
        top = max(top - (top + crop_h - height), int(-0.08 * crop_h))

    canvas = np.full((crop_h, crop_w, 3), bg_color, dtype=np.uint8)
    src_x0, src_y0 = max(0, left), max(0, top)
    src_x1, src_y1 = min(width, left + crop_w), min(height, top + crop_h)
    if src_x1 > src_x0 and src_y1 > src_y0:
        dst_x0, dst_y0 = src_x0 - left, src_y0 - top
        canvas[dst_y0 : dst_y0 + (src_y1 - src_y0), dst_x0 : dst_x0 + (src_x1 - src_x0)] = rgb[
            src_y0:src_y1, src_x0:src_x1
        ]

    return cv2.resize(canvas, (out_w, out_h), interpolation=cv2.INTER_LANCZOS4)


@app.post("/validate")
def validate(body: ValidateBody):
    try:
        rgb = decode_data_url(body.imageDataUrl)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "이미지를 읽지 못했습니다."})

    faces = detect_faces(rgb)
    if len(faces) == 0:
        return {"ok": False, "message": "얼굴을 찾지 못했습니다. 정면 얼굴이 잘 보이는 사진을 올려주세요.", "reason": "no_face"}
    if len(faces) > 1:
        return {"ok": False, "message": "여러 명이 감지되었습니다. 한 명만 나온 사진을 올려주세요.", "reason": "multiple_faces"}

    ok, message, reason = check_quality(rgb, faces[0])
    return {"ok": ok, "message": message, "reason": reason}


@app.post("/transform")
def transform(body: TransformBody):
    try:
        rgb = decode_data_url(body.imageDataUrl)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "이미지를 읽지 못했습니다."})

    bg_color = parse_hex_color(body.background)

    corrected = enhance_lighting(auto_white_balance(rgb)) if body.enhance else rgb

    faces = detect_faces(corrected)
    face = faces[0] if faces else None

    retouched = smooth_skin(corrected, face) if body.enhance else corrected
    composed = replace_background(retouched, bg_color)
    result = crop_to_spec(composed, face, body.spec or "passport", bg_color)

    return {"imageDataUrl": encode_png_data_url(result)}


@app.get("/health")
def health():
    return {"ok": True}
