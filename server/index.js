import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8787;
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
const GEMINI_LOGIN_WAIT_MS = Number(process.env.GEMINI_LOGIN_WAIT_MS || 300000);
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
      viewport: { width: 1366, height: 900 },
      args: ['--start-maximized']
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
  await page.bringToFront().catch(() => {});
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://gemini.google.com'
  });
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront().catch(() => {});

  // 이미 로그인된 경우 즉시 진행
  const readyInput = await findGeminiInput(page);
  if (readyInput) {
    return;
  }

  const loginIndicators = [
    'text=로그인',
    'text=Sign in',
    'input[type="email"]',
    'input[type="password"]'
  ];

  let loginDetected = false;
  for (const selector of loginIndicators) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      loginDetected = true;
      break;
    }
  }

  if (!loginDetected) {
    return;
  }

  const start = Date.now();
  while (Date.now() - start < GEMINI_LOGIN_WAIT_MS) {
    const input = await findGeminiInput(page);
    if (input) {
      return;
    }
    await page.waitForTimeout(1500);
  }

  throw new Error(
    `Gemini 로그인 대기 시간이 초과되었습니다. ${Math.floor(
      GEMINI_LOGIN_WAIT_MS / 1000
    )}초 안에 열린 브라우저에서 Google 로그인을 완료해주세요.`
  );
}

async function findGeminiInput(page) {
  const inputCandidates = [
    'textarea[aria-label*="Enter a prompt"]',
    'textarea[aria-label*="프롬프트"]',
    'textarea[placeholder*="Enter a prompt"]',
    'textarea[placeholder*="프롬프트"]',
    'textarea',
    '[contenteditable="true"]'
  ];

  for (const selector of inputCandidates) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function fillPromptAndSend(page, prompt) {
  const input = await findGeminiInput(page);
  if (!input) {
    throw new Error('Gemini 입력창을 찾지 못했습니다. 페이지가 완전히 로드되었는지 확인하세요.');
  }

  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, prompt);

  await input.click({ timeout: 10000 });
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.press('Meta+V').catch(() => {});
  await page.keyboard.press('Control+V').catch(() => {});

  const inputText = (await input.textContent().catch(() => '')) || '';
  if (!inputText.trim()) {
    await input.fill(prompt).catch(async () => {
      await page.keyboard.type(prompt, { delay: 2 });
    });
  }

  await page.keyboard.press('Enter');
}

async function waitForResponse(page, timeoutMs) {
  const start = Date.now();
  let best = '';
  let lastUpdatedAt = start;
  const settleMs = 4500;
  const pollIntervalMs = 1200;

  while (Date.now() - start < timeoutMs) {
    const stopVisible = await page
      .locator('button:has-text("Stop"), button:has-text("중지")')
      .first()
      .isVisible()
      .catch(() => false);

    const actionButtonsVisible = await page
      .locator('div.buttons-container-v2 copy-button button[data-test-id="copy-button"]')
      .last()
      .isVisible()
      .catch(() => false);

    if (actionButtonsVisible) {
      const latestCopyButton = page.locator(
        'div.buttons-container-v2 copy-button button[data-test-id="copy-button"]'
      );
      try {
        await latestCopyButton.last().click({ timeout: 2500 });
        await page.waitForTimeout(250);
        const copiedText = await page.evaluate(async () => navigator.clipboard.readText());
        if (copiedText?.trim()) {
          const copied = copiedText.trim();
          if (copied.length > best.length) {
            best = copied;
            lastUpdatedAt = Date.now();
          }
          // Stop 버튼이 사라지고 텍스트가 일정 시간 안정화된 뒤 반환해 잘림을 줄인다.
          if (!stopVisible && Date.now() - lastUpdatedAt >= settleMs) {
            return best;
          }
        }
      } catch (_err) {
        // Fallback to DOM text extraction below.
      }
    }

    const texts = await page
      .locator('model-response, .model-response-text, .response-content, markdown, .markdown')
      .allTextContents()
      .catch(() => []);

    const cleaned = texts.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      const latest = cleaned[cleaned.length - 1];
      if (latest.length > best.length) {
        best = latest;
        lastUpdatedAt = Date.now();
      }
    }

    if (!stopVisible && best.length > 30 && Date.now() - lastUpdatedAt >= settleMs) {
      return best;
    }

    await page.waitForTimeout(pollIntervalMs);
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
    await page.bringToFront().catch(() => {});
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

app.get('/api/open-gemini', async (_req, res) => {
  try {
    const context = await getContext();
    const page = await context.newPage();
    await ensureGeminiReady(page);
    return res.json({ ok: true, message: 'Gemini 페이지를 열었습니다.' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Gemini 페이지 열기에 실패했습니다.'
    });
  }
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

if (existsSync(builtClientPath)) {
  app.use(express.static(builtClientPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(builtClientPath, 'index.html'));
  });
} else {
  app.get('*', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: 'Client build 파일이 없습니다. API 엔드포인트(/api/*)를 사용하세요.'
    });
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
