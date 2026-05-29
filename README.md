# KYOBODT

Mobile web app that checks whether an uploaded photo is suitable for an ID photo and converts it into a basic Korean ID photo format.

## Features

- Mobile-first upload flow
- Password gate before photo upload
- OpenAI-backed photo suitability check
- OpenAI image edit-based ID photo conversion
- Local AI provider hook for future local model integration

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-api-key
APP_PASSWORD=kyobo
HOST=0.0.0.0
PORT=5173
```

## Run

```bash
npm run start
```

Open:

```text
http://127.0.0.1:5173
```

For same Wi-Fi mobile testing, use your Mac's local network IP:

```text
http://YOUR_LOCAL_IP:5173
```

## Notes

- `.env` is intentionally ignored and must not be committed.
- ChatGPT subscriptions do not include OpenAI API quota. API billing is separate.
- For local AI, set `AI_PROVIDER=local` and provide `LOCAL_AI_ENDPOINT` / `LOCAL_AI_VALIDATE_ENDPOINT`.
