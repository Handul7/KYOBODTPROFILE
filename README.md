# KYOBODT · 프로필 스튜디오

사진을 골라 배경을 선택하고, AI로 스튜디오 스타일의 프로필을 만든 뒤 원본과 비교해 저장하는 웹 앱입니다. 출력 파일은 **708 × 944px, 3:4 비율의 PNG**입니다. 여권·신분증 사진 규격을 보장하는 서비스는 아닙니다. AI가 얼굴이나 의상을 바꿀 수 있으므로 사용 전 결과를 확인해야 합니다.

## 사진을 만드는 흐름

1. JPG, PNG, WebP 사진을 선택하거나 끌어 놓습니다. 최대 8MB이며, 사진 선택만으로 서버에 전송되지 않습니다.
2. 배경을 고르고 **프로필 만들기**를 누릅니다. 비밀번호 확인 후 사진 적합성 판별과 변환을 순서대로 실행합니다.
3. **원본 / 변환 결과**를 비교하고 **완성한 프로필 저장**을 누릅니다. 실패하면 같은 사진으로 다시 시도할 수 있으며, 처리 취소와 초기화도 지원합니다.

브라우저는 전송 전 사진의 긴 변을 2,048px 이하로 줄이고 JPEG로 다시 인코딩해 원본 EXIF 메타데이터를 제외합니다. 앱은 사진을 디스크에 저장하지 않습니다. OpenAI/Gemini 모드에서는 사진을 해당 외부 서비스로 전송합니다. 외부 서비스의 데이터 처리 정책은 별도로 확인해야 합니다. 취소는 앱의 요청을 중단하며, 이미 시작된 외부 AI 처리나 비용까지 취소된다고 보장하지 않습니다.

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

모델명은 환경 변수로 바꿀 수 있습니다. 키나 엔드포인트가 설정되었다는 화면의 연결 상태는 실제 AI 호출 성공을 보장하지 않습니다.

### OpenAI

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_IMAGE_QUALITY=high
```

### 로컬 AI

Python 서버는 사진 판별과 배경 제거·규격 보정을 담당합니다. 최초 실행 시 모델 파일을 다운로드하므로 인터넷 연결과 여유 저장 공간이 필요합니다. 모델을 받은 뒤 로컬 처리에는 외부 AI API가 필요하지 않습니다.

```bash
python3 -m venv local-ai/.venv
local-ai/.venv/bin/pip install -r local-ai/requirements.txt
```

```env
AI_PROVIDER=local
LOCAL_AI_ENDPOINT=http://127.0.0.1:8765/transform
LOCAL_AI_VALIDATE_ENDPOINT=http://127.0.0.1:8765/validate
```

서로 다른 터미널에서 실행합니다.

```bash
npm run local-ai
npm start
```

Python API는 기본적으로 `127.0.0.1`에 바인딩됩니다. 인증을 담당하는 Node 서버 뒤에 두고 인터넷에 직접 노출하지 마세요. 직접 들어오는 이미지도 최대 8MB, 2,400만 화소로 제한합니다. 브라우저 업로드는 전송 전 2,048px로 축소되므로 이 제한 내에서 처리됩니다.

### Gemini + 로컬 보정

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your-api-key
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
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
- `GET /healthz`는 웹 서버 상태 확인용입니다. 모델·키·외부 서비스의 정상 동작을 검증하는 엔드포인트는 아닙니다.
- 공개 파일은 `index.html`, `app.js`, `styles.css`로 제한합니다. 환경 변수, 서버 코드, Python 코드 등은 웹으로 제공하지 않습니다.
- `.env`와 API 키를 커밋하지 마세요. 외부 AI 사용 요금은 해당 서비스의 계정 설정에 따릅니다.

## 검증

```bash
npm run check
npm test
python3 -m unittest discover -s local-ai -p 'test_*.py'
python3 -m py_compile local-ai/server.py local-ai/image_input.py
```

Node 테스트는 실제 서버와 로컬 모의 AI 서버를 이용해 인증·로그아웃·로그인 제한, 비공개 파일 차단, 파일 형식·용량 검사, 잘못된 AI 응답, 시간제한, 중복 요청 처리를 검증합니다. Python 테스트는 모델을 불러오지 않고 입력 형식·용량 검사를 검증합니다. **실제 AI API 호출, 모델 다운로드, 유료 변환은 자동 테스트에서 실행하지 않습니다.** 실제 인물 사진의 결과 품질은 사용할 제공자와 모델을 설정한 환경에서 별도로 확인해야 합니다.
