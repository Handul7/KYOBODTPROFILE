# KYOBODT · 프로필 스튜디오

사진을 골라 배경을 선택하고, AI로 스튜디오 스타일의 프로필을 만든 뒤 원본과 비교해 저장하는 웹 앱입니다. 출력 파일은 **708 × 944px, 3:4 비율의 PNG 또는 JPG**입니다. 여권·신분증 사진 규격을 보장하는 서비스는 아닙니다. AI가 얼굴이나 의상을 바꿀 수 있으므로 사용 전 결과를 확인해야 합니다.

## 사진을 만드는 흐름

1. JPG, PNG, WebP 사진을 선택하거나 끌어 놓습니다. 모바일에서는 **카메라로 촬영**도 사용할 수 있습니다. 최대 8MB이며, 사진 선택만으로 서버에 전송되지 않습니다.
2. 배경을 고르고 **프로필 만들기**를 누릅니다. 비밀번호 확인 후 사진 적합성 판별과 변환을 순서대로 실행합니다.
3. **원본 / 변환 결과**를 비교하고 **완성한 프로필 저장**을 누릅니다. PNG/JPG 형식을 고를 수 있고, 지원되는 모바일 브라우저에서는 공유 버튼으로 사진 앱이나 파일 앱에 저장할 수 있습니다. 실패하면 같은 사진으로 다시 시도할 수 있으며, 처리 취소와 초기화도 지원합니다.

브라우저에서는 최대 4,000만 화소 사진을 받으며, 전송 전 사진의 긴 변을 2,048px 이하로 줄이고 JPEG로 다시 인코딩해 원본 EXIF 메타데이터를 제외합니다. 앱은 사진을 디스크에 저장하지 않습니다. OpenAI/Gemini 모드에서는 사진을 해당 외부 서비스로 전송합니다. 외부 서비스의 데이터 처리 정책은 별도로 확인해야 합니다. 취소는 앱의 요청을 중단하며, 이미 시작된 외부 AI 처리나 비용까지 취소된다고 보장하지 않습니다.

## 빠른 시작

Node.js 20.3 이상이 필요합니다. CI에서는 Node.js 22를 사용합니다. 웹 서버에 별도 npm 패키지 설치는 필요하지 않습니다.

```bash
cp .env.example .env
```

`.env`에 사용할 모드와 비밀번호를 설정한 뒤 실행합니다.

```bash
npm start
```

기본 주소는 `http://127.0.0.1:5173`입니다. 같은 Wi-Fi의 휴대폰에서는 컴퓨터의 로컬 IP와 포트를 사용합니다. 로컬 개발의 기본 비밀번호 `kyobo`는 공개 배포에 사용하지 마세요.

### AI 호출 없이 화면과 저장 흐름 확인

```bash
AI_PROVIDER=mock APP_PASSWORD=preview-password npm start
```

Mock 모드는 원본을 반환하며 실제 얼굴 판별이나 AI 보정을 하지 않습니다. 화면에 체험 모드임을 표시합니다. 테스트용 사진은 실제 인물 사진 대신 합성 이미지로도 충분합니다.

## AI 모드

| 모드 | 사진 판별 | 변환 | 필요한 설정 |
| --- | --- | --- | --- |
| `openai` | OpenAI 비전 | OpenAI 이미지 편집 | `OPENAI_API_KEY` |
| `local` | MediaPipe + 선명도·조명 검사 | 색·조명 보정, rembg 배경 제거, 얼굴 중심 크롭 | 로컬 AI 서버 |
| `gemini` | 로컬 사진 판별 | Gemini 생성 후 로컬 배경·구도 보정 | `GEMINI_API_KEY` + 로컬 AI 서버 |
| `mock` | 항상 통과 | 원본 반환 | 없음, 개발·검증 전용 |

모델명은 환경 변수로 바꿀 수 있습니다. 새 `.env.example`은 외부 과금 없이 사용할 수 있는 `local` 모드로 시작합니다. 로컬 실행 환경은 별도로 준비해야 하며 앱 실행만으로 패키지나 모델을 설치하지 않습니다.

