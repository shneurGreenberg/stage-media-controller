/**
 * 100% Client-Side Presentation Converter for GitHub Pages (Static Mode).
 * - PDF  -> High-DPI Canvas rendered via locally bundled pdfjs-dist -> WebP/PNG Blobs
 * - PPTX -> Pure-JS JSZip + browser DOMParser -> Crisp 16:9 SVG Blobs (with Hebrew RTL & embedded images)
 * - Image Decks -> Naturally sorted image Blobs
 */

let pdfjsLibPromise = null;

async function loadPdfJs() {
  if (!pdfjsLibPromise) {
    const pdfUrl = new URL('../vendor/pdfjs/pdf.mjs', import.meta.url).href;
    const workerUrl = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
    pdfjsLibPromise = import(pdfUrl).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export async function convertPdfFileToSlideBlobs(file, onProgress) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const total = pdf.numPages;
  const blobs = [];

  for (let pageNum = 1; pageNum <= total; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const baseVp = page.getViewport({ scale: 1 });
    const targetWidth = Math.min(1920, Math.max(1280, baseVp.width * 2));
    const scale = targetWidth / baseVp.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    let blob = await canvasToBlob(canvas, 'image/webp', 0.88);
    if (!blob || blob.type !== 'image/webp') {
      blob = await canvasToBlob(canvas, 'image/png', 1);
    }
    blobs.push(blob);
    if (typeof onProgress === 'function') onProgress(pageNum, total);
  }

  return blobs;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isRtlText(text) {
  return /[\u0590-\u05FF\u0600-\u06FF]/.test(text || '');
}

function wrapTextLines(text, maxChars) {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function findFirstByLocalName(el, localName) {
  if (!el) return null;
  for (const child of el.children || []) {
    if (child.localName === localName) return child;
  }
  return null;
}

function findAllByLocalName(el, localName) {
  if (!el) return [];
  const res = [];
  for (const child of el.children || []) {
    if (child.localName === localName) res.push(child);
  }
  return res;
}

function extractColorFromEl(fillEl, fallback = null) {
  if (!fillEl) return fallback;
  const srgb = findFirstByLocalName(fillEl, 'srgbClr');
  if (srgb && srgb.getAttribute('val')) {
    return `#${srgb.getAttribute('val')}`;
  }
  const scheme = findFirstByLocalName(fillEl, 'schemeClr');
  if (scheme && scheme.getAttribute('val')) {
    const map = {
      dk1: '#111827',
      dk2: '#1e293b',
      lt1: '#ffffff',
      lt2: '#f1f5f9',
      tx1: '#111827',
      tx2: '#334155',
      bg1: '#ffffff',
      bg2: '#f8fafc',
      accent1: '#2563eb',
      accent2: '#ea580c',
      accent3: '#64748b',
      accent4: '#eab308',
      accent5: '#0284c7',
      accent6: '#16a34a',
    };
    return map[scheme.getAttribute('val')] || fallback;
  }
  return fallback;
}

function getEmbedAttr(el) {
  if (!el) return null;
  for (const attr of Array.from(el.attributes || [])) {
    if (attr.localName === 'embed' || attr.name.endsWith(':embed')) {
      return attr.value;
    }
  }
  return null;
}

export async function convertPptxFileToSlideBlobs(file, onProgress) {
  if (!window.JSZip) throw new Error('JSZip לא נטען');
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const domParser = new DOMParser();

  let slideWidthEmu = 12192000;
  let slideHeightEmu = 6858000;
  const presEntry = zip.file('ppt/presentation.xml');
  if (presEntry) {
    try {
      const presDoc = domParser.parseFromString(await presEntry.async('text'), 'application/xml');
      const sldSz = presDoc.getElementsByTagNameNS('*', 'sldSz')[0];
      if (sldSz) {
        slideWidthEmu = Number(sldSz.getAttribute('cx')) || slideWidthEmu;
        slideHeightEmu = Number(sldSz.getAttribute('cy')) || slideHeightEmu;
      }
    } catch {
      // default 16:9
    }
  }

  const canvasW = 1920;
  const canvasH = Math.round((slideHeightEmu / slideWidthEmu) * canvasW) || 1080;
  const scaleX = canvasW / slideWidthEmu;
  const scaleY = canvasH / slideHeightEmu;

  const slideEntries = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide(\d+)\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]));

  if (slideEntries.length === 0) {
    throw new Error('לא נמצאו שקפים בקובץ ה-PPTX');
  }

  // Extract embedded media as base64 data URLs
  const mediaMap = new Map();
  const mimeMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith('ppt/media/') && !zip.files[name].dir) {
      const base = name.split('/').pop();
      const ext = (base.split('.').pop() || '').toLowerCase();
      if (mimeMap[ext]) {
        const b64 = await zip.files[name].async('base64');
        mediaMap.set(base, `data:${mimeMap[ext]};base64,${b64}`);
      }
    }
  }

  const blobs = [];

  for (let i = 0; i < slideEntries.length; i++) {
    const entryPath = slideEntries[i];
    const xmlText = await zip.file(entryPath).async('text');
    const doc = domParser.parseFromString(xmlText, 'application/xml');

    // Slide relationships
    const relPath = entryPath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relMap = new Map();
    if (zip.file(relPath)) {
      try {
        const relDoc = domParser.parseFromString(await zip.file(relPath).async('text'), 'application/xml');
        for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
          const id = rel.getAttribute('Id');
          const target = rel.getAttribute('Target');
          if (id && target) relMap.set(id, target.split('/').pop());
        }
      } catch {
        // ignore
      }
    }

    const cSld = doc.getElementsByTagNameNS('*', 'cSld')[0];
    const spTree = findFirstByLocalName(cSld, 'spTree');

    let bgFill = '#ffffff';
    let bgImageHref = null;
    const bgPr = findFirstByLocalName(findFirstByLocalName(cSld, 'bg'), 'bgPr');
    if (bgPr) {
      const solid = findFirstByLocalName(bgPr, 'solidFill');
      if (solid) bgFill = extractColorFromEl(solid, bgFill);
      const blipFill = findFirstByLocalName(bgPr, 'blipFill');
      const blip = findFirstByLocalName(blipFill, 'blip');
      const rId = getEmbedAttr(blip);
      if (rId && relMap.has(rId) && mediaMap.has(relMap.get(rId))) {
        bgImageHref = mediaMap.get(relMap.get(rId));
      }
    }

    const svgParts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}">`,
      `<rect width="100%" height="100%" fill="${bgFill}" />`,
    ];

    if (bgImageHref) {
      svgParts.push(
        `<image href="${bgImageHref}" x="0" y="0" width="${canvasW}" height="${canvasH}" preserveAspectRatio="xMidYMid slice" />`
      );
    }

    // Embedded pictures
    for (const pic of findAllByLocalName(spTree, 'pic')) {
      const blip = findFirstByLocalName(findFirstByLocalName(pic, 'blipFill'), 'blip');
      const rId = getEmbedAttr(blip);
      const href = rId && relMap.has(rId) ? mediaMap.get(relMap.get(rId)) : null;
      const xfrm = findFirstByLocalName(findFirstByLocalName(pic, 'spPr'), 'xfrm');
      if (!href || !xfrm) continue;
      const off = findFirstByLocalName(xfrm, 'off');
      const ext = findFirstByLocalName(xfrm, 'ext');
      const x = Math.round((Number(off?.getAttribute('x')) || 0) * scaleX);
      const y = Math.round((Number(off?.getAttribute('y')) || 0) * scaleY);
      const w = Math.round((Number(ext?.getAttribute('cx')) || 0) * scaleX);
      const h = Math.round((Number(ext?.getAttribute('cy')) || 0) * scaleY);
      if (w > 0 && h > 0) {
        svgParts.push(
          `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />`
        );
      }
    }

    // Shapes & Text boxes
    let defaultY = 180;
    for (const sp of findAllByLocalName(spTree, 'sp')) {
      const spPr = findFirstByLocalName(sp, 'spPr');
      const xfrm = findFirstByLocalName(spPr, 'xfrm');
      let x = 120;
      let y = defaultY;
      let w = canvasW - 240;
      let h = 240;

      if (xfrm) {
        const off = findFirstByLocalName(xfrm, 'off');
        const ext = findFirstByLocalName(xfrm, 'ext');
        if (off && ext) {
          x = Math.round((Number(off.getAttribute('x')) || 0) * scaleX);
          y = Math.round((Number(off.getAttribute('y')) || 0) * scaleY);
          w = Math.round((Number(ext.getAttribute('cx')) || 0) * scaleX);
          h = Math.round((Number(ext.getAttribute('cy')) || 0) * scaleY);
        }
      } else {
        defaultY += 220;
      }

      const shapeSolid = findFirstByLocalName(spPr, 'solidFill');
      if (shapeSolid && w > 0 && h > 0) {
        const shapeColor = extractColorFromEl(shapeSolid, null);
        if (shapeColor) {
          svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${shapeColor}" />`);
        }
      }

      const txBody = findFirstByLocalName(sp, 'txBody');
      if (!txBody) continue;

      const nvPr = findFirstByLocalName(findFirstByLocalName(sp, 'nvSpPr'), 'nvPr');
      const phType = findFirstByLocalName(nvPr, 'ph')?.getAttribute('type') || '';
      const isTitle = phType === 'title' || phType === 'ctrTitle';

      let cursorY = y + 20;
      for (const p of findAllByLocalName(txBody, 'p')) {
        const pPr = findFirstByLocalName(p, 'pPr');
        const runs = findAllByLocalName(p, 'r');
        const chunks = [];
        let fontSizePx = isTitle ? 72 : 42;
        let fontColor = bgFill === '#ffffff' ? '#0f172a' : '#f8fafc';
        let fontWeight = isTitle ? '700' : '400';

        for (const r of runs) {
          const tEl = findFirstByLocalName(r, 't');
          if (tEl && tEl.textContent) chunks.push(tEl.textContent);
          const rPr = findFirstByLocalName(r, 'rPr');
          if (rPr) {
            const sz = rPr.getAttribute('sz');
            if (sz) fontSizePx = Math.max(20, Math.min(140, Math.round((Number(sz) / 100) * 1.9)));
            if (rPr.getAttribute('b') === '1') fontWeight = '700';
            const rSolid = findFirstByLocalName(rPr, 'solidFill');
            if (rSolid) fontColor = extractColorFromEl(rSolid, fontColor);
          }
        }

        const fullLine = chunks.join('').trim();
        if (!fullLine) {
          cursorY += Math.round(fontSizePx * 0.65);
          continue;
        }

        const rtl = pPr?.getAttribute('rtl') === '1' || isRtlText(fullLine);
        const algn = pPr?.getAttribute('algn') || (isTitle ? 'ctr' : rtl ? 'r' : 'l');
        let anchor = 'start';
        let textX = x + 20;
        if (algn === 'ctr') {
          anchor = 'middle';
          textX = x + Math.round(w / 2);
        } else if (algn === 'r' || (rtl && algn !== 'l')) {
          anchor = 'end';
          textX = x + w - 20;
        }

        const maxChars = Math.max(12, Math.floor((w - 40) / (fontSizePx * 0.54)));
        for (const line of wrapTextLines(fullLine, maxChars)) {
          cursorY += Math.round(fontSizePx * 1.22);
          svgParts.push(
            `<text x="${textX}" y="${cursorY}" fill="${fontColor}" font-size="${fontSizePx}" font-weight="${fontWeight}" font-family="'Segoe UI', 'Heebo', 'Arial', sans-serif" text-anchor="${anchor}" direction="${rtl ? 'rtl' : 'ltr'}" unicode-bidi="plaintext">${escapeXml(line)}</text>`
          );
        }
        cursorY += Math.round(fontSizePx * 0.35);
      }
    }

    svgParts.push('</svg>');
    blobs.push(new Blob([svgParts.join('\n')], { type: 'image/svg+xml;charset=utf-8' }));
    if (typeof onProgress === 'function') onProgress(i + 1, slideEntries.length);
  }

  return blobs;
}
