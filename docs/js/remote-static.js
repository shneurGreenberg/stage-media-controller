import {
  loadLibrary,
  saveLibrary,
  putBlob,
  getBlob,
  deleteBlob,
  getObjectUrl,
  makeId,
} from './db.js';
import { convertPdfFileToSlideBlobs, convertPptxFileToSlideBlobs } from './client-converter.js';
import { RemoteClient } from './p2p.js';

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
const transferBanner = document.getElementById('transferBanner');
const transferProgressFill = document.getElementById('transferProgressFill');
const transferProgressText = document.getElementById('transferProgressText');

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

// Audio Bar DOM
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

// App state
let sessionId = null;
let client = null;
let activeTab = 'decks';
let library = { activeBackgroundId: null, backgrounds: [], images: [], videos: [], audios: [], decks: [] };
let stageState = null;
const stageCachedAssets = new Set();
let preview = null; // { type: 'deck'|'image'|'video', itemId, slideIndex }
let isScrubbingVideo = false;
let isDraggingVolume = false;
let toastTimer = null;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function baseName(fileName) {
  return String(fileName || 'קובץ').replace(/\.[^.]+$/, '');
}

// --- Ensure Asset Is Cached on Stage Display (with live progress for large files) ---
async function ensureAssetOnStage(assetId, label = 'קובץ', showProgress = true) {
  if (!client || !client.connected) {
    showToast('מסך הבמה לא מחובר כרגע');
    return false;
  }
  if (!assetId || stageCachedAssets.has(assetId)) return true;

  const blob = await getBlob(assetId);
  if (!blob) {
    showToast('הקובץ לא נמצא בזיכרון המכשיר');
    return false;
  }

  const isLarge = blob.size > 250 * 1024;
  if (showProgress && isLarge) {
    transferBanner.classList.remove('hidden');
    transferProgressFill.style.width = '5%';
    transferProgressText.textContent = `מעביר ${label} למסך...`;
  }

  try {
    await client.sendAsset(assetId, blob, (pct) => {
      if (showProgress && isLarge) {
        transferProgressFill.style.width = `${pct}%`;
        transferProgressText.textContent = `מעביר ${label} למסך (${pct}%)...`;
      }
    });
    stageCachedAssets.add(assetId);
    return true;
  } catch (err) {
    showToast(err.message || 'שגיאה בהעברת הקובץ למסך');
    return false;
  } finally {
    if (showProgress && isLarge) {
      transferBanner.classList.add('hidden');
      transferProgressFill.style.width = '0%';
    }
  }
}

// Background pre-transfer of adjacent slides for zero-delay Next/Prev switching
function pretransferAdjacentSlides(deck, slideIndex) {
  if (!deck?.slides?.length || !client?.connected) return;
  const neighbors = [slideIndex + 1, slideIndex - 1, slideIndex + 2];
  (async () => {
    for (const idx of neighbors) {
      if (idx < 0 || idx >= deck.slides.length) continue;
      const assetId = deck.slides[idx].assetId;
      if (!stageCachedAssets.has(assetId)) {
        await ensureAssetOnStage(assetId, 'שקף', false);
      }
    }
  })();
}

