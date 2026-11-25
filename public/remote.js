import { renderAndCachePdfDeck } from '/shared/pdf-renderer.js';

const socket = io();

// DOM references
const connDot = document.getElementById('connDot');
const connSubtitle = document.getElementById('connSubtitle');
const sessionBadge = document.getElementById('sessionBadge');
const qrToggleBtn = document.getElementById('qrToggleBtn');
const qrToggleLabel = document.getElementById('qrToggleLabel');
const pairPrompt = document.getElementById('pairPrompt');
const pairForm = document.getElementById('pairForm');
const pairCodeInput = document.getElementById('pairCodeInput');
const controllerMain = document.getElementById('controllerMain');
const stageUnlockWarn = document.getElementById('stageUnlockWarn');

// Live program DOM
const liveCard = document.querySelector('.live-card');
const liveBadge = document.getElementById('liveBadge');
const liveTitle = document.getElementById('liveTitle');
const clearToBgBtn = document.getElementById('clearToBgBtn');
const liveDeckControls = document.getElementById('liveDeckControls');
const liveSlideCounter = document.getElementById('liveSlideCounter');
const livePrevSlideBtn = document.getElementById('livePrevSlideBtn');
const liveNextSlideBtn = document.getElementById('liveNextSlideBtn');
const liveVideoControls = document.getElementById('liveVideoControls');
const videoTimeCurrent = document.getElementById('videoTimeCurrent');
const videoTimeDuration = document.getElementById('videoTimeDuration');
const videoSeekSlider = document.getElementById('videoSeekSlider');
const videoPlayPauseBtn = document.getElementById('videoPlayPauseBtn');
const videoRestartBtn = document.getElementById('videoRestartBtn');
const videoMuteBtn = document.getElementById('videoMuteBtn');

// Preview DOM
const previewPanel = document.getElementById('previewPanel');
const previewTitle = document.getElementById('previewTitle');
const closePreviewBtn = document.getElementById('closePreviewBtn');
const previewStageBox = document.getElementById('previewStageBox');
const previewImage = document.getElementById('previewImage');
const previewVideo = document.getElementById('previewVideo');
const previewLoader = document.getElementById('previewLoader');
const previewLoaderText = document.getElementById('previewLoaderText');
const previewSlideIndicator = document.getElementById('previewSlideIndicator');
const previewIsLiveTag = document.getElementById('previewIsLiveTag');
const previewDeckTools = document.getElementById('previewDeckTools');
const previewPrevBtn = document.getElementById('previewPrevBtn');
const previewNextBtn = document.getElementById('previewNextBtn');
const previewThumbStrip = document.getElementById('previewThumbStrip');
const goLiveBtn = document.getElementById('goLiveBtn');

// Library & Upload DOM
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const countDecks = document.getElementById('countDecks');
const countImages = document.getElementById('countImages');
const countVideos = document.getElementById('countVideos');
const countAudios = document.getElementById('countAudios');
const countBackgrounds = document.getElementById('countBackgrounds');
const uploadHeading = document.getElementById('uploadHeading');
const uploadSubtext = document.getElementById('uploadSubtext');
const fileUploadInput = document.getElementById('fileUploadInput');
const uploadProgressRow = document.getElementById('uploadProgressRow');
const uploadProgressFill = document.getElementById('uploadProgressFill');
const uploadProgressText = document.getElementById('uploadProgressText');
const libraryGrid = document.getElementById('libraryGrid');

// Sticky Audio Bar DOM
const audioLiveDot = document.getElementById('audioLiveDot');
const audioTrackTitle = document.getElementById('audioTrackTitle');
const audioTrackMeta = document.getElementById('audioTrackMeta');
const audioPlayPauseBtn = document.getElementById('audioPlayPauseBtn');
const audioFadeBtn = document.getElementById('audioFadeBtn');
const audioLoopBtn = document.getElementById('audioLoopBtn');
const audioStopBtn = document.getElementById('audioStopBtn');
const audioVolumeSlider = document.getElementById('audioVolumeSlider');
const audioVolumePct = document.getElementById('audioVolumePct');

const toastEl = document.getElementById('toast');

