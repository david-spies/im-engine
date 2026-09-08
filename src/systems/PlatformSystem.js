/**
 * @file PlatformSystem.js — Moving platform animation and player carry
 *
 * Each moving platform stores a pre-allocated _rect object that is mutated
 * in-place every frame.  Physics and rendering both read _rect — no new
 * object is ever created during update, eliminating the spread-operator
 * GC allocation that existed in the original codebase.
 *
 * Player carry: when the agent's bottom is within 2px of a moving platform's
 * top surface, the platform's per-frame x-delta is added to the agent's x so
 * they ride along without slipping off.
 */

/** @param {object} mp  moving platform entity */
export function movingPlatformRectPure(mp) {
  return mp._rect;   // always current — updated by PlatformSystem each frame
}

export class PlatformSystem {
  /**
   * Initialise pre-allocated _rect on every moving platform in the room.
   * Call once when entering a room.
   * @param {object} room
   */
  static initRoom(room) {
    for (const mp of room.movingPlatforms) {
      if (!mp._rect) {
        mp._rect = { x: 0, y: 0, w: mp.w, h: mp.h, axis: mp.axis, __sourceId: mp.id, __dx: 0, __dy: 0 };
      }
      PlatformSystem._compute(mp);
      mp._lastX = mp._rect.x;
      mp._lastY = mp._rect.y;
    }
  }

  /**
   * Advance all moving platforms in the current room by dt seconds.
   * Mutates mp._rect in-place; also stores frame delta for player carry.
   * @param {object} room
   * @param {number} dt
   */
  static update(room, dt) {
    for (const mp of room.movingPlatforms) {
      mp.phase += mp.speed * dt;
      const prevX = mp._rect.x;
      const prevY = mp._rect.y;
      PlatformSystem._compute(mp);
      mp._rect.__dx = mp._rect.x - prevX;
      mp._rect.__dy = mp._rect.y - prevY;
    }
  }

  /** Compute current position from phase (sine oscillation) */
  static _compute(mp) {
    const t = (Math.sin(mp.phase) + 1) / 2;  // 0..1
    if (mp.axis === 'x') {
      mp._rect.x = mp.minPos + t * (mp.maxPos - mp.minPos);
      mp._rect.y = mp.y;
    } else {
      mp._rect.x = mp.x;
      mp._rect.y = mp.minPos + t * (mp.maxPos - mp.minPos);
    }
  }

  /**
   * Reset all movers in a room to their start phase (Lift Reset pickup effect).
   * @param {object} room
   */
  static resetAll(room) {
    for (const mp of room.movingPlatforms) {
      mp.phase = mp.startPhase;
      PlatformSystem._compute(mp);
      mp._rect.__dx = 0;
      mp._rect.__dy = 0;
    }
  }
}

/**
 * Update the electrified zone cycle timers.
 * @param {object} room
 * @param {number} dt
 */
export function updateElectrifiedZones(room, dt) {
  for (const z of room.electrifiedZones) {
    z.timer -= dt;
    if (z.timer <= 0) {
      z.live  = !z.live;
      z.timer = z.live ? z.onDuration : z.offDuration;
    }
  }
}
