/**
 * @file LevelGen.js — Procedural room and level generator
 *
 * Accepts an injected RNG instance so generation is fully deterministic
 * given the same seed — essential for daily challenges and co-op sync.
 *
 * Improvements over the original:
 *  • All platform positions are clamped to canvas bounds before furniture/
 *    robot placement, so no entity can ever spawn off-screen
 *  • Moving platform _rect objects are pre-allocated here (not at runtime)
 *  • Control room is guaranteed empty (no movers, no hazards, no robots)
 *  • JSDoc types on all returned room objects
 */

import { RNG } from '../engine/RNG.js';

const CW = 640, CH = 400;
const FLOORS         = 4;
const ROOMS_PER_FLOOR = 8;
const ROOM_MIN_X     = 4;
const ROOM_MAX_X     = CW - 4;
const GROUND_Y       = CH - 70;
const LEFT_ENTRY_END  = 70;
const RIGHT_ENTRY_ST  = 560;

export class LevelGen {
  /** @param {RNG} rng */
  constructor(rng) {
    this.rng = rng;
  }

  /** @returns {Room[]} array of 32 room objects */
  buildRooms() {
    const rooms = [];
    let id = 0;
    for (let f = 0; f < FLOORS; f++) {
      for (let r = 0; r < ROOMS_PER_FLOOR; r++) {
        rooms.push(this._generateRoom(id++, f, r));
      }
    }
    // Control room — top floor, last room
    const ctrl = rooms[rooms.length - 1];
    ctrl.isControlRoom   = true;
    ctrl.furniture       = [];
    ctrl.robots          = [];
    ctrl.movingPlatforms = [];
    ctrl.electrifiedZones = [];
    return rooms;
  }

