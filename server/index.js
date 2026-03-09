import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { existsSync, rmSync } from 'fs';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 8787;
// Cloudflare 프록시 환경에서 장시간 요청이 끊기는 문제를 줄이기 위해 90초 기본값 사용.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90000);
const GEMINI_LOGIN_WAIT_MS = Number(process.env.GEMINI_LOGIN_WAIT_MS || 300000);
const GEMINI_URL = process.env.GEMINI_URL || 'https://gemini.google.com/app';
const GEMINI_RUN_MODE = String(process.env.GEMINI_RUN_MODE || 'headless').toLowerCase();
const GEMINI_PROFILE_DIR = path.resolve(process.env.GEMINI_PROFILE_DIR || path.resolve(process.cwd(), '.gemini-profile'));
const GEMINI_REQUIRE_LOGIN = String(process.env.GEMINI_REQUIRE_LOGIN || 'true') === 'true';
const GEMINI_CDP_URL = (process.env.GEMINI_CDP_URL || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_API_MODEL = (process.env.GEMINI_API_MODEL || 'gemini-2.5-flash-lite').trim();
const GEMINI_HEADLESS = GEMINI_RUN_MODE === 'novnc' ? false : true;
const LOGIN_REQUIRED_FOR_MODE = GEMINI_REQUIRE_LOGIN;
const GEMINI_STEALTH =
  String(process.env.GEMINI_STEALTH || process.env.YOUTUBE_SUMMARY_STEALTH || 'true') === 'true';

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
let headlessCompareContextPromise;

function cleanupProfileSingletonLocks(profileDir) {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const file of lockFiles) {
    const target = path.join(profileDir, file);
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
  }
}

