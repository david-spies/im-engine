/**
 * @file RobotAI.js — Finite State Machine + A* pathfinding for robot enemies
 *
 * Each robot runs a Hierarchical FSM with three top-level states:
 *   IDLE       → plays patrol route, ignores player
 *   ALERT      → has detected the player; switches to pursuit
 *   STUNNED    → frozen by Robot Snooze; returns to IDLE on expiry
 *
 * Detection uses line-of-sight raycasting across the static platform
 * geometry so robots can't "see through walls" (platform columns act as
 * opaque blockers), plus an acoustic radius that triggers on sound events
 * (searching furniture, using a terminal).
 *
 * Hunter robots in ALERT state use grid-based A* to navigate around
 * furniture and gaps rather than bumping into obstacles.
 */

// ── FSM States ────────────────────────────────────────────────────────────────

export const RobotState = Object.freeze({
  IDLE:    'IDLE',
  ALERT:   'ALERT',
  STUNNED: 'STUNNED',
});

// ── Line-of-sight raycast ────────────────────────────────────────────────────

/**
 * Cast a ray from (x1,y1) to (x2,y2) and return true if it reaches the
 * target without being blocked by any static platform column.
 *
 * Platforms block LOS only vertically (their column from y=platform.y
 * down to bottom of screen) — matching the original game's feel where
 * furniture and platform columns occlude robot sight.
 *
 * @param {number} x1 @param {number} y1
 * @param {number} x2 @param {number} y2
 * @param {object[]} platforms
 * @returns {boolean}
 */
export function hasLineOfSight(x1, y1, x2, y2, platforms) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) / 8; // sample every 8px
  if (steps === 0) return true;
  for (let i = 1; i < steps; i++) {
    const t  = i / steps;
    const sx = x1 + dx * t;
    const sy = y1 + dy * t;
    for (const p of platforms) {
      // treat platform as an impassable column between its top surface and
      // the floor.  A gap in the platform at sx means no blocking.
      if (sx > p.x && sx < p.x + p.w) {
        // point is above the platform surface → no blockage from this plat
        if (sy < p.y) continue;
        // The column itself is solid below the platform surface.
        // But platforms only block between x-span; below platform is floor.
        // For simplicity: if a platform column is between the two endpoints
        // at this x, the sightline is broken.
        return false;
      }
    }
  }
  return true;
}

// ── A* Pathfinder ─────────────────────────────────────────────────────────────

/**
 * Lightweight grid-based A* for robot navigation inside a room.
 * The room is discretised into a 32×20 grid (20px cells on 640×400 canvas).
 * Walkable cells are those that sit on a platform surface.
 *
 * @param {number}   startX  world-space pixel x (robot centre)
 * @param {number}   goalX   world-space pixel x (player centre)
 * @param {number}   groundY platform y the robot stands on
 * @param {object[]} furniture  obstacles to route around
 * @returns {number}  next x pixel the robot should move toward, or goalX
 */
export function aStarNextX(startX, goalX, groundY, furniture) {
  const CELL = 20;
  const COLS = Math.ceil(640 / CELL);

  // Convert to grid x
  const sc = Math.floor(startX / CELL);
  const gc = Math.floor(goalX  / CELL);
  if (sc === gc) return goalX;

  // Build blocked set from furniture that sits on the same platform row
  const blocked = new Set();
  for (const f of furniture) {
    if (Math.abs((f.y + f.h) - groundY) < 4) {
      const fc = Math.floor(f.x / CELL);
      blocked.add(fc);
    }
  }

  // Simple 1D A* (movement only horizontal on a single row)
  const open   = [{ c: sc, g: 0, f: Math.abs(gc - sc) }];
  const closed  = new Set();
  const parent  = new Map();

  while (open.length) {
    // Find lowest f — tiny grid so linear scan is fine
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[best].f) best = i;
    }
    const node = open.splice(best, 1)[0];
    if (node.c === gc) {
      // Trace path back to first step
      let cur = gc;
      while (parent.get(cur) !== sc && parent.has(cur)) cur = parent.get(cur);
      return cur * CELL + CELL / 2;
    }
    closed.add(node.c);
    for (const nc of [node.c - 1, node.c + 1]) {
      if (nc < 0 || nc >= COLS || closed.has(nc) || blocked.has(nc)) continue;
      const g = node.g + 1;
      const existing = open.find(n => n.c === nc);
      if (!existing || g < existing.g) {
        if (!existing) open.push({ c: nc, g, f: g + Math.abs(gc - nc) });
        else { existing.g = g; existing.f = g + Math.abs(gc - nc); }
        parent.set(nc, node.c);
      }
    }
  }
  return goalX; // fallback: direct move
}

