const os = require('os');
const QRCode = require('qrcode');

/**
 * Prioritize real LAN Wi-Fi / Ethernet IPv4 addresses over virtual adapters (WSL, Hyper-V, VPN, Docker).
 */
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const lower = name.toLowerCase();
      let score = 50;

      if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan') || lower.includes('en0')) {
        score += 40;
      } else if (lower.includes('ethernet') || lower.includes('eth')) {
        score += 25;
      }

      if (
        lower.includes('vethernet') ||
        lower.includes('wsl') ||
        lower.includes('hyper-v') ||
        lower.includes('docker') ||
        lower.includes('virtual') ||
        lower.includes('vbox') ||
        lower.includes('vmware') ||
        lower.includes('tailscale') ||
        lower.includes('zerotier') ||
        lower.includes('loopback')
      ) {
        score -= 45;
      }

      // Standard private LAN ranges
      if (addr.address.startsWith('192.168.')) score += 20;
      else if (addr.address.startsWith('10.')) score += 10;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr.address)) score += 5;

      candidates.push({ name, address: addr.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function getPrimaryLanIp() {
  if (process.env.PUBLIC_HOST) {
    return process.env.PUBLIC_HOST;
  }
  const addrs = getLanAddresses();
  return addrs.length > 0 ? addrs[0].address : 'localhost';
}

async function generateQrDataUrl(url) {
  return QRCode.toDataURL(url, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

module.exports = {
  getLanAddresses,
  getPrimaryLanIp,
  generateQrDataUrl,
};