async function getContext() {
  if (!browserContextPromise) {
    if (GEMINI_RUN_MODE === 'cdp') {
      if (!GEMINI_CDP_URL) {
        throw new Error('GEMINI_RUN_MODE=cdp 인 경우 GEMINI_CDP_URL 설정이 필요합니다.');
      }
      browserPromise = chromium.connectOverCDP(GEMINI_CDP_URL);
      browserContextPromise = browserPromise.then((browser) => {
        const existing = browser.contexts();
        if (existing.length > 0) {
          return existing[0];
        }
        return browser.newContext();
      });
    } else {
      cleanupProfileSingletonLocks(GEMINI_PROFILE_DIR);
      browserContextPromise = (async () => {
        try {
          return await chromium.launchPersistentContext(GEMINI_PROFILE_DIR, {
            headless: GEMINI_HEADLESS,
            viewport: { width: 1366, height: 900 },
            args: ['--start-maximized']
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/profile appears to be in use|chromium has locked the profile/i.test(message)) {
            throw error;
          }

          // 락 파일이 남아있는 경우 1회 정리 후 재시도.
          cleanupProfileSingletonLocks(GEMINI_PROFILE_DIR);
          return chromium.launchPersistentContext(GEMINI_PROFILE_DIR, {
            headless: GEMINI_HEADLESS,
            viewport: { width: 1366, height: 900 },
            args: ['--start-maximized']
          });
        }
      })().catch((error) => {
        // 실패한 Promise가 캐시되지 않도록 초기화.
        browserContextPromise = undefined;
        throw error;
      });
    }
  }
  return browserContextPromise;
}

async function getHeadlessCompareContext() {
  if (!headlessCompareContextPromise) {
    cleanupProfileSingletonLocks(GEMINI_PROFILE_DIR);
    headlessCompareContextPromise = chromium
      .launchPersistentContext(GEMINI_PROFILE_DIR, {
        headless: true,
        viewport: { width: 1366, height: 900 },
        args: ['--start-maximized']
      })
      .catch((error) => {
        headlessCompareContextPromise = undefined;
        throw error;
      });
  }
  return headlessCompareContextPromise;
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

function extractYouTubeVideoId(link) {
  try {
    const url = new URL(link);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();

    if (host === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        return url.searchParams.get('v');
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
        return parts[1] || null;
      }
    }
  } catch (_err) {
    return null;
  }

  return null;
}

function isYouTubeLink(link) {
  return Boolean(extractYouTubeVideoId(link));
}

function vttToPlainText(vtt) {
  return vtt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line !== 'WEBVTT')
    .filter((line) => !line.startsWith('NOTE'))
    .filter((line) => !line.includes('-->'))
    .filter((line) => !/^\d+$/.test(line))
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchYouTubeTranscriptByYtDlp(link) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'yt-sub-'));
  try {
    const outputTemplate = path.join(workDir, 'sub.%(ext)s');
    await execFileAsync(
      'yt-dlp',
      [
        '--skip-download',
        '--no-warnings',
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs',
        'ko.*,ko,en.*,en',
        '--sub-format',
        'vtt',
        '--output',
        outputTemplate,
        link
      ],
      { timeout: 120000 }
    );

    const files = await readdir(workDir);
    const vttFile = files.find((name) => name.endsWith('.vtt'));
    if (!vttFile) {
      return '';
    }

    const vtt = await readFile(path.join(workDir, vttFile), 'utf-8');
    return vttToPlainText(vtt);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchYouTubeMetadataByYtDlp(link) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    ['--skip-download', '--no-warnings', '--dump-single-json', link],
    { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
  );

  const data = JSON.parse(stdout || '{}');
  const title = String(data.title || '').trim();
  const uploader = String(data.uploader || data.channel || '').trim();
  const description = String(data.description || '').trim();
  const duration = Number.isFinite(data.duration) ? Number(data.duration) : null;

  return [
    title ? `제목: ${title}` : '',
    uploader ? `채널: ${uploader}` : '',
    duration ? `길이(초): ${duration}` : '',
    description ? `설명: ${description}` : ''
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildYouTubePromptWithSource(link, sourceText, sourceLabel, extraContext = '', includeLink = true) {
  const maxChars = 20000;
  const clipped = sourceText.length > maxChars ? `${sourceText.slice(0, maxChars)}...` : sourceText;

  return [
    '너는 팩트체크 분석가야. 반드시 한국어로 답해.',
    '아래에 제공된 유튜브 기반 자료만 근거로 분석해. 자료 밖 추측은 금지.',
    '뉴스성 주장 여부를 먼저 판단하고, 없으면 판정은 "판별불가"로 해.',
    '',
    '출력 형식:',
    '1) 링크요약: [3~6줄]',
    '2) 자막/대본 핵심: [bullet 3~8개]',
    '3) 판정: [가짜뉴스/진짜뉴스/판별불가]',
    '4) 신뢰도: [0~100 정수]',
    '5) 근거: 핵심 근거 3가지',
    '6) 주의: 불확실/검증필요 지점',
    '7) 접근상태: [성공/실패] + 실패사유',
    '',
    includeLink ? `링크: ${link}` : '',
    `자료출처: ${sourceLabel}`,
    extraContext ? `사용자 추가설명: ${extraContext}` : '',
    '',
    '[자료 시작]',
    clipped,
    '[자료 끝]'
  ]
    .filter(Boolean)
    .join('\n');
}

function buildYouTubeNoSourcePrompt(extraContext = '') {
  return [
    '너는 팩트체크 분석가야. 반드시 한국어로 답해.',
    '유튜브 링크 원문은 전달하지 않는다.',
    '현재 자막/대본/메타데이터를 확보하지 못했으므로 판정은 반드시 "판별불가"로 해.',
    '',
    '출력 형식:',
    '1) 링크요약: 확보 실패',
    '2) 자막/대본 핵심: 확보 실패',
    '3) 판정: 판별불가',
    '4) 신뢰도: 0',
    '5) 근거: 자료 미확보',
    '6) 주의: 자막 또는 대본 확보 후 재분석 필요',
    '7) 접근상태: 실패 + 자막/메타데이터 확보 실패',
    '',
    extraContext ? `사용자 추가설명: ${extraContext}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function applyStealthHints(page) {
  if (!GEMINI_STEALTH) {
    return;
  }

  const spoofedUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'language', { get: () => 'ko-KR' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }]
    });

    if (!window.chrome) {
      // 일부 anti-bot 스크립트에서 window.chrome 존재 여부를 체크한다.
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true });
    }
  });
  await page.addInitScript((ua) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
    Object.defineProperty(navigator, 'appVersion', { get: () => ua, configurable: true });
  }, spoofedUserAgent);

  await page.setExtraHTTPHeaders({
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  });

  await page.setViewportSize({ width: 1366, height: 900 });
}

async function ensureGeminiReady(page, options = {}) {
  const { allowLoginPage = false } = options;
  await applyStealthHints(page);
  await page.bringToFront().catch(() => {});
  if (GEMINI_RUN_MODE !== 'cdp') {
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
    if (!allowLoginPage && LOGIN_REQUIRED_FOR_MODE && (loginDetected || maybeAuthPage)) {
      throw new GeminiLoginRequiredError(
        'Gemini 로그인 세션이 필요합니다. 로그인 후 다시 시도하세요.'
      );
    }

    await page.waitForTimeout(1500);
  }

  if (!allowLoginPage && LOGIN_REQUIRED_FOR_MODE) {
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

async function setPromptToInput(page, prompt) {
  const result = await page
    .evaluate((text) => {
      const candidates = [
        'textarea[aria-label*="Enter a prompt"]',
        'textarea[aria-label*="프롬프트"]',
        'textarea[placeholder*="Enter a prompt"]',
        'textarea[placeholder*="프롬프트"]',
        'textarea',
        '[contenteditable="true"]'
      ];

      for (const selector of candidates) {
        const node = document.querySelector(selector);
        if (!node) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          continue;
        }

        node.focus();
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = text;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }

        if (node instanceof HTMLElement && node.isContentEditable) {
          node.innerText = text;
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          return true;
        }
      }

      return false;
    }, prompt)
    .catch(() => false);

  return result;
}

async function findSendButton(page) {
  const selectors = [
    'button[aria-label*="보내기"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="전송"]',
    'button[data-test-id*="send"]',
    'button.send-button',
    'button:has-text("보내기")',
    'button:has-text("Send")',
    'button:has-text("전송")'
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    if (visible && enabled) {
      return button;
    }
  }

  return null;
}

async function isGenerationStarted(page) {
  return page
    .locator('button:has-text("Stop"), button:has-text("중지"), button[aria-label*="Stop"], button[aria-label*="중지"]')
    .first()
    .isVisible()
    .catch(() => false);
}

async function triggerSendByDom(page) {
  return page
    .evaluate(() => {
      const buttonSelectors = [
        'button[aria-label*="보내기"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="전송"]',
        'button[data-test-id*="send"]',
        'button.send-button',
        'button:has-text("보내기")',
        'button:has-text("Send")',
        'button:has-text("전송")'
      ];

      for (const selector of buttonSelectors) {
        const node = document.querySelector(selector);
        if (node instanceof HTMLButtonElement && !node.disabled) {
          node.click();
          return true;
        }
      }

      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const form = active.closest('form');
        if (form) {
          form.requestSubmit?.();
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return true;
        }
      }

      return false;
    })
    .catch(() => false);
}

async function fillPromptAndSend(page, prompt, baselineCount = 0) {
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
  await page.waitForTimeout(500);

  const inputText = (await input.textContent().catch(() => '')) || '';
  if (!inputText.trim()) {
    await input.fill(prompt).catch(async () => {
      await page.keyboard.type(prompt, { delay: 2 });
    });
    await page.waitForTimeout(400);
  }

  // 프로그램적 붙여넣기 후에도 버튼 활성화를 위해 입력 이벤트를 한번 더 강제한다.
  await setPromptToInput(page, prompt).catch(() => {});
  await page.waitForTimeout(500);

  // 요청사항: 붙여넣기 후 1초 정도 대기한 뒤 Enter 전송.
  await page.waitForTimeout(1000);

  // 1) Enter 전송 시도
  for (let i = 0; i < 3; i += 1) {
    await input.press('Enter').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
    if ((await isGenerationStarted(page)) || (await getResponseNodeCount(page)) > baselineCount) {
      return;
    }
  }

  // 2) 보내기 버튼 클릭 시도
  for (let i = 0; i < 4; i += 1) {
    const sendButton = await findSendButton(page);
    if (sendButton) {
      await sendButton.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1000);
      if ((await isGenerationStarted(page)) || (await getResponseNodeCount(page)) > baselineCount) {
        return;
      }
    }

    // 3) DOM 강제 클릭/submit 시도
    const domTriggered = await triggerSendByDom(page);
    if (domTriggered) {
      await page.waitForTimeout(1200);
      if ((await isGenerationStarted(page)) || (await getResponseNodeCount(page)) > baselineCount) {
        return;
      }
    }

    // 버튼 비활성 상태를 대비해 재입력 + Enter를 다시 시도
    await setPromptToInput(page, prompt).catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
    if ((await isGenerationStarted(page)) || (await getResponseNodeCount(page)) > baselineCount) {
      return;
    }
  }

  throw new Error('Gemini 전송이 시작되지 않았습니다. 입력창/전송 버튼 상태를 확인하세요.');
}

const RESPONSE_NODE_SELECTOR = 'model-response, .model-response-text, .response-content, markdown, .markdown';

async function getResponseNodeCount(page) {
  return page
    .evaluate((selector) => document.querySelectorAll(selector).length, RESPONSE_NODE_SELECTOR)
    .catch(() => 0);
}

async function getLatestResponseByDom(page, baselineCount = 0) {
  const text = await page
    .evaluate(({ selector, baseline }) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length === 0) {
        return '';
      }

      const fromIndex = Math.max(0, Math.min(baseline, nodes.length - 1));
      const candidates = nodes.slice(fromIndex);
      const latest = candidates[candidates.length - 1] || nodes[nodes.length - 1];
      const innerText = (latest.innerText || '').trim();
      const textContent = (latest.textContent || '').trim();
      return innerText.length >= textContent.length ? innerText : textContent;
    }, { selector: RESPONSE_NODE_SELECTOR, baseline: baselineCount })
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

async function collectFullResponseWithScroll(page, initialText = '', baselineCount = 0) {
  let best = initialText.trim();

  for (let i = 0; i < 8; i += 1) {
    await page
      .evaluate(() => {
        const expandButtons = Array.from(document.querySelectorAll('button'));
        for (const button of expandButtons) {
          const text = (button.textContent || '').trim().toLowerCase();
          if (text.includes('더보기') || text.includes('show more') || text.includes('계속')) {
            button.click();
          }
        }

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

    const fromDom = await getLatestResponseByDom(page, baselineCount);
    if (fromDom.length > best.length) {
      best = fromDom;
    }

    await page.waitForTimeout(500);
  }

  return best;
}

async function waitForResponse(page, timeoutMs, baselineCount = 0) {
  const start = Date.now();
  let best = '';
  let lastUpdatedAt = start;
  const settleMs = 4500;
  const pollIntervalMs = 1200;
  let seenNewResponse = false;
  let stableSince = 0;

  while (Date.now() - start < timeoutMs) {
    const stopVisible = await isGenerationStarted(page);

    const currentCount = await getResponseNodeCount(page);
    if (currentCount > baselineCount) {
      seenNewResponse = true;
    }

    const copied = await getLatestResponseByCopy(page);
    if (copied.length > best.length) {
      best = copied;
      lastUpdatedAt = Date.now();
    }

    const latest = await getLatestResponseByDom(page, baselineCount);
    if (latest.length > best.length) {
      best = latest;
      lastUpdatedAt = Date.now();
    }

    if (Date.now() - lastUpdatedAt >= settleMs) {
      if (stableSince === 0) {
        stableSince = Date.now();
      }
    } else {
      stableSince = 0;
    }

    // Stop 버튼 감지가 실패하는 UI 변형이 있어도 텍스트가 충분히 안정화되면 완료로 본다.
    if (!stopVisible && (seenNewResponse || best.length > 30) && stableSince > 0) {
      return collectFullResponseWithScroll(page, best, baselineCount);
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  if (best.length > 0) {
    return collectFullResponseWithScroll(page, best, baselineCount);
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
    const baselineCount = await getResponseNodeCount(page);
    await fillPromptAndSend(page, prompt, baselineCount);
    const answer = await waitForResponse(page, GEMINI_TIMEOUT_MS, baselineCount);
    console.log(`[Gemini] response length: ${answer.length}`);
    return answer;
  } finally {
    await page.close().catch(() => {});
  }
}

async function askGeminiByWebHeadless(prompt) {
  const context = await getHeadlessCompareContext();
  const page = await context.newPage();
  try {
    console.log('[GeminiWebHeadless] prompt to send:\n', prompt);
    await page.bringToFront().catch(() => {});
    await ensureGeminiReady(page);
    const baselineCount = await getResponseNodeCount(page);
    await fillPromptAndSend(page, prompt, baselineCount);
    const answer = await waitForResponse(page, GEMINI_TIMEOUT_MS, baselineCount);
    console.log(`[GeminiWebHeadless] response length: ${answer.length}`);
    return answer;
  } finally {
    await page.close().catch(() => {});
  }
}

async function askGeminiByApi(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_API_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  console.log(`[GeminiAPI] model=${GEMINI_API_MODEL} promptLength=${prompt.length}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage =
      data?.error?.message ||
      data?.error?.status ||
      `Gemini API 요청 실패 (status: ${response.status})`;
    throw new Error(apiMessage);
  }

  const text = (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Gemini API 응답 텍스트가 비어 있습니다.');
  }

  console.log(`[GeminiAPI] response length: ${text.length}`);
  return text;
}

async function askGemini(prompt) {
  if (GEMINI_RUN_MODE === 'geminiapi') {
    return askGeminiByApi(prompt);
  }
  return askGeminiByWeb(prompt);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.get('/api/open-gemini', async (_req, res) => {
  if (GEMINI_RUN_MODE === 'geminiapi') {
    return res.json({
      ok: true,
      message: 'geminiapi 모드입니다. 브라우저를 열지 않고 Gemini API를 사용합니다.'
    });
  }

  try {
    const context = await getContext();
    const page = await context.newPage();
    await ensureGeminiReady(page, { allowLoginPage: true });
    return res.json({ ok: true, message: 'Gemini 페이지를 열었습니다. noVNC 화면에서 로그인하세요.' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Gemini 페이지 열기에 실패했습니다.'
    });
  }
});

app.get('/api/auth-status', async (_req, res) => {
  if (GEMINI_RUN_MODE === 'geminiapi') {
    return res.json({ ok: true, loggedIn: true, mode: 'geminiapi' });
  }

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

    let promptForApi = buildPrompt(cleanLink, cleanContext);
    let promptForWeb = buildPrompt(cleanLink, cleanContext);
    if (isYouTubeLink(cleanLink)) {
      let sourceText = '';
      let sourceLabel = '';

      try {
        const transcript = await fetchYouTubeTranscriptByYtDlp(cleanLink);
        if (transcript) {
          sourceText = transcript;
          sourceLabel = 'transcript:yt-dlp';
          console.log(`[API] youtube transcript fetched chars=${transcript.length}`);
        }
      } catch (transcriptError) {
        console.log(
          `[API] youtube transcript fetch failed: ${
            transcriptError instanceof Error ? transcriptError.message : String(transcriptError)
          }`
        );
      }

      if (!sourceText) {
        try {
          const metadata = await fetchYouTubeMetadataByYtDlp(cleanLink);
          if (metadata) {
            sourceText = metadata;
            sourceLabel = 'metadata:yt-dlp';
            console.log(`[API] youtube metadata fetched chars=${metadata.length}`);
          }
        } catch (metaError) {
          console.log(
            `[API] youtube metadata fetch failed: ${
              metaError instanceof Error ? metaError.message : String(metaError)
            }`
          );
        }
      }

      if (sourceText) {
        promptForApi = buildYouTubePromptWithSource(cleanLink, sourceText, sourceLabel, cleanContext, true);
        promptForWeb = buildYouTubePromptWithSource(cleanLink, sourceText, sourceLabel, cleanContext, false);
      } else {
        console.log('[API] youtube source unavailable. use no-source prompt for web');
        promptForWeb = buildYouTubeNoSourcePrompt(cleanContext);
      }
    }

    if (GEMINI_RUN_MODE === 'geminiapi') {
      const [apiResult, webResult] = await Promise.allSettled([
        askGeminiByApi(promptForApi),
        askGeminiByWebHeadless(promptForWeb)
      ]);

      const apiPayload =
        apiResult.status === 'fulfilled'
          ? { ok: true, text: apiResult.value }
          : {
              ok: false,
              error:
                apiResult.reason instanceof Error ? apiResult.reason.message : String(apiResult.reason)
            };
      const webPayload =
        webResult.status === 'fulfilled'
          ? { ok: true, text: webResult.value }
          : {
              ok: false,
              error:
                webResult.reason instanceof Error ? webResult.reason.message : String(webResult.reason)
            };

      if (!apiPayload.ok && !webPayload.ok) {
        throw new Error(`API 실패: ${apiPayload.error} | WEB 실패: ${webPayload.error}`);
      }

      const primary = webPayload.ok ? webPayload.text : apiPayload.text;
      return res.json({
        ok: true,
        link,
        result: primary,
        results: {
          api: apiPayload,
          web: webPayload
        }
      });
    }

    const result = await askGemini(promptForWeb);
    return res.json({
      ok: true,
      link,
      result,
      results: {
        api: { ok: false, error: '현재 모드에서 API 비교 비활성화' },
        web: { ok: true, text: result }
      }
    });
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
