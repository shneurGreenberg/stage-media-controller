import { StageHost, makeSessionCode } from './p2p.js';
import { putBlob, getObjectUrl, listBlobIds } from './db.js';

const DEFAULT_BG_URL = './assets/default-master-bg.svg';

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
const cachedAssetIds = new Set();
let activeBgSlot = 'A';
let currentBgUrl = DEFAULT_BG_URL;
let activeSlideSlot = 'A';
let currentSlideAssetId = null;
let currentVideoAssetId = null;
let currentAudioAssetId = null;
let fadeOutAnimFrame = null;
let videoStopTimer = null;
let cursorHideTimer = null;
let host = null;

const state = {
  sessionId: '',
  showQr: true,
  stageConnected: true,
  stageAudioUnlocked: false,
  remoteCount: 0,
  masterBackgroundAssetId: null,
  visual: {
    type: 'idle', // 'idle' | 'image' | 'video' | 'deck'
    itemId: null,
    title: '',
    assetId: null,
    slideIndex: 0,
    slideCount: 0,
    playing: false,
    currentTime: 0,
    duration: 0,
    muted: false,
    volume: 1,
  },
  audio: {
    itemId: null,
    title: '',
    assetId: null,
    playing: false,
    volume: 0.75,
    loop: true,
    currentTime: 0,
    duration: 0,
    fadingOut: false,
  },
};

function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('session');
  if (fromUrl) return fromUrl.trim().toUpperCase();
  const saved = sessionStorage.getItem('static_stage_session');
  if (saved) return saved;
  const fresh = makeSessionCode();
  sessionStorage.setItem('static_stage_session', fresh);
  return fresh;
}

function renderQrCode(remoteUrl) {
  if (typeof window.qrcode !== 'function') return;
  const qr = window.qrcode(0, 'M');
  qr.addData(remoteUrl);
  qr.make();
  qrImage.src = qr.createDataURL(8, 3);
}

function broadcastState(targetConn = null) {
  const payload = {
    type: 'state:sync',
    state: {
      ...state,
      cachedAssetIds: Array.from(cachedAssetIds),
    },
  };
  if (targetConn) targetConn.send(payload);
  else host?.broadcast(payload);
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
  if (!state.stageAudioUnlocked) {
    state.stageAudioUnlocked = true;
    unlockBanner.classList.add('hidden');
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
      }
    } catch {
      // ignore
    }
    if (state.visual.type === 'video' && state.visual.playing && stageVideo.paused) {
      stageVideo.play().catch(() => {});
    }
    if (state.audio.playing && bgAudio.paused) {
      bgAudio.play().catch(() => {});
    }
    broadcastState();
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
  if (!document.fullscreenElement) unlockStageMedia(true);
  else document.exitFullscreen?.().catch(() => {});
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) unlockStageMedia(true);
    else document.exitFullscreen?.().catch(() => {});
  } else if (e.key === 'q' || e.key === 'Q') {
    state.showQr = !state.showQr;
    qrOverlay.classList.toggle('visible', state.showQr);
    broadcastState();
  } else if (e.key === 'Escape' && !document.fullscreenElement) {
    clearVisualToBackground();
  }
});

// --- Image Decode Helper ---
function decodeImageUrl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {}).finally(() => resolve());
      } else {
        resolve();
      }
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

// --- Smooth Master Background Crossfade ---
async function setMasterBackground(assetId) {
  state.masterBackgroundAssetId = assetId || null;
  let url = DEFAULT_BG_URL;
  if (assetId) {
    const resolved = await getObjectUrl(assetId);
    if (resolved) url = resolved;
  }
  if (url === currentBgUrl) return;
  currentBgUrl = url;
  await decodeImageUrl(url);

  const nextSlot = activeBgSlot === 'A' ? 'B' : 'A';
  const nextImg = nextSlot === 'A' ? bgImgA : bgImgB;
  const prevImg = activeBgSlot === 'A' ? bgImgA : bgImgB;

  nextImg.src = url;
  requestAnimationFrame(() => {
    nextImg.classList.add('active');
    prevImg.classList.remove('active');
    activeBgSlot = nextSlot;
  });
}

