import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8787;
// Cloudflare 프록시 환경에서 장시간 요청이 끊기는 문제를 줄이기 위해 90초 기본값 사용.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90000);
const GEMINI_LOGIN_WAIT_MS = Number(process.env.GEMINI_LOGIN_WAIT_MS || 300000);
const GEMINI_URL = process.env.GEMINI_URL || 'https://gemini.google.com/app';
const GEMINI_HEADLESS = String(process.env.GEMINI_HEADLESS || 'true') === 'true';
const GEMINI_PROFILE_DIR = path.resolve(process.env.GEMINI_PROFILE_DIR || path.resolve(process.cwd(), '.gemini-profile'));
const GEMINI_REQUIRE_LOGIN = String(process.env.GEMINI_REQUIRE_LOGIN || 'true') === 'true';
const GEMINI_CDP_URL = (process.env.GEMINI_CDP_URL || '').trim();

app.use(cors());
app.use(express.json());

class GeminiLoginRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeminiLoginRequiredError';
  }
}

let browserContextPromise;
let browserPromise;

async function getContext() {
  if (!browserContextPromise) {
    if (GEMINI_CDP_URL) {
      browserPromise = chromium.connectOverCDP(GEMINI_CDP_URL);
      browserContextPromise = browserPromise.then((browser) => {
        const existing = browser.contexts();
        if (existing.length > 0) {
          return existing[0];
        }
        return browser.newContext();
      });
    } else {
      browserContextPromise = chromium.launchPersistentContext(GEMINI_PROFILE_DIR, {
        headless: GEMINI_HEADLESS,
        viewport: { width: 1366, height: 900 },
        args: ['--start-maximized']
      });
    }
  }
  return browserContextPromise;
}