// --- Session Connection ---
function connectToSession(code) {
  sessionId = code.trim().toUpperCase();
  sessionBadge.textContent = sessionId;
  pairPrompt.classList.add('hidden');
  controllerMain.classList.remove('hidden');

  const url = new URL(window.location.href);
  url.searchParams.set('session', sessionId);
  window.history.replaceState({}, '', url.toString());

  client = new RemoteClient(sessionId, {
    onStatusChange: async (status) => {
      if (status === 'connected') {
        connDot.className = 'conn-dot online';
        connSubtitle.textContent = 'מסך הבמה מחובר בזמן אמת (P2P)';
        // Sync active Master Background automatically if set in local library
        if (library.activeBackgroundId) {
          const bg = library.backgrounds.find((b) => b.id === library.activeBackgroundId);
          if (bg) {
            const ok = await ensureAssetOnStage(bg.assetId, 'רקע ראשי', false);
            if (ok) client.send({ type: 'remote:set-background', assetId: bg.assetId });
          }
        }
      } else if (status === 'reconnecting') {
        connDot.className = 'conn-dot warn';
        connSubtitle.textContent = 'מנסה להתחבר מחדש למסך הבמה...';
      } else {
        connDot.className = 'conn-dot warn';
        connSubtitle.textContent = 'מתחבר למסך הבמה...';
      }
    },
    onMessage: (msg) => {
      if (msg.type === 'state:sync' && msg.state) {
        stageState = msg.state;
        if (Array.isArray(msg.state.cachedAssetIds)) {
          msg.state.cachedAssetIds.forEach((id) => stageCachedAssets.add(id));
        }
        renderStageState();
      } else if (msg.type === 'stage:video-progress' && stageState?.visual?.type === 'video') {
        stageState.visual.currentTime = msg.currentTime;
        stageState.visual.duration = msg.duration;
        stageState.visual.playing = msg.playing;
        updateVideoProgressUI(msg.currentTime, msg.duration, msg.playing);
      } else if (msg.type === 'stage:audio-progress' && stageState) {
        stageState.audio.currentTime = msg.currentTime;
        stageState.audio.duration = msg.duration;
        stageState.audio.playing = msg.playing;
        if (msg.playing && !stageState.audio.fadingOut) {
          audioTrackMeta.textContent = `מתנגן ברקע · ${formatTime(msg.currentTime)} / ${formatTime(msg.duration)}`;
        }
      }
    },
  });
}

pairForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = pairCodeInput.value.trim().toUpperCase();
  if (code) connectToSession(code);
});

// --- Upload Config per Category ---
const UPLOAD_CONFIG = {
  decks: {
    heading: 'הוספת מצגת או סט תמונות',
    subtext: 'תומך ב-PPTX, PDF או בחירת מספר תמונות יחד (מעובד ישירות בדפדפן)',
    accept: '.pptx,.pdf,image/*',
    multiple: true,
  },
  images: {
    heading: 'הוספת תמונות למסך מלא',
    subtext: 'PNG, JPG, WebP — נשמר מקומית ומוצג מיידית',
    accept: 'image/*',
    multiple: true,
  },
  videos: {
    heading: 'הוספת סרטון (MP4 / WebM)',
    subtext: 'מועבר ישירות למסך וחוזר לרקע הראשי אוטומטית בסיום',
    accept: 'video/mp4,video/webm,video/quicktime,video/*',
    multiple: false,
  },
  audios: {
    heading: 'הוספת מוזיקת רקע / שיר (MP3 / WAV)',
    subtext: 'מתנגן ברקע במקביל לשקפים או לרקע הראשי',
    accept: 'audio/*',
    multiple: false,
  },
  backgrounds: {
    heading: 'הוספת תמונת רקע ראשית (Master Background)',
    subtext: 'מוצגת כברירת מחדל כשלא מוקרן תוכן פעיל',
    accept: 'image/*',
    multiple: false,
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

fileUploadInput.addEventListener('change', async () => {
  const files = Array.from(fileUploadInput.files || []);
  fileUploadInput.value = '';
  if (files.length === 0) return;

  uploadProgressRow.classList.remove('hidden');
  uploadProgressFill.style.width = '10%';
  uploadProgressText.textContent = 'מעבד קבצים...';

  try {
    if (activeTab === 'decks') {
      const first = files[0];
      const lower = first.name.toLowerCase();
      let slideBlobs = [];
      let title = baseName(first.name);

      if (files.length === 1 && lower.endsWith('.pdf')) {
        slideBlobs = await convertPdfFileToSlideBlobs(first, (done, total) => {
          uploadProgressFill.style.width = `${Math.round((done / total) * 100)}%`;
          uploadProgressText.textContent = `ממיר עמוד ${done} מתוך ${total}...`;
        });
      } else if (files.length === 1 && lower.endsWith('.pptx')) {
        slideBlobs = await convertPptxFileToSlideBlobs(first, (done, total) => {
          uploadProgressFill.style.width = `${Math.round((done / total) * 100)}%`;
          uploadProgressText.textContent = `ממיר שקף ${done} מתוך ${total}...`;
        });
      } else {
        const sorted = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        slideBlobs = sorted;
        if (sorted.length > 1) title = `מצגת תמונות (${sorted.length} שקפים)`;
      }

      const deckId = makeId('deck');
      const slides = [];
      for (let i = 0; i < slideBlobs.length; i++) {
        const assetId = `${deckId}_s${i}`;
        await putBlob(assetId, slideBlobs[i]);
        slides.push({ index: i, assetId });
      }

      library.decks.unshift({ id: deckId, title, slides, createdAt: Date.now() });
      await saveLibrary(library);
      showToast(`המצגת "${title}" נוספה (${slides.length} שקפים)`);
    } else if (activeTab === 'images') {
      for (const file of files) {
        const id = makeId('img');
        const assetId = `${id}_blob`;
        await putBlob(assetId, file);
        library.images.unshift({ id, title: baseName(file.name), assetId, createdAt: Date.now() });
      }
      await saveLibrary(library);
      showToast('התמונות נוספו בהצלחה');
    } else if (activeTab === 'videos') {
      const file = files[0];
      const id = makeId('vid');
      const assetId = `${id}_blob`;
      await putBlob(assetId, file);
      library.videos.unshift({ id, title: baseName(file.name), assetId, createdAt: Date.now() });
      await saveLibrary(library);
      showToast('הסרטון נוסף בהצלחה');
    } else if (activeTab === 'audios') {
      const file = files[0];
      const id = makeId('aud');
      const assetId = `${id}_blob`;
      await putBlob(assetId, file);
      library.audios.unshift({ id, title: baseName(file.name), assetId, createdAt: Date.now() });
      await saveLibrary(library);
      showToast('רצועת השמע נוספה בהצלחה');
    } else if (activeTab === 'backgrounds') {
      const file = files[0];
      const id = makeId('bg');
      const assetId = `${id}_blob`;
      await putBlob(assetId, file);
      library.backgrounds.unshift({ id, title: baseName(file.name), assetId, createdAt: Date.now() });
      library.activeBackgroundId = id;
      await saveLibrary(library);
      if (client?.connected) {
        const ok = await ensureAssetOnStage(assetId, 'רקע ראשי', true);
        if (ok) client.send({ type: 'remote:set-background', assetId });
      }
      showToast('הרקע הראשי עודכן!');
    }

    await renderLibrary();
  } catch (err) {
    console.error('[remote] Upload error:', err);
    showToast(err.message || 'שגיאה בהוספת הקובץ');
  } finally {
    uploadProgressRow.classList.add('hidden');
    uploadProgressFill.style.width = '0%';
  }
});

// --- Topbar & Live Program Controls ---
qrToggleBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:toggle-qr' });
});

clearToBgBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:clear-visual' });
  showToast('חוזר לרקע הראשי');
});

async function pushDeckSlideLive(deck, slideIndex) {
  if (!deck || !deck.slides.length) return;
  const idx = Math.max(0, Math.min(slideIndex, deck.slides.length - 1));
  const slide = deck.slides[idx];
  const ok = await ensureAssetOnStage(slide.assetId, `שקף ${idx + 1}`, true);
  if (!ok) return;
  client.send({
    type: 'remote:go-live',
    visualType: 'deck',
    itemId: deck.id,
    title: deck.title,
    assetId: slide.assetId,
    slideIndex: idx,
    slideCount: deck.slides.length,
  });
  pretransferAdjacentSlides(deck, idx);
}

livePrevSlideBtn.addEventListener('click', () => {
  if (stageState?.visual?.type !== 'deck') return;
  const deck = library.decks.find((d) => d.id === stageState.visual.itemId);
  if (deck) pushDeckSlideLive(deck, (stageState.visual.slideIndex || 0) - 1);
});

liveNextSlideBtn.addEventListener('click', () => {
  if (stageState?.visual?.type !== 'deck') return;
  const deck = library.decks.find((d) => d.id === stageState.visual.itemId);
  if (deck) pushDeckSlideLive(deck, (stageState.visual.slideIndex || 0) + 1);
});

videoPlayPauseBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:video-control', action: 'toggle' });
});
videoRestartBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:video-control', action: 'restart' });
});
videoMuteBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:video-control', action: 'mute' });
});