로컬 상태는 Python 서버의 `/health`에서 **모델 준비 완료 여부를 직접 확인**합니다. 외부 AI는 키·모델이 설정되면 `configured`로 표시하며, 실제 계정 권한·할당량은 변환 시 확인합니다. 화면 연결 확인과 진단 명령은 유료 AI를 호출하지 않습니다.

### OpenAI

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
OPENAI_VISION_MODEL=gpt-6-luna
OPENAI_IMAGE_QUALITY=high
```

### 로컬 AI

Python 서버는 사진 판별과 배경 제거·규격 보정을 담당합니다. **Python 3.11–3.13**을 권장합니다. 시스템 `python3`가 3.14 이상이면 별도 호환 환경을 선택하세요. 현행 rembg는 NumPy 2 계열을 사용합니다. MediaPipe의 OpenCV 의존성과 중복 설치되지 않도록 `opencv-contrib-python` 하나만 사용합니다.

모델 다운로드는 아래 준비 명령에서 `--download`를 명시할 때만 수행합니다. 서버는 시작 시 캐시된 모델만 메모리에 올리며, 파일이 없으면 준비가 필요하다는 상태를 반환합니다. 받은 모델로 로컬 처리할 때는 외부 AI API와 인터넷 연결이 필요하지 않습니다.

```bash
python3.11 -m venv local-ai/.venv
local-ai/.venv/bin/python -m pip install -r local-ai/requirements.txt
local-ai/.venv/bin/python local-ai/doctor.py --json
# 최초 모델 준비를 원할 때만 명시적으로 실행
local-ai/.venv/bin/python local-ai/prepare_models.py --download
```

```env
AI_PROVIDER=local
LOCAL_AI_ENDPOINT=http://127.0.0.1:8765/transform
LOCAL_AI_VALIDATE_ENDPOINT=http://127.0.0.1:8765/validate
```

`doctor.py`는 패키지 버전과 모델 파일 유무를 확인하며 설치·다운로드를 하지 않습니다. 누락 항목이 있으면 종료 코드 1을 반환합니다. 기본 배경 모델 `u2net_human_seg`는 약 176MB이며, 캐시는 저장소의 `local-ai/models/`에 둡니다. 시작 시 공식 배경 모델 체크섬을 검사하며, 파일이 없거나 손상되면 네트워크로 자동 복구하지 않고 오류를 표시합니다. 명시적인 준비 명령만 파일을 다운로드할 수 있습니다. 더 가벼운 시험용 `u2netp`는 약 4.7MB이며 머리카락 등 세부 품질이 낮을 수 있습니다. `REMBG_MODEL=u2netp`를 모델 준비와 서버 실행에 모두 지정해야 합니다. `KYOBODT_MODEL_DIR`와 `U2NET_HOME`으로 캐시 경로를 바꿀 수 있습니다.

Windows에서는 `local-ai/.venv/Scripts/python.exe` 경로를 사용합니다. 서버 시작 명령은 `python -m uvicorn server:app --app-dir local-ai --host 127.0.0.1 --port 8765`입니다. Linux에서 OpenCV 공유 라이브러리 오류가 발생하면 해당 배포판의 OpenCV 실행 라이브러리 설치 여부를 확인하세요.

서로 다른 터미널에서 실행합니다.

```bash
npm run local-ai
npm start
```

모델 상태는 `http://127.0.0.1:8765/health`에서 확인합니다. `/ready`는 준비 완료 시 200, 준비 전에는 503을 반환합니다. 모델 준비 후 서버를 다시 시작하거나 `POST /warmup`으로 캐시 로딩을 다시 시도할 수 있습니다. `warmup`은 모델을 다운로드하지 않습니다. 로딩 중에도 상태 조회는 응답합니다.

Python API는 기본적으로 `127.0.0.1`에 바인딩됩니다. 인증을 담당하는 Node 서버 뒤에 두고 인터넷에 직접 노출하지 마세요. 직접 들어오는 이미지도 최대 8MB, 2,400만 화소로 제한합니다. 브라우저 업로드는 전송 전 2,048px로 축소되므로 이 제한 내에서 처리됩니다.

