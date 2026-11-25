const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const { getLanAddresses, getPrimaryLanIp, generateQrDataUrl } = require('./lib/network');
const {
  DATA_DIR,
  UPLOADS_DIR,
  DECKS_DIR,
  ensureDirs,
  loadLibrary,
  saveLibrary,
  getActiveBackgroundUrl,
  safeUnlink,
} = require('./lib/storage');
const { detectTools, processPresentationUpload } = require('./lib/converter');

ensureDirs();

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024,
});

app.use(express.json({ limit: '50mb' }));

// Static app files & locally bundled vendor scripts (100% offline ready)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));
app.use('/media/decks', express.static(DECKS_DIR, { maxAge: '1d' }));
app.use(
  '/vendor/pdfjs',
  express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '7d' })
);

// Fix Hebrew/UTF-8 filenames uploaded via multipart/form-data
function decodeOriginalName(rawName) {
  if (!rawName) return 'untitled';
  try {
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
    // Use decoded if it looks valid and has no replacement characters
    if (decoded && !decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return rawName;
}

function makeId(prefix = 'item') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function makeSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

// Multer storage
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const original = decodeOriginalName(file.originalname);
    const ext = path.extname(original).toLowerCase() || '';
    const safeExt = ext.replace(/[^a-z0-9.]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB max (for HD lesson videos)
    files: 200,
  },
});

// Shared library state (persisted on disk)
let library = loadLibrary();
const conversionTools = detectTools();

// In-memory active presentation sessions
const sessions = new Map();

function createSessionState(sessionId) {
  return {
    sessionId,
    showQr: true,
    stageConnected: false,
    stageAudioUnlocked: false,
    remoteCount: 0,
    masterBackgroundUrl: getActiveBackgroundUrl(library),
    visual: {
      type: 'idle', // 'idle' | 'image' | 'video' | 'deck'
      itemId: null,
      title: '',
      url: null,
      slideIndex: 0,
      slideCount: 0,
      pdfUrl: null,
      playing: false,
      currentTime: 0,
      duration: 0,
      muted: false,
      volume: 1,
      commandSeq: 0,
      seekSeq: 0,
      seekTo: 0,
    },
    audio: {
      itemId: null,
      title: '',
      url: null,
      playing: false,
      volume: 0.75,
      loop: true,
      currentTime: 0,
      duration: 0,
      fadingOut: false,
      commandSeq: 0,
      seekSeq: 0,
      seekTo: 0,
    },
  };
}

function getOrCreateSession(rawId) {
  const sessionId = String(rawId || makeSessionCode())
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 16) || makeSessionCode();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSessionState(sessionId));
  }
  const s = sessions.get(sessionId);
  s.masterBackgroundUrl = getActiveBackgroundUrl(library);
  return s;
}

function broadcastState(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return;
  io.to(`session:${sessionId}`).emit('state:sync', state);
}

function broadcastLibraryToAll() {
  const bgUrl = getActiveBackgroundUrl(library);
  const payload = {
    ...library,
    activeBackgroundUrl: bgUrl,
  };
  io.emit('library:updated', payload);

  for (const [sessionId, state] of sessions.entries()) {
    state.masterBackgroundUrl = bgUrl;
    // Refresh live deck slide URLs if a PDF just finished rendering
    if (state.visual.type === 'deck' && state.visual.itemId) {
      const deck = library.decks.find((d) => d.id === state.visual.itemId);
      if (deck) {
        const idx = Math.max(0, Math.min(state.visual.slideIndex, Math.max(0, deck.slides.length - 1)));
        state.visual.slideIndex = idx;
        state.visual.slideCount = deck.slides.length;
        state.visual.url = deck.slides[idx]?.url || null;
        state.visual.pdfUrl = deck.pdfUrl || null;
      }
    }
    broadcastState(sessionId);
  }
}

