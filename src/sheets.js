/**
 * Google Sheets integration: parse the downloaded wallet CSV, check for
 * duplicate dates, push data with formulas, and format the new rows to
 * match existing ones. Ported from sheets.py, switched from interactive
 * OAuth (can't run unattended on a server) to a service account.
 */
const fs = require('fs');
const { google } = require('googleapis');
const { settings } = require('./config');
const { loadServiceAccountCredentials } = require('./googleAuth');
const { log, warn } = require('./utils');
const { dateKey, formatDMonY, parseDateLoose, addDays, todayIST, compareDate } = require('./dateUtil');

const CSV_HEADER_ROW = 7;
const CSV_DATA_START = 8;

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Parses the wallet CSV, skipping the 6 metadata lines Flipkart puts at
// the top of the export.
function parseCsv(csvPath) {
  const allLines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
  const headerLine = allLines[CSV_HEADER_ROW - 1].trim();
  const headers = parseCsvLine(headerLine).map((h) => h.trim());

  const rows = [];
  for (const rawLine of allLines.slice(CSV_DATA_START - 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    if (values.length >= headers.length) {
      const row = {};
      headers.forEach((h, i) => {
        row[h] = values[i];
      });
      rows.push(row);
    }
  }
  return rows;
}

// Sheet names with spaces or other special characters (like "1.DATA Ads")
// must be single-quoted in A1-notation ranges, or the Sheets API rejects
// the range/misparses it. Always quoting is safe even for simple names.
function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

let sheetsClientPromise = null;
function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = loadServiceAccountCredentials();
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

async function openWorksheet(send) {
  if (!settings.SPREADSHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID is not set.');
  }
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: settings.SPREADSHEET_ID,
    fields: 'sheets.properties',
  });
  const sheetProps = (meta.data.sheets || []).find((s) => s.properties.title === settings.SHEET_NAME);
  if (!sheetProps) {
    throw new Error(`Sheet tab '${settings.SHEET_NAME}' not found in the spreadsheet.`);
  }
  log(send, 'sheets.open', `Connected to sheet '${settings.SHEET_NAME}'`);
  return {
    sheets,
    spreadsheetId: settings.SPREADSHEET_ID,
    sheetName: settings.SHEET_NAME,
    sheetId: sheetProps.properties.sheetId,
    rowCount: sheetProps.properties.gridProperties.rowCount,
  };
}

async function colValues(ws, colLetter) {
  const range = `${quoteSheetName(ws.sheetName)}!${colLetter}:${colLetter}`;
  const res = await ws.sheets.spreadsheets.values.get({ spreadsheetId: ws.spreadsheetId, range });
  const values = res.data.values || [];
  return values.map((row) => (row[0] !== undefined ? String(row[0]) : ''));
}

// The set of dates (as "YYYY-MM-DD" keys) already recorded in column J.
async function getPresentDates(send) {
  const ws = await openWorksheet(send);
  const jValues = await colValues(ws, 'J');
  const present = new Set();
  for (const v of jValues) {
    const d = parseDateLoose(v);
    if (d) present.add(dateKey(d));
  }
  log(send, 'sheets.present_dates', `Sheet currently holds ${present.size} distinct date(s)`);
  return present;
}

// Dates in the last lookbackDays calendar days (ending yesterday) that are
// absent from presentDateKeys, oldest-first. On a normal run this is just
// [yesterday]; any earlier day a previous run skipped shows up too.
function missingDatesInWindow(presentDateKeys, lookbackDays, today) {
  const t = today || todayIST();
  const yesterday = addDays(t, -1);
  const window = [];
  for (let i = 0; i < Math.max(1, lookbackDays); i += 1) {
    window.push(addDays(yesterday, -i));
  }
  return window
    .filter((d) => !presentDateKeys.has(dateKey(d)))
    .sort(compareDate);
}

