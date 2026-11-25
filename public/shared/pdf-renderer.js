/**
 * Offline client-side PDF high-DPI slide renderer using locally bundled pdfjs-dist.
 * Renders every PDF page onto an HTML5 canvas at ~1600px width, exports crisp WebP/PNG
 * images, and uploads them to the server so both Stage Display and Mobile Remote
 * enjoy zero-flicker preloaded slides.
 */

let pdfjsLibPromise = null;

async function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('/vendor/pdfjs/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
      return lib;
    });
  }
  return pdfjsLibPromise;
}

export async function renderPdfToDataUrls(pdfUrl, onProgress) {
  const pdfjsLib = await loadPdfJs();
  const loadingTask = pdfjsLib.getDocument(pdfUrl);
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const rendered = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    // Target crisp Full-HD width (max 1920px) without excessive memory on phones
    const targetWidth = Math.min(1920, Math.max(1280, baseViewport.width * 2));
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Prefer WebP for fast LAN preloading; fall back to PNG if browser doesn't support WebP encoding
    let dataUrl = canvas.toDataURL('image/webp', 0.9);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/png');
    }
    rendered.push(dataUrl);

    if (typeof onProgress === 'function') {
      onProgress(pageNum, totalPages);
    }
  }

  return rendered;
}

export async function renderAndCachePdfDeck(deck, onProgress) {
  if (!deck || !deck.pdfUrl) return deck;
  const slides = await renderPdfToDataUrls(deck.pdfUrl, onProgress);

  const res = await fetch(`/api/decks/${encodeURIComponent(deck.id)}/rendered-slides`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slides }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to cache rendered PDF slides');
  }

  const data = await res.json();
  return data.deck;
}