function updateRoomCounts(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return;
  const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
  let stageConnected = false;
  let remoteCount = 0;

  if (room) {
    for (const socketId of room) {
      const sock = io.sockets.sockets.get(socketId);
      if (!sock) continue;
      if (sock.data.role === 'stage') stageConnected = true;
      if (sock.data.role === 'remote') remoteCount++;
    }
  }

  state.stageConnected = stageConnected;
  state.remoteCount = remoteCount;
  if (!stageConnected) {
    state.stageAudioUnlocked = false;
  }
  broadcastState(sessionId);
}

// --- Page Routes ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stage.html'));
});

app.get('/stage', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stage.html'));
});

app.get('/remote', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'remote.html'));
});

// --- REST API ---
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    lanIp: getPrimaryLanIp(),
    interfaces: getLanAddresses(),
    tools: {
      libreoffice: Boolean(conversionTools.soffice),
      poppler: Boolean(conversionTools.pdftoppm),
    },
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    const session = getOrCreateSession(req.query.session);
    const lanIp = req.query.host ? String(req.query.host).trim() : getPrimaryLanIp();
    const remoteUrl = `http://${lanIp}:${PORT}/remote?session=${encodeURIComponent(session.sessionId)}`;
    const qrDataUrl = await generateQrDataUrl(remoteUrl);
    res.json({
      sessionId: session.sessionId,
      url: remoteUrl,
      shortUrl: `${lanIp}:${PORT}/remote`,
      qrDataUrl,
      lanIp,
      port: PORT,
      interfaces: getLanAddresses(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/library', (_req, res) => {
  res.json({
    ...library,
    activeBackgroundUrl: getActiveBackgroundUrl(library),
  });
});

// Upload Master Background
app.post('/api/upload/background', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ תמונה' });
  const title = (req.body.title || '').trim() || path.parse(decodeOriginalName(req.file.originalname)).name;
  const item = {
    id: makeId('bg'),
    title,
    url: `/media/uploads/${req.file.filename}`,
    filePath: req.file.path,
    createdAt: Date.now(),
  };
  library.backgrounds.unshift(item);
  library.activeBackgroundId = item.id;
  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ item, activeBackgroundUrl: getActiveBackgroundUrl(library) });
});

app.post('/api/backgrounds/:id/activate', (req, res) => {
  const { id } = req.params;
  if (id === 'default') {
    library.activeBackgroundId = null;
  } else {
    const found = library.backgrounds.find((b) => b.id === id);
    if (!found) return res.status(404).json({ error: 'רקע לא נמצא' });
    library.activeBackgroundId = found.id;
  }
  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ ok: true, activeBackgroundUrl: getActiveBackgroundUrl(library) });
});

// Upload Full-Screen Image(s)
app.post('/api/upload/image', upload.array('files', 50), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'לא נבחרו קבצי תמונה' });

  const created = [];
  for (const file of files) {
    const original = decodeOriginalName(file.originalname);
    const title =
      files.length === 1 && req.body.title
        ? String(req.body.title).trim()
        : path.parse(original).name;
    const item = {
      id: makeId('img'),
      title,
      url: `/media/uploads/${file.filename}`,
      filePath: file.path,
      createdAt: Date.now(),
    };
    library.images.unshift(item);
    created.push(item);
  }
  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ items: created });
});

// Upload Video
app.post('/api/upload/video', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ וידאו' });
  const original = decodeOriginalName(req.file.originalname);
  const title = (req.body.title || '').trim() || path.parse(original).name;
  const item = {
    id: makeId('vid'),
    title,
    url: `/media/uploads/${req.file.filename}`,
    filePath: req.file.path,
    mimeType: req.file.mimetype,
    size: req.file.size,
    createdAt: Date.now(),
  };
  library.videos.unshift(item);
  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ item });
});