// App State
let sessionId = null;
let activeTab = 'decks';
let library = {
  activeBackgroundId: null,
  activeBackgroundUrl: '/assets/default-master-bg.svg',
  backgrounds: [],
  images: [],
  videos: [],
  audios: [],
  decks: [],
};
let stageState = null;
let preview = null; // { type: 'deck'|'image'|'video', itemId, slideIndex }
let isScrubbingVideo = false;
let isDraggingVolume = false;
let toastTimer = null;
const renderingDeckIds = new Set();
const preloadedUrls = new Set();

// --- Helpers ---
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function preloadUrl(url) {
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.src = url;
}

function preloadDeckNeighbors(deck, idx) {
  if (!deck?.slides?.length) return;
  for (const offset of [-1, 0, 1, 2]) {
    const target = idx + offset;
    if (target >= 0 && target < deck.slides.length) {
      preloadUrl(deck.slides[target].url);
    }
  }
}

// --- Session Pairing ---
function readSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('session');
  if (fromQuery) return fromQuery.trim().toUpperCase();
  return null;
}

function joinSession(code) {
  sessionId = code.trim().toUpperCase();
  sessionBadge.textContent = sessionId;
  pairPrompt.classList.add('hidden');
  controllerMain.classList.remove('hidden');

  const url = new URL(window.location.href);
  url.searchParams.set('session', sessionId);
  window.history.replaceState({}, '', url.toString());

  socket.emit('session:join', { sessionId, role: 'remote' });
}

pairForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = pairCodeInput.value.trim().toUpperCase();
  if (!code) return;
  joinSession(code);
});

const initialCode = readSessionFromUrl();
if (initialCode) {
  joinSession(initialCode);
} else {
  pairPrompt.classList.remove('hidden');
  controllerMain.classList.add('hidden');
}

// --- Upload Config per Tab ---
const UPLOAD_CONFIG = {
  decks: {
    heading: 'העלאת מצגת או סט תמונות',
    subtext: 'תומך ב-PPTX, PDF או בחירת מספר תמונות יחד כמצגת',
    accept: '.pptx,.ppt,.pdf,image/*',
    multiple: true,
    endpoint: '/api/upload/deck',
    fieldName: 'files',
  },
  images: {
    heading: 'העלאת תמונות להצגה במסך מלא',
    subtext: 'PNG, JPG, WebP — ניתן לבחור מספר תמונות יחד',
    accept: 'image/*',
    multiple: true,
    endpoint: '/api/upload/image',
    fieldName: 'files',
  },
  videos: {
    heading: 'העלאת סרטון (MP4 / WebM)',
    subtext: 'הסרטון יתנגן עם שמע ויחזור אוטומטית לרקע הראשי בסיום',
    accept: 'video/mp4,video/webm,video/quicktime,video/*',
    multiple: false,
    endpoint: '/api/upload/video',
    fieldName: 'file',
  },
  audios: {
    heading: 'העלאת מוזיקת רקע / שיר (MP3 / WAV)',
    subtext: 'ניתן לנגן ברקע במקביל לשקפים או לרקע הראשי',
    accept: 'audio/*',
    multiple: false,
    endpoint: '/api/upload/audio',
    fieldName: 'file',
  },
  backgrounds: {
    heading: 'העלאת תמונת רקע ראשית (Master Background)',
    subtext: 'התמונה שתוצג כברירת מחדל כשלא מוקרן תוכן פעיל',
    accept: 'image/*',
    multiple: false,
    endpoint: '/api/upload/background',
    fieldName: 'file',
  },
};

function updateUploadBar() {
  const cfg = UPLOAD_CONFIG[activeTab];
  uploadHeading.textContent = cfg.heading;
  uploadSubtext.textContent = cfg.subtext;
  fileUploadInput.accept = cfg.accept;
  fileUploadInput.multiple = cfg.multiple;
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    tabButtons.forEach((b) => {
      const isAct = b === btn;
      b.classList.toggle('active', isAct);
      b.setAttribute('aria-selected', String(isAct));
    });
    updateUploadBar();
    renderLibrary();
  });
});

