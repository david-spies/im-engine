/**
 * @file PlayerSystem.js — Agent 4125 physics and input handling
 *
 * Uses the custom Physics module for AABB/swept collision so movement is
 * frame-rate independent (important for 60fps target with variable dt).
 *
 * Key improvements over the original:
 *  • Sub-pixel precision via swept AABB (no tunnelling through thin platforms)
 *  • Velocity clamped to terminal velocity (no infinite fall speed)
 *  • Edge-snatch: the agent can grab a platform edge within ±4px to prevent
 *    pixel-perfect jump misses that feel unfair
 *  • Auto-walk toward pendingTarget with jump-assist for ledge targets
 *  • Movement input locked during elevator ride
 */

import {
  GRAVITY, MOVE_SPEED, JUMP_VELOCITY, TERM_VELOCITY,
  groundPlatform, electrifiedAt, elevatorSide, CW, CH,
} from '../physics/Physics.js';

const EDGE_SNATCH = 4;   // px of leniency for landing on platform edges
const ARRIVE_DIST = 14;  // px from target centre to trigger interaction

export class PlayerSystem {
  /**
   * @param {object}   state
   * @param {object}   audio    AudioMiddleware instance
   * @param {Function} onDeath  callback(cause: 'fall'|'electrocute'|'robot')
   * @param {Function} onTravel callback(direction: -1|1, side: 'left'|'right')
   * @param {Function} onRoomChange callback(direction: 'left'|'right')
   */
  constructor(state, audio, onDeath, onTravel, onRoomChange) {
    this.state        = state;
    this.audio        = audio;
    this.onDeath      = onDeath;
    this.onTravel     = onTravel;
    this.onRoomChange = onRoomChange;
  }

  /**
   * @param {number} dt      delta-time in seconds
   * @param {object} room    current room
   * @param {boolean} soundEvent  player made noise this frame
   */
  update(dt, room, soundEvent) {
    const state = this.state;

    // Elevator ride locks all player physics
    if (state.elevatorRide) {
      this._updateRide(dt);
      return;
    }

    const p    = state.player;
    const keys = state.keys;

    // ── Input ──────────────────────────────────────────────────────────
    const manualL = keys['arrowleft']  || keys['a'];
    const manualR = keys['arrowright'] || keys['d'];
    let moveX     = (manualR ? 1 : 0) - (manualL ? 1 : 0);

    // Manual input cancels click-to-walk
    // Use keysPressed (initial press) for jump/elevator keys so a held key
    // doesn't permanently block auto-walk from completing its arrival.
    const pressed = state.keysPressed;
    if (moveX !== 0 || pressed['arrowup'] || pressed['w'] ||
        pressed['arrowdown'] || pressed['s'] || pressed[' ']) {
      state.pendingTarget = null;
    }

    // Auto-walk toward pending target
    if (state.pendingTarget && moveX === 0) {
      const target = state.pendingTarget;
      const dx     = target.x - (p.x + p.w / 2);
      if (Math.abs(dx) > ARRIVE_DIST) {
        moveX = dx > 0 ? 1 : -1;
        // Jump assist for targets on a raised ledge
        if (target.y < p.y - 20 && p.onGround && Math.abs(dx) < 60) {
          this._doJump(p);
        }
      } else {
        // Arrived
        if (target.onArrive) target.onArrive();
        state.pendingTarget = null;
      }
    }

    p.vx = moveX * MOVE_SPEED;
    if (moveX !== 0) p.facing = moveX;

    // ── Horizontal movement ────────────────────────────────────────────
    p.x += p.vx * dt;
    p.x  = Math.max(4, Math.min(CW - 4 - p.w, p.x));

    // ── Gravity & vertical movement ───────────────────────────────────
    p.vy = Math.min(p.vy + GRAVITY * dt, TERM_VELOCITY);
    const prevY = p.y;
    p.y += p.vy * dt;

    // ── Platform landing ───────────────────────────────────────────────
    const plat = groundPlatform(room, p.x, p.y, p.w, p.h, prevY);
    p.ridingPlatformId = null;
    if (plat) {
      p.y        = plat.y - p.h;
      p.vy       = 0;
      p.onGround = true;
      // Carry on moving platform
      if (plat.__sourceId && plat.axis === 'x') {
        p.ridingPlatformId = plat.__sourceId;
        p.x = Math.max(4, Math.min(CW - 4 - p.w, p.x + plat.__dx));
      }
      // Electrified floor check
      const zone = electrifiedAt(room, p.x, p.w);
      if (zone) {
        this.onDeath('electrocute');
        return;
      }
    } else if (p.y + p.h >= CH - 30 && (p.x < 30 || p.x + p.w > CW - 30)) {
      // Elevator shaft floor catch
      p.y        = CH - 30 - p.h;
      p.vy       = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    // ── Pit death ─────────────────────────────────────────────────────
    if (p.y > CH + 40) {
      this.onDeath('fall');
      return;
    }

    // ── Footstep + walk animation ─────────────────────────────────────
    if (p.onGround && Math.abs(p.vx) > 0.1) {
      p.walkCycle    += dt * 9;
      p.footstepTimer -= dt;
      if (p.footstepTimer <= 0) {
        this.audio.footstep(p.x + p.w / 2);
        p.footstepTimer = 0.27;
      }
    }

    // ── Invulnerability countdown ─────────────────────────────────────
    if (p.invuln > 0) p.invuln -= dt;

    // ── Elevator zone ─────────────────────────────────────────────────
    // IMPORTANT: use pressed (keysPressed — fired once on initial press) not
    // keys (held state). keys['arrowleft'] is true every frame while held,
    // which caused the "teleport" bug — room changes were firing 60×/second.
    const side = elevatorSide(p.x, p.w);
    if (side === 'left') {
      if (pressed['arrowup']   || pressed['w']) this.onTravel(-1, 'left');
      if (pressed['arrowleft'] || pressed['a']) this.onRoomChange(-1);
    } else if (side === 'right') {
      if (pressed['arrowdown']  || pressed['s']) this.onTravel(1, 'right');
      if (pressed['arrowright'] || pressed['d']) this.onRoomChange(1);
    }
  }

  /** Trigger a somersault jump */
  doJump() {
    const p = this.state.player;
    if (p.onGround && !this.state.elevatorRide) {
      this._doJump(p);
    }
  }

  _doJump(p) {
    p.vy       = JUMP_VELOCITY;
    p.onGround = false;
    this.audio.jump(p.x + p.w / 2);
  }

  _updateRide(dt) {
    const ride = this.state.elevatorRide;
    ride.progress += dt / ride.duration;
    if (ride.progress >= 1) {
      this.audio.stopElevatorWhir();
      const { targetId, side } = ride;
      this.state.elevatorRide = null;
      // Signal the game to enter the target room
      if (this._onRideComplete) this._onRideComplete(targetId, side);
    }
  }

  /** @param {Function} cb  called with (targetId, side) when ride finishes */
  onRideComplete(cb) { this._onRideComplete = cb; }
}