### Gemini + 로컬 보정

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your-api-key
GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
LOCAL_AI_ENDPOINT=http://127.0.0.1:8765/transform
LOCAL_AI_VALIDATE_ENDPOINT=http://127.0.0.1:8765/validate
```

Node와 Python 서버를 모두 실행해야 합니다. 판별은 로컬에서, 이미지 생성은 Gemini에서 처리하고 생성 결과를 로컬에서 다시 보정합니다. 생성형 모드에서는 동일 인물의 특징을 유지하도록 요청하지만, 보존을 보장하지 않습니다.

## 배포와 운영

이 저장소는 **지속 실행되는 단일 Node 서버**를 기준으로 합니다. 정적 호스팅만으로는 인증·AI API가 동작하지 않습니다. Railway 등 Node 프로세스를 실행하는 환경에서는 시작 명령을 `npm start`로 지정하고 플랫폼이 제공하는 `PORT`를 사용합니다.

```env
NODE_ENV=production
HOST=0.0.0.0
APP_PASSWORD=replace-with-a-long-unique-password
AI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
AI_TIMEOUT_MS=120000
```

- `NODE_ENV=production`에서는 `APP_PASSWORD`가 없으면 인증과 변환을 사용할 수 없습니다. HTTPS가 필요하며 세션 쿠키에 `Secure`를 적용합니다.
- 비밀번호는 서버 인증 시 한 번만 전송합니다. 브라우저 저장소에 비밀번호를 보관하지 않고, **HttpOnly / SameSite=Strict** 쿠키로 8시간 동안 이용합니다. 이전 버전의 `sessionStorage` 비밀번호는 페이지를 열면 제거합니다.
- 세션과 로그인 실패 횟수는 **프로세스 메모리**에 저장합니다. 서버가 재시작되면 다시 로그인해야 합니다. 여러 인스턴스나 서버리스 환경에 배포하려면 공유 세션 저장소와 요청 제한 저장소를 먼저 연결해야 합니다.
- 동일 연결 주소에서 비밀번호를 10회 틀리면 15분 동안 인증을 제한합니다. 리버스 프록시 뒤에서는 여러 이용자가 같은 주소로 집계될 수 있습니다. 큰 규모의 서비스에는 신뢰할 수 있는 프록시 설정과 별도 인증 시스템이 필요합니다.
- 한 세션은 한 번에 하나의 AI 요청만 처리합니다. `AI_TIMEOUT_MS`는 각 외부 AI 요청의 시간제한이며 기본 120초입니다. Gemini 생성과 로컬 보정에는 각각 적용됩니다.
- `GET /healthz`는 웹 서버 생존 확인용입니다. `npm run doctor` 또는 `/api/config`는 선택한 제공자의 설정과 로컬 모델 준비 상태를 확인합니다. 외부 API 권한·잔액·실제 생성 성공은 검증하지 않습니다.
- 공개 파일은 `index.html`, `app.js`, `styles.css`로 제한합니다. 환경 변수, 서버 코드, Python 코드 등은 웹으로 제공하지 않습니다.
- `.env`와 API 키를 커밋하지 마세요. 외부 AI 사용 요금은 해당 서비스의 계정 설정에 따릅니다.

## 검증

```bash
npm run check
npm test
python3 -m unittest discover -s local-ai -p 'test_*.py'
python3 -m py_compile local-ai/server.py local-ai/image_input.py
```

Node 테스트는 모의 브라우저, 실제 Node 서버와 로컬 모의 AI 서버를 이용해 인증·로그아웃·로그인 제한, 비공개 파일 차단, 파일 형식·용량 검사, 잘못된 AI 응답, 시간제한, 중복 요청 처리를 검증합니다. Python 테스트는 모델을 불러오지 않고 입력 형식·용량, 모델 준비 중 상태 응답·중복 초기화 차단·오류 후 재시도·암묵적 다운로드 방지를 검증합니다. **실제 AI API 호출, 모델 다운로드, 유료 변환은 자동 테스트에서 실행하지 않습니다.** 실제 인물 사진의 결과 품질은 사용할 제공자와 모델을 설정한 환경에서 별도로 확인해야 합니다.


## 브라우저와 실제 사용

- 최근 Chrome, Edge, Firefox, Safari를 대상으로 합니다. 비밀번호 창과 요청 시간제한은 일부 구형 브라우저용 대체 동작을 포함합니다.
- 카메라 버튼은 기기의 파일 촬영 기능을 사용합니다. 데스크톱에서는 파일 선택 화면으로 열릴 수 있습니다. HEIC는 지원을 가장하지 않고 JPG로 변환하라는 안내를 표시합니다. MIME 정보가 비어 있는 모바일 JPG/PNG/WebP 파일은 확장자를 확인한 뒤 실제 이미지 디코딩과 서버 형식 검사를 거칩니다.
- 사진이 옆으로 보이면 변환 전에 90° 회전할 수 있습니다. 회전 결과도 긴 변 2,048px로 정리하고 메타데이터를 제외합니다.
- 결과를 만든 뒤 배경을 바꾸려면 **이 사진으로 배경을 바꿔 다시 만들기**를 사용하세요. 이는 새 AI 요청이며 외부 서비스에서는 추가 비용이 발생할 수 있습니다.
- PNG/JPG 파일은 미리 생성해 모바일 공유 버튼의 사용자 동작 권한을 유지합니다. 공유 미지원 브라우저에는 일반 다운로드를 제공합니다. 사진 앱 저장 위치는 브라우저와 운영체제에 따라 다릅니다.
- 인터넷 연결이 끊기면 외부 AI 변환을 멈추고 원본을 화면에 유지합니다. 로컬 서버가 실행 중이면 인터넷 없이도 로컬 모드를 사용할 수 있습니다.

## 모델 및 의존성 검토 기준

2026-11-05 공식 문서 확인 기준으로 새 클라우드 설정의 기본값은 OpenAI `gpt-image-2.5-flare` / 판별용 `gpt-6-luna`, Gemini `gemini-nano-banana-2.1`입니다. **이미 지정한 환경 변수는 자동으로 변경하지 않습니다.** 계정의 모델 접근 권한과 모델별 요금을 확인한 뒤 사용하세요. 과거 `gpt-image-1.5`는 2026-12-01, `gpt-4.1-mini`는 2027-01-14 종료 일정이 공지되어 있으므로 기존 설정은 갱신이 필요합니다. 진단 명령은 알려진 과거 모델 설정을 경고합니다.

OpenAI 입력 판별은 `store: false`를 사용합니다. 이미지 편집은 현재 모델에 맞는 옵션을 사용하며, 기존 1.5 모델을 명시한 경우에만 높은 입력 충실도 옵션을 보냅니다. Gemini는 이미지 출력 모달리티를 명시합니다. 두 제공자 모두 얼굴의 비율·표정·원래 자세를 유지하도록 요청하고 응답 이미지 형식을 검증합니다. 생성형 모델의 동일성 보존을 보장하지는 않습니다.

검토 출처: [OpenAI 이미지 편집 API](https://developers.openai.com/api/reference/resources/images/methods/edit), [OpenAI 모델 종료 일정](https://developers.openai.com/api/docs/deprecations), [Gemini 이미지 생성](https://aistudio.google.com/docs/image-generation), [Gemini 모델 종료 일정](https://aistudio.google.com/docs/deprecations), [MediaPipe Python 환경](https://developers.google.com/edge/mediapipe/solutions/setup_python), [rembg 패키지](https://pypi.org/project/rembg/).

의존성 버전은 요구 조건과 설치 해결 결과를 확인했습니다. 실제 모델 다운로드·실제 인물 사진 추론·유료 클라우드 변환은 이 개선 작업의 자동 검증에서 수행하지 않았습니다. 운영 환경에서는 별도 검증이 필요합니다.
