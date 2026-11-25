import { renderAndCachePdfDeck } from '/shared/pdf-renderer.js';

const socket = io();

// DOM elements
const bgImgA = document.getElementById('bgImgA');
const bgImgB = document.getElementById('bgImgB');
const visualStage = document.getElementById('visualStage');
const slideSlotA = document.getElementById('slideSlotA');
const slideSlotB = document.getElementById('slideSlotB');
const slideImgA = document.getElementById('slideImgA');
const slideImgB = document.getElementById('slideImgB');
const videoLayer = document.getElementById('videoLayer');
const stageVideo = document.getElementById('stageVideo');
const bgAudio = document.getElementById('bgAudio');
const qrOverlay = document.getElementById('qrOverlay');
const qrImage = document.getElementById('qrImage');
const qrCodeText = document.getElementById('qrCodeText');
const qrUrlText = document.getElementById('qrUrlText');
const qrStatusPill = document.getElementById('qrStatusPill');
const unlockBanner = document.getElementById('unlockBanner');

// Runtime state
let sessionId = null;
let library = { decks: [], images: [], videos: [], audios: [], backgrounds: [] };
let currentState = null;
let activeBgSlot = 'A';
let currentBgUrl = '/assets/default-master-bg.svg';
let activeSlideSlot = 'A';
let currentSlideUrl = null;
let lastVideoUrl = null;
let lastVideoSeekSeq = 0;
let lastAudioUrl = null;
let lastAudioSeekSeq = 0;
let audioUnlocked = false;
let fadeOutAnimFrame = null;
let videoStopTimer = null;
let cursorHideTimer = null;
const preloadCache = new Map();
const renderingPdfIds = new Set();

// --- Session Initialization & QR Code ---
function getInitialSessionId() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('session');
  if (fromQuery) return fromQuery.toUpperCase();
  const saved = sessionStorage.getItem('stage_session_id');
  if (saved) return saved;
  return null;
}

async function initSessionAndQr() {
  const requested = getInitialSessionId();
  const query = requested ? `?session=${encodeURIComponent(requested)}` : '';
  const res = await fetch(`/api/qr${query}`);
  const data = await res.json();

  sessionId = data.sessionId;
  sessionStorage.setItem('stage_session_id', sessionId);

  // Keep URL clean with session param so F5 reload preserves pairing
  const url = new URL(window.location.href);
  if (url.searchParams.get('session') !== sessionId) {
    url.searchParams.set('session', sessionId);
    window.history.replaceState({}, '', url.toString());
  }

  qrImage.src = data.qrDataUrl;
  qrCodeText.textContent = sessionId;
  qrUrlText.textContent = data.shortUrl;

  socket.emit('session:join', { sessionId, role: 'stage' });
}

// --- Auto-hide Cursor ---
function resetCursorTimer() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => {
    document.body.classList.add('cursor-hidden');
  }, 2000);
}

window.addEventListener('mousemove', resetCursorTimer, { passive: true });
window.addEventListener('mousedown', resetCursorTimer, { passive: true });
resetCursorTimer();

// --- Audio & Fullscreen Unlock ---
function unlockStageMedia(enterFullscreen = true) {
  if (!audioUnlocked) {
    audioUnlocked = true;
    unlockBanner.classList.add('hidden');
    // Unlock audio context silently
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
      }
    } catch {
      // ignore
    }
    socket.emit('stage:audio-unlocked', { unlocked: true });

    // Resume any pending video/audio if blocked by autoplay policy
    if (currentState?.visual?.type === 'video' && currentState.visual.playing && stageVideo.paused) {
      stageVideo.play().catch(() => {});
    }
    if (currentState?.audio?.playing && bgAudio.paused) {
      bgAudio.play().catch(() => {});
    }
  }

  if (enterFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
}

unlockBanner.addEventListener('click', (e) => {
  e.stopPropagation();
  unlockStageMedia(true);
});

