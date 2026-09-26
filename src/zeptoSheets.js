/**
 * Pure Node.js Google Sheets Client & Pipeline for Zepto
 *
 * Handles:
 *  - EAN, Zone, and Catalog lookup loading
 *  - Existing dates scanning and gap detection
 *  - Sales_F transformation to 15-column schema with formulas
 *  - Format-preserving batch append
 *  - Vendor Inventory_F stock snapshot refresh
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { getSheetsClient } = require('./googleAuth');
const { log, warn } = require('./utils');

const SALES_TAB = 'SALES DATA-Zepto';
const INVENTORY_TAB = 'FC Inventory In Zepto';
const CHANNEL_NAME = 'VB EXPORT - Zepto';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a Date object to dd-mmm-yyyy (e.g. 09-Aug-2026).
 */
function formatSheetDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const mon = MONTH_NAMES[d.getMonth()];
  const yr = d.getFullYear();
  return `${day}-${mon}-${yr}`;
}

/**
 * Parses dd-mm-yyyy or yyyy-mm-dd or dd-mmm-yyyy to Date object.
 */
function parseAnyDate(str) {
  if (!str) return null;
  const s = String(str).trim();

  // dd-mm-yyyy e.g. 09-08-2026
  const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    return new Date(year, month, day);
  }

  // dd-mmm-yyyy e.g. 09-Aug-2026
  const dMmmMatch = s.match(/^(\d{1,2})[-/]([A-Za-z]{3,})[-/](\d{4})$/);
  if (dMmmMatch) {
    const day = parseInt(dMmmMatch[1], 10);
    const monStr = dMmmMatch[2].slice(0, 3).toLowerCase();
    const month = MONTH_NAMES.findIndex((m) => m.toLowerCase() === monStr);
    const year = parseInt(dMmmMatch[3], 10);
    if (month !== -1) return new Date(year, month, day);
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Google Sheets WEEKNUM type 1 (weeks start Sunday, Jan 1 is in week 1).
 */
function weekNum(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - jan1) / 86400000);
  return Math.floor((dayOfYear + jan1.getDay()) / 7) + 1;
}

/**
 * Cleans monetary string to float.
 */
function parseMoney(val) {
  if (val === undefined || val === null || val === '') return 0.0;
  const clean = String(val).replace(/,/g, '').replace(/₹/g, '').trim();
  const num = parseFloat(clean);
  return isNaN(num) ? 0.0 : Math.round(num * 100) / 100;
}

/**
 * Loads lookup mappings from the spreadsheet.
 */
async function loadLookups(sheets, sheetId, send = () => {}) {
  // Read EAN OMS Mapping, Zone Mapping, and Master Sheet-OMS in parallel
  const [eanRes, zoneRes, masterRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "'EAN OMS Mapping'!A1:Z5000" }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "'Zone Mapping'!A1:Z1000" }),
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "'Master Sheet-OMS'!A1:Z5000" }),
  ]);

  // 1. EAN Map (Header row 1, 0-indexed)
  const eanRows = eanRes.data.values || [];
  const eanHeaders = (eanRows[0] || []).map((h) => String(h || '').trim());
  const eanColIdx = eanHeaders.findIndex((h) => /ean/i.test(h));
  const skuColIdx = eanHeaders.findIndex((h) => /^sku$/i.test(h) || /seller\s*sku/i.test(h));
  const sizeColIdx = eanHeaders.findIndex((h) => /^size$/i.test(h));

  const eanMap = new Map();
  for (let i = 1; i < eanRows.length; i++) {
    const row = eanRows[i];
    const ean = String(row[eanColIdx] || '').trim();
    if (ean) {
      eanMap.set(ean, {
        sku: String(row[skuColIdx] || '').trim(),
        size: String(row[sizeColIdx] || '').trim(),
      });
    }
  }

  // 2. Zone Map (Header row 1, 0-indexed)
  const zoneRows = zoneRes.data.values || [];
  const zoneHeaders = (zoneRows[0] || []).map((h) => String(h || '').trim());
  const locColIdx = zoneHeaders.findIndex((h) => /location|city/i.test(h));
  const zoneColIdx = zoneHeaders.findIndex((h) => /^zone$/i.test(h));

  const zoneMap = new Map();
  for (let i = 1; i < zoneRows.length; i++) {
    const row = zoneRows[i];
    const loc = String(row[locColIdx] || '').trim().toLowerCase();
    if (loc) {
      zoneMap.set(loc, String(row[zoneColIdx] || '').trim());
    }
  }

  // 3. Master Sheet-OMS (Header row 3, 2-indexed)
  const masterRows = masterRes.data.values || [];
  const masterHeaderIdx = 2; // Row 3
  const masterHeaders = (masterRows[masterHeaderIdx] || []).map((h) => String(h || '').trim());
  const masterSkuIdx = masterHeaders.findIndex((h) => /^sku$/i.test(h));
  const catalogIdx = masterHeaders.findIndex((h) => /catalog\s*\+?color/i.test(h));

  const catalogMap = new Map();
  for (let i = masterHeaderIdx + 1; i < masterRows.length; i++) {
    const row = masterRows[i];
    const sku = String(row[masterSkuIdx] || '').trim();
    if (sku) {
      catalogMap.set(sku, String(row[catalogIdx] || '').trim());
    }
  }

  log(send, `[zepto.lookups] Loaded ${eanMap.size} EANs, ${zoneMap.size} zones, and ${catalogMap.size} master SKUs.`);
  return { eanMap, zoneMap, catalogMap };
}