// Handle File Upload with Progress
fileUploadInput.addEventListener('change', async () => {
  const files = Array.from(fileUploadInput.files || []);
  fileUploadInput.value = '';
  if (files.length === 0) return;

  const cfg = UPLOAD_CONFIG[activeTab];
  const formData = new FormData();
  if (cfg.multiple) {
    for (const f of files) formData.append(cfg.fieldName, f);
  } else {
    formData.append(cfg.fieldName, files[0]);
  }

  uploadProgressRow.classList.remove('hidden');
  uploadProgressFill.style.width = '5%';
  uploadProgressText.textContent = 'מעלה קבצים...';

  try {
    const responseJson = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', cfg.endpoint);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          uploadProgressFill.style.width = `${Math.max(8, pct)}%`;
          uploadProgressText.textContent = pct < 100 ? `מעלה ${pct}%...` : 'מעבד בשרת...';
        }
      };
      xhr.onload = () => {
        let parsed = {};
        try {
          parsed = JSON.parse(xhr.responseText || '{}');
        } catch {
          // ignore
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `שגיאת שרת (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('שגיאת רשת בהעלאה'));
      xhr.send(formData);
    });

    // If a PDF deck needs client-side rendering into cached slide images, do it automatically!
    if (responseJson.deck && responseJson.deck.needsClientRender && responseJson.deck.pdfUrl) {
      await runClientPdfRender(responseJson.deck);
    }

    showToast('הקובץ הועלה בהצלחה!');
  } catch (err) {
    showToast(err.message || 'ההעלאה נכשלה');
  } finally {
    uploadProgressRow.classList.add('hidden');
    uploadProgressFill.style.width = '0%';
  }
});

async function runClientPdfRender(deck) {
  if (!deck || !deck.pdfUrl || renderingDeckIds.has(deck.id)) return;
  renderingDeckIds.add(deck.id);
  uploadProgressRow.classList.remove('hidden');
  uploadProgressText.textContent = 'ממיר עמודי PDF לשקפים...';
  uploadProgressFill.style.width = '10%';

  try {
    await renderAndCachePdfDeck(deck, (done, total) => {
      const pct = Math.round((done / total) * 100);
      uploadProgressFill.style.width = `${pct}%`;
      uploadProgressText.textContent = `ממיר שקף ${done} מתוך ${total}...`;
      if (preview?.itemId === deck.id) {
        previewLoaderText.textContent = `ממיר שקף ${done} מתוך ${total}...`;
      }
    });
    showToast('המצגת מוכנה להצגה!');
  } catch (err) {
    console.error('[remote] PDF render error:', err);
    showToast('שגיאה בהמרת ה-PDF לשקפים');
  } finally {
    renderingDeckIds.delete(deck.id);
    uploadProgressRow.classList.add('hidden');
  }
}

// --- Topbar & Live Program Controls ---
qrToggleBtn.addEventListener('click', () => {
  socket.emit('remote:toggle-qr', {});
});

clearToBgBtn.addEventListener('click', () => {
  socket.emit('remote:clear-visual');
  showToast('חוזר לרקע הראשי');
});

livePrevSlideBtn.addEventListener('click', () => {
  socket.emit('remote:slide-step', { delta: -1 });
});

liveNextSlideBtn.addEventListener('click', () => {
  socket.emit('remote:slide-step', { delta: 1 });
});

videoPlayPauseBtn.addEventListener('click', () => {
  socket.emit('remote:video-control', { action: 'toggle' });
});

videoRestartBtn.addEventListener('click', () => {
  socket.emit('remote:video-control', { action: 'restart' });
});

videoMuteBtn.addEventListener('click', () => {
  socket.emit('remote:video-control', { action: 'mute' });
});

videoSeekSlider.addEventListener('pointerdown', () => {
  isScrubbingVideo = true;
});
videoSeekSlider.addEventListener('input', () => {
  videoTimeCurrent.textContent = formatTime(videoSeekSlider.value);
});
videoSeekSlider.addEventListener('change', () => {
  isScrubbingVideo = false;
  socket.emit('remote:video-control', { action: 'seek', value: Number(videoSeekSlider.value) });
});

// --- Preview Panel Controls ---
function openPreview(type, itemId, slideIndex = 0) {
  preview = { type, itemId, slideIndex };
  renderPreview();
  renderLibrary();
  previewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Auto-render uncached PDF deck when opened in preview
  if (type === 'deck') {
    const deck = library.decks.find((d) => d.id === itemId);
    if (deck && deck.needsClientRender && deck.pdfUrl) {
      runClientPdfRender(deck);
    }
  }
}

function closePreview() {
  preview = null;
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewPanel.classList.add('hidden');
  renderLibrary();
}

closePreviewBtn.addEventListener('click', closePreview);

function stepPreviewSlide(delta) {
  if (!preview || preview.type !== 'deck') return;
  const deck = library.decks.find((d) => d.id === preview.itemId);
  if (!deck || !deck.slides.length) return;
  const next = Math.max(0, Math.min(preview.slideIndex + delta, deck.slides.length - 1));
  if (next !== preview.slideIndex) {
    preview.slideIndex = next;
    renderPreview();
  }
}

previewPrevBtn.addEventListener('click', () => stepPreviewSlide(-1));
previewNextBtn.addEventListener('click', () => stepPreviewSlide(1));

// Touch Swipe Gestures on Preview Viewport (RTL-intuitive)
let touchStartX = 0;
let touchStartY = 0;
previewStageBox.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  },
  { passive: true }
);
previewStageBox.addEventListener(
  'touchend',
  (e) => {
    if (!preview || preview.type !== 'deck' || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) {
      // Swipe right -> next slide in RTL feel, or swipe left -> next: let's match standard slide strip flow
      stepPreviewSlide(dx > 0 ? 1 : -1);
    }
  },
  { passive: true }
);

goLiveBtn.addEventListener('click', () => {
  if (!preview) return;
  if (preview.type === 'deck') {
    const deck = library.decks.find((d) => d.id === preview.itemId);
    if (!deck || deck.slides.length === 0) {
      showToast('השקפים עדיין בהכנה...');
      return;
    }
    socket.emit('remote:go-live', {
      type: 'deck',
      itemId: preview.itemId,
      slideIndex: preview.slideIndex,
    });
    showToast(`שקף ${preview.slideIndex + 1} מוצג כעת על המסך`);
  } else if (preview.type === 'image') {
    socket.emit('remote:go-live', { type: 'image', itemId: preview.itemId });
    showToast('התמונה מוצגת כעת על המסך');
  } else if (preview.type === 'video') {
    previewVideo.pause();
    socket.emit('remote:go-live', { type: 'video', itemId: preview.itemId });
    showToast('הסרטון הופעל על המסך');
  }
});

function renderPreview() {
  if (!preview) {
    previewPanel.classList.add('hidden');
    return;
  }

  previewPanel.classList.remove('hidden');
  previewImage.classList.add('hidden');
  previewVideo.classList.add('hidden');
  previewLoader.classList.add('hidden');
  previewSlideIndicator.classList.add('hidden');
  previewIsLiveTag.classList.add('hidden');
  previewDeckTools.classList.add('hidden');

  const liveVis = stageState?.visual;

  if (preview.type === 'image') {
    const img = library.images.find((i) => i.id === preview.itemId);
    if (!img) return closePreview();
    previewTitle.textContent = img.title;
    previewImage.src = img.url;
    previewImage.classList.remove('hidden');
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = 'הצג על המסך';
    if (liveVis?.type === 'image' && liveVis.itemId === img.id) {
      previewIsLiveTag.classList.remove('hidden');
    }
    return;
  }

  if (preview.type === 'video') {
    const vid = library.videos.find((v) => v.id === preview.itemId);
    if (!vid) return closePreview();
    previewTitle.textContent = vid.title;
    if (previewVideo.getAttribute('src') !== vid.url) {
      previewVideo.src = vid.url;
    }
    previewVideo.classList.remove('hidden');
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = 'הפעל סרטון על המסך';
    if (liveVis?.type === 'video' && liveVis.itemId === vid.id) {
      previewIsLiveTag.classList.remove('hidden');
    }
    return;
  }

  if (preview.type === 'deck') {
    const deck = library.decks.find((d) => d.id === preview.itemId);
    if (!deck) return closePreview();
    previewTitle.textContent = deck.title;

    if (!deck.slides || deck.slides.length === 0) {
      previewLoader.classList.remove('hidden');
      previewLoaderText.textContent = 'ממיר את עמודי המצגת לשקפים...';
      goLiveBtn.disabled = true;
      goLiveBtn.textContent = 'ממתין להכנת השקפים...';
      return;
    }

    const total = deck.slides.length;
    preview.slideIndex = Math.max(0, Math.min(preview.slideIndex, total - 1));
    const slide = deck.slides[preview.slideIndex];

    previewImage.src = slide.url;
    previewImage.classList.remove('hidden');
    preloadDeckNeighbors(deck, preview.slideIndex);

    previewSlideIndicator.textContent = `שקף ${preview.slideIndex + 1} מתוך ${total}`;
    previewSlideIndicator.classList.remove('hidden');
    previewDeckTools.classList.remove('hidden');

    previewPrevBtn.disabled = preview.slideIndex <= 0;
    previewNextBtn.disabled = preview.slideIndex >= total - 1;

    const isExactSlideLive =
      liveVis?.type === 'deck' &&
      liveVis.itemId === deck.id &&
      liveVis.slideIndex === preview.slideIndex;
    previewIsLiveTag.classList.toggle('hidden', !isExactSlideLive);

    goLiveBtn.disabled = false;
    goLiveBtn.textContent = isExactSlideLive
      ? `שקף ${preview.slideIndex + 1} כבר בשידור (רענן)`
      : `הצג על המסך (שקף ${preview.slideIndex + 1})`;

    // Build / update scrollable thumbnail strip
    previewThumbStrip.innerHTML = '';
    deck.slides.forEach((s, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-item';
      const isThumbLive =
        liveVis?.type === 'deck' && liveVis.itemId === deck.id && liveVis.slideIndex === idx;
      if (idx === preview.slideIndex) btn.classList.add('is-preview');
      if (isThumbLive) btn.classList.add('is-live');

      const img = document.createElement('img');
      img.src = s.url;
      img.loading = 'lazy';
      img.alt = `שקף ${idx + 1}`;
      btn.appendChild(img);

      const num = document.createElement('span');
      num.className = 'thumb-num';
      num.textContent = String(idx + 1);
      btn.appendChild(num);

      if (isThumbLive) {
        const tag = document.createElement('span');
        tag.className = 'thumb-live-dot';
        tag.textContent = 'LIVE';
        btn.appendChild(tag);
      }

      btn.addEventListener('click', () => {
        preview.slideIndex = idx;
        renderPreview();
      });

      previewThumbStrip.appendChild(btn);
      if (idx === preview.slideIndex) {
        requestAnimationFrame(() => {
          btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        });
      }
    });
  }
}

// --- Persistent Background Audio Controls ---
audioPlayPauseBtn.addEventListener('click', () => {
  socket.emit('remote:audio-control', { action: 'toggle' });
});

audioFadeBtn.addEventListener('click', () => {
  socket.emit('remote:audio-control', { action: 'fade-out' });
  showToast('דועך את מוזיקת הרקע בהדרגה...');
});

audioLoopBtn.addEventListener('click', () => {
  socket.emit('remote:audio-control', { action: 'loop' });
});

audioStopBtn.addEventListener('click', () => {
  socket.emit('remote:audio-control', { action: 'stop' });
});

audioVolumeSlider.addEventListener('pointerdown', () => {
  isDraggingVolume = true;
});
audioVolumeSlider.addEventListener('input', () => {
  const val = Number(audioVolumeSlider.value);
  audioVolumePct.textContent = `${Math.round(val * 100)}%`;
  socket.emit('remote:audio-control', { action: 'volume', value: val });
});
audioVolumeSlider.addEventListener('change', () => {
  isDraggingVolume = false;
});

// --- Render Stage State into Live Card + Audio Bar ---
function renderStageState() {
  if (!stageState) return;

  // Connection & Stage status
  if (stageState.stageConnected) {
    connDot.className = 'conn-dot online';
    connSubtitle.textContent = 'מסך הבמה מחובר בזמן אמת';
  } else {
    connDot.className = 'conn-dot warn';
    connSubtitle.textContent = 'מחובר לשרת — ממתין למסך הבמה';
  }

  stageUnlockWarn.classList.toggle(
    'hidden',
    !stageState.stageConnected || Boolean(stageState.stageAudioUnlocked)
  );

  // QR toggle button
  qrToggleBtn.classList.toggle('qr-active', Boolean(stageState.showQr));
  qrToggleLabel.textContent = stageState.showQr ? 'QR מוצג' : 'QR מוסתר';

  // Visual program
  const vis = stageState.visual || { type: 'idle' };
  const isLive = vis.type !== 'idle';
  liveCard.classList.toggle('is-live', isLive);
  clearToBgBtn.disabled = !isLive;

  liveDeckControls.classList.add('hidden');
  liveVideoControls.classList.add('hidden');

  if (!isLive) {
    liveBadge.className = 'status-badge badge-idle';
    liveBadge.textContent = 'רקע ראשי';
    liveTitle.textContent = 'המסך מציג את תמונת הרקע הראשית';
  } else if (vis.type === 'image') {
    liveBadge.className = 'status-badge badge-live';
    liveBadge.textContent = 'בשידור חי · LIVE';
    liveTitle.textContent = `תמונה: ${vis.title}`;
  } else if (vis.type === 'deck') {
    liveBadge.className = 'status-badge badge-live';
    liveBadge.textContent = 'בשידור חי · LIVE';
    liveTitle.textContent = vis.title;
    liveDeckControls.classList.remove('hidden');
    const total = Math.max(1, vis.slideCount || 1);
    const cur = (vis.slideIndex || 0) + 1;
    liveSlideCounter.textContent = `${cur} / ${total}`;
    livePrevSlideBtn.disabled = vis.slideIndex <= 0;
    liveNextSlideBtn.disabled = vis.slideIndex >= total - 1;
  } else if (vis.type === 'video') {
    liveBadge.className = 'status-badge badge-live';
    liveBadge.textContent = 'וידאו בשידור · LIVE';
    liveTitle.textContent = vis.title;
    liveVideoControls.classList.remove('hidden');
    updateVideoProgressUI(vis.currentTime, vis.duration, vis.playing, vis.muted);
  }

  // Background Audio Bar
  const aud = stageState.audio || {};
  const hasTrack = Boolean(aud.url);
  audioPlayPauseBtn.disabled = !hasTrack;
  audioStopBtn.disabled = !hasTrack || !aud.playing;
  audioFadeBtn.disabled = !hasTrack || !aud.playing || Boolean(aud.fadingOut);
  audioLoopBtn.classList.toggle('loop-on', Boolean(aud.loop));
  audioLiveDot.classList.toggle('playing', Boolean(aud.playing));

  if (!hasTrack) {
    audioTrackTitle.textContent = 'מוזיקת רקע — לא נבחר שיר';
    audioTrackMeta.textContent = 'בחר רצועה בלשונית "אודיו" להפעלה במקביל למסך';
    audioPlayPauseBtn.textContent = '▶';
  } else {
    audioTrackTitle.textContent = aud.title || 'רצועת שמע';
    if (aud.fadingOut) {
      audioTrackMeta.textContent = 'דועך בהדרגה...';
    } else if (aud.playing) {
      audioTrackMeta.textContent = `מתנגן ברקע · ${formatTime(aud.currentTime)} / ${formatTime(aud.duration)}`;
    } else {
      audioTrackMeta.textContent = 'מושהה';
    }
    audioPlayPauseBtn.textContent = aud.playing ? '⏸' : '▶';
  }

  if (!isDraggingVolume && typeof aud.volume === 'number') {
    audioVolumeSlider.value = String(aud.volume);
    audioVolumePct.textContent = `${Math.round(aud.volume * 100)}%`;
  }

  renderPreview();
  renderLibrary();
}

function updateVideoProgressUI(currentTime, duration, playing, muted) {
  videoTimeCurrent.textContent = formatTime(currentTime);
  videoTimeDuration.textContent = formatTime(duration);
  if (!isScrubbingVideo) {
    videoSeekSlider.max = String(Math.max(1, duration || 0));
    videoSeekSlider.value = String(currentTime || 0);
  }
  videoPlayPauseBtn.textContent = playing ? 'השהה ⏸' : 'נגן ▶';
  if (typeof muted === 'boolean') {
    videoMuteBtn.textContent = muted ? '🔇' : '🔊';
  }
}

// --- Delete Media Item ---
async function deleteItem(category, id, title) {
  if (!confirm(`למחוק את "${title}"?`)) return;
  try {
    const res = await fetch(`/api/library/${encodeURIComponent(category)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('המחיקה נכשלה');
    if (preview?.itemId === id) closePreview();
    showToast('הפריט נמחק');
  } catch (err) {
    showToast(err.message);
  }
}

// --- Render Library Grid ---
function renderLibrary() {
  countDecks.textContent = String(library.decks.length);
  countImages.textContent = String(library.images.length);
  countVideos.textContent = String(library.videos.length);
  countAudios.textContent = String(library.audios.length);
  countBackgrounds.textContent = String(library.backgrounds.length);

  libraryGrid.innerHTML = '';
  libraryGrid.classList.toggle('list-mode', activeTab === 'audios');

  const liveVis = stageState?.visual;
  const liveAud = stageState?.audio;

  // 1. Presentations / Decks
  if (activeTab === 'decks') {
    if (library.decks.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין מצגות. העלה קובץ PPTX, PDF או סט תמונות למעלה.</div>`;
      return;
    }

    for (const deck of library.decks) {
      const isLive = liveVis?.type === 'deck' && liveVis.itemId === deck.id;
      const isPrev = preview?.type === 'deck' && preview.itemId === deck.id;

      const card = document.createElement('div');
      card.className = 'media-card';
      if (isPrev) card.classList.add('is-preview');
      if (isLive) card.classList.add('is-live');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      if (deck.slides && deck.slides[0]?.url) {
        const img = document.createElement('img');
        img.src = deck.slides[0].url;
        img.loading = 'lazy';
        img.alt = deck.title;
        thumb.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'card-thumb-placeholder';
        ph.textContent = '📑';
        thumb.appendChild(ph);
      }

      if (isLive) {
        thumb.innerHTML += `<span class="card-flag flag-live">LIVE</span>`;
      } else if (isPrev) {
        thumb.innerHTML += `<span class="card-flag flag-preview">PREVIEW</span>`;
      }

      const body = document.createElement('div');
      body.className = 'card-body';
      const slideInfo = deck.needsClientRender
        ? 'לחץ להכנת שקפים (PDF)'
        : `${deck.slides.length} שקפים`;
      body.innerHTML = `
        <div class="card-meta">
          <div class="card-title"></div>
          <div class="card-sub">${slideInfo}</div>
        </div>
      `;
      body.querySelector('.card-title').textContent = deck.title;

      const delBtn = document.createElement('button');
      delBtn.className = 'card-del-btn';
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.title = 'מחק';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteItem('decks', deck.id, deck.title);
      });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => {
        const initialSlide = isLive ? liveVis.slideIndex || 0 : 0;
        openPreview('deck', deck.id, initialSlide);
      });
      libraryGrid.appendChild(card);
    }
    return;
  }

  // 2. Full-screen Images
  if (activeTab === 'images') {
    if (library.images.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין תמונות. העלה תמונות להצגה במסך מלא.</div>`;
      return;
    }

    for (const item of library.images) {
      const isLive = liveVis?.type === 'image' && liveVis.itemId === item.id;
      const isPrev = preview?.type === 'image' && preview.itemId === item.id;

      const card = document.createElement('div');
      card.className = 'media-card';
      if (isPrev) card.classList.add('is-preview');
      if (isLive) card.classList.add('is-live');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = `<img src="${item.url}" loading="lazy" alt="" />`;
      if (isLive) thumb.innerHTML += `<span class="card-flag flag-live">LIVE</span>`;
      else if (isPrev) thumb.innerHTML += `<span class="card-flag flag-preview">PREVIEW</span>`;

      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = `<div class="card-meta"><div class="card-title"></div><div class="card-sub">תמונה למסך מלא</div></div>`;
      body.querySelector('.card-title').textContent = item.title;

      const delBtn = document.createElement('button');
      delBtn.className = 'card-del-btn';
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteItem('images', item.id, item.title);
      });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openPreview('image', item.id));
      libraryGrid.appendChild(card);
    }
    return;
  }

  // 3. Videos
  if (activeTab === 'videos') {
    if (library.videos.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין סרטונים. העלה קובץ MP4 או WebM למעלה.</div>`;
      return;
    }

    for (const item of library.videos) {
      const isLive = liveVis?.type === 'video' && liveVis.itemId === item.id;
      const isPrev = preview?.type === 'video' && preview.itemId === item.id;

      const card = document.createElement('div');
      card.className = 'media-card';
      if (isPrev) card.classList.add('is-preview');
      if (isLive) card.classList.add('is-live');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = `<video src="${item.url}#t=0.5" muted preload="metadata" playsinline></video>`;
      if (isLive) thumb.innerHTML += `<span class="card-flag flag-live">LIVE</span>`;
      else if (isPrev) thumb.innerHTML += `<span class="card-flag flag-preview">PREVIEW</span>`;

      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = `<div class="card-meta"><div class="card-title"></div><div class="card-sub">וידאו</div></div>`;
      body.querySelector('.card-title').textContent = item.title;

      const delBtn = document.createElement('button');
      delBtn.className = 'card-del-btn';
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteItem('videos', item.id, item.title);
      });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openPreview('video', item.id));
      libraryGrid.appendChild(card);
    }
    return;
  }

  // 4. Audio / Background Music
  if (activeTab === 'audios') {
    if (library.audios.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין רצועות שמע. העלה קובץ MP3 או WAV למוזיקת רקע.</div>`;
      return;
    }

    for (const track of library.audios) {
      const isCurrent = liveAud?.itemId === track.id;
      const isPlaying = isCurrent && liveAud?.playing;

      const row = document.createElement('div');
      row.className = 'audio-row-card';
      if (isPlaying) row.classList.add('is-playing');

      row.innerHTML = `
        <div class="audio-row-left">
          <div class="audio-play-icon">${isPlaying ? '⏸' : '▶'}</div>
          <div class="card-meta">
            <div class="card-title"></div>
            <div class="card-sub">${isPlaying ? 'מתנגן כעת ברקע' : isCurrent ? 'מושהה בנגן' : 'לחץ להפעלה ברקע'}</div>
          </div>
        </div>
      `;
      row.querySelector('.card-title').textContent = track.title;

      const delBtn = document.createElement('button');
      delBtn.className = 'card-del-btn';
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteItem('audios', track.id, track.title);
      });
      row.appendChild(delBtn);

      row.addEventListener('click', () => {
        if (isCurrent) {
          socket.emit('remote:audio-control', { action: 'toggle' });
        } else {
          socket.emit('remote:audio-control', { action: 'play-track', itemId: track.id });
          showToast(`מנגן ברקע: ${track.title}`);
        }
      });

      libraryGrid.appendChild(row);
    }
    return;
  }

  // 5. Master Backgrounds
  if (activeTab === 'backgrounds') {
    const items = [
      ...library.backgrounds,
      {
        id: 'default',
        title: 'רקע ברירת מחדל (סטודיו כהה)',
        url: '/assets/default-master-bg.svg',
        isDefault: true,
      },
    ];

    for (const bg of items) {
      const isActive =
        (bg.isDefault && !library.activeBackgroundId) ||
        (!bg.isDefault && library.activeBackgroundId === bg.id);

      const card = document.createElement('div');
      card.className = 'media-card';
      if (isActive) card.classList.add('is-active-bg');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = `<img src="${bg.url}" loading="lazy" alt="" />`;
      if (isActive) {
        thumb.innerHTML += `<span class="card-flag flag-active">רקע פעיל</span>`;
      }

      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = `<div class="card-meta"><div class="card-title"></div><div class="card-sub">${isActive ? 'מוגדר כרקע הראשי' : 'לחץ להגדרה כרקע ראשי'}</div></div>`;
      body.querySelector('.card-title').textContent = bg.title;

      if (!bg.isDefault) {
        const delBtn = document.createElement('button');
        delBtn.className = 'card-del-btn';
        delBtn.type = 'button';
        delBtn.textContent = '🗑';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteItem('backgrounds', bg.id, bg.title);
        });
        body.appendChild(delBtn);
      }

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', async () => {
        if (isActive) return;
        const res = await fetch(`/api/backgrounds/${encodeURIComponent(bg.id)}/activate`, {
          method: 'POST',
        });
        if (res.ok) showToast('הרקע הראשי עודכן!');
      });

      libraryGrid.appendChild(card);
    }
  }
}

