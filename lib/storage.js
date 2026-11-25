const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DECKS_DIR = path.join(DATA_DIR, 'decks');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');

const DEFAULT_BACKGROUND_URL = '/assets/default-master-bg.svg';

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, DECKS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createEmptyLibrary() {
  return {
    activeBackgroundId: null,
    backgrounds: [],
    images: [],
    videos: [],
    audios: [],
    decks: [],
  };
}

function loadLibrary() {
  ensureDirs();
  if (!fs.existsSync(LIBRARY_FILE)) {
    const empty = createEmptyLibrary();
    saveLibrary(empty);
    return empty;
  }
  try {
    const raw = fs.readFileSync(LIBRARY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...createEmptyLibrary(),
      ...parsed,
    };
  } catch (err) {
    console.error('[storage] Failed to parse library.json, resetting:', err.message);
    const empty = createEmptyLibrary();
    saveLibrary(empty);
    return empty;
  }
}

function saveLibrary(library) {
  ensureDirs();
  const tmpPath = `${LIBRARY_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(library, null, 2), 'utf8');
  fs.renameSync(tmpPath, LIBRARY_FILE);
}

function getActiveBackgroundUrl(library) {
  if (library.activeBackgroundId) {
    const found = library.backgrounds.find((b) => b.id === library.activeBackgroundId);
    if (found) return found.url;
  }
  if (library.backgrounds.length > 0) {
    return library.backgrounds[0].url;
  }
  return DEFAULT_BACKGROUND_URL;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    const resolved = path.resolve(filePath);
    const dataRoot = path.resolve(DATA_DIR);
    if (!resolved.startsWith(dataRoot)) return;
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
    }
  } catch (err) {
    console.warn('[storage] Could not delete path:', filePath, err.message);
  }
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  DECKS_DIR,
  DEFAULT_BACKGROUND_URL,
  ensureDirs,
  loadLibrary,
  saveLibrary,
  getActiveBackgroundUrl,
  safeUnlink,
};
