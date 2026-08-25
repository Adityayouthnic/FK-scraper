const { chromium } = require('playwright');
const { appendWalletRow } = require('./sheets');

async function runScrapeJob(send) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const client = await page.context().newCDPSession(page);

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1024,
    maxHeight: 768,
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
    const walletData = await scrapeFlipkartWallet(page, send);
    send('log', { message: 'Writing to Google Sheet...' });
    const rowsAdded = await appendWalletRow(walletData);
    send('log', { message: `Wrote ${rowsAdded} row(s) to the sheet.` });
    return { rowsAdded };
  } finally {
    try {
      await client.send('Page.stopScreencast');
    } catch {}
    await browser.close();
  }
}

// --- Placeholder: replace the body of this function with your existing ---
// --- Flipkart wallet login + scraping steps. Everything above and below ---
// --- (screencast streaming, Sheets write, WebSocket wiring) already works. ---
async function scrapeFlipkartWallet(page, send) {
  send('log', { message: 'Opening Flipkart...' });
  await page.goto('https://www.flipkart.com', { waitUntil: 'domcontentloaded' });

  // TODO: swap in your real steps, e.g.:
  //   await page.fill('#login-email-input-selector', process.env.FLIPKART_EMAIL);
  //   await page.fill('#login-password-input-selector', process.env.FLIPKART_PASSWORD);
  //   await page.click('button[type=submit]');
  //   await page.goto('https://www.flipkart.com/account/wallet');
  //   const balance = await page.textContent('.wallet-balance-selector');

  send('log', { message: 'Placeholder run finished — plug in your real scraping steps here.' });

  return {
    scrapedAt: new Date().toISOString(),
    balance: 'N/A (placeholder)',
  };
}

module.exports = { runScrapeJob };
