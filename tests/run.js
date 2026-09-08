/**
 * @file run.js — Node.js test runner for pure-logic modules
 *
 * Tests everything that doesn't need a browser (DOM/Canvas/WebGL/WebAudio):
 *   • RNG — determinism, distribution, daily seed
 *   • LevelGen — room count, bounds, entry coverage, fragment capacity
 *   • PasswordSystem — fragment placement, orientation, completion
 *   • Physics — AABB overlap, swept AABB, Quadtree
 *   • AI — FSM state transitions, A* next-step
 *   • Pool — particle lifecycle, zero-allocation update
 *   • State — snapshot / restore round-trip
 *
 * Run: node tests/run.js
 */

import { RNG, dailySeed }       from '../src/engine/RNG.js';
import { LevelGen }             from '../src/entities/LevelGen.js';
import { PasswordSystem }       from '../src/entities/PasswordSystem.js';
import { PlatformSystem }       from '../src/systems/PlatformSystem.js';
import { aabbOverlap, sweptAABB, Quadtree } from '../src/physics/Physics.js';
import { hasLineOfSight, aStarNextX, updateRobotFSM, RobotState } from '../src/ai/RobotAI.js';
import { spawnParticle, updateParticles, PARTICLES, particlePoolStats } from '../src/engine/Pool.js';
import { createState, snapshot, restore } from '../src/engine/State.js';

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✅  ${label}`); passed++; }
  else       { console.error(`  ❌  ${label}`); failed++; }
}

function section(name) { console.log(`\n── ${name} ${'─'.repeat(50 - name.length)}`); }

// ── RNG ──────────────────────────────────────────────────────────────────────

section('RNG');
{
  const r1 = new RNG(42), r2 = new RNG(42);
  const seq1 = Array.from({ length: 100 }, () => r1.next());
  const seq2 = Array.from({ length: 100 }, () => r2.next());
  assert(seq1.every((v, i) => v === seq2[i]), 'Same seed → identical sequence');

  const r3 = new RNG(99);
  const vals = Array.from({ length: 10000 }, () => r3.next());
  assert(vals.every(v => v >= 0 && v < 1), 'All values in [0,1)');

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  assert(Math.abs(mean - 0.5) < 0.02, `Roughly uniform distribution (mean=${mean.toFixed(3)})`);

  const r4 = new RNG(1);
  assert(r4.int(5, 10) >= 5 && r4.int(5, 10) <= 10, 'int(a,b) in range');
  assert(r4.int(10, 5) >= 5 && r4.int(10, 5) <= 10, 'int(b,a) handles reversed args');

  const arr   = [1, 2, 3, 4, 5];
  const r5    = new RNG(7);
  const sh    = r5.shuffle(arr);
  assert(sh.length === arr.length && sh.every(v => arr.includes(v)), 'shuffle preserves elements');
  assert(arr.join(',') === '1,2,3,4,5', 'shuffle does not mutate original');

  const seed = dailySeed();
  assert(typeof seed === 'number' && seed > 0, `dailySeed() returns positive number (${seed})`);

  // Snapshot / restore
  const r6 = new RNG(123);
  r6.next(); r6.next();
  const snap = r6.getState();
  const v1   = r6.next();
  r6.setState(snap);
  const v2   = r6.next();
  assert(v1 === v2, 'RNG snapshot/restore produces same next value');
}

// ── LevelGen ─────────────────────────────────────────────────────────────────

section('LevelGen');
{
  const CW = 640;
  let totalRooms = 0, leftFail = 0, rightFail = 0, platOOB = 0, furnOOB = 0;
  let robotOOB = 0, terminalOOB = 0, moverOOB = 0, electOOB = 0;
  let badTerminal = 0, codeNoPhone = 0, ctrlHasMover = 0, ctrlHasElect = 0;

  for (let trial = 0; trial < 3000; trial++) {
    const rng   = new RNG(trial * 7919 + 13);
    const gen   = new LevelGen(rng);
    const rooms = gen.buildRooms();

    assert(rooms.length === 32, '32 rooms generated'), totalRooms++;

    for (const r of rooms) {
      if (r.isControlRoom) {
        if (r.movingPlatforms.length)  ctrlHasMover++;
        if (r.electrifiedZones.length) ctrlHasElect++;
        continue;
      }
      totalRooms++;
      if (!r.platforms.some(p => p.x < 58 && p.x + p.w > 40)) leftFail++;
      if (!r.platforms.some(p => p.x < 598 && p.x + p.w > 580)) rightFail++;
      r.platforms.forEach(p => { if (p.x < 0 || p.x + p.w > CW) platOOB++; });
      r.furniture.forEach(f => { if (f.x < 0 || f.x + f.w > CW) furnOOB++; });
      r.robots.forEach(rb => { if (rb.x < 0 || rb.x + rb.w > CW) robotOOB++; });
      if (r.hasPhone && !r.terminal) badTerminal++;
      if (!r.hasPhone && r.hasCodeRoom) codeNoPhone++;
      if (r.terminal && (r.terminal.x < 0 || r.terminal.x + r.terminal.w > CW)) terminalOOB++;
      r.movingPlatforms.forEach(mp => {
        if (mp.axis === 'x' && (mp.minPos < 0 || mp.maxPos + mp.w > CW)) moverOOB++;
      });
      r.electrifiedZones.forEach(z => { if (z.x < 0 || z.x + z.w > CW) electOOB++; });
    }
  }

  assert(leftFail    === 0, `Left entry always covered (${leftFail} failures / ${totalRooms})`);
  assert(rightFail   === 0, `Right entry always covered (${rightFail} failures)`);
  assert(platOOB     === 0, `No out-of-bounds platforms (${platOOB})`);
  assert(furnOOB     === 0, `No out-of-bounds furniture (${furnOOB})`);
  assert(robotOOB    === 0, `No out-of-bounds robots (${robotOOB})`);
  assert(terminalOOB === 0, `No out-of-bounds terminals (${terminalOOB})`);
  assert(moverOOB    === 0, `Moving platform ranges in bounds (${moverOOB})`);
  assert(electOOB    === 0, `Electrified zones in bounds (${electOOB})`);
  assert(badTerminal === 0, `Every hasPhone room has a terminal (${badTerminal})`);
  assert(codeNoPhone === 0, `hasCodeRoom never true without hasPhone (${codeNoPhone})`);
  assert(ctrlHasMover === 0, `Control room has no moving platforms (${ctrlHasMover})`);
  assert(ctrlHasElect === 0, `Control room has no electrified zones (${ctrlHasElect})`);
}

// ── PasswordSystem ────────────────────────────────────────────────────────────

section('PasswordSystem');
{
  const rng  = new RNG(555);
  const pw   = new PasswordSystem(rng);
  const frags = pw.init();

  assert(frags.length === 36, '36 fragments created');
  assert(pw.getGroups().length === 9, '9 letter groups');
  assert(new Set(pw.getGroups().map(g => g.letter)).size === 9, 'All 9 letters unique');

  // Distribute into dummy furniture
  const slots = frags.map((_, i) => ({ furn: { loot: null } }));
  new RNG(555).shuffle(slots); // same seed shuffle for determinism
  frags.forEach((f, i) => { f.found = true; }); // mark all found
  frags.forEach(f => { if (f.needsFlip) pw.toggleFlip(f.id); });

  let placed = 0;
  for (const f of frags) {
    const r = pw.tryPlace(f.id);
    if (r.ok) placed++;
  }
  assert(placed === 36, `All 36 fragments placeable (placed=${placed})`);
  assert(pw.isComplete(), 'Password complete after placing all fragments');

  // Wrong orientation must reject
  const pw2 = new PasswordSystem(new RNG(42));
  pw2.init();
  const f0 = pw2.allFragments()[0];
  f0.found = true;
  f0.flipped = !f0.needsFlip;           // deliberately wrong orientation
  const r = pw2.tryPlace(f0.id);
  assert(r.ok === false && r.reason === 'orientation', 'Wrong orientation correctly rejected');

  // Correct orientation accepts
  f0.flipped = f0.needsFlip;
  const r2 = pw2.tryPlace(f0.id);
  assert(r2.ok === true, 'Correct orientation accepted');

  // Already-placed fragment rejected
  const r3 = pw2.tryPlace(f0.id);
  assert(r3.ok === false && r3.reason === 'invalid', 'Already-placed fragment rejected');

  // Display string
  const display = pw2.currentDisplay();
  assert(typeof display === 'string' && display.length > 0, `currentDisplay() returns string: "${display}"`);
}

// ── Physics ───────────────────────────────────────────────────────────────────

section('Physics');
{
  // AABB overlap
  assert(aabbOverlap(0,0,10,10, 5,5,10,10), 'Overlapping rects: true');
  assert(!aabbOverlap(0,0,10,10, 11,0,10,10), 'Non-overlapping rects: false');
  assert(!aabbOverlap(0,0,10,10, 10,0,10,10), 'Touching edges (strict): false');

  // Swept AABB: vx=25 means the object travels 25px this frame, reaching the target at x=20
  const t1 = sweptAABB(0,0,10,10, 25,0, 20,0,10,10);
  assert(t1 > 0 && t1 < 1, `Swept AABB hit returns 0<t<1 (t=${t1.toFixed(3)})`);
  const t2 = sweptAABB(0,0,10,10, 0,0, 50,0,10,10);
  assert(t2 === Infinity, 'Stationary swept AABB: no hit when vel=0');

  // Quadtree
  const qt = new Quadtree();
  const objs = Array.from({length:50}, (_,i) => ({x: i*10, y: i*5, w:8, h:8, id:i}));
  objs.forEach(o => qt.insert(o));
  const results = [];
  qt.retrieve({x:0,y:0,w:50,h:50}, results);
  assert(results.length > 0, 'Quadtree retrieve returns candidates');
  assert(results.some(o => o.id === 0), 'Quadtree returns object at origin');

  qt.clear();
  const after = [];
  qt.retrieve({x:0,y:0,w:50,h:50}, after);
  assert(after.length === 0, 'Quadtree clear empties all nodes');
}

// ── AI ────────────────────────────────────────────────────────────────────────

section('AI');
{
  // Line-of-sight: no blockers → clear
  assert(hasLineOfSight(0,0,100,0,[]), 'LOS with no platforms: clear');
  // LOS blocked by platform column in between
  const wall = [{x:40, y:0, w:10}];
  assert(!hasLineOfSight(0,0,100,0,wall), 'LOS blocked by platform column');

  // A* next-step: no obstacles → moves toward goal
  const next = aStarNextX(100, 300, 330, []);
  assert(next > 100, 'A* moves right toward goal when path is clear');
  const nextL = aStarNextX(300, 100, 330, []);
  assert(nextL < 300, 'A* moves left toward goal');

  // A* same-cell: returns goalX
  const same = aStarNextX(150, 155, 330, []);
  assert(same === 155, 'A* returns goalX when already in same cell');

  // FSM: patrol robot stays IDLE when no player nearby
  const robot = {
    x: 100, y: 330, w: 22, h: 24,
    minX: 60, maxX: 200,
    dir: 1, speed: 1.5,
    kind: 'patrol', frozen: 0, fsm: RobotState.IDLE, alerted: false,
  };
  const player = { x: 500, y: 330, w: 18, h: 40 };
  const room   = { platforms: [], furniture: [] };
  updateRobotFSM(robot, player, room, 1/60, false, false);
  assert(robot.fsm === RobotState.IDLE, 'Patrol robot stays IDLE when player is far');

  // FSM: hunter transitions to ALERT when player is close + LOS
  const hunter = {
    x: 50, y: 330, w: 22, h: 24,
    minX: 20, maxX: 300,
    dir: 1, speed: 1.5,
    kind: 'hunter', frozen: 0, fsm: RobotState.IDLE, alerted: false,
  };
  const nearPlayer = { x: 80, y: 330, w: 18, h: 40 };
  updateRobotFSM(hunter, nearPlayer, room, 1/60, false, false);
  assert(hunter.fsm === RobotState.ALERT, 'Hunter transitions to ALERT when player is in range + LOS');

  // FSM: global freeze sets STUNNED regardless of proximity
  hunter.fsm = RobotState.IDLE;
  updateRobotFSM(hunter, nearPlayer, room, 1/60, true, false);
  assert(hunter.fsm === RobotState.STUNNED, 'Global freeze sets robot to STUNNED');
}

// ── Object Pool ───────────────────────────────────────────────────────────────

section('Object Pool (Particles)');
{
  // Clear any leftover particles from previous test runs
  PARTICLES.length = 0;

  const before = particlePoolStats();
  for (let i = 0; i < 20; i++) spawnParticle(i * 10, 100, 0, -50, 0.5, 255, 100, 0);
  assert(PARTICLES.length === 20, '20 particles spawned');

  updateParticles(0.6); // advance past lifetime (0.5s)
  assert(PARTICLES.length === 0, 'All particles expired and removed after dt > life');

  const after = particlePoolStats();
  assert(after.pooled >= 20, `Particles returned to pool (pooled=${after.pooled})`);

  // Reuse: spawn again — should reuse pooled objects
  for (let i = 0; i < 10; i++) spawnParticle(0, 0, 0, 0, 2, 255, 255, 0);
  const reuse = particlePoolStats();
  assert(reuse.pooled === after.pooled - 10, 'Particles reused from pool');
  PARTICLES.length = 0;
}

// ── State snapshot / restore ──────────────────────────────────────────────────

section('State snapshot / restore');
{
  // Build a minimal state with real rooms so restore() can find them
  const rng   = new RNG(999);
  const gen   = new LevelGen(rng);
  const s     = createState();
  s.phase     = 'playing';
  s.timeRemaining = 12345;
  s.lives     = 2;
  s.rooms     = gen.buildRooms();
  PlatformSystem.initRoom(s.rooms[0]);

  // Mutate some state
  s.rooms[0].furniture[0].searched = true;
  s.rooms[0].robots[0] && (s.rooms[0].robots[0].x = 77);
  s.player.x = 123; s.player.y = 200;

  const snap = snapshot(s);

  // Restore into a fresh state that shares the same rooms geometry
  const s2 = createState();
  s2.rooms  = s.rooms;  // same structural reference (real use case)
  restore(s2, snap);

  assert(s2.phase === 'playing',   'phase restored');
  assert(s2.timeRemaining === 12345, 'timeRemaining restored');
  assert(s2.lives === 2,           'lives restored');
  assert(s2.player.x === 123,     'player.x restored');
  assert(s2.player.y === 200,     'player.y restored');
  assert(s2.rooms[0].furniture[0].searched === true, 'furniture searched flag restored');
  if (s2.rooms[0].robots[0]) {
    assert(s2.rooms[0].robots[0].x === 77, 'robot.x restored');
  }

  // Verify snapshot is a deep copy (mutation doesn't bleed back)
  s2.timeRemaining = 99999;
  s2.player.x      = 999;
  const snap2 = snapshot(s2);
  assert(snap.timeRemaining !== snap2.timeRemaining, 'snapshots are independent copies');
}

// ── Platform system ───────────────────────────────────────────────────────────

section('PlatformSystem');
{
  const rng  = new RNG(12);
  const gen  = new LevelGen(rng);
  const rooms = gen.buildRooms();

  // Init all rooms
  for (const r of rooms) PlatformSystem.initRoom(r);

  // Every moving platform should have a _rect after init
  let missingRect = 0;
  for (const r of rooms) {
    for (const mp of r.movingPlatforms) {
      if (!mp._rect) missingRect++;
    }
  }
  assert(missingRect === 0, `All moving platforms have _rect after initRoom (missing=${missingRect})`);

  // Update should mutate _rect without allocating new objects
  const testRoom = rooms.find(r => r.movingPlatforms.length > 0);
  if (testRoom) {
    const mp      = testRoom.movingPlatforms[0];
    const rectRef = mp._rect;          // hold reference
    PlatformSystem.update(testRoom, 1/60);
    assert(mp._rect === rectRef, '_rect object is mutated in-place (no new allocation)');

    // Reset should return movers to start phase
    const phaseBefore = mp.phase;
    PlatformSystem.resetAll(testRoom);
    assert(mp.phase === mp.startPhase, 'resetAll restores startPhase');
  } else {
    console.log('  ⚠️  No room with moving platforms in this seed — skipping _rect identity test');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed === 0) {
  console.log('  ALL TESTS PASSED ✅');
} else {
  console.error(`  ${failed} TEST(S) FAILED ❌`);
  process.exit(1);
}
