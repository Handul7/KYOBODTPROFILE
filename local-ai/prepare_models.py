"""Explicit one-time preparation; no network access without --download."""
import argparse
import json
from model_runtime import FACE_MODEL_PATH, REMBG_HOME, REMBG_MODEL, cache_status, load_models


def main():
    parser = argparse.ArgumentParser(description="KYOBODT 로컬 AI 모델 준비")
    parser.add_argument("--download", action="store_true", help="누락된 모델을 공식 저장소에서 다운로드합니다 (human 모델 약 176MB)")
    args = parser.parse_args()
    print(json.dumps({"facePath": str(FACE_MODEL_PATH), "backgroundPath": str(REMBG_HOME), "model": REMBG_MODEL, "cache": cache_status()}, ensure_ascii=False, indent=2))
    try:
        models = load_models(allow_download=args.download)
        models["detector"].close()
    except Exception as error:
        print("모델 준비 실패:", str(error))
        return 1
    print("모델 준비 완료. 웹 서버와 로컬 AI 서버를 실행하세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