// Upload Audio / Background Music
app.post('/api/upload/audio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ שמע' });
  const original = decodeOriginalName(req.file.originalname);
  const title = (req.body.title || '').trim() || path.parse(original).name;
  const item = {
    id: makeId('aud'),
    title,
    url: `/media/uploads/${req.file.filename}`,
    filePath: req.file.path,
    mimeType: req.file.mimetype,
    size: req.file.size,
    createdAt: Date.now(),
  };
  library.audios.unshift(item);
  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ item });
});

// Upload Presentation Deck (.pptx, .pdf, or multiple images)
app.post('/api/upload/deck', upload.array('files', 200), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'לא נבחרו קבצים למצגת' });

  try {
    const deckId = makeId('deck');
    const firstName = decodeOriginalName(files[0].originalname);
    const firstExt = path.extname(firstName).toLowerCase();
    const customTitle = (req.body.title || '').trim();

    // Case 1: Single .pptx / .ppt / .pdf file
    if (files.length === 1 && ['.pptx', '.ppt', '.pdf'].includes(firstExt)) {
      const file = files[0];
      const result = await processPresentationUpload({
        filePath: file.path,
        originalName: firstName,
        deckId,
        decksDir: DECKS_DIR,
        uploadedUrl: `/media/uploads/${file.filename}`,
      });

      const deck = {
        id: deckId,
        title: customTitle || path.parse(firstName).name,
        sourceType: firstExt.replace('.', ''),
        method: result.method,
        needsClientRender: Boolean(result.needsClientRender),
        pdfUrl: result.pdfUrl || null,
        slides: result.slides || [],
        sourceFilePath: file.path,
        deckDir: path.join(DECKS_DIR, deckId),
        createdAt: Date.now(),
      };

      library.decks.unshift(deck);
      saveLibrary(library);
      broadcastLibraryToAll();
      return res.json({ deck });
    }

    // Case 2: Multiple images uploaded as a slide deck
    const imageFiles = files
      .map((file) => ({ file, original: decodeOriginalName(file.originalname) }))
      .sort((a, b) => a.original.localeCompare(b.original, undefined, { numeric: true }));

    const slides = imageFiles.map(({ file }, index) => ({
      index,
      url: `/media/uploads/${file.filename}`,
      filePath: file.path,
    }));

    const deck = {
      id: deckId,
      title: customTitle || `מצגת תמונות (${slides.length} שקפים)`,
      sourceType: 'images',
      method: 'image-deck',
      needsClientRender: false,
      pdfUrl: null,
      slides,
      createdAt: Date.now(),
    };

    library.decks.unshift(deck);
    saveLibrary(library);
    broadcastLibraryToAll();
    res.json({ deck });
  } catch (err) {
    console.error('[upload/deck] Conversion error:', err);
    res.status(500).json({ error: err.message || 'שגיאה בעיבוד המצגת' });
  }
});

