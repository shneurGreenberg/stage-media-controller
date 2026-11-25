/**
 * PeerJS WebRTC DataChannel + Same-Browser BroadcastChannel Real-Time Transport.
 * Works 100% statically on GitHub Pages with zero backend server!
 * Supports chunked binary asset transfer (32KB chunks with backpressure) for images,
 * slides, videos, and audio directly from Phone -> Stage Display.
 */

const PEER_PREFIX = 'smctrl-stage-v1-';
const CHUNK_SIZE = 32 * 1024;
const PEER_CONFIG = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  },
};

export function makeSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

/**
 * Stage Display Host: accepts connections from Mobile Remotes over PeerJS WebRTC
 * AND same-browser BroadcastChannel tabs.
 */
export class StageHost {
  constructor(sessionId, { onRemoteCountChange, onCommand, onAssetReceived, onStatusChange }) {
    this.sessionId = sessionId.toUpperCase();
    this.onRemoteCountChange = onRemoteCountChange;
    this.onCommand = onCommand;
    this.onAssetReceived = onAssetReceived;
    this.onStatusChange = onStatusChange;

    this.connections = new Map(); // id -> { send(msg), isOpen() }
    this.incomingTransfers = new Map(); // assetId -> { mimeType, totalChunks, chunks, received }
    this.peer = null;
    this.bc = null;
    this.bcRemotes = new Set();

    this._initBroadcastChannel();
    this._initPeer();
  }

  _initBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.bc = new BroadcastChannel(`smctrl-bc-${this.sessionId}`);
    this.bc.onmessage = (ev) => {
      const data = ev.data;
      if (!data || !data._fromRemote) return;
      const clientId = `bc:${data._clientId}`;

      if (data.type === 'bc:hello') {
        if (!this.connections.has(clientId)) {
          this.bcRemotes.add(clientId);
          this.connections.set(clientId, {
            send: (payload) => this.bc.postMessage({ ...payload, _fromStage: true, _toClientId: data._clientId }),
            isOpen: () => true,
          });
          this.onRemoteCountChange?.(this.connections.size);
        }
        this.bc.postMessage({ type: 'bc:welcome', _fromStage: true, _toClientId: data._clientId });
        this.onCommand?.({ type: 'remote:joined' }, this.connections.get(clientId));
        return;
      }

      if (data.type === 'bc:bye') {
        if (this.connections.delete(clientId)) {
          this.bcRemotes.delete(clientId);
          this.onRemoteCountChange?.(this.connections.size);
        }
        return;
      }

      const conn = this.connections.get(clientId);
      if (conn) this._handleMessage(data, conn);
    };
  }

  _initPeer() {
    if (!window.Peer) {
      this.onStatusChange?.('peer-unavailable');
      return;
    }

    const peerId = `${PEER_PREFIX}${this.sessionId}`;
    this.peer = new window.Peer(peerId, PEER_CONFIG);

    this.peer.on('open', () => {
      this.onStatusChange?.('ready');
    });

    this.peer.on('connection', (conn) => {
      const id = `peer:${conn.peer}:${Date.now()}`;
      const wrapper = {
        send: (payload) => {
          if (conn.open) conn.send(payload);
        },
        isOpen: () => conn.open,
      };

      conn.on('open', () => {
        this.connections.set(id, wrapper);
        this.onRemoteCountChange?.(this.connections.size);
        this.onCommand?.({ type: 'remote:joined' }, wrapper);
      });

      conn.on('data', (msg) => this._handleMessage(msg, wrapper));

      const cleanup = () => {
        if (this.connections.delete(id)) {
          this.onRemoteCountChange?.(this.connections.size);
        }
      };
      conn.on('close', cleanup);
      conn.on('error', cleanup);
    });

    this.peer.on('disconnected', () => {
      this.onStatusChange?.('reconnecting');
      setTimeout(() => {
        if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
          this.peer.reconnect();
        }
      }, 2000);
    });

    this.peer.on('error', (err) => {
      console.warn('[StageHost] PeerJS error:', err?.type || err);
      this.onStatusChange?.('error', err);
    });
  }

  async _handleMessage(msg, conn) {
    if (!msg || typeof msg !== 'object') return;

    // Handle chunked binary asset transfer
    if (msg.type === 'asset:start') {
      this.incomingTransfers.set(msg.assetId, {
        mimeType: msg.mimeType || 'application/octet-stream',
        totalChunks: Number(msg.totalChunks) || 0,
        chunks: new Array(Number(msg.totalChunks) || 0),
        received: 0,
      });
      return;
    }

    if (msg.type === 'asset:chunk') {
      const transfer = this.incomingTransfers.get(msg.assetId);
      if (!transfer) return;
      transfer.chunks[msg.index] = msg.data;
      transfer.received += 1;
      return;
    }

    if (msg.type === 'asset:end') {
      const transfer = this.incomingTransfers.get(msg.assetId);
      if (!transfer) return;
      this.incomingTransfers.delete(msg.assetId);
      const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
      await this.onAssetReceived?.(msg.assetId, blob);
      conn.send({ type: 'asset:ready', assetId: msg.assetId });
      return;
    }

    // Direct blob shortcut over BroadcastChannel
    if (msg.type === 'asset:blob') {
      await this.onAssetReceived?.(msg.assetId, msg.blob);
      conn.send({ type: 'asset:ready', assetId: msg.assetId });
      return;
    }

    this.onCommand?.(msg, conn);
  }

  broadcast(payload) {
    for (const conn of this.connections.values()) {
      try {
        if (conn.isOpen()) conn.send(payload);
      } catch {
        // ignore closed channel
      }
    }
  }
}

