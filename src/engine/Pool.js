/**
 * @file Pool.js — Typed object pools for zero-allocation hot paths
 *
 * Every temporary object created in the render/update loop that would
 * otherwise be collected by the GC is allocated from a pool instead.
 * Pools grow on demand but never shrink (stable working set).
 *
 * Supported types:
 *   Vec2      — {x,y}          for position/velocity arithmetic
 *   Rect      — {x,y,w,h}      for AABB collision tests
 *   Particle  — {x,y,vx,vy,life,maxLife,r,g,b,a,size}
 */

// ── Vec2 ─────────────────────────────────────────────────────────────────────

const _vec2Pool = [];

/** @returns {{x:number,y:number}} */
export function allocVec2(x = 0, y = 0) {
  const v = _vec2Pool.length ? _vec2Pool.pop() : { x: 0, y: 0 };
  v.x = x; v.y = y;
  return v;
}

/** @param {{x:number,y:number}} v */
export function freeVec2(v) { _vec2Pool.push(v); }

// ── Rect ─────────────────────────────────────────────────────────────────────

const _rectPool = [];

/** @returns {{x:number,y:number,w:number,h:number}} */
export function allocRect(x = 0, y = 0, w = 0, h = 0) {
  const r = _rectPool.length ? _rectPool.pop() : { x: 0, y: 0, w: 0, h: 0 };
  r.x = x; r.y = y; r.w = w; r.h = h;
  return r;
}

/** @param {{x:number,y:number,w:number,h:number}} r */
export function freeRect(r) { _rectPool.push(r); }

// ── Particle ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Particle
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} life      seconds remaining
 * @property {number} maxLife
 * @property {number} r         0-255
 * @property {number} g
 * @property {number} b
 * @property {number} a         0-1
 * @property {number} size      px
 * @property {boolean} active
 */

const _particlePool = [];
/** @type {Particle[]} live particles each frame */
export const PARTICLES = [];

/** Allocate a particle from pool and push into PARTICLES array */
export function spawnParticle(x, y, vx, vy, life, r, g, b, size = 2) {
  let p = _particlePool.length ? _particlePool.pop() : {};
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life; p.maxLife = life;
  p.r = r; p.g = g; p.b = b; p.a = 1;
  p.size = size; p.active = true;
  PARTICLES.push(p);
  return p;
}

/**
 * Advance all particles by dt, remove dead ones.
 * Called once per frame — O(n) over PARTICLES.length, no allocations.
 * @param {number} dt seconds
 */
export function updateParticles(dt) {
  for (let i = PARTICLES.length - 1; i >= 0; i--) {
    const p = PARTICLES[i];
    p.life -= dt;
    if (p.life <= 0) {
      p.active = false;
      _particlePool.push(p);
      PARTICLES.splice(i, 1); // hot; kept small by short particle lifetimes
      continue;
    }
    p.x  += p.vx * dt;
    p.y  += p.vy * dt;
    p.vy += 80 * dt;          // gravity
    p.a   = p.life / p.maxLife;
  }
}

/**
 * Burst of spark particles for electrocution / vaporization effects.
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} count
 */
export function spawnVaporize(cx, cy, count = 14) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 120;
    const r = 200 + Math.random() * 55;
    const g = Math.random() * 100;
    spawnParticle(cx, cy, Math.cos(angle) * speed, Math.sin(angle) * speed,
      0.35 + Math.random() * 0.25, r, g, 0, 1.5 + Math.random() * 2);
  }
}

/**
 * Debris particles for falling death.
 * @param {number} cx @param {number} cy
 */
export function spawnFallDust(cx, cy) {
  for (let i = 0; i < 8; i++) {
    spawnParticle(cx + (Math.random() - 0.5) * 12, cy,
      (Math.random() - 0.5) * 30, -20 - Math.random() * 40,
      0.4, 127, 127, 220, 2);
  }
}

/**
 * Pool stats for performance HUD / benchmarks.
 * @returns {{pooled:number, live:number}}
 */
export function particlePoolStats() {
  return { pooled: _particlePool.length, live: PARTICLES.length };
}
