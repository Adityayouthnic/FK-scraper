/**
 * Unmapped Items Store & Health Tracker
 *
 * Tracks EANs and Cities discovered during sync runs that do not exist in
 * Google Sheets reference tabs ('EAN OMS Mapping' and 'Zone Mapping').
 * Automatically reconciles and marks them resolved once added to the sheet.
 */

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'unmapped_lookups.json');

let storeCache = null;

function loadStore() {
  if (storeCache) return storeCache;
  try {
    if (fs.existsSync(STORE_FILE)) {
      storeCache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[unmappedStore] Could not read store file:', err.message);
  }

  if (!storeCache) {
    storeCache = {
      unmappedEans: [],
      unmappedCities: [],
      lastUpdated: new Date().toISOString(),
    };
  }
  return storeCache;
}

function saveStore() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    storeCache.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STORE_FILE, JSON.stringify(storeCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[unmappedStore] Could not save store file:', err.message);
  }
}

/**
 * Records newly discovered unmapped EANs and Cities.
 */
function recordUnmapped({ eans = [], cities = [] }) {
  const store = loadStore();
  const now = new Date().toISOString();

  for (const ean of eans) {
    const strEan = String(ean).trim();
    if (!strEan) continue;
    const existing = store.unmappedEans.find((item) => item.value === strEan);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = now;
      existing.resolved = false;
    } else {
      store.unmappedEans.push({
        value: strEan,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        resolved: false,
      });
    }
  }

  for (const city of cities) {
    const strCity = String(city).trim();
    if (!strCity) continue;
    const existing = store.unmappedCities.find((item) => item.value.toLowerCase() === strCity.toLowerCase());
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = now;
      existing.resolved = false;
    } else {
      store.unmappedCities.push({
        value: strCity,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        resolved: false,
      });
    }
  }

  saveStore();
}

/**
 * Automatically reconciles unmapped items against current live lookups.
 * If an item now exists in the sheet lookups, mark it resolved.
 */
function reconcileWithLookups(lookups) {
  if (!lookups) return;
  const store = loadStore();
  const { eanMap, zoneMap } = lookups;

  let changed = false;

  for (const item of store.unmappedEans) {
    if (!item.resolved && eanMap && eanMap.has(item.value)) {
      item.resolved = true;
      item.resolvedAt = new Date().toISOString();
      changed = true;
    }
  }

  for (const item of store.unmappedCities) {
    if (!item.resolved && zoneMap && zoneMap.has(item.value.toLowerCase())) {
      item.resolved = true;
      item.resolvedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) saveStore();
}

/**
 * Returns unresolved unmapped lookups.
 */
function getUnmappedReport() {
  const store = loadStore();
  const unresolvedEans = store.unmappedEans.filter((i) => !i.resolved);
  const unresolvedCities = store.unmappedCities.filter((i) => !i.resolved);

  return {
    totalUnresolved: unresolvedEans.length + unresolvedCities.length,
    unmappedEans: unresolvedEans,
    unmappedCities: unresolvedCities,
    resolvedEansCount: store.unmappedEans.filter((i) => i.resolved).length,
    resolvedCitiesCount: store.unmappedCities.filter((i) => i.resolved).length,
    lastUpdated: store.lastUpdated,
  };
}

module.exports = {
  recordUnmapped,
  reconcileWithLookups,
  getUnmappedReport,
};
