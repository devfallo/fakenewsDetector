import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8787;
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
const GEMINI_URL = process.env.GEMINI_URL || 'https://gemini.google.com/app';
const GEMINI_HEADLESS = String(process.env.GEMINI_HEADLESS || 'false') === 'true';

app.use(cors());
app.use(express.json());

let browserContextPromise;

async function getContext() {
  if (!browserContextPromise) {
    const profileDir = path.resolve(process.cwd(), '.gemini-profile');
    browserContextPromise = chromium.launchPersistentContext(profileDir, {
      headless: GEMINI_HEADLESS,
      viewport: { width: 1366, height: 900 }
    });
  }
  return browserContextPromise;
}

function buildPrompt(link, extraContext = '') {
  return [
    '너는 팩트체크 보조자야. 아래 링크 내용을 기준으로 가짜뉴스 여부를 판단해줘.',
    '반드시 한국어로 답해줘.',
    '출력 형식은 정확히 다음 순서를 지켜:',
    '1) 판정: [가짜뉴스/진짜뉴스/판별불가]',
    '2) 신뢰도: [0~100 정수]',
    '3) 근거: 핵심 근거 3가지',
    '4) 주의: 불확실하거나 확인이 필요한 부분',
    '',
    `링크: ${link}`,
    extraContext ? `사용자 추가설명: ${extraContext}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function ensureGeminiReady(page) {
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const loginIndicators = [
    'text=로그인',
    'text=Sign in',
    'input[type="email"]',
    'input[type="password"]'
  ];

  for (const selector of loginIndicators) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      throw new Error('Gemini 로그인이 필요합니다. 열린 브라우저에서 Google 로그인 후 다시 시도하세요.');
    }
  }
}

async function fillPromptAndSend(page, prompt) {
  const inputCandidates = [
    'textarea[aria-label*="Enter a prompt"]',
    'textarea[placeholder*="Enter a prompt"]',
    'textarea',
    '[contenteditable="true"]'
  ];

  let input = null;
  for (const selector of inputCandidates) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) {
      input = candidate;
      break;
    }
  }

  if (!input) {
    throw new Error('Gemini 입력창을 찾지 못했습니다. 페이지가 완전히 로드되었는지 확인하세요.');
  }

  await input.click({ timeout: 10000 });
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await input.fill(prompt).catch(async () => {
    await page.keyboard.type(prompt, { delay: 2 });
  });

  await page.keyboard.press('Enter');
}

async function waitForResponse(page, timeoutMs) {
  const start = Date.now();
  let best = '';

  while (Date.now() - start < timeoutMs) {
    const texts = await page
      .locator('model-response, .model-response-text, .response-content, markdown, .markdown')
      .allTextContents()
      .catch(() => []);

    const cleaned = texts.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      const latest = cleaned[cleaned.length - 1];
      if (latest.length > best.length) {
        best = latest;
      }
    }

    const stopVisible = await page
      .locator('button:has-text("Stop"), button:has-text("중지")')
      .first()
      .isVisible()
      .catch(() => false);

    if (!stopVisible && best.length > 30) {
      await page.waitForTimeout(1200);
      return best;
    }

    await page.waitForTimeout(1500);
  }

  if (best.length > 0) {
    return best;
  }

  throw new Error('Gemini 응답을 시간 내에 가져오지 못했습니다.');
}

async function askGeminiByWeb(prompt) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await ensureGeminiReady(page);
    await fillPromptAndSend(page, prompt);
    const answer = await waitForResponse(page, GEMINI_TIMEOUT_MS);
    return answer;
  } finally {
    await page.close().catch(() => {});
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.post('/api/check', async (req, res) => {
  const { link, context } = req.body || {};
  if (!link || typeof link !== 'string') {
    return res.status(400).json({ ok: false, error: 'link 값이 필요합니다.' });
  }

  try {
    const prompt = buildPrompt(link.trim(), typeof context === 'string' ? context.trim() : '');
    const result = await askGeminiByWeb(prompt);
    return res.json({ ok: true, link, result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'
    });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const builtClientPath = path.resolve(__dirname, '../client/dist');

app.use(express.static(builtClientPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(builtClientPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
