/**
 * @file AudioMiddleware.js — Procedural audio middleware for Impossible Mission
 *
 * Architecture:
 *   MasterBus ─┬─ MusicBus  (ambient drone, 18% of master)
 *              ├─ SFXBus    (one-shot effects, 70% of master)
 *              └─ VoiceBus  (speech / robot barks, 60% of master)
 *
 * Each bus has an independent GainNode so volume can be mixed per-category.
 * Spatial panning: sound effects are panned left/right proportionally to the
 * sound source's x position within the 640px room width.
 * Room acoustics: a ConvolverNode on the SFXBus adds a slight room reverb
 * (generated procedurally — no IR file needed).
 */

const CW = 640;

export class AudioMiddleware {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx  = null;
    this._master = null;
    this._buses  = {};
    this._noiseBuffer = null;

    // Persistent looping nodes (one per looping sound)
    this._droneNodes    = null;
    this._humNode       = null;
    this._elevatorNode  = null;

    // Speech
    this._lastBarkAt = -999;
  }

  // ── Lazy-init (must be triggered from a user gesture for autoplay policy) ──

  _ensure() {
    if (this._ctx) return this._ctx;
    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this._ctx;

    this._master = ctx.createGain();
    this._master.gain.value = 1.0;
    this._master.connect(ctx.destination);

    // Buses
    const makeBus = (vol, connectTo = this._master) => {
      const g = ctx.createGain();
      g.gain.value = vol;
      g.connect(connectTo);
      return g;
    };

    // SFX bus with subtle room reverb
    const convolver   = ctx.createConvolver();
    convolver.buffer  = this._buildRoomIR(ctx);
    const sfxDry      = makeBus(0.7);
    const sfxWet      = makeBus(0.12);
    sfxWet.connect(convolver);
    convolver.connect(this._master);
    this._buses = {
      music:  makeBus(0.18),
      sfx:    sfxDry,
      sfxWet: sfxWet,
      voice:  makeBus(0.6),
    };

    return ctx;
  }

  /**
   * Procedural impulse response for a small underground room.
   * Generates ~120ms of exponentially-decaying white noise — no IR file needed.
   */
  _buildRoomIR(ctx) {
    const sampleRate = ctx.sampleRate;
    const len  = Math.floor(sampleRate * 0.12);
    const buf  = ctx.createBuffer(2, len, sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      }
    }
    return buf;
  }

  /** Lazily build a shared noise buffer */
  _noise() {
    const ctx = this._ensure();
    if (!this._noiseBuffer) {
      const len = ctx.sampleRate * 1.5;
      this._noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this._noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuffer;
  }

  // ── Internal tone helper ──────────────────────────────────────────────────

  /**
   * @param {number} freq
   * @param {number} dur       seconds
   * @param {'sine'|'square'|'sawtooth'|'triangle'} type
   * @param {number} vol       gain
   * @param {number} delay     offset from now
   * @param {number} sourceX   world-space x for panning (0..640), -1 = centre
   */
  _tone(freq, dur = 0.12, type = 'square', vol = 0.05, delay = 0, sourceX = -1) {
    const ctx = this._ensure();
    const t0 = ctx.currentTime + delay;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const pan  = ctx.createStereoPanner();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    pan.pan.value = sourceX < 0 ? 0 : (sourceX / CW) * 2 - 1;

    osc.connect(gain);
    gain.connect(pan);
    pan.connect(this._buses.sfx);
    pan.connect(this._buses.sfxWet);

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  _noiseBurst(fType, freqFrom, freqTo, dur, vol, delay = 0, sourceX = -1) {
    const ctx = this._ensure();
    const t0   = ctx.currentTime + delay;
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const pan  = ctx.createStereoPanner();

    src.buffer = this._noise();
    filt.type  = fType;
    filt.frequency.setValueAtTime(freqFrom, t0);
    if (freqTo !== freqFrom) filt.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);

    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    pan.pan.value = sourceX < 0 ? 0 : (sourceX / CW) * 2 - 1;

    src.connect(filt); filt.connect(gain);
    gain.connect(pan);
    pan.connect(this._buses.sfx);
    pan.connect(this._buses.sfxWet);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  // ── Public SFX API ────────────────────────────────────────────────────────

  /** @param {number} [sx]  source x for panning */
  jump(sx)    { this._tone(440,.08,'square',.05,0,sx); this._tone(660,.08,'square',.04,.04,sx); }
  search(sx)  { this._tone(220,.06,'square',.04,0,sx); }
  pickup(sx)  { this._tone(523,.07,'square',.05,0,sx); this._tone(784,.09,'square',.05,.06,sx); }
  nothing()   { this._tone(140,.12,'sawtooth',.03); }
  letter()    { [523,659,784].forEach((f,i) => this._tone(f,.12,'square',.06,i*.1)); }
  blip(f=300,sx) { this._tone(f,.05,'square',.03,0,sx); }
  snooze(sx)  { this._tone(700,.1,'sine',.05,0,sx); this._tone(400,.2,'sine',.04,.08,sx); }

  win() { [523,659,784,1046].forEach((f,i) => this._tone(f,.22,'square',.07,i*.18)); }
  lose(){ [392,330,261,196].forEach((f,i) => this._tone(f,.3,'sawtooth',.06,i*.22)); }

  /** Vaporization / electrocution burst — panned to source */
  vaporize(sx = -1) {
    this._noiseBurst('bandpass', 2200, 300, .5, .09, 0, sx);
    this._tone(95, .4, 'sawtooth', .05, .05, sx);
  }

  /** Falling death scream — pitch descends realistically */
  fallScream(sx = -1) {
    const ctx = this._ensure();
    const t0 = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const pan  = ctx.createStereoPanner();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(900, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + .55);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.07, t0 + .04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + .6);
    pan.pan.value = sx < 0 ? 0 : (sx / CW) * 2 - 1;
    osc.connect(gain); gain.connect(pan); pan.connect(this._buses.sfx);
    osc.start(t0); osc.stop(t0 + .62);
    this._noiseBurst('highpass', 600, 600, .5, .04, 0, sx);
  }

  /** Footstep click */
  footstep(sx = -1) {
    this._noiseBurst('lowpass', 300, 300, .06, .05, 0, sx);
  }

  // ── Ambient drone ─────────────────────────────────────────────────────────

  startDrone() {
    const ctx = this._ensure();
    if (this._droneNodes) return;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    const g  = ctx.createGain();
    o1.type = o2.type = 'sine';
    o1.frequency.value = 55; o2.frequency.value = 58.5;
    g.gain.value = 1.0;
    o1.connect(g); o2.connect(g); g.connect(this._buses.music);
    o1.start(); o2.start();
    this._droneNodes = { o1, o2, g };
  }

  stopDrone() {
    if (!this._droneNodes) return;
    const ctx = this._ctx;
    const { o1, o2, g } = this._droneNodes;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + .6);
    o1.stop(ctx.currentTime + .65); o2.stop(ctx.currentTime + .65);
    this._droneNodes = null;
  }

  // ── Robot hum (scales with active robot count) ────────────────────────────

  /** @param {number} intensity  0..1 */
  setRobotHum(intensity) {
    const ctx = this._ensure();
    if (intensity <= 0) {
      if (this._humNode) {
        this._humNode.g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + .3);
        const n = this._humNode;
        setTimeout(() => { try { n.o.stop(); } catch {} }, 350);
        this._humNode = null;
      }
      return;
    }
    if (!this._humNode) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = 120;
      g.gain.value = 0;
      o.connect(g); g.connect(this._buses.sfx);
      o.start();
      this._humNode = { o, g };
    }
    this._humNode.g.gain.linearRampToValueAtTime(
      Math.min(0.035, intensity * 0.035), ctx.currentTime + .2
    );
  }

  // ── Elevator whir ─────────────────────────────────────────────────────────

  startElevatorWhir() {
    const ctx = this._ensure();
    if (this._elevatorNode) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 70;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + .15);
    o.connect(g); g.connect(this._buses.sfx);
    o.start();
    this._elevatorNode = { o, g };
  }

  stopElevatorWhir() {
    if (!this._elevatorNode) return;
    const ctx = this._ctx;
    const { o, g } = this._elevatorNode;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + .2);
    o.stop(ctx.currentTime + .25);
    this._elevatorNode = null;
  }

  // ── Speech synthesis ──────────────────────────────────────────────────────

  speak(text, { rate = 0.82, pitch = 0.55, volume = 0.9 } = {}) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.pitch = pitch; u.volume = volume;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  }

  cancelSpeech() { try { window.speechSynthesis?.cancel(); } catch {} }

  /**
   * Throttled robot bark — at most once every 14s game time.
   * @param {string[]} lines
   * @param {number}   now   game time in seconds (not wall-clock)
   */
  maybeBark(lines, now) {
    if (now - this._lastBarkAt < 14) return;
    this._lastBarkAt = now;
    const line = lines[Math.floor(Math.random() * lines.length)];
    this.speak(line, { rate: 1.0, pitch: 0.4, volume: 0.55 });
  }

  resetBarkCooldown() { this._lastBarkAt = -999; }

  // ── Simon tones ───────────────────────────────────────────────────────────

  simonTone(freq) {
    const ctx = this._ensure();
    const t0  = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.001, t0);
    g.gain.linearRampToValueAtTime(0.12, t0 + .01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + .3);
    osc.connect(g); g.connect(this._buses.sfx);
    osc.start(t0); osc.stop(t0 + .32);
  }
}