videoSeekSlider.addEventListener('pointerdown', () => { isScrubbingVideo = true; });
videoSeekSlider.addEventListener('input', () => {
  videoTimeCurrent.textContent = formatTime(videoSeekSlider.value);
});
videoSeekSlider.addEventListener('change', () => {
  isScrubbingVideo = false;
  client?.send({ type: 'remote:video-control', action: 'seek', value: Number(videoSeekSlider.value) });
});

// --- Preview Panel (Local on Phone only) ---
function openPreview(type, itemId, slideIndex = 0) {
  preview = { type, itemId, slideIndex };
  renderPreview();
  renderLibrary();
  previewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  if (!deck?.slides?.length) return;
  const next = Math.max(0, Math.min(preview.slideIndex + delta, deck.slides.length - 1));
  if (next !== preview.slideIndex) {
    preview.slideIndex = next;
    renderPreview();
  }
}

previewPrevBtn.addEventListener('click', () => stepPreviewSlide(-1));
previewNextBtn.addEventListener('click', () => stepPreviewSlide(1));

let touchStartX = 0;
let touchStartY = 0;
previewStageBox.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });
previewStageBox.addEventListener('touchend', (e) => {
  if (!preview || preview.type !== 'deck' || e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy)) {
    stepPreviewSlide(dx > 0 ? 1 : -1);
  }
}, { passive: true });

goLiveBtn.addEventListener('click', async () => {
  if (!preview) return;
  goLiveBtn.disabled = true;
  try {
    if (preview.type === 'deck') {
      const deck = library.decks.find((d) => d.id === preview.itemId);
      if (deck) {
        await pushDeckSlideLive(deck, preview.slideIndex);
        showToast(`שקף ${preview.slideIndex + 1} מוצג כעת על המסך`);
      }
    } else if (preview.type === 'image') {
      const img = library.images.find((i) => i.id === preview.itemId);
      if (img) {
        const ok = await ensureAssetOnStage(img.assetId, 'תמונה', true);
        if (ok) {
          client.send({
            type: 'remote:go-live',
            visualType: 'image',
            itemId: img.id,
            title: img.title,
            assetId: img.assetId,
          });
          showToast('התמונה מוצגת כעת על המסך');
        }
      }
    } else if (preview.type === 'video') {
      const vid = library.videos.find((v) => v.id === preview.itemId);
      if (vid) {
        previewVideo.pause();
        const ok = await ensureAssetOnStage(vid.assetId, 'סרטון', true);
        if (ok) {
          client.send({
            type: 'remote:go-live',
            visualType: 'video',
            itemId: vid.id,
            title: vid.title,
            assetId: vid.assetId,
          });
          showToast('הסרטון הופעל על המסך');
        }
      }
    }
  } finally {
    goLiveBtn.disabled = false;
  }
});

async function renderPreview() {
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
    const url = await getObjectUrl(img.assetId);
    if (url) {
      previewImage.src = url;
      previewImage.classList.remove('hidden');
    }
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = 'הצג על המסך';
    previewIsLiveTag.classList.toggle('hidden', !(liveVis?.type === 'image' && liveVis.itemId === img.id));
    return;
  }

  if (preview.type === 'video') {
    const vid = library.videos.find((v) => v.id === preview.itemId);
    if (!vid) return closePreview();
    previewTitle.textContent = vid.title;
    const url = await getObjectUrl(vid.assetId);
    if (url && previewVideo.getAttribute('src') !== url) {
      previewVideo.src = url;
    }
    previewVideo.classList.remove('hidden');
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = 'הפעל סרטון על המסך';
    previewIsLiveTag.classList.toggle('hidden', !(liveVis?.type === 'video' && liveVis.itemId === vid.id));
    return;
  }

  if (preview.type === 'deck') {
    const deck = library.decks.find((d) => d.id === preview.itemId);
    if (!deck || !deck.slides.length) return closePreview();
    previewTitle.textContent = deck.title;

    const total = deck.slides.length;
    preview.slideIndex = Math.max(0, Math.min(preview.slideIndex, total - 1));
    const currentSlide = deck.slides[preview.slideIndex];

    const url = await getObjectUrl(currentSlide.assetId);
    if (url) {
      previewImage.src = url;
      previewImage.classList.remove('hidden');
    }

    previewSlideIndicator.textContent = `שקף ${preview.slideIndex + 1} מתוך ${total}`;
    previewSlideIndicator.classList.remove('hidden');
    previewDeckTools.classList.remove('hidden');
    previewPrevBtn.disabled = preview.slideIndex <= 0;
    previewNextBtn.disabled = preview.slideIndex >= total - 1;

    const isExactLive =
      liveVis?.type === 'deck' && liveVis.itemId === deck.id && liveVis.slideIndex === preview.slideIndex;
    previewIsLiveTag.classList.toggle('hidden', !isExactLive);
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = isExactLive
      ? `שקף ${preview.slideIndex + 1} כבר בשידור (רענן)`
      : `הצג על המסך (שקף ${preview.slideIndex + 1})`;

    previewThumbStrip.innerHTML = '';
    for (let idx = 0; idx < deck.slides.length; idx++) {
      const s = deck.slides[idx];
      const thumbUrl = await getObjectUrl(s.assetId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-item';
      const isThumbLive =
        liveVis?.type === 'deck' && liveVis.itemId === deck.id && liveVis.slideIndex === idx;
      if (idx === preview.slideIndex) btn.classList.add('is-preview');
      if (isThumbLive) btn.classList.add('is-live');

      const img = document.createElement('img');
      if (thumbUrl) img.src = thumbUrl;
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
        requestAnimationFrame(() => btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
      }
    }
  }
}

