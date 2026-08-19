import 'dotenv/config';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const config = {
  productUrl: process.env.PRODUCT_URL || 'https://www.musinsa.com/products/6990137',
  intervalSeconds: Math.max(60, Number(process.env.INTERVAL_SECONDS || 300)),
  notifyOnFirstAvailable: parseBoolean(process.env.NOTIFY_ON_FIRST_AVAILABLE, false),
  stateFile: path.resolve(process.env.STATE_FILE || './state.json'),
  timeoutMs: Math.max(10_000, Number(process.env.PAGE_TIMEOUT_MS || 45_000)),
  headless: parseBoolean(process.env.HEADLESS, true),
  openOptionPanel: parseBoolean(process.env.OPEN_OPTION_PANEL, true),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookKind: (process.env.WEBHOOK_KIND || 'discord').toLowerCase(),
};

const once = process.argv.includes('--once');
const testNotify = process.argv.includes('--test-notify');
let shuttingDown = false;

if (!/^https:\/\/(www\.)?musinsa\.com\/products\/\d+/.test(config.productUrl)) {
  throw new Error('PRODUCT_URL은 https://www.musinsa.com/products/숫자 형식이어야 합니다.');
}

process.on('SIGINT', () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

if (testNotify) {
  await notify([
    '🧪 무신사 재입고 알림 테스트',
    '상품: 테스트 상품',
    '옵션: M',
    `링크: ${config.productUrl}`,
  ].join('\n'));
  process.exit(0);
}

console.log(`[시작] ${config.productUrl}`);
console.log(`[설정] ${config.intervalSeconds}초마다 확인합니다.`);

const browser = await chromium.launch({
  headless: config.headless,
  channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});

try {
  do {
    const startedAt = Date.now();
    try {
      await checkOnce(browser);
    } catch (error) {
      console.error(`[오류] ${new Date().toLocaleString('ko-KR')} ${formatError(error)}`);
    }

    if (once || shuttingDown) break;
    const remaining = Math.max(1_000, config.intervalSeconds * 1_000 - (Date.now() - startedAt));
    await sleep(remaining);
  } while (!shuttingDown);
} finally {
  await browser.close();
}

async function checkOnce(browserInstance) {
  const context = await browserInstance.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);

  try {
    const response = await page.goto(config.productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });

    if (response && response.status() >= 400) {
      throw new Error(`상품 페이지 HTTP ${response.status()}`);
    }

    await page.waitForTimeout(2_500);
    await detectAccessBlock(page);

    if (config.openOptionPanel) {
      await openOptionPanel(page);
      await page.waitForTimeout(800);
    }

    const snapshot = await extractSnapshot(page);
    snapshot.checkedAt = new Date().toISOString();
    snapshot.url = config.productUrl;

    if (snapshot.status === 'unknown') {
      throw new Error('재고 상태를 판별하지 못했습니다. 페이지 구조 변경 또는 접근 제한일 수 있습니다.');
    }

    const previous = await loadState();
    const changes = findRestocks(previous, snapshot);
    const firstRun = !previous;

    if (changes.length > 0 && (!firstRun || config.notifyOnFirstAvailable)) {
      await notify(formatRestockMessage(snapshot, changes));
      console.log(`[재입고] ${changes.map((item) => item.label).join(', ')}`);
    } else {
      console.log(`[확인] ${new Date().toLocaleString('ko-KR')} ${snapshot.name} — ${summary(snapshot)}`);
    }

    await saveState(snapshot, previous);
  } finally {
    await context.close();
  }
}

async function openOptionPanel(page) {
  const candidates = [
    page.getByRole('button', { name: /^구매하기$/ }),
    page.getByRole('button', { name: /바로\s*구매/ }),
    page.getByText(/^구매하기$/, { exact: true }),
  ];

  for (const locator of candidates) {
    try {
      const first = locator.first();
      if (await first.isVisible() && await first.isEnabled()) {
        await first.click({ timeout: 3_000 });
        return;
      }
    } catch {
      // 다음 후보를 시도합니다.
    }
  }
}

async function detectAccessBlock(page) {
  const title = (await page.title()).toLowerCase();
  const body = (await page.locator('body').innerText({ timeout: 10_000 })).slice(0, 5_000).toLowerCase();
  const blocked = [
    'verify you are human',
    'access denied',
    'checking your browser',
    '비정상적인 접근',
    '접근이 제한',
  ].some((text) => title.includes(text) || body.includes(text));

  if (blocked) throw new Error('무신사가 자동화 접근을 제한했습니다. 확인 간격을 늘려 주세요.');
}

