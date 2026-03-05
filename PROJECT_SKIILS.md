# PROJECT_SKIILS

## Frontend
- React 19 (`react`, `react-dom`)
- Vite 7 (`vite`, `@vitejs/plugin-react`)
- React Markdown (`react-markdown`)
- GitHub Flavored Markdown 지원 (`remark-gfm`)
- CSS (plain CSS, `client/src/styles.css`)

## Backend
- Node.js (ES Modules)
- Express 4 (`express`)
- CORS (`cors`)
- dotenv (`dotenv`)
- Playwright 1.58.2 (`playwright`)
- Gemini Web 자동화 기반 응답 수집 (Playwright persistent context)

## Infra / Deployment
- Docker / Docker Compose
- Playwright 공식 런타임 이미지
  - `mcr.microsoft.com/playwright:v1.58.2-noble`
- 포트 매핑: `8787 -> 8080` (container)
- 볼륨 마운트로 Gemini 로그인 세션 유지
  - `./server/.gemini-profile:/app/.gemini-profile`

## CI/CD
- GitHub Actions
  - CI: 의존성 설치, 서버 문법 체크, 클라이언트 빌드
  - Pages Deploy: `client/dist` 빌드 산출물 GitHub Pages 배포
- GitHub Pages (클라이언트 정적 배포)

## Dev Tooling
- concurrently (루트에서 client/server 동시 실행)
- npm scripts 기반 개발/빌드/실행
