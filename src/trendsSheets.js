/**
 * Google Sheets integration for Search Trends: authenticate via service account
 * and append scraped rows below existing data in the Search_Trends tab.
 *
 * Columns I/J/K/L are pushed as formulas (not computed values), matching the
 * formulas in the existing rows of that sheet:
 *   I = numeric version of D ("3.3L" -> 330000)
 *   J = numeric version of G, keeping the </> prefix (">1K" -> ">1000")
 *   K = numeric version of H, keeping the </> prefix (LET() form)
 *   L = ISO week number of the scraped date (column A)
 */
const { settings } = require('./config');
const { getSheetsClient } = require('./googleAuth');
const { log, warn } = require('./utils');

// Formula templates copied verbatim from the existing Search_Trends sheet;
// {r} substitutes in the target row number.
const _I_TEMPLATE =
  '=IF(ISNUMBER(D{r}),D{r},\n IF(RIGHT(D{r},1)="L",VALUE(LEFT(D{r},LEN(D{r})-1))*100000,\n ' +
  'IF(RIGHT(D{r},1)="K",VALUE(LEFT(D{r},LEN(D{r})-1))*1000,\n VALUE(D{r}))))';

const _J_TEMPLATE =
  '=IF(G{r}=0,0,\n IF(LEFT(G{r},1)=">",\n   ">"&\n   IF(RIGHT(G{r},1)="K",\n      ' +
  'VALUE(MID(G{r},2,LEN(G{r})-2))*1000,\n   IF(RIGHT(G{r},1)="L",\n      ' +
  'VALUE(MID(G{r},2,LEN(G{r})-2))*100000,\n      VALUE(MID(G{r},2,99)))),\n ' +
  'IF(LEFT(G{r},1)="<",\n   "<"&\n   IF(RIGHT(G{r},1)="K",\n      ' +
  'VALUE(MID(G{r},2,LEN(G{r})-2))*1000,\n   IF(RIGHT(G{r},1)="L",\n      ' +
  'VALUE(MID(G{r},2,LEN(G{r})-2))*100000,\n      VALUE(MID(G{r},2,99)))),\n G{r})))';

const _K_TEMPLATE =
  '=IF(TRIM(H{r})="","",\nIFERROR(\nLET(\nx,UPPER(TRIM(H{r})),\n' +
  'sign,IF(LEFT(x,1)=">",">",IF(LEFT(x,1)="<","<","")),\n' +
  'core,IF(sign<>"",MID(x,2,99),x),\nnum,IF(LEFT(core,1)="K",\n        ' +
  'VALUE(MID(core,2,99))*1000,\n    IF(RIGHT(core,1)="K",\n        ' +
  'VALUE(LEFT(core,LEN(core)-1))*1000,\n    IF(RIGHT(core,1)="L",\n        ' +
  'VALUE(LEFT(core,LEN(core)-1))*100000,\n        VALUE(core)\n))),\n' +
  'sign & num\n),\n"ERROR"))';

const _L_TEMPLATE = '=ISOWEEKNUM(A{r})';

function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Robust date comparison helper that handles various Google Sheet display formats:
 * M/D/YYYY, MM/DD/YYYY, D/M/YYYY, DD/MM/YYYY, YYYY-MM-DD, Date objects, etc.
 */
function isSameDate(cellVal, { y, m, d }) {
  if (!cellVal) return false;
  const s = String(cellVal).trim();
  if (!s) return false;

  const targetY = y;
  const targetM = m;
  const targetD = d;

  const candidates = [
    `${targetM}/${targetD}/${targetY}`,
    `${String(targetM).padStart(2, '0')}/${String(targetD).padStart(2, '0')}/${targetY}`,
    `${targetD}/${targetM}/${targetY}`,
    `${String(targetD).padStart(2, '0')}/${String(targetM).padStart(2, '0')}/${targetY}`,
    `${targetY}-${String(targetM).padStart(2, '0')}-${String(targetD).padStart(2, '0')}`,
    `${targetY}-${targetM}-${targetD}`,
  ];
  if (candidates.includes(s)) return true;

  const parts = s.split(/[\/\-\.]/).map((p) => parseInt(p, 10));
  if (parts.length === 3 && !parts.some(isNaN)) {
    let [p1, p2, p3] = parts;
    if (p3 < 100) p3 += 2000;
    if (p3 === targetY) {
      if ((p1 === targetM && p2 === targetD) || (p1 === targetD && p2 === targetM)) return true;
    }
  }

  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    if (dt.getFullYear() === targetY && (dt.getMonth() + 1) === targetM && dt.getDate() === targetD) {
      return true;
    }
  }
  return false;
}

