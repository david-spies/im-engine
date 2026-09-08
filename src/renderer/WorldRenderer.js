/**
 * @file WorldRenderer.js — Canvas2D game-world renderer
 *
 * Draws everything onto the offscreen 640×400 game canvas.  The CRTRenderer
 * then post-processes that canvas into the display canvas via WebGL shaders.
 *
 * All draw operations use the pre-allocated colour palette and avoid
 * creating temporary string objects where possible (colours are cached as
 * string constants).  The 2D context state is managed with save()/restore()
 * only around transforms, not for every property change (cheaper).
 */

import { PARTICLES } from '../engine/Pool.js';
import { movingPlatformRectPure } from '../systems/PlatformSystem.js';

// ── Palette ───────────────────────────────────────────────────────────────────

export const PAL = {
  bg:           '#4040c0',
  bgDark:       '#202080',
  wall:         '#7878ff',
  furniture:    '#c060ff',
  furnDark:     '#8030b0',
  ladder:       '#7fdcff',
  agent:        '#ffffff',
  agentShadow:  '#202080',
  robot:        '#ff4040',
  orb:          '#50e050',
  gold:         '#ffb000',
  cyan:         '#7fdcff',
  red:          '#ff4040',
  green:        '#50e050',
};

// ── CW/CH ─────────────────────────────────────────────────────────────────────

const CW = 640, CH = 400;

// ── WorldRenderer ─────────────────────────────────────────────────────────────

export class WorldRenderer {
  /**
   * @param {HTMLCanvasElement} canvas  the 640×400 offscreen game canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * Main entry point — draw the complete frame for one room.
   * @param {object}   state   GameState
   * @param {object}   room    current room object
   * @param {number}   now     performance.now() for animation timers
   */
  draw(state, room, now) {
    const ctx = this.ctx;
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, CW, CH);

    if (!room) return;  // pre-game guard

