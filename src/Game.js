/**
 * @file Game.js — Central game orchestrator
 *
 * Wires every subsystem together and owns the primary requestAnimationFrame
 * loop.  No game logic lives here — Game.js is purely coordination:
 *   • Instantiate systems
 *   • Route state transitions between screens
 *   • Feed dt to each system in order
 *   • Hand off rendered frames to CRTRenderer
 *
 * Deterministic simulation guarantee:
 *   The RNG is seeded once at game start and never touched by rendering or
 *   audio.  Given the same seed, identical input sequences produce byte-for-
 *   byte identical state — required for netcode lockstep and daily challenges.
 */

import { RNG, dailySeed }        from './engine/RNG.js';
import { createState, snapshot, restore } from './engine/State.js';
import { updateParticles, spawnVaporize, spawnFallDust } from './engine/Pool.js';
import { LevelGen }              from './entities/LevelGen.js';
import { PasswordSystem }        from './entities/PasswordSystem.js';
import { PlatformSystem, updateElectrifiedZones } from './systems/PlatformSystem.js';
import { PlayerSystem }          from './systems/PlayerSystem.js';
import { updateRobotFSM }        from './ai/RobotAI.js';
import { aabbOverlap }           from './physics/Physics.js';
import { WorldRenderer }         from './renderer/WorldRenderer.js';
import { CRTRenderer }           from './renderer/CRTRenderer.js';
import { AudioMiddleware }       from './audio/AudioMiddleware.js';
import { UISystem }              from './ui/UISystem.js';
import { NetworkClient }         from './network/Network.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOTAL_GAME_SECONDS   = 6 * 3600;
const DEATH_PENALTY_SECS   = 10 * 60;
const PHONE_COST_SECS      = 2  * 60;
const ROBOT_SNOOZE_SECS    = 12;
const SIMON_TONES          = [880, 740, 622, 523, 440, 349];
const SIMON_MAX_LENGTH     = 14;
const ATOMBENDER_BARKS     = [
  "Get him, my robots!",
  "Destroy the intruder!",
  "You cannot escape, Agent!",
  "Seize him!",
];