/**
 * Mobile Remote Client: connects to Stage Display via BroadcastChannel (if same browser)
 * or PeerJS WebRTC DataChannel (cross-device over Wi-Fi / Internet).
 */
export class RemoteClient {
  constructor(sessionId, { onStatusChange, onMessage }) {
    this.sessionId = sessionId.toUpperCase();
    this.onStatusChange = onStatusChange;
    this.onMessage = onMessage;

    this.clientId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.transport = null; // 'bc' | 'peer'
    this.bc = null;
    this.peer = null;
    this.conn = null;
    this.connected = false;
    this.destroyed = false;
    this.pendingAssetResolvers = new Map();
    this.inflightTransfers = new Map();

    this._connect();
  }

  _connect() {
    this.onStatusChange?.('connecting');

    // 1. Probe BroadcastChannel first (instant when testing in two tabs of same browser)
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(`smctrl-bc-${this.sessionId}`);
      this.bc.onmessage = (ev) => {
        const data = ev.data;
        if (!data || !data._fromStage) return;
        if (data._toClientId && data._toClientId !== this.clientId) return;

        if (data.type === 'bc:welcome') {
          if (!this.connected) {
            this.transport = 'bc';
            this.connected = true;
            this.onStatusChange?.('connected');
            if (this.peer) {
              try { this.peer.destroy(); } catch {}
              this.peer = null;
            }
          }
          return;
        }
        if (this.transport === 'bc') {
          this._handleIncoming(data);
        }
      };

      this.bc.postMessage({ type: 'bc:hello', _fromRemote: true, _clientId: this.clientId });
      window.addEventListener('beforeunload', () => {
        if (this.transport === 'bc' && this.bc) {
          this.bc.postMessage({ type: 'bc:bye', _fromRemote: true, _clientId: this.clientId });
        }
      });
    }