// --- Persistent Background Audio Controls ---
audioPlayPauseBtn.addEventListener('click', () => client?.send({ type: 'remote:audio-control', action: 'toggle' }));
audioFadeBtn.addEventListener('click', () => {
  client?.send({ type: 'remote:audio-control', action: 'fade-out' });
  showToast('דועך את מוזיקת הרקע בהדרגה...');
});
audioLoopBtn.addEventListener('click', () => client?.send({ type: 'remote:audio-control', action: 'loop' }));
audioStopBtn.addEventListener('click', () => client?.send({ type: 'remote:audio-control', action: 'stop' }));

audioVolumeSlider.addEventListener('pointerdown', () => { isDraggingVolume = true; });
audioVolumeSlider.addEventListener('input', () => {
  const val = Number(audioVolumeSlider.value);
  audioVolumePct.textContent = `${Math.round(val * 100)}%`;
  client?.send({ type: 'remote:audio-control', action: 'volume', value: val });
});
audioVolumeSlider.addEventListener('change', () => { isDraggingVolume = false; });

function updateVideoProgressUI(currentTime, duration, playing, muted) {
  videoTimeCurrent.textContent = formatTime(currentTime);
  videoTimeDuration.textContent = formatTime(duration);
  if (!isScrubbingVideo) {
    videoSeekSlider.max = String(Math.max(1, duration || 0));
    videoSeekSlider.value = String(currentTime || 0);
  }
  videoPlayPauseBtn.textContent = playing ? 'השהה ⏸' : 'נגן ▶';
  if (typeof muted === 'boolean') videoMuteBtn.textContent = muted ? '🔇' : '🔊';
}

function renderStageState() {
  if (!stageState) return;
  stageUnlockWarn.classList.toggle('hidden', Boolean(stageState.stageAudioUnlocked));
  qrToggleBtn.classList.toggle('qr-active', Boolean(stageState.showQr));
  qrToggleLabel.textContent = stageState.showQr ? 'QR מוצג' : 'QR מוסתר';

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
    liveSlideCounter.textContent = `${(vis.slideIndex || 0) + 1} / ${total}`;
    livePrevSlideBtn.disabled = vis.slideIndex <= 0;
    liveNextSlideBtn.disabled = vis.slideIndex >= total - 1;
  } else if (vis.type === 'video') {
    liveBadge.className = 'status-badge badge-live';
    liveBadge.textContent = 'וידאו בשידור · LIVE';
    liveTitle.textContent = vis.title;
    liveVideoControls.classList.remove('hidden');
    updateVideoProgressUI(vis.currentTime, vis.duration, vis.playing, vis.muted);
  }

  const aud = stageState.audio || {};
  const hasTrack = Boolean(aud.assetId);
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
    audioTrackMeta.textContent = aud.fadingOut
      ? 'דועך בהדרגה...'
      : aud.playing
      ? `מתנגן ברקע · ${formatTime(aud.currentTime)} / ${formatTime(aud.duration)}`
      : 'מושהה';
    audioPlayPauseBtn.textContent = aud.playing ? '⏸' : '▶';
  }

  if (!isDraggingVolume && typeof aud.volume === 'number') {
    audioVolumeSlider.value = String(aud.volume);
    audioVolumePct.textContent = `${Math.round(aud.volume * 100)}%`;
  }

  renderPreview();
  renderLibrary();
}

