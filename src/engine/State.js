/**
 * @file State.js — Centralized, snapshot-capable game state container
 *
 * All mutable game state lives here so that:
 *   1. Systems read/write through a single reference (no scattered globals)
 *   2. Deterministic snapshots can be taken for cloud saves and netcode
 *      rollback / reconciliation
 *   3. TypeScript-style JSDoc types give IDE completion without a compiler
 */

/**
 * @typedef {Object} PlayerState
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} w
 * @property {number} h
 * @property {boolean} onGround
 * @property {number}  facing       1 = right, -1 = left
 * @property {number}  invuln       seconds of invulnerability remaining
 * @property {number}  walkCycle    animation phase (radians)
 * @property {number}  footstepTimer
 * @property {string|null} ridingPlatformId
 */

/**
 * @typedef {Object} ElevatorRide
 * @property {number}  targetId
 * @property {number}  direction   -1 up, 1 down
 * @property {number}  progress    0..1
 * @property {number}  duration    seconds
 * @property {'left'|'right'} side
 */

/**
 * Factory — returns a fresh, fully-initialised game state object.
 * Every field is present at startup so no runtime undefined checks
 * are needed inside hot-path systems.
 * @returns {GameState}
 */
export function createState() {
  return {
    // ── lifecycle ──────────────────────────────────────────────────────
    /** @type {'title'|'intro'|'playing'|'paused'|'puzzle'|'phone'|'simon'|'won'|'lost'} */
    phase: 'title',
    seed: 0,
    tick: 0,             // incremented every logical frame (for netcode)

    // ── timing ─────────────────────────────────────────────────────────
    timeRemaining: 6 * 3600,   // seconds
    lastTimestamp: 0,

    // ── agent ──────────────────────────────────────────────────────────
    /** @type {PlayerState} */
    player: {
      x: 60, y: 290, w: 18, h: 40,
      vx: 0, vy: 0,
      onGround: false,
      facing: 1,
      invuln: 0,
      walkCycle: 0,
      footstepTimer: 0,
      ridingPlatformId: null,
    },
    lives: 3,

    // ── world ──────────────────────────────────────────────────────────
    rooms: [],          // Room[] — built by LevelGen, never mutated structurally after init
    currentRoomId: 0,

    // ── interaction ────────────────────────────────────────────────────
    robotSnoozeActive: 0,      // seconds
    /** @type {{kind:string,x:number,y:number,ref:object}|null} */
    pendingTarget: null,
    /** @type {ElevatorRide|null} */
    elevatorRide: null,

    // ── puzzle ─────────────────────────────────────────────────────────
    simonSeq: [],
    simonPlayerIdx: 0,
    simonPlaying: false,
    simonTempo: 600,

    // ── keys ───────────────────────────────────────────────────────────
    /** @type {Record<string,boolean>} */
    keys: {},
    /** @type {Record<string,boolean>} pressed this frame (cleared each frame) */
    keysPressed: {},

    // ── network / telemetry ────────────────────────────────────────────
    /** @type {string|null} session id for cloud features */
    sessionId: null,
    /** @type {object[]} queued telemetry events */
    telemetryQueue: [],
  };
}

/**
 * Deep-clone the mutable portion of state for cloud save / netcode snapshot.
 * Rooms array is structurally shared (only searched/loot flags change) so
 * we clone those selectively.
 * @param {GameState} s
 * @returns {object}
 */
export function snapshot(s) {
  return {
    phase: s.phase,
    seed: s.seed,
    tick: s.tick,
    timeRemaining: s.timeRemaining,
    lives: s.lives,
    currentRoomId: s.currentRoomId,
    robotSnoozeActive: s.robotSnoozeActive,
    player: { ...s.player },
    simonSeq: [...s.simonSeq],
    simonPlayerIdx: s.simonPlayerIdx,
    // per-room mutable flags only
    roomFlags: s.rooms.map(r => ({
      id: r.id,
      furniture: r.furniture.map(f => ({ id: f.id, searched: f.searched })),
      robots: r.robots.map(rb => ({ id: rb.id, x: rb.x, dir: rb.dir, frozen: rb.frozen })),
      movingPlatforms: r.movingPlatforms.map(mp => ({ id: mp.id, phase: mp.phase })),
      electrifiedZones: r.electrifiedZones.map(z => ({ live: z.live, timer: z.timer })),
    })),
  };
}

/**
 * Restore mutable room flags from a snapshot without rebuilding room geometry.
 * @param {GameState} s
 * @param {object}    snap
 */
export function restore(s, snap) {
  s.phase           = snap.phase;
  s.tick            = snap.tick;
  s.timeRemaining   = snap.timeRemaining;
  s.lives           = snap.lives;
  s.currentRoomId   = snap.currentRoomId;
  s.robotSnoozeActive = snap.robotSnoozeActive;
  Object.assign(s.player, snap.player);
  s.simonSeq = [...snap.simonSeq];
  s.simonPlayerIdx = snap.simonPlayerIdx;
  for (const rf of snap.roomFlags) {
    const room = s.rooms.find(r => r.id === rf.id);
    if (!room) continue;
    rf.furniture.forEach((ff, i) => { if (room.furniture[i]) room.furniture[i].searched = ff.searched; });
    rf.robots.forEach((rb, i) => {
      if (!room.robots[i]) return;
      room.robots[i].x = rb.x;
      room.robots[i].dir = rb.dir;
      room.robots[i].frozen = rb.frozen;
    });
    rf.movingPlatforms.forEach((mp, i) => { if (room.movingPlatforms[i]) room.movingPlatforms[i].phase = mp.phase; });
    rf.electrifiedZones.forEach((z, i) => {
      if (!room.electrifiedZones[i]) return;
      room.electrifiedZones[i].live = z.live;
      room.electrifiedZones[i].timer = z.timer;
    });
  }
}