// --- Smooth Image / Slide Crossfade ---
async function showVisualAsset(assetId) {
  if (!assetId) return;
  hideVideoLayer();
  if (assetId === currentSlideAssetId && visualStage.classList.contains('visible')) return;

  const url = await getObjectUrl(assetId);
  if (!url) return;
  await decodeImageUrl(url);
  if (state.visual.assetId !== assetId) return;

  const nextSlot = activeSlideSlot === 'A' ? 'B' : 'A';
  const nextSlotEl = nextSlot === 'A' ? slideSlotA : slideSlotB;
  const prevSlotEl = activeSlideSlot === 'A' ? slideSlotA : slideSlotB;
  const nextImgEl = nextSlot === 'A' ? slideImgA : slideImgB;

  nextImgEl.src = url;
  requestAnimationFrame(() => {
    visualStage.classList.add('visible');
    nextSlotEl.classList.add('active');
    prevSlotEl.classList.remove('active');
    activeSlideSlot = nextSlot;
    currentSlideAssetId = assetId;
  });
}

function hideVisualLayer() {
  visualStage.classList.remove('visible');
  currentSlideAssetId = null;
}

function clearVisualToBackground() {
  hideVisualLayer();
  hideVideoLayer();
  state.visual = {
    type: 'idle',
    itemId: null,
    title: '',
    assetId: null,
    slideIndex: 0,
    slideCount: 0,
    playing: false,
    currentTime: 0,
    duration: 0,
    muted: false,
    volume: 1,
  };
  broadcastState();
}

// --- Smooth Video Playback ---
function hideVideoLayer() {
  clearTimeout(videoStopTimer);
  if (!videoLayer.classList.contains('visible') && !stageVideo.src) return;
  videoLayer.classList.remove('visible');
  videoStopTimer = setTimeout(() => {
    if (!videoLayer.classList.contains('visible')) {
      stageVideo.pause();
      stageVideo.removeAttribute('src');
      stageVideo.load();
      currentVideoAssetId = null;
    }
  }, 520);
}

async function startVideoAsset(assetId) {
  clearTimeout(videoStopTimer);
  hideVisualLayer();
  const url = await getObjectUrl(assetId);
  if (!url) return;

  if (currentVideoAssetId !== assetId) {
    currentVideoAssetId = assetId;
    stageVideo.src = url;
    stageVideo.currentTime = 0;
    stageVideo.load();
  }
  stageVideo.volume = state.visual.volume;
  stageVideo.muted = state.visual.muted;

  try {
    await stageVideo.play();
    state.visual.playing = true;
    videoLayer.classList.add('visible');
  } catch {
    // Fallback to muted if browser blocked autoplay before user clicked Stage
    stageVideo.muted = true;
    state.visual.muted = true;
    stageVideo.play().catch(() => {});
    videoLayer.classList.add('visible');
  }
  broadcastState();
}

let lastVideoProg = 0;
stageVideo.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastVideoProg < 350 || state.visual.type !== 'video') return;
  lastVideoProg = now;
  state.visual.currentTime = stageVideo.currentTime || 0;
  state.visual.duration = stageVideo.duration || 0;
  state.visual.playing = !stageVideo.paused;
  host?.broadcast({
    type: 'stage:video-progress',
    currentTime: state.visual.currentTime,
    duration: state.visual.duration,
    playing: state.visual.playing,
  });
});

stageVideo.addEventListener('ended', () => {
  if (state.visual.type !== 'video') return;
  clearVisualToBackground();
});

// --- Independent Background Audio Engine ---
function cancelAudioFade() {
  if (fadeOutAnimFrame) {
    cancelAnimationFrame(fadeOutAnimFrame);
    fadeOutAnimFrame = null;
  }
}