// Save pre-rendered slide images produced by client-side pdf.js fallback
app.post('/api/decks/:id/rendered-slides', (req, res) => {
  const deck = library.decks.find((d) => d.id === req.params.id);
  if (!deck) return res.status(404).json({ error: 'מצגת לא נמצאה' });

  const { slides } = req.body || {};
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: 'לא התקבלו שקפים מרונדרים' });
  }

  try {
    const outDir = path.join(DECKS_DIR, deck.id);
    fs.mkdirSync(outDir, { recursive: true });

    const savedSlides = [];
    for (let i = 0; i < slides.length; i++) {
      const dataUrl = String(slides[i] || '');
      const match = dataUrl.match(/^data:image\/(png|webp|jpeg);base64,(.+)$/);
      if (!match) continue;
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const fileName = `slide-${String(i + 1).padStart(3, '0')}.${ext}`;
      fs.writeFileSync(path.join(outDir, fileName), buffer);
      savedSlides.push({
        index: savedSlides.length,
        url: `/media/decks/${deck.id}/${fileName}`,
      });
    }

    if (savedSlides.length === 0) {
      return res.status(400).json({ error: 'תמונות השקפים לא תקינות' });
    }

    deck.slides = savedSlides;
    deck.needsClientRender = false;
    deck.method = deck.method === 'libreoffice-pdf-client-render'
      ? 'libreoffice+pdfjs-cached'
      : 'pdfjs-cached-images';
    deck.deckDir = outDir;

    saveLibrary(library);
    broadcastLibraryToAll();
    res.json({ deck });
  } catch (err) {
    console.error('[rendered-slides] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete media item
app.delete('/api/library/:category/:id', (req, res) => {
  const { category, id } = req.params;
  const allowed = ['backgrounds', 'images', 'videos', 'audios', 'decks'];
  if (!allowed.includes(category)) {
    return res.status(400).json({ error: 'קטגוריה לא תקינה' });
  }

  const list = library[category];
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'הפריט לא נמצא' });

  const [removed] = list.splice(idx, 1);

  if (removed.filePath) safeUnlink(removed.filePath);
  if (removed.sourceFilePath) safeUnlink(removed.sourceFilePath);
  if (removed.deckDir) safeUnlink(removed.deckDir);
  if (Array.isArray(removed.slides)) {
    for (const s of removed.slides) {
      if (s.filePath) safeUnlink(s.filePath);
    }
  }

  if (category === 'backgrounds' && library.activeBackgroundId === id) {
    library.activeBackgroundId = library.backgrounds[0]?.id || null;
  }

  // If currently live on any session, clear cleanly
  for (const [sessionId, state] of sessions.entries()) {
    let changed = false;
    if (state.visual.itemId === id) {
      state.visual = {
        ...createSessionState(sessionId).visual,
        commandSeq: state.visual.commandSeq + 1,
      };
      changed = true;
    }
    if (state.audio.itemId === id) {
      state.audio = {
        ...createSessionState(sessionId).audio,
        commandSeq: state.audio.commandSeq + 1,
      };
      changed = true;
    }
    if (changed) broadcastState(sessionId);
  }

  saveLibrary(library);
  broadcastLibraryToAll();
  res.json({ ok: true });
});

