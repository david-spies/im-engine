/**
 * @file PasswordSystem.js — Password fragment collection and assembly
 *
 * Manages:
 *   • 9-letter password generation (one fresh random 9-char string per game)
 *   • 36 fragments (4 per letter group) with random orientation flags
 *   • Fragment found/placed state
 *   • Orientation (needsFlip / flipped) validation for placement
 */

import { RNG } from '../engine/RNG.js';

const PASSWORD_LENGTH  = 9;
const FRAGS_PER_LETTER = 4;

/**
 * @typedef {Object} Fragment
 * @property {string}  id
 * @property {string}  letter
 * @property {number}  groupIndex
 * @property {number}  correctSlot  0..3
 * @property {boolean} needsFlip    must be flipped before placing
 * @property {boolean} flipped      current player-toggled state
 * @property {boolean} found
 * @property {boolean} placed
 */

/**
 * @typedef {Object} LetterGroup
 * @property {string}        letter
 * @property {number}        groupIndex
 * @property {(string|null)[]} slots  4 slots, filled with fragId or null
 * @property {number}        filledCount
 * @property {boolean}       complete
 */

export class PasswordSystem {
  /** @param {RNG} rng */
  constructor(rng) {
    this.rng = rng;
    /** @type {LetterGroup[]} */
    this.groups = [];
    /** @type {Fragment[]} */
    this.fragments = [];
    this.password  = '';
  }

  /** Initialise a fresh password and fragment set for a new game */
  init() {
    const letters = this.rng.shuffle('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')).slice(0, PASSWORD_LENGTH);
    this.password  = letters.join('');
    this.groups    = letters.map((L, i) => ({
      letter: L, groupIndex: i,
      slots: [null, null, null, null],
      filledCount: 0, complete: false,
    }));
    this.fragments = [];
    let fid = 0;
    for (let gi = 0; gi < this.groups.length; gi++) {
      for (let s = 0; s < FRAGS_PER_LETTER; s++) {
        this.fragments.push({
          id: `F${fid++}`,
          letter: this.groups[gi].letter,
          groupIndex: gi,
          correctSlot: s,
          needsFlip: this.rng.next() < 0.4,
          flipped: false,
          found: false, placed: false,
        });
      }
    }
    return this.fragments;
  }

  /** @returns {Fragment[]} */
  allFragments() { return this.fragments; }

  /** @returns {LetterGroup[]} */
  getGroups() { return this.groups; }

  /** @returns {string} */
  getPassword() { return this.password; }

  /** @returns {Fragment[]} found but unplaced */
  unplacedFound() { return this.fragments.filter(f => f.found && !f.placed); }

  /** @returns {number} */
  totalFound() { return this.fragments.filter(f => f.found).length; }

  /** @returns {boolean} */
  isComplete() { return this.groups.every(g => g.complete); }

  /** Password display string with _ for incomplete letters */
  currentDisplay() {
    return this.groups.map(g => g.complete ? g.letter : '_').join(' ');
  }

  /** Mark a fragment as found (from furniture search or Simon reward) */
  markFound(fragId) {
    const f = this._find(fragId);
    if (f) f.found = true;
    return f;
  }

  /** Toggle the flipped state of a found, unplaced fragment */
  toggleFlip(fragId) {
    const f = this._find(fragId);
    if (f && f.found && !f.placed) f.flipped = !f.flipped;
  }

  /**
   * Attempt to place a fragment into its correct slot.
   * @param {string} fragId
   * @returns {{ ok: boolean, reason?: string, letterComplete?: boolean, letter?: string, groupIndex?: number }}
   */
  tryPlace(fragId) {
    const frag = this._find(fragId);
    if (!frag || frag.placed) return { ok: false, reason: 'invalid' };

    const correctlyOriented = frag.needsFlip ? frag.flipped : !frag.flipped;
    if (!correctlyOriented)  return { ok: false, reason: 'orientation' };

    const g = this.groups[frag.groupIndex];
    if (g.slots[frag.correctSlot]) return { ok: false, reason: 'occupied' };

    g.slots[frag.correctSlot] = frag.id;
    g.filledCount++;
    frag.placed = true;

    if (g.filledCount === FRAGS_PER_LETTER) {
      g.complete = true;
      return { ok: true, letterComplete: true, letter: g.letter, groupIndex: g.groupIndex };
    }
    return { ok: true, letterComplete: false };
  }

  _find(fragId) { return this.fragments.find(f => f.id === fragId) ?? null; }

  static get PASSWORD_LENGTH()  { return PASSWORD_LENGTH; }
  static get FRAGS_PER_LETTER() { return FRAGS_PER_LETTER; }
  static get TOTAL_FRAGMENTS()  { return PASSWORD_LENGTH * FRAGS_PER_LETTER; }
}