function startAudioFadeOut(durationMs = 3000) {
  cancelAudioFade();
  state.audio.fadingOut = true;
  broadcastState();
  const startVol = bgAudio.volume;
  const startTime = performance.now();

  function step(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    bgAudio.volume = Math.max(0, startVol * (1 - t));
    if (t < 1) {
      fadeOutAnimFrame = requestAnimationFrame(step);
    } else {
      fadeOutAnimFrame = null;
      bgAudio.pause();
      bgAudio.currentTime = 0;
      state.audio.playing = false;
      state.audio.fadingOut = false;
      state.audio.currentTime = 0;
      broadcastState();
    }
  }
  fadeOutAnimFrame = requestAnimationFrame(step);
}

let lastAudioProg = 0;
bgAudio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastAudioProg < 450 || !currentAudioAssetId) return;
  lastAudioProg = now;
  state.audio.currentTime = bgAudio.currentTime || 0;
  state.audio.duration = bgAudio.duration || 0;
  state.audio.playing = !bgAudio.paused;
  host?.broadcast({
    type: 'stage:audio-progress',
    currentTime: state.audio.currentTime,
    duration: state.audio.duration,
    playing: state.audio.playing,
  });
});

bgAudio.addEventListener('ended', () => {
  if (!bgAudio.loop) {
    state.audio.playing = false;
    state.audio.fadingOut = false;
    state.audio.currentTime = 0;
    broadcastState();
  }
});

// --- Handle Incoming Commands from Mobile Remote ---
async function handleCommand(msg, conn) {
  switch (msg.type) {
    case 'remote:joined':
      broadcastState(conn);
      break;

    case 'remote:toggle-qr':
      state.showQr = typeof msg.showQr === 'boolean' ? msg.showQr : !state.showQr;
      qrOverlay.classList.toggle('visible', state.showQr);
      broadcastState();
      break;

    case 'remote:set-background':
      await setMasterBackground(msg.assetId || null);
      broadcastState();
      break;

    case 'remote:go-live': {
      state.visual = {
        type: msg.visualType,
        itemId: msg.itemId,
        title: msg.title || '',
        assetId: msg.assetId,
        slideIndex: Number(msg.slideIndex) || 0,
        slideCount: Number(msg.slideCount) || 0,
        playing: msg.visualType === 'video',
        currentTime: 0,
        duration: 0,
        muted: false,
        volume: 1,
      };
      if (msg.visualType === 'image' || msg.visualType === 'deck') {
        await showVisualAsset(msg.assetId);
        broadcastState();
      } else if (msg.visualType === 'video') {
        await startVideoAsset(msg.assetId);
      }
      break;
    }

    case 'remote:clear-visual':
      clearVisualToBackground();
      break;

    case 'remote:video-control': {
      if (state.visual.type !== 'video') break;
      if (msg.action === 'play') {
        stageVideo.play().catch(() => {});
        state.visual.playing = true;
      } else if (msg.action === 'pause') {
        stageVideo.pause();
        state.visual.playing = false;
      } else if (msg.action === 'toggle') {
        if (stageVideo.paused) {
          stageVideo.play().catch(() => {});
          state.visual.playing = true;
        } else {
          stageVideo.pause();
          state.visual.playing = false;
        }
      } else if (msg.action === 'restart') {
        stageVideo.currentTime = 0;
        stageVideo.play().catch(() => {});
        state.visual.currentTime = 0;
        state.visual.playing = true;
      } else if (msg.action === 'seek' && Number.isFinite(Number(msg.value))) {
        stageVideo.currentTime = Math.max(0, Number(msg.value));
        state.visual.currentTime = stageVideo.currentTime;
      } else if (msg.action === 'mute') {
        stageVideo.muted = !stageVideo.muted;
        state.visual.muted = stageVideo.muted;
      }
      broadcastState();
      break;
    }

    case 'remote:audio-control': {
      if (msg.action === 'play-track') {
        cancelAudioFade();
        const url = await getObjectUrl(msg.assetId);
        if (!url) break;
        currentAudioAssetId = msg.assetId;
        state.audio.itemId = msg.itemId;
        state.audio.title = msg.title || 'רצועת שמע';
        state.audio.assetId = msg.assetId;
        state.audio.fadingOut = false;
        bgAudio.src = url;
        bgAudio.loop = state.audio.loop;
        bgAudio.volume = state.audio.volume;
        bgAudio.currentTime = 0;
        bgAudio.play().catch(() => {});
        state.audio.playing = true;
      } else if (msg.action === 'toggle' && currentAudioAssetId) {
        cancelAudioFade();
        state.audio.fadingOut = false;
        if (bgAudio.paused) {
          bgAudio.volume = state.audio.volume;
          bgAudio.play().catch(() => {});
          state.audio.playing = true;
        } else {
          bgAudio.pause();
          state.audio.playing = false;
        }
      } else if (msg.action === 'stop') {
        cancelAudioFade();
        bgAudio.pause();
        bgAudio.currentTime = 0;
        state.audio.playing = false;
        state.audio.fadingOut = false;
        state.audio.currentTime = 0;
      } else if (msg.action === 'fade-out' && state.audio.playing) {
        startAudioFadeOut(3000);
        return;
      } else if (msg.action === 'volume' && Number.isFinite(Number(msg.value))) {
        cancelAudioFade();
        state.audio.fadingOut = false;
        state.audio.volume = Math.max(0, Math.min(1, Number(msg.value)));
        bgAudio.volume = state.audio.volume;
      } else if (msg.action === 'loop') {
        state.audio.loop = !state.audio.loop;
        bgAudio.loop = state.audio.loop;
      }
      broadcastState();
      break;
    }
  }
}