// --- Socket.io Real-Time Sync ---
io.on('connection', (socket) => {
  socket.on('session:join', ({ sessionId, role }) => {
    const cleanRole = role === 'stage' ? 'stage' : 'remote';
    const session = getOrCreateSession(sessionId);

    // Leave previous session room if any
    if (socket.data.sessionId && socket.data.sessionId !== session.sessionId) {
      socket.leave(`session:${socket.data.sessionId}`);
      updateRoomCounts(socket.data.sessionId);
    }

    socket.data.sessionId = session.sessionId;
    socket.data.role = cleanRole;
    socket.join(`session:${session.sessionId}`);

    socket.emit('library:updated', {
      ...library,
      activeBackgroundUrl: getActiveBackgroundUrl(library),
    });

    updateRoomCounts(session.sessionId);
  });

  // Toggle QR code visibility on Stage Display
  socket.on('remote:toggle-qr', ({ showQr } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.showQr = typeof showQr === 'boolean' ? showQr : !state.showQr;
    broadcastState(sessionId);
  });

  // Go Live with Image, Video, or Deck Slide
  socket.on('remote:go-live', ({ type, itemId, slideIndex = 0 } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);

    if (type === 'image') {
      const img = library.images.find((i) => i.id === itemId);
      if (!img) return;
      state.visual = {
        ...createSessionState(sessionId).visual,
        type: 'image',
        itemId: img.id,
        title: img.title,
        url: img.url,
        commandSeq: state.visual.commandSeq + 1,
      };
      broadcastState(sessionId);
      return;
    }

    if (type === 'video') {
      const vid = library.videos.find((v) => v.id === itemId);
      if (!vid) return;
      state.visual = {
        ...createSessionState(sessionId).visual,
        type: 'video',
        itemId: vid.id,
        title: vid.title,
        url: vid.url,
        playing: true,
        currentTime: 0,
        duration: 0,
        muted: false,
        volume: 1,
        commandSeq: state.visual.commandSeq + 1,
      };
      broadcastState(sessionId);
      return;
    }

    if (type === 'deck') {
      const deck = library.decks.find((d) => d.id === itemId);
      if (!deck) return;
      const total = deck.slides.length;
      const clampedIdx = total > 0 ? Math.max(0, Math.min(Number(slideIndex) || 0, total - 1)) : Math.max(0, Number(slideIndex) || 0);
      state.visual = {
        ...createSessionState(sessionId).visual,
        type: 'deck',
        itemId: deck.id,
        title: deck.title,
        url: deck.slides[clampedIdx]?.url || null,
        pdfUrl: deck.pdfUrl || null,
        slideIndex: clampedIdx,
        slideCount: total,
        commandSeq: state.visual.commandSeq + 1,
      };
      broadcastState(sessionId);
    }
  });

  // Instant Next / Previous / Jump Slide on Live Deck
  socket.on('remote:slide-step', ({ delta = 0, slideIndex } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    if (state.visual.type !== 'deck' || !state.visual.itemId) return;

    const deck = library.decks.find((d) => d.id === state.visual.itemId);
    if (!deck) return;

    const total = deck.slides.length || state.visual.slideCount || 1;
    const targetIdx =
      typeof slideIndex === 'number'
        ? slideIndex
        : state.visual.slideIndex + Number(delta || 0);
    const clamped = Math.max(0, Math.min(targetIdx, total - 1));

    state.visual.slideIndex = clamped;
    state.visual.slideCount = total;
    state.visual.url = deck.slides[clamped]?.url || null;
    state.visual.commandSeq += 1;
    broadcastState(sessionId);
  });

  // Clear Visual -> Return smoothly to Master Background
  socket.on('remote:clear-visual', () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.visual = {
      ...createSessionState(sessionId).visual,
      commandSeq: state.visual.commandSeq + 1,
    };
    broadcastState(sessionId);
  });

  // Video Controls (Play, Pause, Seek, Restart, Volume, Mute)
  socket.on('remote:video-control', ({ action, value } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    if (state.visual.type !== 'video') return;

    switch (action) {
      case 'play':
        state.visual.playing = true;
        break;
      case 'pause':
        state.visual.playing = false;
        break;
      case 'toggle':
        state.visual.playing = !state.visual.playing;
        break;
      case 'restart':
        state.visual.playing = true;
        state.visual.currentTime = 0;
        state.visual.seekTo = 0;
        state.visual.seekSeq += 1;
        break;
      case 'seek':
        if (typeof value === 'number' && Number.isFinite(value)) {
          state.visual.currentTime = Math.max(0, value);
          state.visual.seekTo = Math.max(0, value);
          state.visual.seekSeq += 1;
        }
        break;
      case 'volume':
        if (typeof value === 'number') {
          state.visual.volume = Math.max(0, Math.min(1, value));
        }
        break;
      case 'mute':
        state.visual.muted = typeof value === 'boolean' ? value : !state.visual.muted;
        break;
      default:
        return;
    }

    state.visual.commandSeq += 1;
    broadcastState(sessionId);
  });

  // Independent Background Audio Controls
  socket.on('remote:audio-control', ({ action, itemId, value } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);

    switch (action) {
      case 'play-track': {
        const track = library.audios.find((a) => a.id === itemId);
        if (!track) return;
        state.audio = {
          ...state.audio,
          itemId: track.id,
          title: track.title,
          url: track.url,
          playing: true,
          currentTime: 0,
          duration: 0,
          fadingOut: false,
          commandSeq: state.audio.commandSeq + 1,
        };
        break;
      }
      case 'play':
        if (!state.audio.url) return;
        state.audio.playing = true;
        state.audio.fadingOut = false;
        state.audio.commandSeq += 1;
        break;
      case 'pause':
        state.audio.playing = false;
        state.audio.fadingOut = false;
        state.audio.commandSeq += 1;
        break;
      case 'toggle':
        if (!state.audio.url) return;
        state.audio.playing = !state.audio.playing;
        state.audio.fadingOut = false;
        state.audio.commandSeq += 1;
        break;
      case 'stop':
        state.audio = {
          ...state.audio,
          playing: false,
          currentTime: 0,
          fadingOut: false,
          commandSeq: state.audio.commandSeq + 1,
        };
        break;
      case 'fade-out':
        if (!state.audio.playing) return;
        state.audio.fadingOut = true;
        state.audio.commandSeq += 1;
        break;
      case 'volume':
        if (typeof value === 'number') {
          state.audio.volume = Math.max(0, Math.min(1, value));
          state.audio.fadingOut = false;
        }
        break;
      case 'loop':
        state.audio.loop = typeof value === 'boolean' ? value : !state.audio.loop;
        break;
      case 'seek':
        if (typeof value === 'number' && Number.isFinite(value)) {
          state.audio.currentTime = Math.max(0, value);
          state.audio.seekTo = Math.max(0, value);
          state.audio.seekSeq += 1;
        }
        break;
      default:
        return;
    }

    broadcastState(sessionId);
  });

  // --- Stage Telemetry -> Remote ---
  socket.on('stage:audio-unlocked', ({ unlocked = true } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.stageAudioUnlocked = Boolean(unlocked);
    broadcastState(sessionId);
  });

  socket.on('stage:video-progress', ({ currentTime, duration, playing } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    if (state.visual.type !== 'video') return;
    state.visual.currentTime = Number(currentTime) || 0;
    state.visual.duration = Number(duration) || 0;
    if (typeof playing === 'boolean') state.visual.playing = playing;
    socket.to(`session:${sessionId}`).emit('stage:video-progress', {
      currentTime: state.visual.currentTime,
      duration: state.visual.duration,
      playing: state.visual.playing,
    });
  });

  socket.on('stage:video-ended', () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    if (state.visual.type !== 'video') return;
    // Automatically return Stage Display to Master Background when video finishes
    state.visual = {
      ...createSessionState(sessionId).visual,
      commandSeq: state.visual.commandSeq + 1,
    };
    broadcastState(sessionId);
  });

  socket.on('stage:audio-progress', ({ currentTime, duration, playing } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.audio.currentTime = Number(currentTime) || 0;
    state.audio.duration = Number(duration) || 0;
    if (typeof playing === 'boolean') state.audio.playing = playing;
    socket.to(`session:${sessionId}`).emit('stage:audio-progress', {
      currentTime: state.audio.currentTime,
      duration: state.audio.duration,
      playing: state.audio.playing,
    });
  });

  socket.on('stage:audio-ended', () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.audio.playing = false;
    state.audio.fadingOut = false;
    state.audio.currentTime = 0;
    broadcastState(sessionId);
  });

  socket.on('stage:fade-out-done', () => {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return;
    const state = sessions.get(sessionId);
    state.audio.playing = false;
    state.audio.fadingOut = false;
    state.audio.currentTime = 0;
    broadcastState(sessionId);
  });

  socket.on('disconnect', () => {
    const sessionId = socket.data.sessionId;
    if (sessionId) {
      updateRoomCounts(sessionId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getPrimaryLanIp();
  console.log('');
  console.log('==============================================================');
  console.log('  Stage Presentation & Media Controller is running!');
  console.log('==============================================================');
  console.log(`  Stage Display (PC / Projector):  http://localhost:${PORT}/stage`);
  console.log(`  Mobile Remote (Same Wi-Fi):      http://${lanIp}:${PORT}/remote`);
  console.log(`  Conversion tools:                LibreOffice=${conversionTools.soffice ? 'YES' : 'NO (built-in SVG fallback)'} | Poppler=${conversionTools.pdftoppm ? 'YES' : 'NO (built-in PDF.js fallback)'}`);
  console.log('==============================================================');
  console.log('');
});
