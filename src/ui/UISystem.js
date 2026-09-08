/**
 * @file UISystem.js — HUD and overlay management
 *
 * The HUD is rendered in a separate DOM layer (a transparent div over the
 * canvases) rather than directly onto the game canvas.  This means:
 *   • HUD updates don't dirty the game canvas each frame
 *   • CSS transitions handle smooth timer pulses, danger flash, etc.
 *   • The minimap has its own <canvas> at low resolution (120×90)
 *   • All overlay screens (title, pause, puzzle, phone, simon, win, lose)
 *     are managed here; none touch the game canvas
 */

export class UISystem {
  /** @param {object} elements  map of id → HTMLElement */
  constructor(elements) {
    this.el = elements;
    this._msgTimer = null;
  }

  // ── HUD update ─────────────────────────────────────────────────────────────

  /**
   * @param {object} state         GameState
   * @param {string} passwordDisplay  e.g. "A _ T _ _ _ _ _ _"
   */
  updateHUD(state, passwordDisplay) {
    const t   = Math.max(0, Math.floor(state.timeRemaining));
    const h   = Math.floor(t / 3600);
    const m   = Math.floor((t % 3600) / 60);
    const s   = t % 60;
    const fmt = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');

    this.el.time.textContent     = fmt;
    this.el.password.textContent = passwordDisplay;
    this.el.lives.innerHTML      = Array.from({ length: Math.max(0, state.lives) }).map(() => '●').join('') || '—';

    const danger = state.timeRemaining < 600;
    this.el.time.classList.toggle('danger', danger);
  }

  // ── Minimap ────────────────────────────────────────────────────────────────

  /**
   * @param {object[]} rooms
   * @param {number}   currentRoomId
   * @param {number}   FLOORS
   * @param {number}   PER_FLOOR
   */
  renderMinimap(rooms, currentRoomId, FLOORS, PER_FLOOR) {
    const canvas = this.el.minimap;
    if (!canvas) return;
    const ctx   = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cw = W / PER_FLOOR, ch = H / FLOORS;
    for (const r of rooms) {
      const cx = r.indexOnFloor * cw;
      const cy = (FLOORS - 1 - r.floor) * ch;
      ctx.fillStyle = r.isControlRoom
        ? '#ffb000'
        : r.visited ? '#7fdcff' : '#1a1a5c';
      ctx.fillRect(cx + 1, cy + 1, cw - 2, ch - 2);
    }
    const cur = rooms[currentRoomId];
    if (cur) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1;
      ctx.strokeRect(
        cur.indexOnFloor * cw + 1,
        (FLOORS - 1 - cur.floor) * ch + 1,
        cw - 2, ch - 2
      );
    }
  }

  // ── Message toast ──────────────────────────────────────────────────────────

  /** @param {string} msg @param {number} [duration=2600] */
  showMessage(msg, duration = 2600) {
    if (this._msgTimer) clearTimeout(this._msgTimer);
    this.el.messageText.textContent = msg;
    this.el.messageBar.classList.remove('hidden');
    this._msgTimer = setTimeout(() => {
      this.el.messageText.textContent = 'Agent 4125 standing by.';
    }, duration);
  }

  // ── Screen management ──────────────────────────────────────────────────────

  /** @param {string|null} name */
  showScreen(name) {
    for (const [k, el] of Object.entries(this.el.screens)) {
      el.classList.toggle('hidden', k !== name);
    }
  }

  /** @param {boolean} visible */
  setHUDVisible(visible) {
    this.el.hud.classList.toggle('hidden', !visible);
    this.el.minimapContainer.classList.toggle('hidden', !visible);
    if (!visible) this.el.messageBar.classList.add('hidden');
  }

  // ── Puzzle board ───────────────────────────────────────────────────────────

  /**
   * Render the pocket-computer puzzle grid and fragment shelf.
   * @param {object[]} groups      PasswordSystem.getGroups()
   * @param {object[]} unplaced    unplaced found fragments
   * @param {Function} onPlace     (fragId) => void
   * @param {Function} onFlip      (fragId) => void
   */
  renderPuzzleBoard(groups, unplaced, onPlace, onFlip) {
    const grid = this.el.puzzleGrid;
    grid.innerHTML = '';
    for (const g of groups) {
      for (let s = 0; s < 4; s++) {
        const cell = document.createElement('div');
        cell.className = 'puzzle-cell' +
          (g.slots[s] ? ' filled' : '') +
          (g.complete  ? ' group-complete' : '');
        cell.textContent = g.complete ? g.letter : (g.slots[s] ? '■' : '');
        grid.appendChild(cell);
      }
    }

    const shelf = this.el.pieceShelf;
    shelf.innerHTML = '';
    if (!unplaced.length) {
      const note = document.createElement('div');
      note.className   = 'small-note';
      note.textContent = 'No fragments in inventory. Search more furniture.';
      shelf.appendChild(note);
      return;
    }
    for (const frag of unplaced) {
      const tile = document.createElement('div');
      tile.className = 'piece-tile' + (frag.flipped ? ' flipped' : '');
      tile.textContent = frag.flipped ? '⟲' : '▣';
      tile.title = `Group ${frag.groupIndex + 1}${frag.needsFlip ? ' (may need flip)' : ''}`;
      tile.addEventListener('click',    () => onPlace(frag.id));
      tile.addEventListener('dblclick', () => onFlip(frag.id));
      tile.addEventListener('contextmenu', e => { e.preventDefault(); onFlip(frag.id); });
      shelf.appendChild(tile);
    }
    const hint = document.createElement('div');
    hint.className   = 'small-note';
    hint.textContent = 'Right-click or double-click a fragment to flip its orientation.';
    shelf.appendChild(hint);
  }

  // ── Simon grid ─────────────────────────────────────────────────────────────

  /**
   * @param {number[]} simonTones   SIMON_TONES array
   * @param {Function} onClick      (tileIndex) => void
   */
  renderSimonGrid(simonTones, onClick) {
    const grid = this.el.simonGrid;
    grid.innerHTML = '';
    for (let i = 0; i < simonTones.length; i++) {
      const tile = document.createElement('div');
      tile.className   = 'simon-tile';
      tile.dataset.idx = i;
      tile.textContent = i + 1;
      tile.addEventListener('click', () => onClick(i));
      grid.appendChild(tile);
    }
  }

  flashSimonTile(index, dur = 400) {
    const tile = this.el.simonGrid.children[index];
    if (!tile) return;
    tile.classList.add('lit');
    setTimeout(() => tile.classList.remove('lit'), dur);
  }

  // ── Win screen ─────────────────────────────────────────────────────────────

  showWin(password, timeUsed, lives) {
    this.el.winText.innerHTML =
      `Password "<b>${password}</b>" accepted.<br>
       Atombender neutralized.<br><br>
       Time used: ${this._fmtTime(timeUsed)}<br>
       Lives remaining: ${Math.max(0, lives)}`;
    this.showScreen('win');
  }

  showLose(fragsFound) {
    this.el.loseFrags.textContent = fragsFound;
    this.showScreen('lose');
  }

  _fmtTime(sec) {
    sec = Math.floor(sec);
    return [Math.floor(sec/3600), Math.floor((sec%3600)/60), sec%60]
      .map(v => String(v).padStart(2,'0')).join(':');
  }
}
