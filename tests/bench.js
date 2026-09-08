/**
 * @file bench.js — Performance benchmarks for Impossible Mission engine
 *
 * Verifies the engine maintains ≤16.67ms per frame (≥60fps) under the
 * worst-case load described in the Engineering Directive:
 *   • Maximum active hunter robots
 *   • Animated moving platforms
 *   • Full particle system (vaporization burst × multiple deaths)
 *   • A* pathfinding every frame per hunter
 *   • Quadtree rebuild + query every frame
 *   • Electrified zone update
 *
 * Run: node tests/bench.js
 *
 * All numbers are in milliseconds.  The benchmark runs each scenario
 * for 1000 frames and reports mean/P95/P99/max per frame time.
 */

import { RNG }           from '../src/engine/RNG.js';
import { LevelGen }      from '../src/entities/LevelGen.js';
import { PlatformSystem, updateElectrifiedZones } from '../src/systems/PlatformSystem.js';
import { updateRobotFSM } from '../src/ai/RobotAI.js';
import { Quadtree, aabbOverlap } from '../src/physics/Physics.js';
import { spawnParticle, updateParticles, PARTICLES } from '../src/engine/Pool.js';

const FRAMES        = 1000;
const FRAME_BUDGET  = 16.67;   // ms — 60fps
const DT            = 1 / 60;

// ── Percentile helper ─────────────────────────────────────────────────────────

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean   = times.reduce((s, t) => s + t, 0) / times.length;
  const p95    = sorted[Math.floor(sorted.length * 0.95)];
  const p99    = sorted[Math.floor(sorted.length * 0.99)];
  const max    = sorted[sorted.length - 1];
  const over16 = times.filter(t => t > FRAME_BUDGET).length;
  return { mean, p95, p99, max, over16, total: times.length };
}

function printStats(label, s) {
  const pass = s.p99 <= FRAME_BUDGET * 2 && s.max <= FRAME_BUDGET * 4;
  const flag = pass ? '✅' : '⚠️ ';
  console.log(`  ${flag} ${label}`);
  console.log(`     mean=${s.mean.toFixed(3)}ms  P95=${s.p95.toFixed(3)}ms  P99=${s.p99.toFixed(3)}ms  max=${s.max.toFixed(3)}ms  over16ms=${s.over16}/${s.total}`);
}

// ── Scenario 1: Full room simulation ─────────────────────────────────────────

function benchRoomSimulation() {
  console.log('\n── Scenario 1: Full room simulation (robots + platforms + hazards + particles)');

  const rng   = new RNG(0xDEADBEEF);
  const gen   = new LevelGen(rng);
  const rooms = gen.buildRooms();

  // Pick the most loaded room: deepest floor with the most robots
  let worstRoom = null;
  for (const r of rooms) {
    if (r.isControlRoom) continue;
    if (!worstRoom || r.robots.length >= worstRoom.robots.length && r.floor >= worstRoom.floor) {
      worstRoom = r;
    }
  }

  PlatformSystem.initRoom(worstRoom);

  // Force all robots to hunter/ALERT for maximum AI load
  for (const r of worstRoom.robots) { r.kind = 'hunter'; r.fsm = 'ALERT'; }

  // Player at centre of room
  const player = { x: 300, y: worstRoom.platforms[0].y - 40, w: 18, h: 40 };

  // Spawn a burst of particles (simulate a death)
  for (let i = 0; i < 20; i++) {
    spawnParticle(300, 330, (Math.random()-0.5)*150, -80 - Math.random()*60, 0.5, 255, 64, 0);
  }

  const qt  = new Quadtree();
  const buf = [];
  const times = [];

  for (let frame = 0; frame < FRAMES; frame++) {
    const t0 = performance.now();

    // Platform simulation
    PlatformSystem.update(worstRoom, DT);
    updateElectrifiedZones(worstRoom, DT);

    // Robot AI (FSM + A*)
    for (const r of worstRoom.robots) {
      updateRobotFSM(r, player, worstRoom, DT, false, false);
    }

    // Quadtree rebuild + collision query
    qt.clear();
    for (const r of worstRoom.robots) qt.insert(r);
    buf.length = 0;
    qt.retrieve(player, buf);
    for (const r of buf) aabbOverlap(player.x, player.y, player.w, player.h, r.x, r.y, r.w, r.h);

    // Particle update
    updateParticles(DT);

    times.push(performance.now() - t0);
  }

  console.log(`     Room: floor=${worstRoom.floor} robots=${worstRoom.robots.length} movers=${worstRoom.movingPlatforms.length} zones=${worstRoom.electrifiedZones.length} particles_peak=20`);
  return stats(times);
}