// ── Robot FSM update ─────────────────────────────────────────────────────────

const ALERT_RADIUS    = 160; // px — direct sight range
const ACOUSTIC_RADIUS =  90; // px — range for sound-triggered detection

/**
 * Update a single robot entity for one frame.
 * Mutates robot.x, robot.dir, robot.fsm, robot.frozen in-place.
 *
 * @param {object} robot   robot entity data
 * @param {object} player  {x,y,w,h}
 * @param {object} room    current room (platforms, furniture)
 * @param {number} dt      delta seconds
 * @param {boolean} globalFreeze  Robot Snooze active
 * @param {boolean} soundEvent    player made noise this frame (search/terminal)
 */
export function updateRobotFSM(robot, player, room, dt, globalFreeze, soundEvent) {
  // ── STUNNED ─────────────────────────────────────────────────────────
  if (globalFreeze || robot.frozen > 0) {
    robot.fsm = RobotState.STUNNED;
    if (!globalFreeze) robot.frozen -= dt;
    return;
  }

  const px = player.x + player.w / 2;
  const py = player.y + player.h / 2;
  const rx = robot.x  + robot.w  / 2;
  const ry = robot.y  + robot.h  / 2;
  const dist = Math.hypot(px - rx, py - ry);

  // Transition into ALERT
  if (robot.fsm !== RobotState.ALERT) {
    let detected = false;
    if (robot.kind === 'hunter') {
      // Vision: distance + LOS
      if (dist < ALERT_RADIUS && hasLineOfSight(rx, ry, px, py, room.platforms)) {
        detected = true;
      }
      // Acoustics: nearby sound event
      if (soundEvent && dist < ACOUSTIC_RADIUS) detected = true;
    }
    // Patrol bots react only to direct contact (handled in collision system)
    if (detected) robot.fsm = RobotState.ALERT;
  }

  // Lose the player if they move far enough away (give up range)
  if (robot.fsm === RobotState.ALERT && dist > ALERT_RADIUS * 1.6) {
    robot.fsm = RobotState.IDLE;
  }

  // ── IDLE — patrol ───────────────────────────────────────────────────
  if (robot.fsm === RobotState.IDLE || robot.kind === 'stationary') {
    if (robot.kind === 'stationary') return;
    robot.x += robot.dir * robot.speed * dt * 60; // speed in original px/frame units
    if (robot.x < robot.minX) { robot.x = robot.minX; robot.dir = 1; }
    if (robot.x > robot.maxX) { robot.x = robot.maxX; robot.dir = -1; }
    return;
  }

  // ── ALERT — pursuit with A* ─────────────────────────────────────────
  if (robot.kind === 'hunter') {
    const targetX = aStarNextX(rx, px, robot.y + robot.h, room.furniture);
    const dx = targetX - rx;
    robot.dir = dx >= 0 ? 1 : -1;
    robot.x  += robot.dir * robot.speed * dt * 60 * 1.35; // pursuit boost
    robot.x   = Math.max(robot.minX, Math.min(robot.maxX, robot.x));
  } else {
    // Patrol bots keep patrolling even in ALERT (they're dumb)
    robot.x += robot.dir * robot.speed * dt * 60;
    if (robot.x < robot.minX) { robot.x = robot.minX; robot.dir = 1; }
    if (robot.x > robot.maxX) { robot.x = robot.maxX; robot.dir = -1; }
  }
}