export class Game {
  /**
   * @param {object} elements   DOM element map (see main.js)
   * @param {object} [opts]
   * @param {string} [opts.apiBase]   REST API base URL
   * @param {string} [opts.wsUrl]     WebSocket server URL
   */
  constructor(elements, opts = {}) {
    // Canvases
    this._gameCanvas    = elements.gameCanvas;   // 640×400 offscreen
    this._displayCanvas = elements.displayCanvas; // actual DOM canvas

    // Systems (initialised lazily in start())
    this._rng      = null;
    this._levelGen = null;
    this._pw       = null;
    this._state    = createState();

    this._worldRenderer = new WorldRenderer(this._gameCanvas);
    this._crtRenderer   = new CRTRenderer(this._displayCanvas, this._gameCanvas);
    this._audio         = new AudioMiddleware();
    this._ui            = new UISystem(elements);
    this._network       = new NetworkClient(opts);
    this._playerSystem  = null;

    // Frame timing
    this._rafId    = null;
    this._lastTime = 0;

    // Simon state (local to this session)
    this._simonTileFlash = null;

    // Input
    this._bindInput();
    this._bindButtons(elements);

    // Intro timers
    this._introTimers = [];
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Entry point — show title, start RAF loop */
  launch() {
    this._ui.showScreen('title');
    this._ui.setHUDVisible(false);
    this._rafId = requestAnimationFrame(ts => this._loop(ts));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _beginIntro() {
    this._clearIntroTimers();
    this._audio.cancelSpeech();
    this._state.phase = 'intro';
    this._ui.showScreen('intro');

    const subtitle = this._el('intro-subtitle');
    const line1 = "Another visitor...";
    const line2 = "Stay a while... stay forever!";
    const bark  = "Destroy the intruder!";

    this._audio.speak(`${line1} ${line2}`, { rate: 0.78, pitch: 0.45 });

    this._typewriter(subtitle, line1, 55, () => {
      this._introTimers.push(setTimeout(() => {
        this._typewriter(subtitle, line2, 50, () => {
          this._introTimers.push(setTimeout(() => {
            this._audio.speak(bark, { rate: 1.05, pitch: 0.25, volume: 0.7 });
            this._typewriter(subtitle, `[ ${bark.toUpperCase()} ]`, 40, () => {
              this._introTimers.push(setTimeout(() => this._startGame(), 1400));
            });
          }, 500));
        });
      }, 600));
    });
  }

  _startGame(seed) {
    this._clearIntroTimers();
    this._audio.cancelSpeech();

    // Fresh deterministic seed
    const s = seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    this._rng       = new RNG(s);
    this._levelGen  = new LevelGen(this._rng);
    this._pw        = new PasswordSystem(this._rng);

    const state = this._state = createState();
    state.seed  = s;
    state.phase = 'playing';
    state.timeRemaining = TOTAL_GAME_SECONDS;
    state._passwordComplete = false;

    // Build world
    state.rooms = this._levelGen.buildRooms();
    this._distributeFragments(state.rooms);
    state.currentRoomId = 0;
    state.rooms[0].visited = true;
    this._enterRoom(0, 'spawn');

    // Player system
    this._playerSystem = new PlayerSystem(
      state, this._audio,
      cause => this._killPlayer(cause),
      (dir, side) => this._startElevatorRide(dir, side),
      dir => this._travelRoom(dir),
    );
    this._playerSystem.onRideComplete((targetId, side) => this._enterRoom(targetId, `elevator-${side}`));

    // Audio
    this._audio.resetBarkCooldown();
    this._audio.startDrone();

    // Network telemetry
    this._network.track('game_start', { seed: s });

    this._ui.setHUDVisible(true);
    this._ui.showScreen(null);
    this._ui.showMessage('Mission start. Search every room. Avoid contact with hostiles.');
  }

  _returnToTitle() {
    this._state.phase = 'title';
    this._audio.stopDrone();
    this._audio.stopElevatorWhir();
    this._audio.setRobotHum(0);
    this._audio.cancelSpeech();
    this._ui.setHUDVisible(false);
    this._ui.showScreen('title');
    this._network.flushTelemetry();
  }

  // ── Game loop ─────────────────────────────────────────────────────────────

  _loop(timestamp) {
    this._rafId = requestAnimationFrame(ts => this._loop(ts));
    const dt  = Math.min(0.05, (timestamp - this._lastTime) / 1000);
    this._lastTime = timestamp;

    const state = this._state;

    if (state.phase === 'playing') {
      this._update(dt, timestamp);
    }

    // Render world (always, even on overlays — keeps canvas warm for CRT)
    const room = state.rooms[state.currentRoomId] ?? null;
    state._passwordComplete = this._pw?.isComplete() ?? false;
    this._worldRenderer.draw(state, room, timestamp);
    this._crtRenderer.present(dt);

    // HUD
    if (state.phase === 'playing' || state.phase === 'paused') {
      this._ui.updateHUD(state, this._pw?.currentDisplay() ?? '');
      if (room) this._ui.renderMinimap(state.rooms, state.currentRoomId,
        LevelGen.FLOORS, LevelGen.ROOMS_PER_FLOOR);
    }
  }

  _update(dt, now) {
    const state = this._state;
    const room  = state.rooms[state.currentRoomId];
    if (!room) return;

    // Time
    state.timeRemaining -= dt;
    if (state.timeRemaining <= 0) { state.timeRemaining = 0; this._loseGame(); return; }

    // Platforms + hazards
    PlatformSystem.update(room, dt);
    updateElectrifiedZones(room, dt);

    // Invulnerability
    if (state.player.invuln > 0) state.player.invuln -= dt;

    // Robot snooze countdown
    if (state.robotSnoozeActive > 0) state.robotSnoozeActive -= dt;

    // Sound event flag (did player make noise this frame?)
    const soundEvent = !!state._soundEventThisFrame;
    state._soundEventThisFrame = false;

    // Player physics
    this._playerSystem.update(dt, room, soundEvent);

    // Robot AI (FSM + A*)
    let activeRobots = 0;
    for (const r of room.robots) {
      updateRobotFSM(r, state.player, room, dt, state.robotSnoozeActive > 0, soundEvent);
      if (r.fsm === 'ALERT' && r.kind === 'hunter') {
        this._audio.maybeBark(ATOMBENDER_BARKS, TOTAL_GAME_SECONDS - state.timeRemaining);
      }
      if (r.frozen <= 0 && state.robotSnoozeActive <= 0) activeRobots++;
    }
    this._audio.setRobotHum(Math.min(1, activeRobots * 0.5));

    // Collision: player vs robots
    this._checkRobotCollisions(room, state.player);

    // Particles
    updateParticles(dt);

    // Keybuffer clear (pressed-this-frame flags) — in-place to avoid GC
    const kp = state.keysPressed;
    for (const k in kp) delete kp[k];
  }

  // ── Room traversal ────────────────────────────────────────────────────────

  _enterRoom(targetId, fromSide) {
    const state = this._state;
    if (targetId < 0 || targetId >= state.rooms.length) return;

    state.currentRoomId        = targetId;
    state.pendingTarget        = null;
    state._soundEventThisFrame = false;

    const room   = state.rooms[targetId];
    room.visited = true;

    // Initialise moving platform rects for this room
    PlatformSystem.initRoom(room);

    // Place player at entry point
    const p = state.player;
    if (fromSide === 'left' || fromSide === 'elevator-left') p.x = 40;
    else if (fromSide === 'right' || fromSide === 'elevator-right') p.x = CW - 60;
    else p.x = 60;
    p.y  = room.platforms[0].y - p.h;
    p.vy = 0;
    p.ridingPlatformId = null;

    if (room.isControlRoom) {
      this._tryControlRoom();
    } else {
      this._ui.showMessage(`Room ${targetId + 1} — Floor ${room.floor + 1}.`, 1800);
    }
  }

  _travelRoom(direction) {
    const state = this._state;
    const room  = state.rooms[state.currentRoomId];
    const target = room.indexOnFloor + direction;
    if (target < 0 || target >= LevelGen.ROOMS_PER_FLOOR) {
      this._ui.showMessage('No more rooms in that direction.');
      return;
    }
    const targetId = room.floor * LevelGen.ROOMS_PER_FLOOR + target;
    this._enterRoom(targetId, direction > 0 ? 'left' : 'right');
  }

  _startElevatorRide(direction, side) {
    const state = this._state;
    if (state.elevatorRide) return;
    const room        = state.rooms[state.currentRoomId];
    const targetFloor = room.floor + direction;
    if (targetFloor < 0 || targetFloor >= LevelGen.FLOORS) {
      this._ui.showMessage('The shaft ends here.'); return;
    }
    const targetId = targetFloor * LevelGen.ROOMS_PER_FLOOR + room.indexOnFloor;
    state.elevatorRide = { targetId, direction, progress: 0, duration: 0.7, side };
    this._audio.startElevatorWhir();
  }

  _tryControlRoom() {
    if (this._pw.isComplete()) {
      this._winGame();
    } else {
      this._ui.showMessage(
        `ACCESS DENIED. ${this._pw.totalFound()}/${PasswordSystem.TOTAL_FRAGMENTS} fragments recovered.`, 4200
      );
      const p = this._state.player;
      p.x = CW - 90;
    }
  }

  // ── Death & respawn ───────────────────────────────────────────────────────

  _killPlayer(cause) {
    const state = this._state;
    if (state.player.invuln > 0) return;

    state.lives         -= 1;
    state.timeRemaining -= DEATH_PENALTY_SECS;

    const p = state.player;
    if (cause === 'fall') {
      spawnFallDust(p.x + p.w / 2, p.y + p.h);
      this._audio.fallScream(p.x + p.w / 2);
    } else {
      spawnVaporize(p.x + p.w / 2, p.y + p.h / 2);
      this._audio.vaporize(p.x + p.w / 2);
    }

    const msgs = { fall: 'Fell into a gap!', electrocute: 'Electrified!', robot: 'Robot contact!' };
    this._ui.showMessage(`${msgs[cause] ?? 'Killed!'} —10:00 penalty.`, 3000);

    p.invuln = 2.0;
    const room = state.rooms[state.currentRoomId];
    p.x = 60;
    p.y = room.platforms[0].y - p.h;
    p.vy = 0;
    p.ridingPlatformId = null;

    this._network.track('death', { cause, room: state.currentRoomId, timeLeft: state.timeRemaining });

    if (state.lives <= 0 || state.timeRemaining <= 0) this._loseGame();
  }

  _checkRobotCollisions(room, p) {
    if (p.invuln > 0 || this._state.robotSnoozeActive > 0) return;
    for (const r of room.robots) {
      if (r.frozen > 0) continue;
      if (aabbOverlap(p.x, p.y, p.w, p.h, r.x, r.y, r.w, r.h)) {
        this._killPlayer('robot'); return;
      }
    }
  }

  // ── Interactions ──────────────────────────────────────────────────────────

  doSearch() {
    const state = this._state;
    if (state.phase !== 'playing' || state.elevatorRide) return;
    const room = state.rooms[state.currentRoomId];
    const p    = state.player;
    const target = room.furniture.find(
      f => !f.searched &&
           Math.abs((f.x + f.w / 2) - (p.x + p.w / 2)) < 26 &&
           Math.abs((f.y + f.h)     - (p.y + p.h))      < 30
    );
    if (!target) { this._ui.showMessage('Nothing nearby to search.'); return; }

    target.searched = true;
    state._soundEventThisFrame = true;
    this._audio.search(p.x + p.w / 2);
    this._resolveLoot(target.loot, target);
  }

  _resolveLoot(loot, furn) {
    const state = this._state;
    const room  = state.rooms[state.currentRoomId];
    if (!loot || loot.kind === 'nothing') {
      this._audio.nothing();
      this._ui.showMessage('You searched it. Nothing here.');
      return;
    }
    switch (loot.kind) {
      case 'fragment': {
        const frag = this._pw.markFound(loot.fragId);
        this._audio.pickup(furn.x + furn.w / 2);
        this._ui.showMessage(`Found fragment for group ${frag.groupIndex + 1}! Open Pocket Computer (ENTER).`, 3600);
        this._network.track('fragment_found', { fragId: loot.fragId, room: state.currentRoomId });
        break;
      }
      case 'snooze':
        state.robotSnoozeActive = ROBOT_SNOOZE_SECS;
        this._audio.snooze(furn.x + furn.w / 2);
        this._ui.showMessage('Robot Snooze! All robots frozen for 12 seconds.');
        break;
      case 'liftreset':
        PlatformSystem.resetAll(room);
        room.robots.forEach(r => { r.x = Math.max(r.minX, Math.min(r.maxX, r.x)); });
        this._audio.blip(500, furn.x);
        this._ui.showMessage('Lift Reset — all moving platforms recalibrated.');
        break;
      case 'time':
        state.timeRemaining += loot.amount;
        this._audio.blip(700, furn.x);
        this._ui.showMessage(`Chronometer chip: +${Math.round(loot.amount / 60)} minutes.`);
        break;
    }
  }

  doUseTerminal() {
    const state = this._state;
    if (state.phase !== 'playing' || state.elevatorRide) return;
    const room = state.rooms[state.currentRoomId];
    if (!room.hasPhone) { this._ui.showMessage('No terminal here.'); return; }
    state._soundEventThisFrame = true;
    if (room.hasCodeRoom) this._openSimon();
    else this._openPhone();
  }

  doOpenComputer() {
    if (this._state.phase !== 'playing' || this._state.elevatorRide) return;
    this._openPuzzleBoard();
  }

  doJump() {
    if (this._state.phase !== 'playing') return;
    this._playerSystem?.doJump();
  }

  // ── Puzzle board ──────────────────────────────────────────────────────────

  _openPuzzleBoard() {
    this._state.phase = 'puzzle';
    this._ui.showScreen('puzzle');
    this._renderPuzzle();
  }

  _closePuzzleBoard() {
    this._state.phase = 'playing';
    this._ui.showScreen(null);
  }

  _renderPuzzle() {
    this._ui.renderPuzzleBoard(
      this._pw.getGroups(),
      this._pw.unplacedFound(),
      fragId => {
        const r = this._pw.tryPlace(fragId);
        if (r.ok) {
          this._audio.pickup();
          if (r.letterComplete) {
            this._audio.letter();
            this._ui.showMessage(`Letter group ${r.groupIndex + 1} complete: "${r.letter}"!`, 2600);
          }
        } else if (r.reason === 'orientation') {
          this._audio.nothing();
          this._ui.showMessage('Wrong orientation — try flipping (right-click / double-click).', 2600);
        }
        this._renderPuzzle();
        if (this._pw.isComplete()) {
          this._ui.el.password.textContent = this._pw.currentDisplay();
        }
      },
      fragId => { this._pw.toggleFlip(fragId); this._renderPuzzle(); }
    );
  }

  // ── Phone terminal ────────────────────────────────────────────────────────

  _openPhone() {
    this._state.phase = 'phone';
    this._ui.showScreen('phone');
    const unplaced  = this._pw.unplacedFound();
    const phoneText = this._el('phone-text');
    const orientBtn = this._el('btn-phone-orient');
    if (!unplaced.length) {
      phoneText.textContent = 'No fragments to orient. Find more puzzle pieces first.';
      orientBtn.disabled    = true;
    } else {
      phoneText.textContent = `${unplaced.length} fragment(s) can be auto-oriented for 2 minutes.`;
      orientBtn.disabled    = false;
    }
  }

  _closePhone() { this._state.phase = 'playing'; this._ui.showScreen(null); }

  _orientViaPhone() {
    const unplaced = this._pw.unplacedFound();
    if (!unplaced.length) return;
    if (this._state.timeRemaining < PHONE_COST_SECS) {
      this._ui.showMessage('Insufficient time for this call.'); return;
    }
    this._state.timeRemaining -= PHONE_COST_SECS;
    const frag = unplaced[0];
    frag.flipped = frag.needsFlip;
    this._audio.blip(600);
    this._ui.showMessage('Fragment orientation corrected.', 2200);
    this._openPhone();
  }

  // ── Simon (Musical Checkers) ──────────────────────────────────────────────

  _openSimon() {
    const state = this._state;
    state.phase        = 'simon';
    state.simonSeq     = [];
    state.simonPlayerIdx = 0;
    state.simonPlaying   = false;

    const room      = state.rooms[state.currentRoomId];
    const floorRatio = room.floor / Math.max(1, LevelGen.FLOORS - 1);
    const minLen     = 4 + Math.round(floorRatio * 4);
    const maxLen     = 7 + Math.round(floorRatio * 7);
    const length     = Math.min(SIMON_MAX_LENGTH, this._rng.int(minLen, maxLen));
    state.simonTempo = Math.max(360, 600 - length * 16);

    for (let i = 0; i < length; i++) state.simonSeq.push(this._rng.int(0, 5));

    this._ui.showScreen('simon');
    this._ui.renderSimonGrid(SIMON_TONES, i => this._handleSimonClick(i));
    this._el('simon-status').textContent =
      `Sequence length: ${length}. Click PLAY SEQUENCE, then repeat.`;
  }

  _playSimonSequence() {
    const state = this._state;
    if (state.simonPlaying) return;
    state.simonPlaying    = true;
    state.simonPlayerIdx  = 0;
    const tempo   = state.simonTempo;
    const flashDur = Math.max(220, tempo - 220);
    this._el('simon-status').textContent = 'Watch and listen carefully...';
    state.simonSeq.forEach((idx, i) => {
      setTimeout(() => {
        this._ui.flashSimonTile(idx, flashDur);
        this._audio.simonTone(SIMON_TONES[idx]);
      }, i * tempo);
    });
    setTimeout(() => {
      state.simonPlaying = false;
      this._el('simon-status').textContent = 'Your turn — repeat the sequence.';
    }, state.simonSeq.length * tempo + 200);
  }

  _handleSimonClick(i) {
    const state = this._state;
    if (state.simonPlaying || state.phase !== 'simon') return;
    this._ui.flashSimonTile(i, 200);
    this._audio.simonTone(SIMON_TONES[i]);
    if (i !== state.simonSeq[state.simonPlayerIdx]) {
      this._el('simon-status').textContent = 'Incorrect. Terminal lockout.';
      this._audio.nothing();
      setTimeout(() => this._closeSimon(), 1400);
      return;
    }
    state.simonPlayerIdx++;
    if (state.simonPlayerIdx >= state.simonSeq.length) {
      this._el('simon-status').textContent = 'Correct! Dispensing reward...';
      this._audio.letter();
      this._grantSimonReward();
      setTimeout(() => this._closeSimon(), 1600);
    }
  }

  _grantSimonReward() {
    const roll = this._rng.next();
    if (roll < 0.4) {
      this._state.robotSnoozeActive = 15;
      this._ui.showMessage('Bonus: Robot Snooze (15s)!');
    } else if (roll < 0.7) {
      this._state.timeRemaining += 10 * 60;
      this._ui.showMessage('Bonus: +10 minutes!');
    } else {
      const rem = this._pw.allFragments().filter(f => !f.found);
      if (rem.length) {
        const frag = this._pw.markFound(this._rng.choice(rem).id);
        this._ui.showMessage(`Bonus: Fragment for group ${frag.groupIndex + 1} recovered!`);
      } else {
        this._state.timeRemaining += 10 * 60;
        this._ui.showMessage('Bonus: +10 minutes!');
      }
    }
  }

  _closeSimon() { this._state.phase = 'playing'; this._ui.showScreen(null); }

  // ── Win / Lose ────────────────────────────────────────────────────────────

  _winGame() {
    this._state.phase = 'won';
    this._audio.win();
    this._audio.stopDrone();
    this._audio.setRobotHum(0);
    const used = TOTAL_GAME_SECONDS - this._state.timeRemaining;
    this._ui.showWin(this._pw.getPassword(), used, this._state.lives);
    this._network.track('win', { timeUsed: used, seed: this._state.seed });
    this._network.flushTelemetry();
  }

  _loseGame() {
    this._state.phase = 'lost';
    this._audio.lose();
    this._audio.stopDrone();
    this._audio.setRobotHum(0);
    this._ui.showLose(this._pw.totalFound());
    this._network.track('loss', { fragsFound: this._pw.totalFound(), seed: this._state.seed });
    this._network.flushTelemetry();
  }

  // ── Fragment distribution ─────────────────────────────────────────────────

  _distributeFragments(rooms) {
    const frags = this._pw.init();
    const slots = [];
    for (const r of rooms) {
      if (!r.isControlRoom) r.furniture.forEach(f => slots.push({ room: r, furn: f }));
    }
    const shuffled = this._rng.shuffle(slots);
    frags.forEach((frag, i) => {
      if (i < shuffled.length) shuffled[i].furn.loot = { kind: 'fragment', fragId: frag.id };
    });
    for (let i = frags.length; i < shuffled.length; i++) {
      const roll = this._rng.next();
      const furn = shuffled[i].furn;
      if      (roll < 0.18) furn.loot = { kind: 'snooze' };
      else if (roll < 0.30) furn.loot = { kind: 'liftreset' };
      else if (roll < 0.40) furn.loot = { kind: 'time', amount: this._rng.int(2, 8) * 60 };
      else                  furn.loot = { kind: 'nothing' };
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  _bindInput() {
    // CRITICAL: never capture this._state in a closure here.
    // _startGame() replaces this._state with a fresh object, so any closure
    // that captured the old reference would write keys to a stale object that
    // PlayerSystem no longer reads — causing complete input failure.
    // Always dereference this._state at call time so we always hit the live state.

    window.addEventListener('keydown', e => {
      const state = this._state;   // read live reference every event
      const key = e.key.toLowerCase();

      state.keys[key] = true;
      state.keysPressed[key] = true;

      if ([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
        e.preventDefault();
      }

      if (state.phase === 'playing') {
        if (e.key === ' ')   this.doJump();
        if (key === 'e')     this.doSearch();
        if (key === 'f')     this.doUseTerminal();
        if (e.key === 'Enter')   this.doOpenComputer();
        if (e.key === 'Escape')  this._pause();
      } else if (state.phase === 'intro')  {
        this._startGame();
      } else if (state.phase === 'paused') {
        if (e.key === 'Escape') this._resume();
      }
    });

    window.addEventListener('keyup', e => {
      this._state.keys[e.key.toLowerCase()] = false;  // always live reference
    });

    // Canvas click-to-interact
    const canvas = this._displayCanvas;
    canvas.addEventListener('click',    e => this._handleCanvasClick(e));
    canvas.addEventListener('touchend', e => { e.preventDefault(); this._handleCanvasClick(e); });
  }

  _handleCanvasClick(e) {
    if (this._state.phase !== 'playing') return;
    const rect    = this._displayCanvas.getBoundingClientRect();
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    const scaleX  = 640 / rect.width;
    const scaleY  = 400 / rect.height;
    const gx = (clientX - rect.left) * scaleX;
    const gy = (clientY - rect.top)  * scaleY;

    const room = this._state.rooms[this._state.currentRoomId];
    if (!room) return;

    const furnHit = room.furniture.find(
      f => !f.searched && gx >= f.x - 4 && gx <= f.x + f.w + 4 && gy >= f.y - 14 && gy <= f.y + f.h + 4
    );
    if (furnHit) {
      this._state.pendingTarget = {
        kind: 'furniture', ref: furnHit,
        x: furnHit.x + furnHit.w / 2, y: furnHit.y,
        onArrive: () => this.doSearch(),
      };
      this._ui.showMessage('Moving to search...', 1400);
      return;
    }
    if (room.hasPhone && room.terminal) {
      const t = room.terminal;
      if (gx >= t.x - 4 && gx <= t.x + t.w + 4 && gy >= t.y - 14 && gy <= t.y + t.h + 4) {
        this._state.pendingTarget = {
          kind: 'terminal', ref: t,
          x: t.x + t.w / 2, y: t.y,
          onArrive: () => this.doUseTerminal(),
        };
        this._ui.showMessage('Moving to terminal...', 1400);
        return;
      }
    }
    this._state.pendingTarget = { kind: 'walk', x: gx, y: gy };
  }

  _bindButtons(elements) {
    const on = (id, fn) => {
      const el = elements.buttons?.[id] ?? document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('btn-start',        () => this._beginIntro());
    on('btn-howto',        () => this._ui.showScreen('howto'));
    on('btn-howto-back',   () => this._ui.showScreen('title'));
    on('btn-resume',       () => this._resume());
    on('btn-restart',      () => this._returnToTitle());
    on('btn-win-restart',  () => this._returnToTitle());
    on('btn-lose-restart', () => this._returnToTitle());
    on('btn-intro-skip',   () => this._startGame());
    on('btn-puzzle-close', () => this._closePuzzleBoard());
    on('btn-phone-orient', () => this._orientViaPhone());
    on('btn-phone-close',  () => this._closePhone());
    on('btn-simon-start',  () => this._playSimonSequence());
    on('btn-simon-leave',  () => this._closeSimon());
  }

  _pause() {
    if (this._state.phase !== 'playing') return;
    this._state.phase = 'paused';
    this._audio.stopDrone();
    this._ui.showScreen('pause');
  }

  _resume() {
    this._state.phase = 'playing';
    this._lastTime    = performance.now();
    this._audio.startDrone();
    this._ui.showScreen(null);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _el(id) { return document.getElementById(id); }

  _clearIntroTimers() {
    this._introTimers.forEach(t => clearTimeout(t));
    this._introTimers = [];
  }

  _typewriter(el, text, speed, onDone) {
    el.textContent = '';
    let i = 0;
    const step = () => {
      if (i <= text.length) {
        el.textContent = text.slice(0, i++);
        this._introTimers.push(setTimeout(step, speed));
      } else if (onDone) { onDone(); }
    };
    step();
  }

  /** Cloud save the current state snapshot */
  async saveToCloud() {
    const snap = snapshot(this._state);
    return this._network.saveCloud(snap);
  }

  /** Load and restore a cloud save */
  async loadFromCloud() {
    const snap = await this._network.loadCloud();
    if (!snap || !this._state.rooms.length) return false;
    restore(this._state, snap);
    return true;
  }
}

// Re-export CW for WorldRenderer and PlayerSystem
const CW = 640;