/**
 * Returns a set of unique dates already recorded in column B of SALES DATA-Zepto.
 */
async function getExistingSalesDates(sheets, sheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${SALES_TAB}'!B3:B`,
  });

  const rows = res.data.values || [];
  const existing = new Set();
  for (const r of rows) {
    const cell = String(r[0] || '').trim();
    if (cell) {
      const parsed = parseAnyDate(cell);
      if (parsed) {
        existing.add(formatSheetDate(parsed));
      }
    }
  }
  return existing;
}

/**
 * Calculates missing dates in the last N days (default 10).
 */
async function getMissingSalesDates(sheets, sheetId, lookbackDays = 10, send = () => {}) {
  const existing = await getExistingSalesDates(sheets, sheetId);
  const today = new Date();
  const missing = [];

  for (let n = 1; n <= lookbackDays; n++) {
    const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
    const formatted = formatSheetDate(target);
    if (!existing.has(formatted)) {
      missing.push(target);
    }
  }

  missing.sort((a, b) => a - b);
  log(send, `[zepto.sheet] Found ${existing.size} recorded dates in sheet. Missing in last ${lookbackDays} days: ${missing.length ? missing.map(formatSheetDate).join(', ') : 'none'}`);
  return { missing, existing };
}

/**
 * Transforms raw Zepto Sales_F CSV text into destination sheet rows.
 */
function transformSalesCsv(csvText, lookups, send = () => {}) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!records.length) {
    return [];
  }

  const sample = records[0];
  const gsvKey = Object.keys(sample).find((k) => /gross\s*selling\s*value/i.test(k));
  if (!gsvKey) {
    throw new Error(`Sales_F CSV is missing Gross Selling Value column. Found: ${Object.keys(sample).join(', ')}`);
  }

  const { eanMap, zoneMap, catalogMap } = lookups;
  const transformed = [];

  for (const r of records) {
    const rawDate = r['Date'] || r['date'];
    const d = parseAnyDate(rawDate);
    if (!d) continue;

    const eanStr = String(r['EAN'] || r['ean'] || '').trim();
    const eanInfo = eanMap.get(eanStr) || { sku: '', size: '' };
    const city = String(r['City'] || r['city'] || '').trim();
    const zone = zoneMap.get(city.toLowerCase()) || '';
    const catalog = catalogMap.get(eanInfo.sku) || '';
    const qty = parseInt(r['Sales (Qty) - Units'] || r['Units'] || r['Qty'] || '0', 10);
    const saleVal = parseMoney(r[gsvKey]);

    transformed.push({
      dateObj: d,
      sheetDate: formatSheetDate(d),
      sku: eanInfo.sku,
      ean: parseInt(eanStr, 10) || eanStr,
      channel: CHANNEL_NAME,
      qty,
      saleValue: saleVal,
      catalog,
      size: eanInfo.size,
      city,
      zone,
      week: weekNum(d),
      monthNum: d.getMonth() + 1,
      year: d.getFullYear(),
    });
  }

  return transformed;
}

