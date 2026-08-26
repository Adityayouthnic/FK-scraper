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

// Flipkart's export carries 6 metadata lines before the real header, so the
// header has historically been row 7. That's only a fallback now: the header
// is located by looking for the row that actually contains "Transaction Id",
// so a change in how many preamble lines they emit can't silently shift every
// column by a row.
const FALLBACK_HEADER_ROW = 7;
const HEADER_MARKER = 'transaction id';

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

// Turns a matrix of cell values into objects keyed by the report's own
// header row, wherever that row happens to be.
function rowsFromMatrix(matrix) {
  let headerIdx = matrix.findIndex((cells) =>
    cells.some((c) => String(c ?? '').trim().toLowerCase() === HEADER_MARKER));
  if (headerIdx === -1) headerIdx = FALLBACK_HEADER_ROW - 1;
  if (headerIdx < 0 || headerIdx >= matrix.length) {
    throw new Error('Could not locate the header row in the downloaded report.');
  }

  const headers = (matrix[headerIdx] || []).map((h) => String(h ?? '').trim());
  const rows = [];
  for (const cells of matrix.slice(headerIdx + 1)) {
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
    const row = {};
    headers.forEach((h, i) => {
      if (h) row[h] = cells[i] === undefined || cells[i] === null ? '' : String(cells[i]);
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvFile(filePath) {
  const matrix = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => parseCsvLine(line));
  return rowsFromMatrix(matrix);
}

async function parseXlsxFile(filePath) {
  // Required lazily so a CSV-only run never pays to load exceljs.
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The downloaded workbook has no sheets.');

  const matrix = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    // row.values is 1-based with a leading hole, hence the slice.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const v of values) {
      if (v === null || v === undefined) cells.push('');
      else if (v instanceof Date) cells.push(v.toISOString());
      else if (typeof v === 'object') cells.push(String(v.text ?? v.result ?? v.hyperlink ?? ''));
      else cells.push(String(v));
    }
    matrix.push(cells);
  });
  return rowsFromMatrix(matrix);
}

// Flipkart's wallet export has arrived as CSV historically, but the UI calls
// it a report download and the extension isn't guaranteed — so sniff the
// actual bytes rather than trusting the filename. An .xlsx is a ZIP
// container ("PK\x03\x04"); anything else is treated as delimited text.
// Parsing a real workbook with the CSV reader would silently yield garbage
// rows, which is the worst outcome here: corrupt data that still looks
// plausible once it lands in the sheet.
async function parseReport(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
  return isZip ? parseXlsxFile(filePath) : parseCsvFile(filePath);
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

  const csvRows = await parseReport(csvPath);
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

    // Mirror Python's float(): convert only when the WHOLE string is
    // numeric, otherwise pass the original through untouched.
    //
    // parseFloat() must not be used here — it parses a leading prefix, so
    // the comma-grouped amounts Flipkart exports ("1,234.50") would silently
    // become 1. Leaving such a value as a string is correct: USER_ENTERED
    // makes Sheets parse "1,234.50" as 1234.5 itself, which is exactly what
    // the Python did.
    let gross = row['gross_amount'] || '';
    const grossText = String(gross).trim();
    const grossNum = Number(grossText);
    if (grossText !== '' && Number.isFinite(grossNum)) gross = grossNum;

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
