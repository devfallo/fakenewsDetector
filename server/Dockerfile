FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY server/package*.json ./
RUN npm ci --omit=dev

RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb \
  x11vnc \
  fluxbox \
  novnc \
  yt-dlp \
  python3-websockify \
  && rm -rf /var/lib/apt/lists/*

COPY server/index.js ./index.js
COPY server/.env.example ./.env.example
COPY server/start-with-vnc.sh ./start-with-vnc.sh
RUN chmod +x ./start-with-vnc.sh

ENV NODE_ENV=production
ENV PORT=8787
ENV GEMINI_HEADLESS=false

EXPOSE 8787
EXPOSE 6080
VOLUME ["/app/.gemini-profile"]

CMD ["sh", "./start-with-vnc.sh"]
