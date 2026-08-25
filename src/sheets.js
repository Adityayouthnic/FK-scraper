const fs = require('fs');
const { google } = require('googleapis');

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  }
  // Local dev: a file path. Cloud Run: the JSON content itself (mounted secret).
  if (fs.existsSync(raw)) {
    return JSON.parse(fs.readFileSync(raw, 'utf8'));
  }
  return JSON.parse(raw);
}

async function getSheetsClient() {
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// data: { scrapedAt, balance, ... } — adjust the `values` row below to match
// whatever fields your real scraper ends up returning.
async function appendWalletRow(data) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set.');
  }

  const sheets = await getSheetsClient();
  const values = [[data.scrapedAt, data.balance]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:B',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  return values.length;
}

module.exports = { appendWalletRow };