// --- Delete Media Item ---
async function deleteItem(category, id, title) {
  if (!confirm(`למחוק את "${title}"?`)) return;
  const list = library[category];
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const [removed] = list.splice(idx, 1);

  if (removed.assetId) await deleteBlob(removed.assetId);
  if (Array.isArray(removed.slides)) {
    for (const s of removed.slides) await deleteBlob(s.assetId);
  }
  if (category === 'backgrounds' && library.activeBackgroundId === id) {
    library.activeBackgroundId = library.backgrounds[0]?.id || null;
    const nextBg = library.backgrounds[0];
    client?.send({ type: 'remote:set-background', assetId: nextBg?.assetId || null });
  }
  if (stageState?.visual?.itemId === id) client?.send({ type: 'remote:clear-visual' });
  if (stageState?.audio?.itemId === id) client?.send({ type: 'remote:audio-control', action: 'stop' });
  if (preview?.itemId === id) closePreview();

  await saveLibrary(library);
  await renderLibrary();
  showToast('הפריט נמחק');
}

// --- Render Library Grid ---
async function renderLibrary() {
  countDecks.textContent = String(library.decks.length);
  countImages.textContent = String(library.images.length);
  countVideos.textContent = String(library.videos.length);
  countAudios.textContent = String(library.audios.length);
  countBackgrounds.textContent = String(library.backgrounds.length);

  libraryGrid.innerHTML = '';
  libraryGrid.classList.toggle('list-mode', activeTab === 'audios');

  const liveVis = stageState?.visual;
  const liveAud = stageState?.audio;

  if (activeTab === 'decks') {
    if (library.decks.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין מצגות. הוסף קובץ PPTX, PDF או סט תמונות למעלה.</div>`;
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
      const firstUrl = deck.slides[0] ? await getObjectUrl(deck.slides[0].assetId) : null;
      if (firstUrl) {
        thumb.innerHTML = `<img src="${firstUrl}" loading="lazy" alt="" />`;
      } else {
        thumb.innerHTML = `<div class="card-thumb-placeholder">📑</div>`;
      }
      if (isLive) thumb.innerHTML += `<span class="card-flag flag-live">LIVE</span>`;
      else if (isPrev) thumb.innerHTML += `<span class="card-flag flag-preview">PREVIEW</span>`;

      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = `<div class="card-meta"><div class="card-title"></div><div class="card-sub">${deck.slides.length} שקפים</div></div>`;
      body.querySelector('.card-title').textContent = deck.title;

      const delBtn = document.createElement('button');
      delBtn.className = 'card-del-btn';
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteItem('decks', deck.id, deck.title); });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openPreview('deck', deck.id, isLive ? liveVis.slideIndex || 0 : 0));
      libraryGrid.appendChild(card);
    }
    return;
  }

  if (activeTab === 'images') {
    if (library.images.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין תמונות. הוסף תמונות להצגה במסך מלא.</div>`;
      return;
    }
    for (const item of library.images) {
      const isLive = liveVis?.type === 'image' && liveVis.itemId === item.id;
      const isPrev = preview?.type === 'image' && preview.itemId === item.id;
      const url = await getObjectUrl(item.assetId);
      const card = document.createElement('div');
      card.className = 'media-card';
      if (isPrev) card.classList.add('is-preview');
      if (isLive) card.classList.add('is-live');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = url ? `<img src="${url}" loading="lazy" alt="" />` : `<div class="card-thumb-placeholder">🖼️</div>`;
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
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteItem('images', item.id, item.title); });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openPreview('image', item.id));
      libraryGrid.appendChild(card);
    }
    return;
  }

  if (activeTab === 'videos') {
    if (library.videos.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין סרטונים. הוסף קובץ MP4 או WebM למעלה.</div>`;
      return;
    }
    for (const item of library.videos) {
      const isLive = liveVis?.type === 'video' && liveVis.itemId === item.id;
      const isPrev = preview?.type === 'video' && preview.itemId === item.id;
      const url = await getObjectUrl(item.assetId);
      const card = document.createElement('div');
      card.className = 'media-card';
      if (isPrev) card.classList.add('is-preview');
      if (isLive) card.classList.add('is-live');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = url
        ? `<video src="${url}#t=0.5" muted preload="metadata" playsinline></video>`
        : `<div class="card-thumb-placeholder">🎬</div>`;
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
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteItem('videos', item.id, item.title); });
      body.appendChild(delBtn);

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', () => openPreview('video', item.id));
      libraryGrid.appendChild(card);
    }
    return;
  }

  if (activeTab === 'audios') {
    if (library.audios.length === 0) {
      libraryGrid.innerHTML = `<div class="empty-state">אין עדיין רצועות שמע. הוסף קובץ MP3 או WAV למוזיקת רקע.</div>`;
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
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteItem('audios', track.id, track.title); });
      row.appendChild(delBtn);

      row.addEventListener('click', async () => {
        if (isCurrent) {
          client?.send({ type: 'remote:audio-control', action: 'toggle' });
        } else {
          const ok = await ensureAssetOnStage(track.assetId, 'רצועת שמע', true);
          if (ok) {
            client.send({
              type: 'remote:audio-control',
              action: 'play-track',
              itemId: track.id,
              title: track.title,
              assetId: track.assetId,
            });
            showToast(`מנגן ברקע: ${track.title}`);
          }
        }
      });
      libraryGrid.appendChild(row);
    }
    return;
  }

  if (activeTab === 'backgrounds') {
    const items = [
      ...library.backgrounds,
      { id: 'default', title: 'רקע ברירת מחדל (סטודיו כהה)', assetId: null, url: './assets/default-master-bg.svg', isDefault: true },
    ];
    for (const bg of items) {
      const isActive = (bg.isDefault && !library.activeBackgroundId) || (!bg.isDefault && library.activeBackgroundId === bg.id);
      const url = bg.isDefault ? bg.url : await getObjectUrl(bg.assetId);
      const card = document.createElement('div');
      card.className = 'media-card';
      if (isActive) card.classList.add('is-active-bg');

      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      thumb.innerHTML = url ? `<img src="${url}" loading="lazy" alt="" />` : `<div class="card-thumb-placeholder">🌄</div>`;
      if (isActive) thumb.innerHTML += `<span class="card-flag flag-active">רקע פעיל</span>`;

      const body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = `<div class="card-meta"><div class="card-title"></div><div class="card-sub">${isActive ? 'מוגדר כרקע הראשי' : 'לחץ להגדרה כרקע ראשי'}</div></div>`;
      body.querySelector('.card-title').textContent = bg.title;

      if (!bg.isDefault) {
        const delBtn = document.createElement('button');
        delBtn.className = 'card-del-btn';
        delBtn.type = 'button';
        delBtn.textContent = '🗑';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteItem('backgrounds', bg.id, bg.title); });
        body.appendChild(delBtn);
      }

      card.appendChild(thumb);
      card.appendChild(body);
      card.addEventListener('click', async () => {
        if (isActive) return;
        library.activeBackgroundId = bg.isDefault ? null : bg.id;
        await saveLibrary(library);
        if (client?.connected) {
          if (bg.isDefault) {
            client.send({ type: 'remote:set-background', assetId: null });
          } else {
            const ok = await ensureAssetOnStage(bg.assetId, 'רקע ראשי', true);
            if (ok) client.send({ type: 'remote:set-background', assetId: bg.assetId });
          }
        }
        showToast('הרקע הראשי עודכן!');
        renderLibrary();
      });
      libraryGrid.appendChild(card);
    }
  }
}

// --- Boot ---
async function init() {
  library = await loadLibrary();
  updateUploadBar();
  await renderLibrary();

  const params = new URLSearchParams(window.location.search);
  const code = params.get('session');
  if (code) {
    connectToSession(code);
  } else {
    pairPrompt.classList.remove('hidden');
    controllerMain.classList.add('hidden');
  }
}

init();