async function extractSnapshot(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isUnavailableText = (text) => /품절|sold\s*out|재입고\s*알림/i.test(text);
    const isAvailableText = (text) => /구매하기|바로\s*구매|장바구니|buy\s*now/i.test(text);
    const money = (value) => {
      const match = clean(value).match(/(?:₩\s*)?[\d,]+\s*원|KRW\s*[\d,.]+/i);
      return match ? match[0] : '';
    };
    const candidates = [];

    const addOption = (label, available, source) => {
      let normalized = clean(label)
        .replace(/\s*(품절|sold\s*out|재입고\s*알림)\s*/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized || normalized.length > 80) return;
      if (/^(옵션|옵션 선택|선택|구매하기|바로 구매|장바구니|닫기|확인)$/i.test(normalized)) return;
      candidates.push({ label: normalized, available: Boolean(available), source });
    };

    // 네이티브 select 옵션
    for (const option of document.querySelectorAll('select option')) {
      const label = clean(option.textContent);
      if (!label || option.value === '' || /선택/.test(label)) continue;
      addOption(label, !option.disabled && !isUnavailableText(label), 'select');
    }

    // 옵션 영역의 버튼/role=option. 클래스명 변경에 대비해 여러 단서를 함께 사용합니다.
    const optionRoots = document.querySelectorAll([
      '[class*="option" i]',
      '[class*="size" i]',
      '[data-testid*="option" i]',
      '[aria-label*="옵션"]',
      '[role="listbox"]',
    ].join(','));

    for (const root of optionRoots) {
      for (const element of root.querySelectorAll('button, [role="option"], [role="radio"]')) {
        const label = clean(element.getAttribute('aria-label') || element.textContent);
        const disabled = element.matches(':disabled, [aria-disabled="true"], [data-disabled="true"]');
        addOption(label, !disabled && !isUnavailableText(label), 'option-ui');
      }
    }

    // 페이지에 role=option이 직접 노출되는 경우
    for (const element of document.querySelectorAll('[role="option"], [role="radio"]')) {
      const label = clean(element.getAttribute('aria-label') || element.textContent);
      const disabled = element.matches('[aria-disabled="true"], [data-disabled="true"]');
      addOption(label, !disabled && !isUnavailableText(label), 'aria-option');
    }

    // 내장 JSON 데이터에서 옵션/재고 형태의 객체를 휴리스틱하게 찾습니다.
    const jsonValues = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]')) {
      try { jsonValues.push(JSON.parse(script.textContent)); } catch { /* 무시 */ }
    }

    let productName = '';
    let price = '';
    let jsonProductAvailable = null;
    const seen = new Set();

    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return;
      seen.add(value);

      if (!Array.isArray(value)) {
        const type = clean(value['@type']).toLowerCase();
        if (type === 'product') {
          productName ||= clean(value.name);
          const offers = Array.isArray(value.offers) ? value.offers : [value.offers].filter(Boolean);
          for (const offer of offers) {
            price ||= money(offer?.price ? `${offer.price}원` : '');
            const availability = clean(offer?.availability);
            if (/InStock/i.test(availability)) jsonProductAvailable = true;
            if (/OutOfStock|SoldOut/i.test(availability) && jsonProductAvailable !== true) jsonProductAvailable = false;
          }
        }

        const keys = Object.keys(value);
        const optionish = keys.some((key) => /option|size|color/i.test(key));
        const stockish = keys.some((key) => /stock|inventory|sold.?out|available|품절/i.test(key));
        if (optionish && stockish) {
          const labelKey = keys.find((key) => /option.*(name|value)|size|color|display.*name|label/i.test(key));
          const stockKey = keys.find((key) => /sold.?out|available|stock|inventory|품절/i.test(key));
          const label = labelKey ? clean(value[labelKey]) : '';
          const raw = stockKey ? value[stockKey] : undefined;
          if (label && ['string', 'number', 'boolean'].includes(typeof raw)) {
            const keyLower = stockKey.toLowerCase();
            let available;
            if (/sold|품절/.test(keyLower)) available = !(['y', 'yes', 'true', '1', true, 1].includes(raw));
            else if (/stock|inventory/.test(keyLower)) available = Number(raw) > 0;
            else available = ['y', 'yes', 'true', '1', true, 1].includes(raw);
            addOption(label, available, 'embedded-json');
          }
        }
      }

      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
    };
    for (const value of jsonValues) visit(value);

    productName ||= clean(document.querySelector('meta[property="og:title"]')?.content)
      || clean(document.querySelector('h1')?.textContent)
      || clean(document.title).replace(/\s*[|\-]\s*무신사.*$/i, '');
    price ||= money(document.querySelector('meta[property="product:price:amount"]')?.content)
      || money(document.querySelector('meta[property="og:description"]')?.content)
      || money(document.body.innerText);

    // 동일 옵션이 여러 전략에서 발견되면 '판매 가능' 신호를 우선합니다.
    const optionMap = new Map();
    for (const item of candidates) {
      const key = item.label.toLowerCase();
      const existing = optionMap.get(key);
      if (!existing || item.available) optionMap.set(key, item);
    }
    const options = [...optionMap.values()]
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'))
      .map(({ label, available }) => ({ label, available }));

    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((element) => ({
        text: clean(element.textContent || element.getAttribute('aria-label')),
        disabled: element.matches(':disabled, [aria-disabled="true"]'),
      }));

    const hasEnabledBuyButton = buttons.some((item) => isAvailableText(item.text) && !item.disabled && !isUnavailableText(item.text));
    const hasSoldOutButton = buttons.some((item) => isUnavailableText(item.text));
    const anyOptionAvailable = options.some((item) => item.available);
    const allOptionsUnavailable = options.length > 0 && options.every((item) => !item.available);

    let status = 'unknown';
    if (anyOptionAvailable || hasEnabledBuyButton || jsonProductAvailable === true) status = 'available';
    else if (allOptionsUnavailable || hasSoldOutButton || jsonProductAvailable === false) status = 'sold_out';

    return { name: productName || '무신사 상품', price, status, options };
  });
}