// --- Socket Listeners ---
socket.on('connect', () => {
  if (sessionId) {
    socket.emit('session:join', { sessionId, role: 'remote' });
  }
});

socket.on('disconnect', () => {
  connDot.className = 'conn-dot offline';
  connSubtitle.textContent = 'החיבור נותק — מתחבר מחדש...';
});

socket.on('library:updated', (data) => {
  library = data || library;
  renderPreview();
  renderLibrary();
});

socket.on('state:sync', (state) => {
  stageState = state;
  renderStageState();
});

socket.on('stage:video-progress', ({ currentTime, duration, playing }) => {
  if (!stageState || stageState.visual.type !== 'video') return;
  stageState.visual.currentTime = currentTime;
  stageState.visual.duration = duration;
  stageState.visual.playing = playing;
  updateVideoProgressUI(currentTime, duration, playing);
});

socket.on('stage:audio-progress', ({ currentTime, duration, playing }) => {
  if (!stageState) return;
  stageState.audio.currentTime = currentTime;
  stageState.audio.duration = duration;
  stageState.audio.playing = playing;
  if (playing && !stageState.audio.fadingOut) {
    audioTrackMeta.textContent = `מתנגן ברקע · ${formatTime(currentTime)} / ${formatTime(duration)}`;
  }
});

updateUploadBar();
