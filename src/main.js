/**
 * @file main.js — Application entry point
 *
 * Responsibility: wire the DOM to the Game class.
 * Nothing else lives here — no game logic, no rendering.
 *
 * The "two canvas" pattern:
 *   #game-canvas  640×400 logical canvas — game world is drawn here
 *   #display-canvas  fills the CRT frame — WebGL post-processing output
 *
 * Both canvases are siblings inside #screen so the CSS CRT frame wraps
 * both correctly. The display canvas is visible; the game canvas is hidden.
 */

import { Game } from './Game.js';

// ── Wait for DOM ──────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

  // ── Canvas setup ──────────────────────────────────────────────────────────

  const gameCanvas    = document.getElementById('game-canvas');
  const displayCanvas = document.getElementById('display-canvas');
  gameCanvas.width    = 640;
  gameCanvas.height   = 400;

  // ── DOM element map ───────────────────────────────────────────────────────

  const el = id => document.getElementById(id);

  const elements = {
    gameCanvas,
    displayCanvas,

    // HUD
    hud:              el('hud'),
    time:             el('hud-time'),
    password:         el('hud-password'),
    lives:            el('hud-lives'),
    minimapContainer: el('minimap'),
    minimap:          el('minimap-canvas'),
    messageBar:       el('message-bar'),
    messageText:      el('message-text'),

    // Puzzle board
    puzzleGrid: el('puzzle-grid'),
    pieceShelf: el('piece-shelf'),

    // Simon grid
    simonGrid: el('simon-grid'),

    // Win / lose text
    winText:   el('win-text'),
    loseFrags: el('lose-frags'),

    // Overlay screen containers
    screens: {
      title:  el('screen-title'),
      intro:  el('screen-intro'),
      howto:  el('screen-howto'),
      pause:  el('screen-pause'),
      win:    el('screen-win'),
      lose:   el('screen-lose'),
      puzzle: el('screen-puzzle'),
      phone:  el('screen-phone'),
      simon:  el('screen-simon'),
    },

    // Buttons (UISystem accesses these via document.getElementById
    // as a fallback; the Game class also wires them directly)
    buttons: {},
  };

  // ── Instantiate and launch ────────────────────────────────────────────────

  const game = new Game(elements, {
    apiBase: import.meta.env?.VITE_API_BASE ?? 'https://im-api.example.com',
    wsUrl:   import.meta.env?.VITE_WS_URL   ?? null,
  });

  game.launch();

  // ── Expose for debugging / e2e tests ─────────────────────────────────────

  window.__IM_GAME__ = game;

  // ── Mobile touch controls ─────────────────────────────────────────────────

  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    el('touch-controls')?.classList.add('active');
  }

  document.querySelectorAll('#touch-controls [data-k]').forEach(btn => {
    const k   = btn.getAttribute('data-k');
    const map = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };
    btn.addEventListener('touchstart', e => {
      e.preventDefault();
      if (map[k]) game._state.keys[map[k]] = true;
      if (k === 'jump')   game.doJump();
      if (k === 'search') game.doSearch();
      if (k === 'use')    { game.doUseTerminal(); game.doOpenComputer(); }
    });
    btn.addEventListener('touchend', e => {
      e.preventDefault();
      if (map[k]) game._state.keys[map[k]] = false;
    });
  });

});
