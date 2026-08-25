/**
 * Plain {y, m, d} calendar-date helpers, always anchored to IST.
 *
 * The whole pipeline (Flipkart's own "Yesterday" preset, the browser
 * context's timezone, the sheet's date column) is India-centric, but a
 * Cloud Run container's system clock is UTC — computing "today"/"yesterday"
 * from a plain `new Date()` there could land on the wrong calendar day near
 * the IST midnight boundary. Everything here goes through Asia/Kolkata
 * explicitly instead of relying on the container's local timezone.
 */

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ABBRS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function todayIST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
}

// Arithmetic on a pure calendar date via a UTC-anchored JS Date (safe: no
// DST in India, and UTC anchoring means no local-timezone drift either).
function toUtcDate({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(date) {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function addDays(date, n) {
  const dt = toUtcDate(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtcDate(dt);
}

function dateKey({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function compareDate(a, b) {
  return dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : 0;
}

function monthOrdinal(date) {
  return date.y * 12 + date.m;
}

function formatDMonY(date) {
  return `${String(date.d).padStart(2, '0')}-${MONTH_ABBRS[date.m]}-${date.y}`;
}

// Tolerantly parses the date formats that show up in the sheet / CSV:
// "25-Aug-2026", "25-08-2026", "25/08/2026", "2026-08-25".
function parseDateLoose(value) {
  const v = (value || '').trim();
  if (!v) return null;

  let m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mi = MONTH_ABBRS.findIndex((a) => a.toLowerCase() === m[2].toLowerCase());
    if (mi > 0) return { y: Number(m[3]), m: mi, d: Number(m[1]) };
  }

  m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) };

  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) };

  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };

  return null;
}

module.exports = {
  MONTH_NAMES,
  MONTH_ABBRS,
  todayIST,
  addDays,
  dateKey,
  compareDate,
  monthOrdinal,
  formatDMonY,
  parseDateLoose,
};