    // 2. Start PeerJS WebRTC connection after brief 220ms local-tab probe window
    setTimeout(() => {
      if (this.destroyed || this.transport === 'bc') return;
      this._connectPeer();
    }, 220);
  }

  _connectPeer() {
    if (!window.Peer || this.destroyed) return;
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
    }

    this.peer = new window.Peer(PEER_CONFIG);
    this.peer.on('open', () => {
      if (this.destroyed || this.transport === 'bc') return;
      this._dialStage();
    });

    this.peer.on('error', (err) => {
      console.warn('[RemoteClient] PeerJS error:', err?.type || err);
      if (this.transport === 'bc' || this.destroyed) return;
      this.connected = false;
      this.onStatusChange?.('reconnecting');
      setTimeout(() => {
        if (!this.destroyed && !this.connected && this.transport !== 'bc') {
          if (this.peer && !this.peer.destroyed && this.peer.open) {
            this._dialStage();
          } else {
            this._connectPeer();
          }
        }
      }, 2200);
    });
  }

  _dialStage() {
    if (!this.peer || this.peer.destroyed || this.transport === 'bc') return;
    const targetId = `${PEER_PREFIX}${this.sessionId}`;
    const conn = this.peer.connect(targetId, { reliable: true, serialization: 'binary' });
    this.conn = conn;

    conn.on('open', () => {
      if (this.transport === 'bc') {
        conn.close();
        return;
      }
      this.transport = 'peer';
      this.connected = true;
      this.onStatusChange?.('connected');
    });

    conn.on('data', (msg) => this._handleIncoming(msg));

    conn.on('close', () => {
      if (this.transport !== 'peer' || this.destroyed) return;
      this.connected = false;
      this.onStatusChange?.('reconnecting');
      setTimeout(() => {
        if (!this.destroyed && !this.connected) this._dialStage();
      }, 2000);
    });

    conn.on('error', () => {
      if (this.transport !== 'peer' || this.destroyed) return;
      this.connected = false;
      this.onStatusChange?.('reconnecting');
    });
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'asset:ready' && msg.assetId) {
      const resolvers = this.pendingAssetResolvers.get(msg.assetId);
      if (resolvers) {
        this.pendingAssetResolvers.delete(msg.assetId);
        resolvers.forEach((fn) => fn());
      }
    }
    this.onMessage?.(msg);
  }

  send(payload) {
    if (!this.connected) return false;
    if (this.transport === 'bc' && this.bc) {
      this.bc.postMessage({ ...payload, _fromRemote: true, _clientId: this.clientId });
      return true;
    }
    if (this.transport === 'peer' && this.conn && this.conn.open) {
      this.conn.send(payload);
      return true;
    }
    return false;
  }

  async waitForBackpressure() {
    if (this.transport !== 'peer' || !this.conn?.dataChannel) return;
    const dc = this.conn.dataChannel;
    while (dc.bufferedAmount > 512 * 1024 && this.connected) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Stream a Blob to Stage Display in 32KB WebRTC chunks (or direct structured clone on BroadcastChannel).
   */
  async sendAsset(assetId, blob, onProgress) {
    if (!this.connected || !blob) return false;
    if (this.inflightTransfers.has(assetId)) {
      return this.inflightTransfers.get(assetId);
    }

    const transferPromise = (async () => {
      const readyPromise = new Promise((resolve) => {
        const list = this.pendingAssetResolvers.get(assetId) || [];
        list.push(resolve);
        this.pendingAssetResolvers.set(assetId, list);
      });

      if (this.transport === 'bc') {
        this.send({ type: 'asset:blob', assetId, blob });
        onProgress?.(100);
        await readyPromise;
        return true;
      }

      const buf = await blob.arrayBuffer();
      const totalBytes = buf.byteLength;
      const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));

      this.send({
        type: 'asset:start',
        assetId,
        mimeType: blob.type || 'application/octet-stream',
        totalChunks,
        totalBytes,
      });

      for (let i = 0; i < totalChunks; i++) {
        if (!this.connected) throw new Error('החיבור למסך הבמה נותק במהלך ההעברה');
        await this.waitForBackpressure();
        const start = i * CHUNK_SIZE;
        const slice = buf.slice(start, Math.min(start + CHUNK_SIZE, totalBytes));
        this.send({
          type: 'asset:chunk',
          assetId,
          index: i,
          data: slice,
        });
        if (onProgress && (i % 4 === 0 || i === totalChunks - 1)) {
          onProgress(Math.round(((i + 1) / totalChunks) * 100));
        }
      }

      this.send({ type: 'asset:end', assetId });
      await readyPromise;
      return true;
    })().finally(() => {
      this.inflightTransfers.delete(assetId);
    });

    this.inflightTransfers.set(assetId, transferPromise);
    return transferPromise;
  }
}
