/**
 * @file Network.js — Multiplayer, leaderboard, and cloud-save networking layer
 *
 * Architecture:
 *   NetworkClient wraps a WebSocket connection to a lightweight Node.js
 *   backend (see /docs/TDD.md for the server protocol spec).
 *
 *   Implemented:
 *     • Global leaderboard GET/POST via REST (works without WebSocket)
 *     • Cloud save-state sync (JSON snapshot over HTTPS)
 *     • Daily seeded challenge seed fetch
 *     • Telemetry event queue with batched flush
 *
 *   Stubbed (requires backend deployment):
 *     • Real-time cooperative multiplayer via WebSocket
 *     • Deterministic lockstep frame sync
 *     • Server-side anti-cheat for leaderboard submissions
 *
 * All network calls are non-blocking; failures are silent and fall back
 * to local-only play so the game is always fully playable offline.
 */

const DEFAULT_API = 'https://im-api.example.com'; // replace with real endpoint

export class NetworkClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiBase]    REST API base URL
   * @param {string} [opts.wsUrl]      WebSocket server URL
   * @param {string} [opts.sessionId]  player session id (from local storage)
   */
  constructor(opts = {}) {
    this.apiBase   = opts.apiBase   || DEFAULT_API;
    this.wsUrl     = opts.wsUrl     || null;
    this.sessionId = opts.sessionId || this._loadSession();
    /** @type {WebSocket|null} */
    this._ws       = null;
    this._handlers = {};
    /** @type {object[]} */
    this._telemetryQueue = [];
    this._flushTimer     = null;
  }

  // ── Session ───────────────────────────────────────────────────────────────

  _loadSession() {
    try { return localStorage.getItem('im_session') || this._newSession(); }
    catch { return this._newSession(); }
  }

  _newSession() {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('im_session', id); } catch {}
    return id;
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────

  /**
   * Fetch the top N leaderboard entries for a given seed/mode.
   * @param {object} [opts]
   * @param {number} [opts.seed]     0 = any (all-time)
   * @param {string} [opts.mode]     'classic'|'daily'|'speedrun'
   * @param {number} [opts.limit]    default 10
   * @returns {Promise<LeaderboardEntry[]>}
   */
  async getLeaderboard({ seed = 0, mode = 'classic', limit = 10 } = {}) {
    try {
      const url  = `${this.apiBase}/leaderboard?seed=${seed}&mode=${mode}&limit=${limit}`;
      const resp = await fetch(url, { headers: { 'X-Session': this.sessionId } });
      if (!resp.ok) throw new Error(resp.status);
      return await resp.json();
    } catch (e) {
      console.warn('[Network] getLeaderboard failed:', e.message);
      return [];
    }
  }

  /**
   * Submit a completed run to the leaderboard.
   * @param {object} entry
   * @param {string} entry.playerName
   * @param {number} entry.timeUsed     seconds
   * @param {number} entry.seed
   * @param {string} entry.mode
   * @param {object} entry.snapshot     final game state snapshot (anti-cheat)
   */
  async submitRun(entry) {
    try {
      const resp = await fetch(`${this.apiBase}/leaderboard`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session': this.sessionId },
        body:    JSON.stringify(entry),
      });
      if (!resp.ok) throw new Error(resp.status);
      return await resp.json();
    } catch (e) {
      console.warn('[Network] submitRun failed:', e.message);
      return null;
    }
  }

  // ── Cloud save ────────────────────────────────────────────────────────────

  /**
   * Upload a game-state snapshot to cloud storage.
   * @param {object} snap  from State.snapshot()
   */
  async saveCloud(snap) {
    try {
      const resp = await fetch(`${this.apiBase}/save`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session': this.sessionId },
        body:    JSON.stringify({ session: this.sessionId, snapshot: snap }),
      });
      if (!resp.ok) throw new Error(resp.status);
      return true;
    } catch (e) {
      console.warn('[Network] saveCloud failed:', e.message);
      return false;
    }
  }

  /** @returns {Promise<object|null>} last saved snapshot or null */
  async loadCloud() {
    try {
      const resp = await fetch(`${this.apiBase}/save?session=${this.sessionId}`, {
        headers: { 'X-Session': this.sessionId },
      });
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      return data.snapshot || null;
    } catch (e) {
      console.warn('[Network] loadCloud failed:', e.message);
      return null;
    }
  }

  // ── Daily challenge ───────────────────────────────────────────────────────

  /**
   * Fetch today's official seeded challenge seed from the server.
   * Falls back to the locally-computed daily seed if offline.
   * @returns {Promise<number>}
   */
  async getDailySeed() {
    try {
      const resp = await fetch(`${this.apiBase}/daily-seed`);
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      return data.seed;
    } catch {
      const { dailySeed } = await import('../engine/RNG.js');
      return dailySeed();
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────

  /**
   * Queue a telemetry event for batch submission.
   * Events are flushed every 30s or on game-end.
   * @param {string} event  event name
   * @param {object} [data]
   */
  track(event, data = {}) {
    this._telemetryQueue.push({ event, data, ts: Date.now(), session: this.sessionId });
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flushTelemetry(), 30_000);
    }
  }

  async flushTelemetry() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._telemetryQueue.length) return;
    const batch = this._telemetryQueue.splice(0);
    try {
      await fetch(`${this.apiBase}/telemetry`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(batch),
      });
    } catch {}  // telemetry is always best-effort
  }

  // ── WebSocket / Co-op (stub) ──────────────────────────────────────────────

  /**
   * Connect to the cooperative multiplayer WebSocket server.
   * Players share a seed; their positions are streamed to each other.
   * Uses deterministic lockstep: both clients advance the same RNG from
   * the same seed, and only player positions are networked (not full state).
   *
   * @param {string} roomCode  4-character lobby code
   * @returns {Promise<boolean>}
   */
  async connectCoop(roomCode) {
    if (!this.wsUrl) {
      console.warn('[Network] No WebSocket URL configured — co-op unavailable');
      return false;
    }
    return new Promise(resolve => {
      try {
        this._ws = new WebSocket(`${this.wsUrl}/coop?room=${roomCode}&session=${this.sessionId}`);
        this._ws.onopen    = () => resolve(true);
        this._ws.onerror   = () => resolve(false);
        this._ws.onmessage = (e) => this._handleWS(e);
        this._ws.onclose   = () => this._ws = null;
      } catch { resolve(false); }
    });
  }

  /**
   * Send a player position update to the co-op partner.
   * @param {{ x: number, y: number, facing: number, roomId: number }} pos
   */
  sendPosition(pos) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'pos', ...pos }));
    }
  }

  _handleWS(event) {
    try {
      const msg = JSON.parse(event.data);
      const handler = this._handlers[msg.type];
      if (handler) handler(msg);
    } catch {}
  }

  /**
   * Register a handler for incoming WebSocket message types.
   * @param {string}   type
   * @param {Function} handler
   */
  on(type, handler) { this._handlers[type] = handler; }

  disconnect() {
    if (this._ws) { this._ws.close(); this._ws = null; }
  }
}
