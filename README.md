# Stage Presentation & Media Controller

Real-time presentation and media controller built for live lessons and events — works **directly on GitHub Pages (serverless WebRTC P2P)** or **100% offline over local Wi-Fi** with Node.js + Socket.io.

## Live Website (GitHub Pages — No Install Required)

- **Stage Display (PC / Projector):** https://shneurgreenberg.github.io/stage-media-controller/
- **Mobile Remote (Phone):** Scan the QR code shown on the Stage Display (or open https://shneurgreenberg.github.io/stage-media-controller/remote.html)

In GitHub Pages mode, the phone and stage connect directly over WebRTC DataChannel (PeerJS) with chunked binary transfer, IndexedDB media storage, and 100% browser-side `.pptx` & `.pdf` slide rendering.

## Views

1. **Stage Display View (`/stage` or `/`)** — Open fullscreen on the computer connected to a projector or TV:
   - Displays a subtle QR code & 6-character pairing code using the machine's local Wi-Fi IP.
   - Always reverts cleanly to the **Master Background Image** with smooth CSS cross-fades (zero black flashes).
   - Auto-hides mouse cursor after 2 seconds; no menus or chrome visible during presentation.
   - Supports full-screen images, videos (with sound, seek, play/pause, and auto-return to Master Background on finish), PowerPoint/PDF/image decks with next/prev slide preloading, and independent background music with smooth 3-second fade-out.
   - Keyboard shortcuts on Stage: `F` (toggle fullscreen), `Q` (toggle QR), `→` / `←` (next/prev slide).

2. **Mobile Remote Controller View (`/remote`)** — Scan the QR code on a smartphone (same Wi-Fi):
   - High-contrast Hebrew RTL (`dir="rtl"`) mobile interface with large thumb-friendly controls.
   - **Preview vs. Live (Program) workflow:** tap any deck, image, or video to inspect it privately on your phone (with swipeable slide preview + thumbnail strip) before pressing **"הצג על המסך"** (Go Live).
   - Prominent **"חזור לרקע ראשי"** (Clear to Background) button and **"QR מוצג / מוסתר"** toggle.
   - Sticky bottom **Background Audio Bar** to control music independently from visual output.

## Quick Start

```bash
cd stage-controller
npm install
npm start
```

Then:
1. On the projector/stage PC, open `http://localhost:3000/stage` and click the subtle top prompt once to enter fullscreen and unlock browser audio.
2. Connect your smartphone to the **same Wi-Fi network** and scan the QR code shown on the Stage Display.
3. Upload your Master Background, presentations (`.pptx`, `.pdf`, or multi-image decks), videos, and background music directly from your phone or laptop (`http://<LAN-IP>:3000/remote?session=<CODE>`).

### Optional Environment Variables

- `PORT` — Server port (default `3000`).
- `PUBLIC_HOST` — Override the detected local Wi-Fi IP for the QR code (useful if your PC has multiple active network adapters).
- `SOFFICE_PATH` / `PDFTOPPM_PATH` — Custom paths to LibreOffice / Poppler executables.

## PowerPoint (`.pptx`) & PDF Conversion Pipeline

The backend automatically chooses the best available rendering pipeline:

1. **Server-side LibreOffice + Poppler (Pixel-Perfect Recommended):**
   - If `soffice` (LibreOffice) and `pdftoppm` (Poppler) are installed, `.pptx` files are converted via `soffice --headless --convert-to pdf` and extracted into high-DPI PNG slides with `pdftoppm`.
   - Windows quick install (optional):
     ```powershell
     winget install TheDocumentFoundation.LibreOffice
     winget install oschwartz10612.Poppler
     ```
2. **Built-In Zero-Dependency Fallbacks (Works Out-of-the-Box Offline):**
   - **`.pdf`**: Automatically rendered at high DPI in the browser using locally bundled `pdfjs-dist` (`/vendor/pdfjs/`) and cached as WebP/PNG slides on the server for instant preloaded switching.
   - **`.pptx`**: Parsed in pure Node.js (`jszip` + `fast-xml-parser`) into crisp 16:9 SVG slides (supporting Hebrew RTL text, colors, backgrounds, and embedded images).
   - **Multi-image decks**: Select multiple PNG/JPG/WebP slides together to create an instant ordered deck.

## Windows Firewall Tip (Local Wi-Fi)

If your phone cannot reach `http://<LAN-IP>:3000` on the same Wi-Fi, allow Node.js / port `3000` on your Private Wi-Fi network in Windows Defender Firewall:

```powershell
New-NetFirewallRule -DisplayName "Stage Media Controller (Port 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```