document.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) {
    unlockStageMedia(true);
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) unlockStageMedia(true);
    else document.exitFullscreen?.().catch(() => {});
  } else if (e.key === 'q' || e.key === 'Q') {
    socket.emit('remote:toggle-qr', {});
  } else if (e.key === 'ArrowRight' || e.key === ' ') {
    if (currentState?.visual?.type === 'deck') {
      socket.emit('remote:slide-step', { delta: 1 });
    }
  } else if (e.key === 'ArrowLeft') {
    if (currentState?.visual?.type === 'deck') {
      socket.emit('remote:slide-step', { delta: -1 });
    }
  } else if (e.key === 'Escape' && !document.fullscreenElement) {
    socket.emit('remote:clear-visual');
  }
});

// --- Image Preloading ---
function preloadImage(url) {
  if (!url) return Promise.resolve();
  if (preloadCache.has(url)) return preloadCache.get(url);

  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {}).finally(() => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });

  preloadCache.set(url, p);
  // Cap cache size to prevent memory bloat on long events
  if (preloadCache.size > 80) {
    const oldestKey = preloadCache.keys().next().value;
    preloadCache.delete(oldestKey);
  }
  return p;
}

function preloadAdjacentSlides(deckId, currentIdx) {
  const deck = library.decks?.find((d) => d.id === deckId);
  if (!deck || !Array.isArray(deck.slides)) return;
  const targets = [currentIdx - 1, currentIdx + 1, currentIdx + 2];
  for (const idx of targets) {
    if (idx >= 0 && idx < deck.slides.length) {
      preloadImage(deck.slides[idx].url);
    }
  }
}

// --- Smooth Master Background Crossfade ---
async function setMasterBackground(url) {
  if (!url || url === currentBgUrl) return;
  currentBgUrl = url;
  await preloadImage(url);

  const nextSlot = activeBgSlot === 'A' ? 'B' : 'A';
  const nextImg = nextSlot === 'A' ? bgImgA : bgImgB;
  const prevImg = activeBgSlot === 'A' ? bgImgA : bgImgB;

  nextImg.src = url;
  // Wait one frame for browser paint, then crossfade cleanly
  requestAnimationFrame(() => {
    nextImg.classList.add('active');
    prevImg.classList.remove('active');
    activeBgSlot = nextSlot;
  });
}

// --- Smooth Visual (Image / Slide) Crossfade ---
async function showVisualImage(url, { isFullImage = false } = {}) {
  if (!url) return;
  hideVideoLayer();

  if (url === currentSlideUrl && visualStage.classList.contains('visible')) {
    return;
  }

  await preloadImage(url);
  // Check if state changed while waiting for decode
  if (currentState?.visual?.url !== url) return;

  const nextSlot = activeSlideSlot === 'A' ? 'B' : 'A';
  const nextSlotEl = nextSlot === 'A' ? slideSlotA : slideSlotB;
  const prevSlotEl = activeSlideSlot === 'A' ? slideSlotA : slideSlotB;
  const nextImgEl = nextSlot === 'A' ? slideImgA : slideImgB;

  nextImgEl.classList.toggle('cover-mode', false); // Always preserve full image/slide aspect without cropping
  nextImgEl.src = url;

  requestAnimationFrame(() => {
    visualStage.classList.add('visible');
    nextSlotEl.classList.add('active');
    prevSlotEl.classList.remove('active');
    activeSlideSlot = nextSlot;
    currentSlideUrl = url;
  });
}

function hideVisualLayer() {
  visualStage.classList.remove('visible');
  currentSlideUrl = null;
}

// --- Smooth Video Playback Engine ---
function hideVideoLayer() {
  clearTimeout(videoStopTimer);
  if (!videoLayer.classList.contains('visible') && !stageVideo.src) return;
  videoLayer.classList.remove('visible');
  videoStopTimer = setTimeout(() => {
    if (!videoLayer.classList.contains('visible')) {
      stageVideo.pause();
      stageVideo.removeAttribute('src');
      stageVideo.load();
      lastVideoUrl = null;
    }
  }, 520);
}

