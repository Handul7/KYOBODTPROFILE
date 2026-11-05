"""Dependency/cache diagnostics without image uploads, keys, or model downloads."""
import argparse
import importlib.metadata
import importlib.util
import json
import platform
import sys
from model_runtime import FACE_MODEL_PATH, REMBG_HOME, REMBG_MODEL, cache_status

DEPENDENCIES = {"fastapi": "fastapi", "uvicorn": "uvicorn", "Pillow": "PIL", "numpy": "numpy", "opencv-contrib-python": "cv2", "mediapipe": "mediapipe", "rembg": "rembg", "onnxruntime": "onnxruntime", "certifi": "certifi"}


def diagnose():
    packages = {}
    for name, module in DEPENDENCIES.items():
        try:
            packages[name] = {"installed": importlib.util.find_spec(module) is not None, "version": importlib.metadata.version(name)}
        except (ImportError, importlib.metadata.PackageNotFoundError):
            packages[name] = {"installed": False, "version": None}
    compatible = (3, 11) <= sys.version_info[:2] <= (3, 13)
    cached = cache_status()
    return {"python": platform.python_version(), "executable": sys.executable, "platform": platform.system(), "architecture": platform.machine(),
            "recommendedPython": "3.11–3.13", "pythonSupported": compatible, "dependencies": packages,
            "dependenciesReady": compatible and all(item["installed"] for item in packages.values()),
            "modelsCached": cached["face"] and cached["background"], "cache": cached,
            "faceModelPath": str(FACE_MODEL_PATH), "backgroundModelPath": str(REMBG_HOME), "backgroundModel": REMBG_MODEL}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = diagnose()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["dependenciesReady"]:
        print("Python 3.11–3.13 가상환경에서 requirements.txt를 설치하세요.", file=sys.stderr)
    elif not report["modelsCached"]:
        print("모델이 없습니다. prepare_models.py --download를 명시적으로 실행하세요.", file=sys.stderr)
    raise SystemExit(0 if report["dependenciesReady"] and report["modelsCached"] else 1)