/**
 * Formats transformed rows with row-specific Excel/Google formulas for Month and Category.
 */
function buildSheetValues(rows, startRow) {
  return rows.map((r, idx) => {
    const rowNo = startRow + idx;
    return [
      `=TEXT(B${rowNo},"mm'yyyy")`,                // A: Month
      r.sheetDate,                                  // B: Date
      r.sku,                                        // C: Listing Sku Code
      r.ean,                                        // D: EAN
      r.channel,                                    // E: Channel Name
      `=VLOOKUP(C${rowNo},'EAN OMS Mapping'!B:D,3,0)`, // F: Category
      r.qty,                                        // G: Qty
      r.saleValue,                                  // H: Sale Value
      r.catalog,                                    // I: Catalog Name+Color
      r.size,                                       // J: Size
      r.city,                                       // K: City
      r.zone,                                       // L: Zone
      r.week,                                       // M: Week NUm
      r.monthNum,                                   // N: Month Num
      r.year,                                       // O: Year
    ];
  });
}

/**
 * Copies row formatting from srcRow to destRows.
 */
async function copyRowFormat(sheets, sheetId, tabId, srcRow, firstRow, lastRow, width = 15) {
  if (srcRow < 1 || lastRow < firstRow) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          copyPaste: {
            source: {
              sheetId: tabId,
              startRowIndex: srcRow - 1,
              endRowIndex: srcRow,
              startColumnIndex: 0,
              endColumnIndex: width,
            },
            destination: {
              sheetId: tabId,
              startRowIndex: firstRow - 1,
              endRowIndex: lastRow,
              startColumnIndex: 0,
              endColumnIndex: width,
            },
            pasteType: 'PASTE_FORMAT',
            pasteOrientation: 'NORMAL',
          },
        },
      ],
    },
  });
}

/**
 * Appends new sales rows into SALES DATA-Zepto, re-verifying against duplicates.
 */