    this._drawBricks(ctx);
    this._drawShafts(ctx, room, state.elevatorRide);
    this._drawPlatforms(ctx, room);
    this._drawElectrifiedZones(ctx, room, now);
    this._drawMovingPlatforms(ctx, room);
    this._drawFurniture(ctx, room);
    this._drawTerminal(ctx, room);
    this._drawControlRoomGate(ctx, room, state);
    this._drawRobots(ctx, room, state.robotSnoozeActive);
    this._drawParticles(ctx, now);
    this._drawAgent(ctx, state.player, state.elevatorRide);
    this._drawInteractionPrompt(ctx, state, room, now);
    this._drawFloorLabel(ctx, room);
  }

  // ── Background ─────────────────────────────────────────────────────────────

  _drawBricks(ctx) {
    ctx.fillStyle = 'rgba(0,0,30,0.16)';
    for (let bx = 0; bx < CW; bx += 40) {
      for (let by = 10; by < CH - 70; by += 24) {
        const offset = (Math.floor(by / 24) % 2 === 0) ? 0 : 20;
        ctx.fillRect(bx + offset, by, 38, 22);
      }
    }
  }

  // ── Elevator shafts + cab ──────────────────────────────────────────────────

  _drawShafts(ctx, room, ride) {
    ctx.fillStyle = PAL.bgDark;
    ctx.fillRect(0, 0, 32, CH);
    ctx.fillRect(CW - 32, 0, 32, CH);

    ctx.strokeStyle = PAL.ladder;
    ctx.lineWidth   = 2;
    for (let y = 8; y < CH; y += 16) {
      ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(26, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CW - 26, y); ctx.lineTo(CW - 6, y); ctx.stroke();
    }

    // Elevator cab
    const cabBaseY = room.platforms[0].y - 34;
    const drawCab  = (shaftX, active, offsetY = 0) => {
      ctx.fillStyle   = active ? '#3a3aa0' : '#202066';
      ctx.fillRect(shaftX, cabBaseY + offsetY, 26, 34);
      ctx.strokeStyle = PAL.gold;
      ctx.lineWidth   = 1;
      ctx.strokeRect(shaftX + 1, cabBaseY + offsetY + 1, 24, 32);
      ctx.fillStyle = active ? 'rgba(255,176,0,0.85)' : 'rgba(127,220,255,0.35)';
      ctx.fillRect(shaftX + 6, cabBaseY + offsetY + 6, 14, 8);

      // Floor indicator dots
      const FLOORS = 4;
      for (let fl = 0; fl < FLOORS; fl++) {
        const dotY = 6 + fl * ((CH - 20) / FLOORS);
        ctx.fillStyle = fl === room.floor ? PAL.gold : 'rgba(127,220,255,0.3)';
        ctx.fillRect(shaftX === 2 ? shaftX - 2 : shaftX + 28, dotY, 3, 3);
      }
    };

    if (ride) {
      const t = ride.progress;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const ofsY  = ride.direction > 0 ? eased * 60 : -eased * 60;
      const shaftX = ride.side === 'left' ? 2 : CW - 30;
      ctx.save();
      ctx.translate(0, ofsY);
      drawCab(shaftX, true, 0);
      ctx.restore();
    } else {
      drawCab(2,       false);
      drawCab(CW - 30, false);
    }
  }

  // ── Static platforms + ledge ───────────────────────────────────────────────

  _drawPlatforms(ctx, room) {
    ctx.fillStyle = '#10103a';
    for (const p of room.platforms) ctx.fillRect(p.x, p.y, p.w, CH - p.y);
    ctx.fillStyle = PAL.wall;
    for (const p of room.platforms) ctx.fillRect(p.x, p.y, p.w, 6);

    if (room.ledge) {
      const l = room.ledge;
      ctx.fillStyle = '#10103a';
      ctx.fillRect(l.x, l.y, l.w, 14);
      ctx.fillStyle = PAL.wall;
      ctx.fillRect(l.x, l.y, l.w, 5);
    }
  }

  // ── Electrified zones ──────────────────────────────────────────────────────

  _drawElectrifiedZones(ctx, room, now) {
    for (const z of room.electrifiedZones) {
      if (z.live) {
        const flicker = Math.sin(now / 40) * 0.5 + 0.5;
        ctx.fillStyle = `rgba(255,${60 + Math.floor(flicker * 120)},60,0.95)`;
        ctx.fillRect(z.x, z.y - 3, z.w, 5);
        // Spark ticks
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 1;
        for (let sx = z.x + 4; sx < z.x + z.w - 4; sx += 10) {
          const sh = 3 + Math.random() * 5;
          ctx.beginPath();
          ctx.moveTo(sx, z.y - 3);
          ctx.lineTo(sx + (Math.random() < 0.5 ? -2 : 2), z.y - 3 - sh);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = 'rgba(255,176,0,0.55)';
        ctx.fillRect(z.x, z.y - 3, z.w, 4);
        ctx.fillStyle = '#000';
        ctx.font = '7px monospace';
        ctx.fillText('⚠', z.x + z.w / 2 - 3, z.y - 6);
      }
    }
  }

  // ── Moving platforms ───────────────────────────────────────────────────────

  _drawMovingPlatforms(ctx, room) {
    for (const mp of room.movingPlatforms) {
      const r = mp._rect;
      if (!r) continue;
      ctx.fillStyle   = '#2a2a70';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle   = PAL.gold;
      ctx.fillRect(r.x, r.y, r.w, 3);
      ctx.strokeStyle = 'rgba(255,176,0,0.6)';
      ctx.lineWidth   = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }

  // ── Furniture ──────────────────────────────────────────────────────────────

  _drawFurniture(ctx, room) {
    for (const f of room.furniture) {
      ctx.fillStyle = f.searched ? PAL.furnDark : PAL.furniture;
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.fillStyle = '#000';
      ctx.fillRect(f.x, f.y, f.w, 4);
      if (!f.searched) {
        ctx.fillStyle = PAL.gold;
        ctx.font      = '10px monospace';
        ctx.fillText('?', f.x + f.w / 2 - 3, f.y - 4);
      }
    }
  }

  // ── Terminal ───────────────────────────────────────────────────────────────

  _drawTerminal(ctx, room) {
    if (!room.hasPhone || !room.terminal) return;
    const t = room.terminal;
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = '#000';
    ctx.font      = 'bold 8px monospace';
    const label   = room.hasCodeRoom ? 'CODE' : 'TEL';
    ctx.fillText(label, t.x + t.w / 2 - label.length * 2.6, t.y - 4);
  }

  // ── Control room gate ──────────────────────────────────────────────────────

  _drawControlRoomGate(ctx, room, state) {
    if (!room.isControlRoom) return;
    const { PasswordSystem } = state._systems || {};
    const unlocked = state._passwordComplete;
    ctx.fillStyle = PAL.gold;
    ctx.font      = 'bold 16px monospace';
    ctx.fillText('ATOMBENDER CONTROL ROOM', CW / 2 - 150, 60);
    ctx.strokeStyle = unlocked ? PAL.green : PAL.red;
    ctx.lineWidth   = 3;
    ctx.strokeRect(CW / 2 - 90, room.platforms[0].y - 110, 180, 110);
    ctx.fillStyle = unlocked ? PAL.green : PAL.red;
    ctx.font      = '10px monospace';
    ctx.fillText(unlocked ? '[ ACCESS GRANTED ]' : '[ ACCESS DENIED ]', CW / 2 - 60, room.platforms[0].y - 12);
  }

  // ── Robots ─────────────────────────────────────────────────────────────────

  _drawRobots(ctx, room, snoozeActive) {
    for (const r of room.robots) {
      const frozen = r.frozen > 0 || snoozeActive > 0;
      ctx.fillStyle = frozen ? '#888' : PAL.robot;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = '#fff';
      ctx.fillRect(r.x + r.w / 2 - 5, r.y + r.h / 2 - 3, 4, 4);
      ctx.fillRect(r.x + r.w / 2 + 1, r.y + r.h / 2 - 3, 4, 4);
      // Alert indicator for hunter robots
      if (r.fsm === 'ALERT' && !frozen) {
        ctx.fillStyle = PAL.red;
        ctx.fillRect(r.x + r.w / 2 - 2, r.y - 6, 4, 4);
      }
    }
  }

  // ── Particles ──────────────────────────────────────────────────────────────

  _drawParticles(ctx) {
    for (const p of PARTICLES) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.a.toFixed(2)})`;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }

  // ── Agent ──────────────────────────────────────────────────────────────────

  _drawAgent(ctx, p, elevatorRide) {
    if (elevatorRide) return;  // cab is visible instead
    if (!p) return;
    this._agentSprite(ctx, p);
  }

  _agentSprite(ctx, p) {
    const cx     = p.x + p.w / 2;
    const topY   = p.y - 9;
    const facing = p.facing >= 0 ? 1 : -1;
    const air    = !p.onGround;
    const moving = p.onGround && Math.abs(p.vx) > 0.1;

    let legSwing = 0, armSwing = 0, armRaise = 0;
    if (air)    { legSwing = 0.9;  armRaise = 1.1; }
    else if (moving) { legSwing = Math.sin(p.walkCycle) * 0.85; armSwing = Math.sin(p.walkCycle) * 0.7; }

    const hipY      = p.y + p.h * 0.52;
    const shoulderY = p.y + p.h * 0.18;
    const legLen    = p.h * 0.46;
    const armLen    = p.h * 0.36;

    ctx.save();
    ctx.translate(cx, 0); ctx.scale(facing, 1); ctx.translate(-cx, 0);

    // Back limbs
    this._limb(ctx, cx - 2, hipY,      -legSwing, legLen, 3.4, PAL.agentShadow);
    this._limb(ctx, cx - 2, shoulderY, air ? -0.5 : -armSwing, armLen, 2.6, PAL.agentShadow);

    // Torso
    ctx.fillStyle = PAL.agent;
    ctx.beginPath();
    ctx.moveTo(cx - p.w * 0.30, shoulderY);
    ctx.lineTo(cx + p.w * 0.30, shoulderY);
    ctx.lineTo(cx + p.w * 0.22, hipY);
    ctx.lineTo(cx - p.w * 0.22, hipY);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = PAL.agentShadow;
    ctx.fillRect(cx - p.w * 0.24, hipY - 3, p.w * 0.48, 3);

    // Head
    ctx.fillStyle = '#ffe0b0';
    ctx.beginPath();
    ctx.ellipse(cx, topY, p.w * 0.30, p.w * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx + p.w * 0.14, topY - 2, 2, 2);

    // Front limbs
    this._limb(ctx, cx + 2, hipY,      legSwing, legLen, 3.4, PAL.agent);
    this._limb(ctx, cx + 2, shoulderY, air ? armRaise : armSwing, armLen, 2.8, PAL.agent);

    ctx.restore();
  }

  _limb(ctx, x, y, swing, len, width, color) {
    const a    = Math.PI / 2 + swing * 0.55;
    const endX = x + Math.cos(a) * len;
    const endY = y + Math.sin(a) * len;
    ctx.strokeStyle = color;
    ctx.lineWidth   = width;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(endX, endY);
    ctx.stroke();
  }

  // ── Interaction prompt ─────────────────────────────────────────────────────

  _drawInteractionPrompt(ctx, state, room, now) {
    const p = state.player;
    if (!p) return;
    const nearFurniture = room.furniture.find(
      f => !f.searched &&
           Math.abs((f.x + f.w / 2) - (p.x + p.w / 2)) < 26 &&
           Math.abs((f.y + f.h)     - (p.y + p.h))      < 30
    );
    const nearTerminal =
      room.hasPhone && room.terminal &&
      Math.abs((room.terminal.x + room.terminal.w / 2) - (p.x + p.w / 2)) < 26 &&
      Math.abs((room.terminal.y + room.terminal.h)     - (p.y + p.h))      < 30;

    let prompt = null;
    if (nearFurniture)  prompt = 'PRESS E TO SEARCH';
    else if (nearTerminal) prompt = room.hasCodeRoom ? 'PRESS F FOR TERMINAL' : 'PRESS F TO CALL';
    if (!prompt) return;

    ctx.font = 'bold 10px monospace';
    const tw = ctx.measureText(prompt).width;
    const px = Math.max(4, Math.min(CW - tw - 12, p.x + p.w / 2 - tw / 2 - 4));
    const py = p.y - 18;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(px, py - 12, tw + 8, 14);
    ctx.fillStyle = PAL.gold;
    ctx.fillText(prompt, px + 4, py - 1);
  }

  // ── Floor label ────────────────────────────────────────────────────────────

  _drawFloorLabel(ctx, room) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, CH - 18, CW, 18);
    ctx.fillStyle = PAL.cyan;
    ctx.font      = '10px monospace';
    ctx.fillText(
      `FLOOR ${room.floor + 1}  ROOM ${room.indexOnFloor + 1}/8${room.isControlRoom ? '  [CONTROL ROOM]' : ''}`,
      8, CH - 5
    );
  }
}
