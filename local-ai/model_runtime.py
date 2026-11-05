"""Model lifecycle and cache policy; importing this module never downloads models."""
from __future__ import annotations

import os
import hashlib
from pathlib import Path
import threading
import time
import urllib.request
import ssl

MODEL_ROOT = Path(os.environ.get("KYOBODT_MODEL_DIR", Path(__file__).parent / "models")).expanduser().resolve()
FACE_MODEL_PATH = MODEL_ROOT / "blaze_face_short_range.tflite"
REMBG_HOME = Path(os.environ.get("U2NET_HOME", MODEL_ROOT / "rembg")).expanduser().resolve()
REMBG_MODEL = os.environ.get("REMBG_MODEL", "u2net_human_seg")
FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
MODEL_CHECKSUMS = {"u2net_human_seg": "c09ddc2e0104f800e3e1bb4652583d1f", "u2netp": "8e83ca70e441ab06c318d82300c84806"}
SUPPORTED_MODELS = set(MODEL_CHECKSUMS)


def background_model_path() -> Path:
    # rembg 2.0.86 uses per-model directories and also accepts its legacy flat cache.
    nested = REMBG_HOME / "models" / REMBG_MODEL / f"{REMBG_MODEL}.onnx"
    legacy = REMBG_HOME / f"{REMBG_MODEL}.onnx"
    return nested if nested.is_file() or not legacy.is_file() else legacy


def verified_background_path() -> Path:
    path = background_model_path()
    if not path.is_file():
        raise SetupError("missing_models", "모델 파일이 없습니다. prepare_models.py --download를 먼저 실행하세요.")
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "md5").hexdigest()
    if checksum != MODEL_CHECKSUMS.get(REMBG_MODEL):
        raise SetupError("corrupt_model", "배경 모델 파일이 손상되었습니다. prepare_models.py --download로 명시적으로 다시 준비하세요.")
    return path


def verify_face_model() -> None:
    if not FACE_MODEL_PATH.is_file():
        raise SetupError("missing_models", "얼굴 모델 파일이 없습니다. prepare_models.py --download를 먼저 실행하세요.")
    with FACE_MODEL_PATH.open("rb") as stream:
        header = stream.read(8)
    if not 1024 <= FACE_MODEL_PATH.stat().st_size <= 5 * 1024 * 1024 or header[4:8] != b"TFL3":
        raise SetupError("corrupt_model", "얼굴 모델 파일이 손상되었습니다. prepare_models.py --download로 명시적으로 다시 준비하세요.")


class SetupError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def cache_status() -> dict:
    return {
        "face": FACE_MODEL_PATH.is_file(),
        "background": background_model_path().is_file(),
        "backgroundModel": REMBG_MODEL,
    }


def load_models(*, allow_download: bool = False) -> dict:
    if REMBG_MODEL not in SUPPORTED_MODELS:
        raise SetupError("invalid_model", "REMBG_MODEL은 u2net_human_seg 또는 u2netp를 사용하세요.")
    cached = cache_status()
    if not allow_download and not (cached["face"] and cached["background"]):
        raise SetupError("missing_models", "모델 파일이 없습니다. local-ai/prepare_models.py --download를 먼저 실행하세요.")
    if not allow_download:
        verify_face_model()
        verified_background_path()
    try:
        import certifi
        from mediapipe.tasks import python as mp_tasks
        from mediapipe.tasks.python import vision as mp_vision
        import onnxruntime as ort
        from rembg.sessions.u2net_human_seg import U2netHumanSegSession
        from rembg.sessions.u2netp import U2netpSession
        import pooch
    except ImportError as error:
        raise SetupError("missing_dependencies", "로컬 AI 의존성을 설치하세요. local-ai/doctor.py로 환경을 확인할 수 있습니다.") from error
    face_valid = False
    try:
        verify_face_model()
        face_valid = True
    except SetupError:
        pass
    if not face_valid and allow_download:
        FACE_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = FACE_MODEL_PATH.with_suffix(".download")
        try:
            context = ssl.create_default_context(cafile=certifi.where())
            with urllib.request.urlopen(FACE_MODEL_URL, context=context, timeout=30) as response:
                data = response.read(5 * 1024 * 1024 + 1)
            if not 1024 <= len(data) <= 5 * 1024 * 1024 or data[4:8] != b"TFL3":
                raise SetupError("download_failed", "얼굴 모델 다운로드를 확인하고 다시 준비해 주세요.")
            temporary.write_bytes(data)
            temporary.replace(FACE_MODEL_PATH)
        finally:
            temporary.unlink(missing_ok=True)
    # Explicit preparation owns downloads. Normal startup never calls rembg's downloader.
    if allow_download:
        target = background_model_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        pooch.retrieve(f"https://github.com/danielgatis/rembg/releases/download/v0.0.0/{REMBG_MODEL}.onnx",
                       known_hash=f"md5:{MODEL_CHECKSUMS[REMBG_MODEL]}", fname=target.name,
                       path=target.parent, progressbar=True)
    verify_face_model()
    model_path = verified_background_path()
    os.environ["U2NET_HOME"] = str(REMBG_HOME)
    detector = mp_vision.FaceDetector.create_from_options(mp_vision.FaceDetectorOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=str(FACE_MODEL_PATH)),
        min_detection_confidence=0.6,
    ))
    try:
        base_session = U2netHumanSegSession if REMBG_MODEL == "u2net_human_seg" else U2netpSession
        class CachedSession(base_session):
            @classmethod
            def download_models(cls, *args, **kwargs):
                # Override the downloader itself, including any missing/corrupt-cache retry.
                return str(model_path)
        session = CachedSession(REMBG_MODEL, ort.SessionOptions(), providers=["CPUExecutionProvider"])
    except Exception:
        detector.close()
        raise
    return {"detector": detector, "background": session}


class ModelRuntime:
    def __init__(self, loader=load_models):
        self.loader = loader
        self._lock = threading.Lock()
        self._state = "idle"
        self._message = "모델 준비 전입니다."
        self._code = None
        self._models = None
        self._started = None

    def start(self) -> bool:
        with self._lock:
            if self._state in {"loading", "ready"}:
                return False
            self._state = "loading"
            self._message = "로컬 AI 모델을 메모리에 준비하고 있습니다."
            self._code = None
            self._started = time.monotonic()
        threading.Thread(target=self._load, daemon=True, name="kyobodt-model-loader").start()
        return True

    def _load(self):
        try:
            models = self.loader()
            with self._lock:
                self._models = models
                self._state = "ready"
                self._message = "로컬 사진 판별·보정 모델이 준비되었습니다."
        except Exception as error:
            with self._lock:
                self._state = "error"
                self._code = error.code if isinstance(error, SetupError) else "model_load_failed"
                self._message = str(error) if isinstance(error, SetupError) else "모델을 불러오지 못했습니다. local-ai/doctor.py로 의존성과 모델 파일을 확인하세요."

    def status(self) -> dict:
        with self._lock:
            return {"ok": True, "ready": self._state == "ready", "state": self._state,
                    "message": self._message, "code": self._code, "models": cache_status()}

    def get(self) -> dict:
        with self._lock:
            if self._state != "ready":
                raise SetupError("not_ready", self._message)
            return self._models