// --- Initialize Stage ---
async function init() {
  const existingIds = await listBlobIds().catch(() => []);
  existingIds.forEach((id) => cachedAssetIds.add(id));

  state.sessionId = getSessionId();
  const url = new URL(window.location.href);
  if (url.searchParams.get('session') !== state.sessionId) {
    url.searchParams.set('session', state.sessionId);
    window.history.replaceState({}, '', url.toString());
  }

  const remoteUrl = new URL(`./remote.html?session=${encodeURIComponent(state.sessionId)}`, window.location.href).href;
  const shortDisplay = `${window.location.host}${new URL('./remote.html', window.location.href).pathname}`;

  qrCodeText.textContent = state.sessionId;
  qrUrlText.textContent = shortDisplay;
  renderQrCode(remoteUrl);

  host = new StageHost(state.sessionId, {
    onStatusChange: (status) => {
      if (status === 'ready' && state.remoteCount === 0) {
        qrStatusPill.textContent = 'מוכן — סרקו לחיבור השלט';
      } else if (status === 'reconnecting') {
        qrStatusPill.textContent = 'מתחבר מחדש...';
      }
    },
    onRemoteCountChange: (count) => {
      state.remoteCount = count;
      if (count > 0) {
        qrStatusPill.textContent = count === 1 ? '● שלט מחובר' : `● ${count} שלטים מחוברים`;
        qrStatusPill.classList.add('paired');
      } else {
        qrStatusPill.textContent = 'מוכן — סרקו לחיבור השלט';
        qrStatusPill.classList.remove('paired');
      }
      broadcastState();
    },
    onAssetReceived: async (assetId, blob) => {
      await putBlob(assetId, blob);
      cachedAssetIds.add(assetId);
      // Warm-decode images/slides in memory immediately for zero-flicker transitions
      if (blob.type.startsWith('image/')) {
        const objUrl = await getObjectUrl(assetId);
        if (objUrl) decodeImageUrl(objUrl);
      }
    },
    onCommand: handleCommand,
  });
}

init();
