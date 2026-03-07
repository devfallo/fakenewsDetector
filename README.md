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
- `GEMINI_RUN_MODE`: 실행 모드 (`geminiapi` | `headless` | `cdp` | `novnc`, 기본 `headless`)
- `GEMINI_TIMEOUT_MS`: 응답 대기 시간(ms)
- `GEMINI_LOGIN_WAIT_MS`: 로그인 대기 시간(ms, 기본 `300000`)
- `GEMINI_REQUIRE_LOGIN`: `true`면 비로그인 상태에서 즉시 오류 반환
- `GEMINI_CDP_URL`: 일반 Chrome 원격 디버깅 주소 (예: `http://host.docker.internal:9222`)
- `GEMINI_API_KEY`: `GEMINI_RUN_MODE=geminiapi`일 때 사용하는 API 키
- `GEMINI_API_MODEL`: API 모델명 (기본 `gemini-2.5-flash-lite`)

## API

### `GET /api/auth-status`

Gemini 로그인 상태 확인:

```json
{
  "ok": true,
  "loggedIn": true
}
```

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

## 배포 (GitHub Actions / GitHub Pages)

이 프로젝트는 프론트(`client`)와 브라우저 자동화 백엔드(`server`)가 분리되어 있습니다.

- GitHub Pages: **프론트엔드 정적 파일만 배포 가능**
- 백엔드(Playwright + Gemini 웹 자동화): 별도 서버(Render, Railway, VPS 등)에 배포 필요

### 1) CI (GitHub Actions)

`/.github/workflows/ci.yml`

- 루트/클라이언트/서버 의존성 설치
- 서버 문법 체크
- 클라이언트 빌드

### 2) GitHub Pages 자동배포

`/.github/workflows/deploy-pages.yml`

- `main` 푸시 시 client 빌드 후 Pages 배포
- 기본 base 경로: `/<repo-name>/`

### 3) Pages에서 API 연결

GitHub 저장소 설정에서 아래 변수를 추가하세요.

- `Settings -> Secrets and variables -> Actions -> Variables`
- 이름: `VITE_API_BASE_URL`
- 값 예시: `https://your-backend.example.com`

이 값을 설정하면 Pages 프론트가 해당 백엔드의 `/api/check`를 호출합니다.

### 4) 로컬 프론트 env 예시

`client/.env.example` 참고:

- `VITE_BASE_PATH`: 빌드 base 경로
- `VITE_API_BASE_URL`: 백엔드 주소 (로컬 개발은 비워두면 프록시 사용)

## 서버 Docker 배포

### 일반 Chrome 세션 재사용 (권장)

Google 계정 보안 정책으로 Playwright 브라우저 로그인 차단이 발생할 수 있습니다. 이 경우 일반 Chrome 로그인 세션을 CDP로 재사용하세요.

1. 호스트에서 일반 Chrome을 원격 디버깅으로 실행

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222
```

2. Chrome에서 `https://gemini.google.com/app` 로그인 완료
3. `docker-compose.yml`에 `GEMINI_CDP_URL: "http://host.docker.internal:9222"` 설정
4. 서버 재시작

```bash
docker compose up -d --build server
```

비로그인 상태 차단(엉뚱한 응답 방지)은 `GEMINI_REQUIRE_LOGIN=true`로 기본 활성화되어 있습니다.  
단, `GEMINI_RUN_MODE=geminiapi`에서는 브라우저 로그인이 필요하지 않습니다.

### 1) Docker Compose로 실행

```bash
docker compose up -d --build
```

헬스체크:

```bash
curl http://localhost:8787/api/health
```

기본 구성은 `geminiapi` 모드입니다.

- `GEMINI_RUN_MODE=geminiapi` + `GEMINI_API_KEY` 설정 시 Gemini API 사용 (브라우저 로그인 불필요)
- `GEMINI_RUN_MODE=headless`
- `GEMINI_RUN_MODE=cdp` + `GEMINI_CDP_URL` 설정 시 호스트 Chrome 세션 재사용
- `GEMINI_RUN_MODE=novnc` 시 컨테이너 내부 가상 GUI + noVNC 사용

### noVNC로 로그인하기

`GEMINI_RUN_MODE=novnc`일 때 컨테이너 실행 후 브라우저에서 아래 주소로 접속:

- `http://localhost:6080/vnc.html`

접속되면 컨테이너 내부 GUI 화면에서 Gemini 로그인 후 세션을 유지할 수 있습니다.
로그인 세션은 볼륨(`./server/.gemini-profile`)에 저장됩니다.

### 2) Dockerfile로 직접 실행

```bash
docker build -f server/Dockerfile -t fakenews-detector-server .
docker run -d \
  --name fakenews-detector-server \
  -p 8787:8787 \
  -e GEMINI_HEADLESS=true \
  -v $(pwd)/server/.gemini-profile:/app/.gemini-profile \
  fakenews-detector-server
```

### 3) 중요 주의사항

- 컨테이너는 기본 `GEMINI_HEADLESS=true`로 실행됩니다.
- Gemini 사용에는 로그인 세션이 필요하며, 세션은 볼륨(`/app/.gemini-profile`)에 저장됩니다.
- 서버만 Docker로 배포해도 API(`/api/*`)는 동작합니다. (`client/dist`가 없으면 API 모드로 404 안내 응답)