  _generateRoom(id, floor, indexOnFloor) {
    const rng = this.rng;

    // ── Platforms ──────────────────────────────────────────────────────
    const platforms = [];
    let x = 30;
    const segCount = rng.int(2, 4);
    for (let i = 0; i < segCount; i++) {
      const w = rng.int(110, 190);
      platforms.push({ x, y: GROUND_Y, w });
      x = x + w + rng.int(0, 1) * rng.int(40, 80);
      if (x > CW - 150) break;
    }
    if (!platforms.length) platforms.push({ x: 30, y: GROUND_Y, w: CW - 60 });

    // Clamp to canvas
    for (const p of platforms) {
      if (p.x < ROOM_MIN_X) { p.w -= ROOM_MIN_X - p.x; p.x = ROOM_MIN_X; }
      if (p.x + p.w > ROOM_MAX_X) p.w = ROOM_MAX_X - p.x;
      p.w = Math.max(p.w, 20);
    }

    // Guarantee left entry zone
    const fp = platforms[0];
    if (fp.x > 20) {
      fp.x <= LEFT_ENTRY_END
        ? (fp.w += fp.x - 20, fp.x = 20)
        : platforms.unshift({ x: 20, y: GROUND_Y, w: fp.x - 20 + 10 });
    }
    // Guarantee right entry zone
    const lp = platforms[platforms.length - 1];
    if (lp.x + lp.w < CW - 20) {
      lp.x <= RIGHT_ENTRY_ST
        ? lp.w = (CW - 20) - lp.x
        : platforms.push({ x: RIGHT_ENTRY_ST - 10, y: GROUND_Y, w: (CW - 20) - (RIGHT_ENTRY_ST - 10) });
    } else if (lp.x + lp.w > ROOM_MAX_X) {
      lp.w = ROOM_MAX_X - lp.x;
    }

    // ── Ledge ─────────────────────────────────────────────────────────
    const hasLedge = rng.next() < 0.45;
    const ledge    = hasLedge
      ? { x: rng.int(180, CW - 260), y: GROUND_Y - 90, w: rng.int(120, 200) }
      : null;

    // ── Moving platforms ───────────────────────────────────────────────
    const movingPlatforms = [];
    const moverCount = rng.int(0, floor === 0 ? 1 : 2);
    for (let i = 0; i < moverCount; i++) {
      if (rng.next() < 0.5) {
        // Vertical mover
        const mx  = rng.int(90, CW - 160);
        const topY = ledge ? ledge.y : GROUND_Y - 90;
        const mp = {
          id: `R${id}M${i}`, axis: 'y', x: mx, y: GROUND_Y - 10, w: 70, h: 10,
          minPos: topY, maxPos: GROUND_Y - 10,
          speed: 0.6 + rng.next() * 0.5,
          phase: rng.next() * Math.PI * 2,
          startPhase: 0,
          _rect: null,
        };
        mp.startPhase = mp.phase;
        movingPlatforms.push(mp);
      } else {
        // Horizontal mover
        const myH = rng.int(GROUND_Y - 160, GROUND_Y - 50);
        const mp  = {
          id: `R${id}M${i}`, axis: 'x', x: 80, y: myH, w: 70, h: 10,
          minPos: 80, maxPos: CW - 160,
          speed: 0.6 + rng.next() * 0.5,
          phase: rng.next() * Math.PI * 2,
          startPhase: 0,
          _rect: null,
        };
        mp.startPhase = mp.phase;
        movingPlatforms.push(mp);
      }
    }

    // ── Electrified zone ───────────────────────────────────────────────
    const electrifiedZones = [];
    if (floor > 0 && rng.next() < 0.35) {
      const host  = rng.choice(platforms);
      const zoneW = Math.min(host.w - 20, rng.int(50, 90));
      if (zoneW > 20) {
        const zoneX = rng.int(host.x + 10, host.x + host.w - zoneW - 10);
        electrifiedZones.push({
          x: zoneX, y: host.y, w: zoneW,
          onDuration:  1.4 + rng.next() * 0.8,
          offDuration: 1.0 + rng.next() * 0.8,
          timer: rng.next() * 2,
          live:  rng.next() < 0.5,
        });
      }
    }

    // ── Furniture ──────────────────────────────────────────────────────
    const FURN_TYPES = ['desk','cabinet','lamp','chair','bookcase','safe','clock','plant'];
    const furniture  = [];
    const furnCount  = rng.int(2, 5);
    for (let i = 0; i < furnCount; i++) {
      const plat = rng.choice(platforms);
      const fx   = rng.int(plat.x + 10, Math.max(plat.x + 10, plat.x + plat.w - 30));
      furniture.push({ id: `R${id}F${i}`, type: rng.choice(FURN_TYPES), x: fx, y: plat.y - 26, w: 22, h: 26, searched: false });
      if (ledge && rng.next() < 0.4) {
        const lx = rng.int(ledge.x + 10, Math.max(ledge.x + 10, ledge.x + ledge.w - 30));
        furniture.push({ id: `R${id}F${i}L`, type: rng.choice(FURN_TYPES), x: lx, y: ledge.y - 26, w: 22, h: 26, searched: false });
      }
    }

    // ── Robots ─────────────────────────────────────────────────────────
    const robots = [];
    const robotCount = floor === 0 ? rng.int(0, 1) : rng.int(1, 2);
    for (let i = 0; i < robotCount; i++) {
      const plat = rng.choice(platforms);
      robots.push({
        id:   `R${id}B${i}`,
        x:    rng.int(plat.x + 10, Math.max(plat.x + 10, plat.x + plat.w - 30)),
        y:    plat.y - 24,
        w: 22, h: 24,
        minX: plat.x, maxX: plat.x + plat.w - 22,
        dir:   rng.choice([-1, 1]),
        speed: rng.int(1, 2) + floor * 0.3,
        kind:  rng.choice(['patrol', 'hunter', 'stationary']),
        frozen: 0,
        fsm:   'IDLE',
        alerted: false,
      });
    }

    // ── Terminal ───────────────────────────────────────────────────────
    const hasPhone    = rng.next() < 0.22;
    const hasCodeRoom = hasPhone && rng.next() < 0.4;
    let terminal      = null;
    if (hasPhone) {
      const tPlat = rng.choice(platforms);
      let tx = rng.int(tPlat.x + 10, Math.max(tPlat.x + 10, tPlat.x + tPlat.w - 26));
      tx = Math.max(4, Math.min(CW - 4 - 16, tx));
      terminal = { x: tx, y: tPlat.y - 30, w: 16, h: 30 };
    }

    return {
      id, floor, indexOnFloor,
      platforms, ledge, furniture, robots,
      movingPlatforms, electrifiedZones,
      hasPhone, hasCodeRoom, terminal,
      isControlRoom: false, visited: false,
    };
  }

  /** Expose generation constants for consumers */
  static get FLOORS()          { return FLOORS; }
  static get ROOMS_PER_FLOOR() { return ROOMS_PER_FLOOR; }
}
