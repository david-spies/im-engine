/**
 * @file Physics.js — Custom 2D physics for Impossible Mission
 *
 * Responsibilities:
 *   • Frame-rate-independent AABB collision detection + response
 *   • Quadtree spatial index for O(log n) proximity queries
 *   • Kinematic platform carrying with sub-pixel precision
 *   • Electrified hazard zone overlap queries
 *   • Edge-snatch logic for elevator entries
 *
 * Constants are tuned to the 640×400 logical canvas coordinate space.
 */

import { allocRect, freeRect } from '../engine/Pool.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const GRAVITY        = 540;   // px/s²  (≈ original feel at 60fps)
export const MOVE_SPEED     = 156;   // px/s
export const JUMP_VELOCITY  = -330;  // px/s
export const TERM_VELOCITY  = 800;   // px/s  maximum downward speed
export const CW             = 640;
export const CH             = 400;

// ── AABB helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if two rects overlap (strict, edges do not count).
 * @param {number} ax @param {number} ay @param {number} aw @param {number} ah
 * @param {number} bx @param {number} by @param {number} bw @param {number} bh
 */
export function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Sweep a moving rect (px,py,pw,ph) with velocity (vx,vy) against a static
 * rect.  Returns the earliest collision time 0..1 or Infinity if no hit.
 * This avoids tunnelling through thin platforms at high speed.
 * @returns {number}
 */
export function sweptAABB(px, py, pw, ph, vx, vy, bx, by, bw, bh) {
  const dxEntry = vx > 0 ? bx - (px + pw) : (bx + bw) - px;
  const dyEntry = vy > 0 ? by - (py + ph) : (by + bh) - py;
  const dxExit  = vx > 0 ? (bx + bw) - px : bx - (px + pw);
  const dyExit  = vy > 0 ? (by + bh) - py : by - (py + ph);

  const txEntry = vx !== 0 ? dxEntry / vx : -Infinity;
  const tyEntry = vy !== 0 ? dyEntry / vy : -Infinity;
  const txExit  = vx !== 0 ? dxExit  / vx :  Infinity;
  const tyExit  = vy !== 0 ? dyExit  / vy :  Infinity;

  const tEntry = Math.max(txEntry, tyEntry);
  const tExit  = Math.min(txExit,  tyExit);

  if (tEntry > tExit || tEntry < 0 || tEntry > 1) return Infinity;
  return tEntry;
}

// ── Quadtree ─────────────────────────────────────────────────────────────────

const QT_MAX_OBJECTS = 6;
const QT_MAX_LEVELS  = 5;

export class Quadtree {
  /**
   * @param {number} level
   * @param {{x:number,y:number,w:number,h:number}} bounds
   */
  constructor(level = 0, bounds = { x: 0, y: 0, w: CW, h: CH }) {
    this.level   = level;
    this.bounds  = bounds;
    /** @type {object[]} */
    this.objects = [];
    /** @type {Quadtree[]} four children, null until split */
    this.nodes   = null;
  }

  /** Remove all objects and collapse children */
  clear() {
    this.objects.length = 0;
    if (this.nodes) {
      for (const n of this.nodes) n.clear();
      this.nodes = null;
    }
  }

  _split() {
    const hw = this.bounds.w / 2, hh = this.bounds.h / 2;
    const x = this.bounds.x, y = this.bounds.y;
    this.nodes = [
      new Quadtree(this.level + 1, { x: x + hw, y: y,      w: hw, h: hh }),
      new Quadtree(this.level + 1, { x: x,       y: y,      w: hw, h: hh }),
      new Quadtree(this.level + 1, { x: x,       y: y + hh, w: hw, h: hh }),
      new Quadtree(this.level + 1, { x: x + hw,  y: y + hh, w: hw, h: hh }),
    ];
  }

  /** Which child node indices does rect {x,y,w,h} fit into? (may span 2-4) */
  _getIndices(obj) {
    const midX = this.bounds.x + this.bounds.w / 2;
    const midY = this.bounds.y + this.bounds.h / 2;
    const top    = obj.y < midY;
    const bottom = obj.y + (obj.h || 0) > midY;
    const left   = obj.x < midX;
    const right  = obj.x + (obj.w || 0) > midX;
    const idx = [];
    if (top    && right) idx.push(0);
    if (top    && left)  idx.push(1);
    if (bottom && left)  idx.push(2);
    if (bottom && right) idx.push(3);
    return idx;
  }

  /** Insert an object with {x,y,w,h} into the tree */
  insert(obj) {
    if (this.nodes) {
      for (const i of this._getIndices(obj)) this.nodes[i].insert(obj);
      return;
    }
    this.objects.push(obj);
    if (this.objects.length > QT_MAX_OBJECTS && this.level < QT_MAX_LEVELS) {
      this._split();
      for (const o of this.objects) {
        for (const i of this._getIndices(o)) this.nodes[i].insert(o);
      }
      this.objects.length = 0;
    }
  }

  /**
   * Retrieve all objects in the same region(s) as the query rect.
   * Results are pushed into `out` array (no allocation).
   * @param {object} query   {x,y,w,h}
   * @param {object[]} out   pre-allocated result array
   */
  retrieve(query, out) {
    if (this.nodes) {
      for (const i of this._getIndices(query)) this.nodes[i].retrieve(query, out);
    }
    for (const o of this.objects) {
      if (!out.includes(o)) out.push(o);
    }
  }
}

// ── Platform resolution ───────────────────────────────────────────────────────

/**
 * Pre-allocated candidate array — reused every frame to avoid GC.
 * @type {object[]}
 */
const _candidates = new Array(16);
let _candidateCount = 0;

/**
 * Find the platform the player rect is currently standing on.
 * Uses the pre-allocated _candidates buffer so zero heap allocation occurs.
 *
 * @param {object}   room
 * @param {number}   x     player left
 * @param {number}   y     player top
 * @param {number}   w
 * @param {number}   h
 * @param {number}   prevY player top position last frame (for swept check)
 * @returns {object|null}  platform object or null
 */
export function groundPlatform(room, x, y, w, h, prevY) {
  _candidateCount = 0;
  for (const p of room.platforms) _candidates[_candidateCount++] = p;
  if (room.ledge) _candidates[_candidateCount++] = room.ledge;
  for (const mp of room.movingPlatforms) {
    _candidates[_candidateCount++] = mp._rect;  // live rect maintained by MovingPlatformSystem
  }

  const bottom = y + h;
  const prevBottom = prevY + h;

  for (let i = 0; i < _candidateCount; i++) {
    const p = _candidates[i];
    if (x + w <= p.x || x >= p.x + p.w) continue;  // no horizontal overlap
    // swept: was above (or at) surface last frame, now at or below
    if (prevBottom <= p.y + 1 && bottom >= p.y) return p;
  }
  return null;
}

/**
 * Check whether the player's x-span overlaps a live electrified zone.
 * @param {object}  room
 * @param {number}  x
 * @param {number}  w
 * @returns {object|null}
 */
export function electrifiedAt(room, x, w) {
  for (const z of room.electrifiedZones) {
    if (z.live && x + w > z.x && x < z.x + z.w) return z;
  }
  return null;
}

/**
 * True if position (px, py) is within the elevator entry zone on either side.
 * @param {number} px  player left x
 * @param {number} pw  player width
 * @returns {'left'|'right'|null}
 */
export function elevatorSide(px, pw) {
  if (px <= 20)         return 'left';
  if (px + pw >= CW - 20) return 'right';
  return null;
}
