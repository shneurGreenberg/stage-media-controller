const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const execFileAsync = promisify(execFile);

function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Direct file path check
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    // PATH lookup
    try {
      const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
      const out = execFileSync(cmd, [candidate], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
        .split(/\r?\n/)[0];
      if (out && fs.existsSync(out.trim())) {
        return out.trim();
      }
    } catch {
      // ignore not found
    }
  }
  return null;
}

function detectTools() {
  const soffice = findExecutable([
    process.env.SOFFICE_PATH,
    'soffice',
    'libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ]);

  const pdftoppm = findExecutable([
    process.env.PDFTOPPM_PATH,
    'pdftoppm',
    'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
    'C:\\Program Files\\poppler\\bin\\pdftoppm.exe',
    '/opt/homebrew/bin/pdftoppm',
    '/usr/bin/pdftoppm',
  ]);

  return { soffice, pdftoppm };
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toArray(val) {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function isRtlText(text) {
  return /[\u0590-\u05FF\u0600-\u06FF]/.test(text || '');
}

function extractColor(node, fallback = null) {
  if (!node || typeof node !== 'object') return fallback;
  const srgb = node['a:srgbClr'];
  if (srgb && srgb['@_val']) {
    return `#${srgb['@_val']}`;
  }
  const scheme = node['a:schemeClr'];
  if (scheme && scheme['@_val']) {
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
    return map[scheme['@_val']] || fallback;
  }
  return fallback;
}

function wrapTextLines(text, maxChars) {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Pure-Node PPTX -> High-resolution SVG slides fallback (zero external CLI dependencies).
 * Extracts slide geometry, solid backgrounds, embedded images, shapes, and RTL/LTR text blocks.
 */
async function convertPptxBuiltinSvg(pptxPath, outDir, deckId) {
  fs.mkdirSync(outDir, { recursive: true });
  const data = fs.readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(data);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    trimValues: false,
  });

  // Slide size in EMUs (default 16:9 widescreen: 12192000 x 6858000)
  let slideWidthEmu = 12192000;
  let slideHeightEmu = 6858000;
  const presXmlFile = zip.file('ppt/presentation.xml');
  if (presXmlFile) {
    try {
      const presXml = parser.parse(await presXmlFile.async('text'));
      const sldSz = presXml?.['p:presentation']?.['p:sldSz'];
      if (sldSz && sldSz['@_cx'] && sldSz['@_cy']) {
        slideWidthEmu = Number(sldSz['@_cx']) || slideWidthEmu;
        slideHeightEmu = Number(sldSz['@_cy']) || slideHeightEmu;
      }
    } catch {
      // use default 16:9
    }
  }

  const canvasW = 1920;
  const canvasH = Math.round((slideHeightEmu / slideWidthEmu) * canvasW) || 1080;
  const scaleX = canvasW / slideWidthEmu;
  const scaleY = canvasH / slideHeightEmu;

  // Find ordered slide XML files
  const slideEntries = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide(\d+)\.xml$/.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)[1]);
      return na - nb;
    });

  if (slideEntries.length === 0) {
    throw new Error('לא נמצאו שקפים בתוך קובץ ה-PPTX');
  }

  const slides = [];
  const mediaOutDir = path.join(outDir, 'media');
  fs.mkdirSync(mediaOutDir, { recursive: true });

  // Extract media files to serve cleanly
  const mediaMap = new Map();
  for (const fileName of Object.keys(zip.files)) {
    if (fileName.startsWith('ppt/media/') && !zip.files[fileName].dir) {
      const base = path.basename(fileName);
      const buf = await zip.files[fileName].async('nodebuffer');
      const ext = path.extname(base).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
      };
      if (mimeMap[ext]) {
        mediaMap.set(base, `data:${mimeMap[ext]};base64,${buf.toString('base64')}`);
      }
    }
  }

  for (let i = 0; i < slideEntries.length; i++) {
    const entryPath = slideEntries[i];
    const slideNum = i + 1;
    const xmlStr = await zip.file(entryPath).async('text');
    const parsed = parser.parse(xmlStr);

    // Load slide relationships (to resolve embedded images)
    const relPath = entryPath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relMap = new Map();
    if (zip.file(relPath)) {
      try {
        const relParsed = parser.parse(await zip.file(relPath).async('text'));
        for (const rel of toArray(relParsed?.Relationships?.Relationship)) {
          if (rel['@_Id'] && rel['@_Target']) {
            relMap.set(rel['@_Id'], path.basename(rel['@_Target']));
          }
        }
      } catch {
        // ignore
      }
    }

    const sld = parsed?.['p:sld'];
    const cSld = sld?.['p:cSld'];
    const spTree = cSld?.['p:spTree'] || {};

    // Determine background color or image
    let bgFill = '#0f172a';
    let bgImageHref = null;
    const bgPr = cSld?.['p:bg']?.['p:bgPr'];
    if (bgPr) {
      if (bgPr['a:solidFill']) {
        bgFill = extractColor(bgPr['a:solidFill'], bgFill);
      } else if (bgPr['a:blipFill']?.['a:blip']?.['@_r:embed']) {
        const mediaName = relMap.get(bgPr['a:blipFill']['a:blip']['@_r:embed']);
        if (mediaName && mediaMap.has(mediaName)) {
          bgImageHref = mediaMap.get(mediaName);
        }
      }
    } else {
      // Clean light presentation canvas when no explicit dark background is set
      bgFill = '#ffffff';
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

    // Render pictures (p:pic)
    for (const pic of toArray(spTree['p:pic'])) {
      const embedId = pic?.['p:blipFill']?.['a:blip']?.['@_r:embed'];
      const xfrm = pic?.['p:spPr']?.['a:xfrm'];
      if (!embedId || !xfrm) continue;
      const mediaName = relMap.get(embedId);
      const href = mediaName ? mediaMap.get(mediaName) : null;
      if (!href) continue;

      const x = Math.round((Number(xfrm?.['a:off']?.['@_x']) || 0) * scaleX);
      const y = Math.round((Number(xfrm?.['a:off']?.['@_y']) || 0) * scaleY);
      const w = Math.round((Number(xfrm?.['a:ext']?.['@_cx']) || 0) * scaleX);
      const h = Math.round((Number(xfrm?.['a:ext']?.['@_cy']) || 0) * scaleY);
      if (w > 0 && h > 0) {
        svgParts.push(
          `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />`
        );
      }
    }

    // Render shapes & text frames (p:sp)
    let defaultTextY = 180;
    for (const sp of toArray(spTree['p:sp'])) {
      const spPr = sp?.['p:spPr'] || {};
      const xfrm = spPr['a:xfrm'];
      let x = 120;
      let y = defaultTextY;
      let w = canvasW - 240;
      let h = 240;

      if (xfrm?.['a:off'] && xfrm?.['a:ext']) {
        x = Math.round((Number(xfrm['a:off']['@_x']) || 0) * scaleX);
        y = Math.round((Number(xfrm['a:off']['@_y']) || 0) * scaleY);
        w = Math.round((Number(xfrm['a:ext']['@_cx']) || 0) * scaleX);
        h = Math.round((Number(xfrm['a:ext']['@_cy']) || 0) * scaleY);
      } else {
        defaultTextY += 220;
      }

      // Optional shape solid fill
      if (spPr['a:solidFill'] && w > 0 && h > 0) {
        const shapeColor = extractColor(spPr['a:solidFill'], null);
        if (shapeColor) {
          svgParts.push(
            `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${shapeColor}" />`
          );
        }
      }

      const txBody = sp?.['p:txBody'];
      if (!txBody) continue;

      const placeholderType = sp?.['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'] || '';
      const isTitle = placeholderType === 'title' || placeholderType === 'ctrTitle';

      let cursorY = y + 20;
      const paragraphs = toArray(txBody['a:p']);
      for (const p of paragraphs) {
        const pPr = p?.['a:pPr'] || {};
        const runs = toArray(p?.['a:r']);
        const textChunks = [];
        let fontSizePx = isTitle ? 72 : 42;
        let fontColor = bgFill === '#ffffff' ? '#0f172a' : '#f8fafc';
        let fontWeight = isTitle ? '700' : '400';

        for (const r of runs) {
          const t = r?.['a:t'];
          if (t !== undefined && t !== null) {
            textChunks.push(typeof t === 'object' ? String(t['#text'] || '') : String(t));
          }
          const rPr = r?.['a:rPr'];
          if (rPr) {
            if (rPr['@_sz']) {
              // PowerPoint size is in hundredths of a point -> scale roughly for 1920x1080
              fontSizePx = Math.max(20, Math.min(140, Math.round((Number(rPr['@_sz']) / 100) * 1.9)));
            }
            if (rPr['@_b'] === '1' || rPr['@_b'] === true) {
              fontWeight = '700';
            }
            if (rPr['a:solidFill']) {
              fontColor = extractColor(rPr['a:solidFill'], fontColor);
            }
          }
        }

        const fullLine = textChunks.join('').trim();
        if (!fullLine) {
          cursorY += Math.round(fontSizePx * 0.65);
          continue;
        }

        const rtl = pPr['@_rtl'] === '1' || isRtlText(fullLine);
        const align = pPr['@_algn'] || (isTitle ? 'ctr' : rtl ? 'r' : 'l');
        let anchor = 'start';
        let textX = x + 20;
        if (align === 'ctr') {
          anchor = 'middle';
          textX = x + Math.round(w / 2);
        } else if (align === 'r' || (rtl && align !== 'l')) {
          anchor = 'end';
          textX = x + w - 20;
        }

        const avgCharWidth = fontSizePx * 0.54;
        const maxChars = Math.max(12, Math.floor((w - 40) / avgCharWidth));
        const wrapped = wrapTextLines(fullLine, maxChars);

        for (const lineText of wrapped) {
          cursorY += Math.round(fontSizePx * 1.22);
          svgParts.push(
            `<text x="${textX}" y="${cursorY}" fill="${fontColor}" font-size="${fontSizePx}" font-weight="${fontWeight}" font-family="'Segoe UI', 'Heebo', 'Arial', sans-serif" text-anchor="${anchor}" direction="${rtl ? 'rtl' : 'ltr'}" unicode-bidi="plaintext">${escapeXml(lineText)}</text>`
          );
        }
        cursorY += Math.round(fontSizePx * 0.35);
      }
    }

    svgParts.push('</svg>');

    const slideFileName = `slide-${String(slideNum).padStart(3, '0')}.svg`;
    const slideFilePath = path.join(outDir, slideFileName);
    fs.writeFileSync(slideFilePath, svgParts.join('\n'), 'utf8');

    slides.push({
      index: i,
      url: `/media/decks/${deckId}/${slideFileName}`,
    });
  }

  return {
    slides,
    method: 'builtin-pptx-svg',
    needsClientRender: false,
  };
}