function findRestocks(previous, current) {
  const currentAvailable = current.options.filter((option) => option.available);
  const currentItems = currentAvailable.length > 0
    ? currentAvailable
    : current.status === 'available' ? [{ label: '상품 구매 가능' }] : [];

  if (!previous) return currentItems;

  const previousAvailability = new Map(
    (previous.options || []).map((option) => [normalizeLabel(option.label), Boolean(option.available)]),
  );

  const newlyAvailable = currentAvailable.filter((option) => {
    const before = previousAvailability.get(normalizeLabel(option.label));
    return before === false;
  });

  if (newlyAvailable.length > 0) return newlyAvailable;
  if (previous.status !== 'available' && current.status === 'available') return currentItems;
  return [];
}

function formatRestockMessage(snapshot, changes) {
  const lines = [
    '🎉 무신사 재입고',
    `상품: ${snapshot.name}`,
    `구매 가능: ${changes.map((item) => item.label).join(', ')}`,
  ];
  if (snapshot.price) lines.push(`현재 가격: ${snapshot.price}`);
  lines.push(`링크: ${snapshot.url}`);
  return lines.join('\n');
}

async function notify(message) {
  const jobs = [];

  if (config.telegramToken && config.telegramChatId) {
    jobs.push(postJson(
      `https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
      { chat_id: config.telegramChatId, text: message, disable_web_page_preview: false },
      'Telegram',
    ));
  }

  if (config.webhookUrl) {
    const payload = config.webhookKind === 'slack' ? { text: message } : { content: message };
    jobs.push(postJson(config.webhookUrl, payload, config.webhookKind));
  }

  if (jobs.length === 0) {
    console.log(message);
    console.warn('[알림] Telegram 또는 Webhook 설정이 없어 콘솔에만 출력했습니다.');
    return;
  }

  await Promise.all(jobs);
}

async function postJson(url, body, label) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${label} 알림 실패: HTTP ${response.status()} ${await response.text()}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(config.stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveState(snapshot, previous) {
  await mkdir(path.dirname(config.stateFile), { recursive: true });
  const temp = `${config.stateFile}.${process.pid}.tmp`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ status: snapshot.status, options: snapshot.options }))
    .digest('hex');

  // GitHub Actions에서는 실제 재고 상태가 바뀔 때만 상태 파일을 커밋합니다.
  if (previous?.fingerprint === fingerprint) return false;

  const stable = {
    ...snapshot,
    fingerprint,
  };
  await writeFile(temp, `${JSON.stringify(stable, null, 2)}\n`, 'utf8');
  await rename(temp, config.stateFile);
  return true;
}

function summary(snapshot) {
  if (snapshot.options.length > 0) {
    const available = snapshot.options.filter((item) => item.available).map((item) => item.label);
    return available.length ? `구매 가능: ${available.join(', ')}` : '모든 옵션 품절';
  }
  return snapshot.status === 'available' ? '구매 가능' : '품절';
}

function normalizeLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(value);
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