function applyVideoState(visual) {
  clearTimeout(videoStopTimer);
  hideVisualLayer();

  const isNewVideo = visual.url !== lastVideoUrl;
  if (isNewVideo) {
    lastVideoUrl = visual.url;
    stageVideo.src = visual.url;
    stageVideo.currentTime = visual.currentTime || 0;
    stageVideo.load();
  }

  stageVideo.volume = typeof visual.volume === 'number' ? visual.volume : 1;
  stageVideo.muted = Boolean(visual.muted);

  if (visual.seekSeq !== lastVideoSeekSeq) {
    lastVideoSeekSeq = visual.seekSeq;
    if (Number.isFinite(visual.seekTo)) {
      try {
        stageVideo.currentTime = visual.seekTo;
      } catch {
        // ignore if metadata not yet loaded
      }
    }
  }

  if (visual.playing) {
    const playPromise = stageVideo.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          videoLayer.classList.add('visible');
        })
        .catch(() => {
          // If browser blocked autoplay with sound before user clicked Stage, try muted so visuals still play
          stageVideo.muted = true;
          stageVideo.play().catch(() => {});
          videoLayer.classList.add('visible');
        });
    } else {
      videoLayer.classList.add('visible');
    }
  } else {
    stageVideo.pause();
    videoLayer.classList.add('visible');
  }
}

let lastVideoProgressSent = 0;
stageVideo.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastVideoProgressSent < 350) return;
  lastVideoProgressSent = now;
  if (currentState?.visual?.type !== 'video') return;
  socket.emit('stage:video-progress', {
    currentTime: stageVideo.currentTime || 0,
    duration: stageVideo.duration || 0,
    playing: !stageVideo.paused,
  });
});

stageVideo.addEventListener('loadedmetadata', () => {
  if (currentState?.visual?.type !== 'video') return;
  socket.emit('stage:video-progress', {
    currentTime: stageVideo.currentTime || 0,
    duration: stageVideo.duration || 0,
    playing: !stageVideo.paused,
  });
});

stageVideo.addEventListener('ended', () => {
  if (currentState?.visual?.type !== 'video') return;
  socket.emit('stage:video-ended');
});

// --- Independent Persistent Background Audio Engine ---
function cancelAudioFadeOut() {
  if (fadeOutAnimFrame) {
    cancelAnimationFrame(fadeOutAnimFrame);
    fadeOutAnimFrame = null;
  }
}

function startAudioFadeOut(durationMs = 3000) {
  cancelAudioFadeOut();
  const startVol = bgAudio.volume;
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    bgAudio.volume = Math.max(0, startVol * (1 - progress));
    if (progress < 1) {
      fadeOutAnimFrame = requestAnimationFrame(step);
    } else {
      fadeOutAnimFrame = null;
      bgAudio.pause();
      bgAudio.currentTime = 0;
      socket.emit('stage:fade-out-done');
    }
  }

  fadeOutAnimFrame = requestAnimationFrame(step);
}

