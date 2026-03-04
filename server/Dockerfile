FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/index.js ./index.js
COPY server/.env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=8787
ENV GEMINI_HEADLESS=true

EXPOSE 8787
VOLUME ["/app/.gemini-profile"]

CMD ["node", "index.js"]