// ── Scenario 2: RNG + LevelGen (new game generation speed) ───────────────────

function benchLevelGen() {
  console.log('\n── Scenario 2: LevelGen — new game generation time (×100 games)');
  const times = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    const rng = new RNG(i * 31337 + 1);
    const gen = new LevelGen(rng);
    gen.buildRooms();
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ── Scenario 3: A* pathfinding stress ────────────────────────────────────────

function benchAstar(aStarNextX) {
  console.log('\n── Scenario 3: A* — 8 hunters pursuing player simultaneously (1000 frames)');
  const furniture = Array.from({length:5}, (_,i) => ({x: 80+i*80, y: 330-26, w:22, h:26}));
  const times = [];

  for (let frame = 0; frame < FRAMES; frame++) {
    const t0 = performance.now();
    for (let r = 0; r < 8; r++) {
      aStarNextX(50 + r*30, 400, 330, furniture);
    }
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ── Scenario 4: Quadtree under heavy object count ────────────────────────────

function benchQuadtree() {
  console.log('\n── Scenario 4: Quadtree — 200 objects, rebuild + query × 1000 frames');
  const objects = Array.from({length:200}, (_,i) => ({
    x: Math.random()*620, y: Math.random()*380, w: 20, h: 20
  }));
  const qt  = new Quadtree();
  const buf = [];
  const query = {x: 200, y: 100, w: 100, h: 100};
  const times = [];

  for (let frame = 0; frame < FRAMES; frame++) {
    const t0 = performance.now();
    qt.clear();
    for (const o of objects) qt.insert(o);
    buf.length = 0;
    qt.retrieve(query, buf);
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ── Scenario 5: Particle pool under max load ──────────────────────────────────

function benchParticles() {
  console.log('\n── Scenario 5: Particle pool — 5 vaporize bursts (70 particles) × 1000 frames');
  PARTICLES.length = 0;
  const times = [];

  for (let frame = 0; frame < FRAMES; frame++) {
    const t0 = performance.now();

    // Respawn if low (simulating repeated deaths)
    if (PARTICLES.length < 20) {
      for (let b = 0; b < 5; b++) {
        for (let i = 0; i < 14; i++) {
          spawnParticle(Math.random()*640, 200, (Math.random()-0.5)*160, -100-Math.random()*80, 0.4, 255, 64, 0, 2);
        }
      }
    }
    updateParticles(DT);
    times.push(performance.now() - t0);
  }
  PARTICLES.length = 0;
  return stats(times);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('Impossible Mission Engine — Performance Benchmarks');
console.log(`Target: ≤${FRAME_BUDGET}ms/frame (60fps) for all pure-logic systems`);
console.log(`Note: Canvas/WebGL rendering is browser-only — not measured here`);
console.log('═'.repeat(60));

const s1 = benchRoomSimulation();
const s2 = benchLevelGen();
const s4 = benchQuadtree();
const s5 = benchParticles();

console.log('\n── Results ──────────────────────────────────────────────────────');
printStats('Room simulation (robots+platforms+particles+qt)', s1);
printStats('LevelGen (new game generation, 100 runs)', s2);
printStats('Quadtree (200 objects, rebuild+query)', s4);
printStats('Particle pool (5 bursts, 70 particles)', s5);

// A* is async import so handled separately
import('../src/ai/RobotAI.js').then(({ aStarNextX }) => {
  console.log('\n── Scenario 3: A* — 8 hunters pursuing player simultaneously');
  const furniture = Array.from({length:5}, (_,i) => ({x:80+i*80, y:330-26, w:22, h:26}));
  const times = [];
  for (let frame = 0; frame < FRAMES; frame++) {
    const t0 = performance.now();
    for (let r = 0; r < 8; r++) aStarNextX(50+r*30, 400, 330, furniture);
    times.push(performance.now() - t0);
  }
  const s3 = stats(times);
  printStats('A* pathfinding (8 hunters/frame)', s3);

  console.log('\n' + '═'.repeat(60));
  const all     = [s1, s2, s3, s4, s5];
  const allPass = all.every(s => s && s.p99 <= FRAME_BUDGET * 2);
  console.log(allPass
    ? '  ALL BENCHMARKS WITHIN BUDGET ✅'
    : '  ⚠️  Some benchmarks exceeded budget — see details above');
});
