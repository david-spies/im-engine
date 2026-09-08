/**
 * @file RNG.js — Deterministic seeded XOR-shift 32 random number generator
 *
 * Using a seeded RNG (rather than Math.random) ensures that given the same
 * seed, every room layout, fragment placement, robot patrol, and puzzle
 * orientation is byte-for-byte identical across clients — essential for
 * deterministic lockstep netcode and daily seeded speedrun challenges.
 */

export class RNG {
  /** @param {number} seed  32-bit unsigned integer */
  constructor(seed) {
    this.s = (seed >>> 0) || 1;
  }

  /** Returns a float in [0, 1) */
  next() {
    let s = this.s;
    s ^= s << 13;  s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;   s >>>= 0;
    this.s = s;
    return (s >>> 0) / 4294967296;
  }

  /** Reseed (e.g. to fork a sub-sequence) */
  reseed(seed) { this.s = (seed >>> 0) || 1; }

  /** Integer in [a, b] inclusive */
  int(a, b) {
    if (b < a) { const t = a; a = b; b = t; }
    return Math.floor(this.next() * (b - a + 1)) + a;
  }

  /** Pick a random element from an array */
  choice(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  /** Fisher-Yates shuffle — returns a new array */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Snapshot the RNG state for deterministic save/restore */
  getState() { return this.s; }
  setState(s) { this.s = s >>> 0; }
}

/**
 * Build a daily-challenge seed from today's UTC date string so all
 * players on the same day share the same generated world.
 * @returns {number}
 */
export function dailySeed() {
  const d = new Date();
  const str = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h || 1;
}
