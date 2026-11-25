/**
 * Persistent browser IndexedDB storage for Media Library metadata and binary Blobs.
 */

const DB_NAME = 'StageMediaControllerDB_v1';
const DB_VERSION = 1;

let dbPromise = null;
const objectUrlCache = new Map();

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export function createEmptyLibrary() {
  return {
    activeBackgroundId: null,
    backgrounds: [],
    images: [],
    videos: [],
    audios: [],
    decks: [],
  };
}

export async function loadLibrary() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get('library');
    req.onsuccess = () => {
      resolve({
        ...createEmptyLibrary(),
        ...(req.result?.value || {}),
      });
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveLibrary(library) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'library', value: library });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putBlob(id, blob) {
  const db = await openDb();
  const prevUrl = objectUrlCache.get(id);
  if (prevUrl) {
    URL.revokeObjectURL(prevUrl);
    objectUrlCache.delete(id);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({
      id,
      blob,
      mimeType: blob.type || 'application/octet-stream',
      createdAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => reject(req.error);
  });
}

export async function hasBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').count(id);
    req.onsuccess = () => resolve((req.result || 0) > 0);
    req.onerror = () => reject(req.error);
  });
}

export async function listBlobIds() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBlob(id) {
  const prevUrl = objectUrlCache.get(id);
  if (prevUrl) {
    URL.revokeObjectURL(prevUrl);
    objectUrlCache.delete(id);
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getObjectUrl(id) {
  if (!id) return null;
  if (objectUrlCache.has(id)) return objectUrlCache.get(id);
  const blob = await getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(id, url);
  return url;
}

export function makeId(prefix = 'item') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