function applyAudioState(audio) {
  if (!audio || !audio.url) {
    cancelAudioFadeOut();
    bgAudio.pause();
    bgAudio.removeAttribute('src');
    lastAudioUrl = null;
    return;
  }

  const isNewTrack = audio.url !== lastAudioUrl;
  if (isNewTrack) {
    cancelAudioFadeOut();
    lastAudioUrl = audio.url;
    bgAudio.src = audio.url;
    bgAudio.currentTime = audio.currentTime || 0;
    bgAudio.load();
  }

  bgAudio.loop = Boolean(audio.loop);

  if (audio.seekSeq !== lastAudioSeekSeq) {
    lastAudioSeekSeq = audio.seekSeq;
    if (Number.isFinite(audio.seekTo)) {
      try {
        bgAudio.currentTime = audio.seekTo;
      } catch {
        // ignore
      }
    }
  }

  if (audio.fadingOut) {
    if (!fadeOutAnimFrame && !bgAudio.paused) {
      startAudioFadeOut(3000);
    }
    return;
  }

  cancelAudioFadeOut();
  bgAudio.volume = typeof audio.volume === 'number' ? Math.max(0, Math.min(1, audio.volume)) : 0.75;

  if (audio.playing) {
    if (bgAudio.paused) {
      bgAudio.play().catch(() => {});
    }
  } else {
    bgAudio.pause();
    if (audio.currentTime === 0 && bgAudio.currentTime > 0.2) {
      bgAudio.currentTime = 0;
    }
  }
}

let lastAudioProgressSent = 0;
bgAudio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastAudioProgressSent < 450) return;
  lastAudioProgressSent = now;
  if (!lastAudioUrl) return;
  socket.emit('stage:audio-progress', {
    currentTime: bgAudio.currentTime || 0,
    duration: bgAudio.duration || 0,
    playing: !bgAudio.paused,
  });
});

bgAudio.addEventListener('ended', () => {
  if (!bgAudio.loop) {
    socket.emit('stage:audio-ended');
  }
});

// --- Apply Full State Sync from Server ---
async function applyState(state) {
  currentState = state;

  // 1. QR Overlay visibility & pairing status
  qrOverlay.classList.toggle('visible', Boolean(state.showQr));
  if (state.remoteCount > 0) {
    qrStatusPill.textContent =
      state.remoteCount === 1 ? '● שלט מחובר' : `● ${state.remoteCount} שלטים מחוברים`;
    qrStatusPill.classList.add('paired');
  } else {
    qrStatusPill.textContent = 'ממתין לסריקת שלט...';
    qrStatusPill.classList.remove('paired');
  }

  // 2. Master Background
  setMasterBackground(state.masterBackgroundUrl);

  // 3. Visual Program
  const visual = state.visual || { type: 'idle' };
  if (visual.type === 'idle') {
    hideVisualLayer();
    hideVideoLayer();
  } else if (visual.type === 'image') {
    await showVisualImage(visual.url, { isFullImage: true });
  } else if (visual.type === 'deck') {
    if (visual.url) {
      await showVisualImage(visual.url, { isFullImage: false });
      preloadAdjacentSlides(visual.itemId, visual.slideIndex);
    } else if (visual.pdfUrl && visual.itemId && !renderingPdfIds.has(visual.itemId)) {
      // Fallback: if an uncached PDF went live directly, render & cache it right here
      const deck = library.decks?.find((d) => d.id === visual.itemId);
      if (deck && deck.needsClientRender) {
        renderingPdfIds.add(visual.itemId);
        renderAndCachePdfDeck(deck)
          .catch((err) => console.error('[stage] PDF fallback render failed:', err))
          .finally(() => renderingPdfIds.delete(visual.itemId));
      }
    }
  } else if (visual.type === 'video') {
    applyVideoState(visual);
  }

  // 4. Independent Background Audio
  applyAudioState(state.audio);
}

// --- Socket Listeners ---
socket.on('connect', () => {
  if (sessionId) {
    socket.emit('session:join', { sessionId, role: 'stage' });
    if (audioUnlocked) {
      socket.emit('stage:audio-unlocked', { unlocked: true });
    }
  }
});

socket.on('library:updated', (data) => {
  library = data || library;
  if (currentState?.visual?.type === 'deck') {
    preloadAdjacentSlides(currentState.visual.itemId, currentState.visual.slideIndex);
  }
});

socket.on('state:sync', (state) => {
  applyState(state);
});

initSessionAndQr().catch((err) => {
  console.error('[stage] Init failed:', err);
  qrUrlText.textContent = 'שגיאה בטעינת החיבור';
});