async function appendSalesData(sheets, sheetId, transformedRows, send = () => {}) {
  if (!transformedRows || !transformedRows.length) {
    return { rowsAdded: 0, message: 'No rows to append.' };
  }

  // 1. Get sheet metadata (tab ID and current dimensions)
  const metaRes = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetMeta = metaRes.data.sheets.find((s) => s.properties.title === SALES_TAB);
  if (!sheetMeta) {
    throw new Error(`Tab '${SALES_TAB}' not found in spreadsheet.`);
  }
  const tabId = sheetMeta.properties.sheetId;

  // 2. Re-check live dates immediately before writing to guarantee zero duplicates
  const liveDates = await getExistingSalesDates(sheets, sheetId);
  const pending = transformedRows.filter((r) => !liveDates.has(r.sheetDate));

  if (!pending.length) {
    log(send, `[zepto.sheet] All ${transformedRows.length} rows already exist in '${SALES_TAB}'. Skipping write.`);
    return { rowsAdded: 0, message: 'All dates already present in sheet.' };
  }

  // 3. Find first empty row
  const currentValuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${SALES_TAB}'!A:B`,
  });
  const currentValues = currentValuesRes.data.values || [];
  const startRow = currentValues.length + 1;
  const endRow = startRow + pending.length - 1;

  log(send, `[zepto.sheet] Writing ${pending.length} rows into '${SALES_TAB}' (rows ${startRow}..${endRow})...`);

  // Ensure sheet has enough row capacity
  const maxRows = sheetMeta.properties.gridProperties.rowCount || 1000;
  if (endRow > maxRows) {
    const addCount = endRow - maxRows + 200;
    log(send, `[zepto.sheet] Expanding sheet capacity by ${addCount} rows...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: tabId,
              dimension: 'ROWS',
              length: addCount,
            },
          },
        ],
      },
    });
  }

  // 4. Build values with formulas
  const values = buildSheetValues(pending, startRow);

  // 5. Write values
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${SALES_TAB}'!A${startRow}:O${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  // 6. Copy row format down from row above
  if (startRow >= 4) {
    try {
      await copyRowFormat(sheets, sheetId, tabId, startRow - 1, startRow, endRow, 15);
      log(send, `[zepto.sheet] Copied table styling down to row ${endRow}.`);
    } catch (fmtErr) {
      warn(send, `[zepto.sheet] Could not copy format: ${fmtErr.message}`);
    }
  }

  const distinctDates = [...new Set(pending.map((r) => r.sheetDate))];
  log(send, `[zepto.sheet] Successfully appended ${pending.length} rows for dates: ${distinctDates.join(', ')}.`);
  return { rowsAdded: pending.length, datesAdded: distinctDates };
}

/**
 * Refreshes the FC Inventory In Zepto tab snapshot from Vendor Inventory_F CSV.
 */
async function refreshInventoryData(sheets, sheetId, csvText, onDate = new Date(), send = () => {}) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!records.length) {
    throw new Error('Refusing to clear inventory tab: Vendor Inventory_F report produced 0 rows.');
  }

  const metaRes = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetMeta = metaRes.data.sheets.find((s) => s.properties.title === INVENTORY_TAB);
  if (!sheetMeta) {
    throw new Error(`Tab '${INVENTORY_TAB}' not found in spreadsheet.`);
  }
  const tabId = sheetMeta.properties.sheetId;

  const FIRST_DATA_ROW = 3;
  const dateStr = formatSheetDate(onDate);

  // Build rows: A..F
  const rows = records.map((r, offset) => {
    const rowNo = FIRST_DATA_ROW + offset;
    const city = String(r['City'] || r['city'] || '').trim();
    const units = parseInt(r['Units'] || r['units'] || r['Qty'] || '0', 10);
    const ean = parseInt(String(r['EAN'] || r['ean'] || '').trim(), 10) || String(r['EAN'] || '');

    return [
      `=XLOOKUP(F${rowNo},'EAN OMS Mapping'!A:A,'EAN OMS Mapping'!B:B,1,0)`, // A: Seller SKU Code
      city,                                                                 // B: City
      `=VLOOKUP(B${rowNo},'Zone Mapping'!A:B,2,0)`,                         // C: Zone
      units,                                                                // D: qty
      dateStr,                                                              // E: date
      ean,                                                                  // F: EAN
    ];
  });

  const totalUnits = rows.reduce((sum, r) => sum + (typeof r[3] === 'number' ? r[3] : 0), 0);
  log(send, `[zepto.inv] Built ${rows.length} inventory snapshot rows (dated ${dateStr}). Total units: ${totalUnits.toLocaleString('en-IN')}`);

  // Find previous data depth
  const currentRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${INVENTORY_TAB}'!A3:F`,
  });
  const oldRowCount = (currentRes.data.values || []).length;
  const oldLastRow = Math.max(FIRST_DATA_ROW - 1 + oldRowCount, FIRST_DATA_ROW);
  const newLastRow = FIRST_DATA_ROW + rows.length - 1;

  // Ensure capacity
  const maxRows = sheetMeta.properties.gridProperties.rowCount || 1000;
  if (newLastRow > maxRows) {
    const addCount = newLastRow - maxRows + 200;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: tabId,
              dimension: 'ROWS',
              length: addCount,
            },
          },
        ],
      },
    });
  }

  // Clear stale range
  const clearRange = `'${INVENTORY_TAB}'!A${FIRST_DATA_ROW}:F${Math.max(oldLastRow, newLastRow)}`;
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: clearRange,
  });

  // Write new rows
  const writeRange = `'${INVENTORY_TAB}'!A${FIRST_DATA_ROW}:F${newLastRow}`;
  log(send, `[zepto.inv] Writing ${rows.length} rows into ${writeRange}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: writeRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  log(send, `[zepto.inv] Successfully refreshed '${INVENTORY_TAB}'. Total units: ${totalUnits}`);
  return { rowsWritten: rows.length, totalUnits, date: dateStr };
}

module.exports = {
  loadLookups,
  getExistingSalesDates,
  getMissingSalesDates,
  transformSalesCsv,
  appendSalesData,
  refreshInventoryData,
  formatSheetDate,
  parseAnyDate,
};