async function openTrendsWorksheet(send) {
  const spreadsheetId = settings.TRENDS_SPREADSHEET_ID;
  const sheetName = settings.TRENDS_SHEET_NAME;

  if (!spreadsheetId) {
    throw new Error('TRENDS_SPREADSHEET_ID (or GOOGLE_SHEET_ID) is not set.');
  }

  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });

  const sheetProps = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheetProps) {
    throw new Error(`Sheet tab '${sheetName}' not found in spreadsheet '${spreadsheetId}'.`);
  }

  return {
    sheets,
    spreadsheetId,
    sheetName,
    sheetId: sheetProps.properties.sheetId,
    rowCount: sheetProps.properties.gridProperties.rowCount,
  };
}

async function getExistingColumnsAB(ws) {
  const range = `${quoteSheetName(ws.sheetName)}!A:B`;
  const res = await ws.sheets.spreadsheets.values.get({
    spreadsheetId: ws.spreadsheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return res.data.values || [];
}

/**
 * Checks if data for this vertical on this date is already present in Google Sheets.
 */
async function isVerticalAlreadyPresent(verticalLabel, targetDate, send) {
  try {
    const ws = await openTrendsWorksheet(send);
    const existingAB = await getExistingColumnsAB(ws);
    const target = (verticalLabel || '').trim().toLowerCase();

    for (const [colA, colB] of existingAB) {
      if (
        isSameDate(colA, targetDate) &&
        String(colB || '').trim().toLowerCase() === target
      ) {
        return true;
      }
    }
  } catch (err) {
    warn(send, 'trends.sheets.check', `Could not check existing sheet rows (${err.message}).`);
  }
  return false;
}

/**
 * Append scraped Search Trends rows below existing data. Returns rows added.
 *
 * @param {Array<object>} rows - Array of scraped row objects
 * @param {string} verticalLabel - Display label of vertical
 * @param {object} scrapedDate - Calendar date object { y, m, d }
 * @param {function} send - WebSocket log emitter
 */
async function pushTrends(rows, verticalLabel, scrapedDate, send) {
  const step = 'trends.sheets.push';

  if (!rows || rows.length === 0) {
    warn(send, step, `No rows to push for '${verticalLabel}'`);
    return 0;
  }

  const ws = await openTrendsWorksheet(send);

  // US-style M/D/YYYY, matching the existing column A values (e.g. "8/10/2026").
  const dateStr = `${scrapedDate.m}/${scrapedDate.d}/${scrapedDate.y}`;

  // ---- Strict Dedup: skip if this (date, vertical) pair was already pushed ----
  const existingAB = await getExistingColumnsAB(ws);
  const target = (verticalLabel || '').trim().toLowerCase();
  for (const [colA, colB] of existingAB) {
    if (
      isSameDate(colA, scrapedDate) &&
      String(colB || '').trim().toLowerCase() === target
    ) {
      log(send, step, `'${verticalLabel}' for ${dateStr} is already in Google Sheets — skipping push to prevent duplicate rows.`);
      return 0;
    }
  }

  const existingRowCount = existingAB.length;
  const startRow = Math.max(existingRowCount + 1, 2);

  const batch = [];
  for (let i = 0; i < rows.length; i++) {
    const r = startRow + i;
    const row = rows[i];
    batch.push([
      dateStr,                                          // A: Scraped date
      verticalLabel,                                    // B: Vertical
      row.term || '',                                   // C: Searched Term
      row.volume || '',                                 // D: Weekly search volume
      row.change || '',                                 // E: % Of Change
      row.ctr || '',                                    // F: CTR%
      row.units || '',                                  // G: Units Sold
      row.products || '',                               // H: No. of Products Shown
      _I_TEMPLATE.replace(/\{r\}/g, String(r)),         // I
      _J_TEMPLATE.replace(/\{r\}/g, String(r)),         // J
      _K_TEMPLATE.replace(/\{r\}/g, String(r)),         // K
      _L_TEMPLATE.replace(/\{r\}/g, String(r)),         // L
    ]);
  }

  const endRow = startRow + batch.length - 1;
  if (endRow > ws.rowCount) {
    const extra = endRow - ws.rowCount + 100;
    try {
      await ws.sheets.spreadsheets.batchUpdate({
        spreadsheetId: ws.spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: ws.sheetId, gridProperties: { rowCount: ws.rowCount + extra } },
              fields: 'gridProperties.rowCount',
            },
          }],
        },
      });
      log(send, step, `Expanded sheet by ${extra} rows`);
    } catch (expandErr) {
      warn(send, step, `Could not expand sheet rows: ${expandErr.message}`);
    }
  }

  const cellRange = `${quoteSheetName(ws.sheetName)}!A${startRow}:L${endRow}`;
  await ws.sheets.spreadsheets.values.update({
    spreadsheetId: ws.spreadsheetId,
    range: cellRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: batch },
  });

  log(send, step, `Pushed ${batch.length} rows to ${cellRange}`);
  return batch.length;
}

module.exports = {
  pushTrends,
  isVerticalAlreadyPresent,
  isSameDate,
  openTrendsWorksheet,
  _I_TEMPLATE,
  _J_TEMPLATE,
  _K_TEMPLATE,
  _L_TEMPLATE,
};