/**
 * Convert a PDF file into high-resolution PNG slides using pdftoppm if available.
 * Returns null if pdftoppm is unavailable (so client-side pdf.js fallback kicks in).
 */
async function convertPdfWithPoppler(pdfPath, outDir, deckId, pdftoppm) {
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = path.join(outDir, 'slide');
  await execFileAsync(pdftoppm, ['-png', '-r', '180', pdfPath, prefix], {
    timeout: 120000,
  });

  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^slide-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide-(\d+)\.png$/i)[1]);
      const nb = Number(b.match(/slide-(\d+)\.png$/i)[1]);
      return na - nb;
    });

  if (files.length === 0) {
    throw new Error('pdftoppm did not produce slide images');
  }

  return {
    slides: files.map((file, index) => ({
      index,
      url: `/media/decks/${deckId}/${file}`,
    })),
    method: 'poppler-png',
    needsClientRender: false,
  };
}

/**
 * Full presentation conversion pipeline:
 * - PPTX: LibreOffice -> PDF -> Poppler PNG (best) | LibreOffice -> PDF (client pdf.js) | Built-in PPTX->SVG parser
 * - PDF:  Poppler PNG (best) | Serve PDF for bundled client-side pdf.js rendering & auto-upload caching
 */
async function processPresentationUpload({ filePath, originalName, deckId, decksDir, uploadedUrl }) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const outDir = path.join(decksDir, deckId);
  fs.mkdirSync(outDir, { recursive: true });
  const tools = detectTools();

  if (ext === '.pptx' || ext === '.ppt') {
    // Tier 1: LibreOffice headless -> PDF (+ Poppler -> PNG)
    if (tools.soffice) {
      try {
        await execFileAsync(
          tools.soffice,
          ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath],
          { timeout: 120000 }
        );
        const generatedPdf = fs
          .readdirSync(outDir)
          .find((f) => f.toLowerCase().endsWith('.pdf'));

        if (generatedPdf) {
          const pdfFullPath = path.join(outDir, generatedPdf);
          if (tools.pdftoppm) {
            return await convertPdfWithPoppler(pdfFullPath, outDir, deckId, tools.pdftoppm);
          }
          // LibreOffice succeeded without pdftoppm -> let client pdf.js render & cache PNG slides
          return {
            slides: [],
            pdfUrl: `/media/decks/${deckId}/${generatedPdf}`,
            method: 'libreoffice-pdf-client-render',
            needsClientRender: true,
          };
        }
      } catch (err) {
        console.warn('[converter] LibreOffice conversion failed, falling back:', err.message);
      }
    }

    // Tier 2: Built-in pure-Node PPTX parser -> crisp SVG slides
    if (ext === '.pptx') {
      return await convertPptxBuiltinSvg(filePath, outDir, deckId);
    }

    throw new Error('קובץ .ppt ישן דורש התקנת LibreOffice על השרת. המר ל-.pptx או .pdf ונסה שוב.');
  }

  if (ext === '.pdf') {
    if (tools.pdftoppm) {
      try {
        return await convertPdfWithPoppler(filePath, outDir, deckId, tools.pdftoppm);
      } catch (err) {
        console.warn('[converter] pdftoppm failed, falling back to browser pdf.js:', err.message);
      }
    }

    return {
      slides: [],
      pdfUrl: uploadedUrl,
      method: 'client-pdfjs',
      needsClientRender: true,
    };
  }

  throw new Error(`סוג קובץ מצגת לא נתמך: ${ext}`);
}

module.exports = {
  detectTools,
  processPresentationUpload,
};
