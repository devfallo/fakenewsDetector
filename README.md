# Fake News Detector (React + Gemini Web 자동화)

커뮤니티/유튜브 숏츠/인스타 릴스 링크를 입력하면, 백엔드가 **Gemini 웹브라우저**를 직접 열어서 판별 프롬프트를 입력하고 응답을 가져와 화면에 보여줍니다.

자동화 흐름:
1. 사용자 링크 + 판별 프롬프트를 하나의 텍스트로 결합
2. Gemini 페이지 로드 후 입력창에 붙여넣기 + Enter 전송
3. 답변 하단 액션 버튼(`buttons-container-v2`, `copy-button`)이 보이면 완료로 간주하고 응답을 수집

## 1) 설치

```bash
npm install
npm --prefix client install
npm --prefix server install
npx playwright install chromium
```

## 2) 실행

```bash
npm run dev
```

- 프론트: `http://localhost:5173`
- 백엔드 API: `http://localhost:8787`

## 3) 첫 사용 전 필수

1. 앱 실행 후 `/api/check`를 처음 호출하면 브라우저가 뜹니다.
2. 열린 브라우저에서 Google 계정으로 Gemini에 로그인합니다.
3. 로그인 완료 후 같은 요청이 자동으로 이어서 진행됩니다. (기본 최대 300초 대기)

로그인 세션은 프로젝트 루트의 `.gemini-profile`에 저장됩니다.

## 4) 환경변수

`server/.env.example`을 참고해 `server/.env`를 만들 수 있습니다.

- `PORT`: 서버 포트 (기본 `8787`)
- `GEMINI_URL`: Gemini 주소 (기본 `https://gemini.google.com/app`)
- `GEMINI_HEADLESS`: `true`면 헤드리스 실행
- `GEMINI_TIMEOUT_MS`: 응답 대기 시간(ms)
- `GEMINI_LOGIN_WAIT_MS`: 로그인 대기 시간(ms, 기본 `300000`)

## API

### `POST /api/check`

요청:

```json
{
  "link": "https://www.youtube.com/shorts/...",
  "context": "선택: 추가 설명"
}
```

응답:

```json
{
  "ok": true,
  "link": "...",
  "result": "Gemini 답변 원문"
}
```