async function applyFormatting(ws, startRow, endRow, send) {
  const step = 'sheets.format';
  const fullRange = {
    sheetId: ws.sheetId,
    startRowIndex: startRow - 1,
    endRowIndex: endRow,
    startColumnIndex: 0,
    endColumnIndex: 12,
  };
  const borderStyle = { style: 'SOLID', colorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } } };

  const requests = [
    {
      repeatCell: {
        range: fullRange,
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: 'Calibri', fontSize: 11 },
            horizontalAlignment: 'CENTER',
          },
        },
        fields:
          'userEnteredFormat.textFormat.fontFamily,' +
          'userEnteredFormat.textFormat.fontSize,' +
          'userEnteredFormat.horizontalAlignment',
      },
    },
    {
      updateBorders: {
        range: fullRange,
        top: borderStyle,
        bottom: borderStyle,
        left: borderStyle,
        right: borderStyle,
        innerHorizontal: borderStyle,
        innerVertical: borderStyle,
      },
    },
  ];

  try {
    await ws.sheets.spreadsheets.batchUpdate({ spreadsheetId: ws.spreadsheetId, requestBody: { requests } });
    log(send, step, `Formatted rows ${startRow}-${endRow} (Calibri 11, centered, borders)`);
  } catch (fmtErr) {
    warn(send, step, `Formatting failed (data was still pushed): ${fmtErr.message}`);
  }
}

// Pushes CSV data for targetDate ({y,m,d}) to the sheet. Returns the number
// of rows added (0 if that date is already present — treated as a
// duplicate, not an error).
async function pushToSheet(csvPath, targetDate, send) {
  const step = 'sheets.push';
  const dateStr = formatDMonY(targetDate);

  const ws = await openWorksheet(send);

  const jValues = await colValues(ws, 'J');
  const alreadyPresent = jValues.some((v) => {
    const d = parseDateLoose(v);
    return d && dateKey(d) === dateKey(targetDate);
  });
  if (alreadyPresent) {
    log(send, step, `Data for ${dateStr} already exists in sheet — skipping`);
    return 0;
  }

  const csvRows = parseCsv(csvPath);
  if (csvRows.length === 0) {
    warn(send, step, 'CSV has no data rows');
    return 0;
  }
  log(send, step, `Parsed ${csvRows.length} rows from CSV`);

  const cValues = await colValues(ws, 'C');
  const startRow = Math.max(cValues.length + 1, 2);
  log(send, step, `Appending starting at row ${startRow}`);

  // Columns: A=S.No, B=Month, C=TransId, D=gross_amount, E=campaign_id,
  //          F=Campaign, G=Operation, H=OpSubType, I=status, J=Date,
  //          K=GrossAmountFinal, L=Top-Up (blank)
  const batch = csvRows.map((row, i) => {
    const sheetRow = startRow + i;
    const aVal = sheetRow === 2 ? 1 : `=A${sheetRow - 1}+1`;
    const bVal =
      `=IF(MONTH(J${sheetRow})>=4,MONTH(J${sheetRow})-3,MONTH(J${sheetRow})+9)` +
      `&"."&TEXT(J${sheetRow},"MMM'YY")`;
    const kVal =
      `=IF(OR(G${sheetRow}="Redeem",G${sheetRow}="EXPIRE_AUTH_TOPUP"),` +
      `D${sheetRow}*-1,D${sheetRow})`;

    let gross = row['gross_amount'] || '';
    const grossNum = parseFloat(gross);
    if (Number.isFinite(grossNum)) gross = grossNum;

    return [
      aVal,
      bVal,
      row['Transaction Id'] || '',
      gross,
      row['campaign_id'] || '',
      row['Campaign'] || '',
      row['Operation'] || '',
      row['Operation Sub Type'] || '',
      row['status'] || '',
      dateStr,
      kVal,
      '',
    ];
  });

  const endRow = startRow + batch.length - 1;
  if (endRow > ws.rowCount) {
    const extra = endRow - ws.rowCount + 50;
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
  }

  const cellRange = `${quoteSheetName(ws.sheetName)}!A${startRow}:L${endRow}`;
  await ws.sheets.spreadsheets.values.update({
    spreadsheetId: ws.spreadsheetId,
    range: cellRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: batch },
  });
  log(send, step, `Pushed ${batch.length} rows to ${cellRange}`);

  await applyFormatting(ws, startRow, endRow, send);

  return batch.length;
}

module.exports = { getPresentDates, missingDatesInWindow, pushToSheet };