function buildPrompt(link, extraContext = '') {
  return [
    '너는 팩트체크 분석가야. 반드시 아래 2단계로 분석해.',
    '반드시 한국어로 답해줘.',
    '링크에서 직접 확인한 정보만 사용하고, 추측/상상/일반 지식 보완을 금지해.',
    '링크 접근 실패, 자막 확보 실패, 본문 확인 실패 중 하나라도 있으면 판정은 반드시 "판별불가"로 해.',
    '브랜드명/키워드만으로 사실 판단하지 마.',
    '',
    '[1단계: 링크 내용 파악]',
    '- 링크의 핵심 내용을 먼저 요약해.',
    '- 영상/게시글이면 자막 또는 대본(추정 포함) 핵심 문장을 먼저 정리해.',
    '- 자막/대본을 정확히 얻지 못하면 그 사실을 명시해.',
    '',
    '[2단계: 팩트체크 판단]',
    '- 1단계에서 정리한 자막/대본/요약 내용을 근거로 사실성 판단을 해.',
    '- 뉴스성 주장이 없거나 검증 불가능하면 판정은 "판별불가"로 해.',
    '',
    '출력 형식은 정확히 다음 순서를 지켜:',
    '1) 링크요약: [3~6줄]',
    '2) 자막/대본 핵심: [핵심 문장 bullet 3~8개, 없으면 "확보 실패"]',
    '3) 판정: [가짜뉴스/진짜뉴스/판별불가]',
    '4) 신뢰도: [0~100 정수]',
    '5) 근거: 핵심 근거 3가지 (각 근거에 "링크에서 확인한 문장/정보"를 1개 이상 포함)',
    '6) 주의: 불확실하거나 확인이 필요한 부분',
    '7) 접근상태: [성공/실패] + 실패사유',
    '',
    `링크: ${link}`,
    extraContext ? `사용자 추가설명: ${extraContext}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function ensureGeminiReady(page) {
  await page.bringToFront().catch(() => {});
  if (!GEMINI_CDP_URL) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://gemini.google.com'
    });
  }
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront().catch(() => {});

  const loginIndicators = ['text=로그인', 'text=Sign in', 'input[type="email"]', 'input[type="password"]'];
  const start = Date.now();
  while (Date.now() - start < GEMINI_LOGIN_WAIT_MS) {
    const input = await findGeminiInput(page);
    if (input) {
      return;
    }

    let loginDetected = false;
    for (const selector of loginIndicators) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        loginDetected = true;
        break;
      }
    }

    const currentUrl = page.url();
    const maybeAuthPage = /accounts\.google\.com|signin|servicelogin/i.test(currentUrl);
    if (GEMINI_REQUIRE_LOGIN && (loginDetected || maybeAuthPage)) {
      throw new GeminiLoginRequiredError(
        'Gemini 로그인 세션이 필요합니다. 로그인 후 다시 시도하세요.'
      );
    }

    await page.waitForTimeout(1500);
  }

  if (GEMINI_REQUIRE_LOGIN) {
    throw new GeminiLoginRequiredError(
      `Gemini 입력창 확인에 실패했습니다. ${Math.floor(
        GEMINI_LOGIN_WAIT_MS / 1000
      )}초 내 로그인/접속 상태를 확인해주세요.`
    );
  }

  throw new Error('Gemini 입력창을 시간 내에 찾지 못했습니다.');
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

async function getLatestResponseByDom(page) {
  const text = await page
    .evaluate(() => {
      const selectors = [
        'model-response',
        '.model-response-text',
        '.response-content',
        'markdown',
        '.markdown'
      ];

      const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      if (nodes.length === 0) {
        return '';
      }

      const latest = nodes[nodes.length - 1];
      const innerText = (latest.innerText || '').trim();
      const textContent = (latest.textContent || '').trim();
      return innerText.length >= textContent.length ? innerText : textContent;
    })
    .catch(() => '');

  return text.trim();
}

async function getLatestResponseByCopy(page) {
  const actionButtonsVisible = await page
    .locator('div.buttons-container-v2 copy-button button[data-test-id="copy-button"]')
    .last()
    .isVisible()
    .catch(() => false);

  if (!actionButtonsVisible) {
    return '';
  }

  const latestCopyButton = page.locator(
    'div.buttons-container-v2 copy-button button[data-test-id="copy-button"]'
  );
  try {
    await latestCopyButton.last().click({ timeout: 2500 });
    await page.waitForTimeout(250);
    const copiedText = await page.evaluate(async () => navigator.clipboard.readText());
    return (copiedText || '').trim();
  } catch (_err) {
    return '';
  }
}

async function collectFullResponseWithScroll(page, initialText = '') {
  let best = initialText.trim();

  for (let i = 0; i < 8; i += 1) {
    await page
      .evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const candidates = document.querySelectorAll(
          'model-response, .model-response-text, .response-content, markdown, .markdown'
        );
        const latest = candidates[candidates.length - 1];
        if (latest && 'scrollHeight' in latest && 'scrollTop' in latest) {
          latest.scrollTop = latest.scrollHeight;
        }
      })
      .catch(() => {});

    const copied = await getLatestResponseByCopy(page);
    if (copied.length > best.length) {
      best = copied;
    }

    const fromDom = await getLatestResponseByDom(page);
    if (fromDom.length > best.length) {
      best = fromDom;
    }

    await page.waitForTimeout(500);
  }

  return best;
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

    const copied = await getLatestResponseByCopy(page);
    if (copied.length > best.length) {
      best = copied;
      lastUpdatedAt = Date.now();
    }

    const latest = await getLatestResponseByDom(page);
    if (latest.length > best.length) {
      best = latest;
      lastUpdatedAt = Date.now();
    }

    if (!stopVisible && best.length > 30 && Date.now() - lastUpdatedAt >= settleMs) {
      return collectFullResponseWithScroll(page, best);
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  if (best.length > 0) {
    return collectFullResponseWithScroll(page, best);
  }

  throw new Error('Gemini 응답을 시간 내에 가져오지 못했습니다.');
}

async function askGeminiByWeb(prompt) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    console.log('[Gemini] prompt to send:\n', prompt);
    await page.bringToFront().catch(() => {});
    await ensureGeminiReady(page);
    await fillPromptAndSend(page, prompt);
    const answer = await waitForResponse(page, GEMINI_TIMEOUT_MS);
    console.log(`[Gemini] response length: ${answer.length}`);
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

app.get('/api/auth-status', async (_req, res) => {
  try {
    const context = await getContext();
    const page = await context.newPage();
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const input = await findGeminiInput(page);
    await page.close().catch(() => {});
    return res.json({ ok: true, loggedIn: Boolean(input) });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Gemini 인증 상태 확인에 실패했습니다.'
    });
  }
});

app.post('/api/check', async (req, res) => {
  const { link, context } = req.body || {};
  if (!link || typeof link !== 'string') {
    return res.status(400).json({ ok: false, error: 'link 값이 필요합니다.' });
  }

  try {
    const cleanLink = link.trim();
    const cleanContext = typeof context === 'string' ? context.trim() : '';
    console.log(`[API] /api/check requested link: ${cleanLink}`);
    if (cleanContext) {
      console.log(`[API] /api/check context: ${cleanContext}`);
    } else {
      console.log('[API] /api/check context: (empty)');
    }

    const prompt = buildPrompt(cleanLink, cleanContext);
    const result = await askGeminiByWeb(prompt);
    return res.json({ ok: true, link, result });
  } catch (error) {
    if (error instanceof GeminiLoginRequiredError) {
      return res.status(401).json({
        ok: false,
        error: error.message
      });
    }

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
