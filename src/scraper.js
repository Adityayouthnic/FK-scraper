const { chromium } = require('playwright');
const { login } = require('./flipkartLogin');

const WALLET_URL = 'https://seller.flipkart.com/index.html#dashboard/ads/wallet/summary';
const VIEWPORT = { width: 1024, height: 768 };

// Tracks the single in-flight Playwright page, if any, so incoming input
// events (mouse/keyboard from the live view) can be relayed to it. There is
// at most one active run at a time (enforced in server.js).
let activePage = null;

async function dispatchInput(evt) {
  if (!activePage) return;
  try {
    switch (evt.event) {
      case 'mousemove':
        await activePage.mouse.move(evt.x, evt.y);
        break;
      case 'mousedown':
        await activePage.mouse.move(evt.x, evt.y);
        await activePage.mouse.down({ button: evt.button || 'left' });
        break;
      case 'mouseup':
        await activePage.mouse.up({ button: evt.button || 'left' });
        break;
      case 'wheel':
        await activePage.mouse.wheel(evt.deltaX || 0, evt.deltaY || 0);
        break;
      case 'keydown':
        await activePage.keyboard.down(evt.key);
        break;
      case 'keyup':
        await activePage.keyboard.up(evt.key);
        break;
      default:
        break;
    }
  } catch {
    // Page may be mid-navigation when an input event arrives; drop it.
  }
}

async function runScrapeJob(send) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage({ viewport: VIEWPORT });
  activePage = page;
  const client = await page.context().newCDPSession(page);

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    send('frame', { data });
    try {
      await client.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // WS/browser may already be closing; safe to ignore.
    }
  });

  try {
    await login(page, send);

    send('log', { message: 'Opening wallet summary...' });
    await page.goto(WALLET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500); // let the SPA route render after the hash change
    send('log', { message: `On wallet page: ${page.url()}` });

    // TODO: data extraction + Google Sheets write go here once the actual
    // scraping requirements are shared (see src/sheets.js:appendWalletRow).
    send('log', { message: 'Login + navigation to wallet summary complete.' });

    return { rowsAdded: 0 };
  } finally {
    try {
      await client.send('Page.stopScreencast');
    } catch {}
    activePage = null;
    await browser.close();
  }
}

module.exports = { runScrapeJob, dispatchInput };
