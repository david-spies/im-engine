# Technical Design Document
## Impossible Mission: Agent 4125 — Engine v2.0

---

## 1. Overview

This document describes the architecture of the Impossible Mission v2.0 engine:
a modular, ES6-module browser game targeting 60fps with WebGL CRT post-processing,
FSM-driven robot AI with A* pathfinding, zero-allocation hot-path physics,
an audio middleware layer, cloud save/leaderboard REST API stubs, and a
cooperative multiplayer networking design.

The engine ships as a single HTML file (dev: Vite dev server; prod: `dist/index.html`
+ `dist/assets/index-*.js`, ~20 KB gzipped). No backend is required for single-player.

---

## 2. Directory Structure

```
im-engine
├── index.html                  Application shell (two-canvas CRT setup)
├── vite.config.js              Build configuration
├── package.json
├── src/
│   ├── main.js                 Entry point — DOM wiring, Game instantiation
│   ├── Game.js                 Central orchestrator — no logic, pure coordination
│   ├── engine/
│   │   ├── ECS.js              Entity-Component-System core + object pool
│   │   ├── State.js            Centralized game state + snapshot/restore
│   │   ├── RNG.js              Seeded XOR-shift RNG + daily seed
│   │   └── Pool.js             Object pools: Vec2, Rect, Particle
│   ├── entities/
│   │   ├── LevelGen.js         Procedural room generator (32 rooms, 4 floors)
│   │   └── PasswordSystem.js   Password + fragment management
│   ├── physics/
│   │   └── Physics.js          AABB, swept AABB, Quadtree, platform/hazard queries
│   ├── ai/
│   │   └── RobotAI.js          FSM (IDLE/ALERT/STUNNED), LOS raycasting, 1D A*
│   ├── audio/
│   │   └── AudioMiddleware.js  Web Audio API middleware: buses, spatial pan, reverb IR
│   ├── renderer/
│   │   ├── CRTRenderer.js      WebGL2 post-processor: barrel, CA, scanlines, bloom
│   │   └── WorldRenderer.js    Canvas2D game-world renderer (offscreen 640×400)
│   ├── systems/
│   │   ├── PlatformSystem.js   Moving platform animation + Lift Reset
│   │   └── PlayerSystem.js     Frame-rate-independent player physics + input
│   ├── ui/
│   │   └── UISystem.js         HUD, minimap, overlays, puzzle/Simon UI
│   └── network/
│       └── Network.js          REST leaderboard, cloud save, co-op WebSocket stub
├── tests/
│   ├── run.js                  Node.js test suite (3061 assertions)
│   └── bench.js                Performance benchmarks (5 scenarios)
└── docs/
    └── TDD.md                  This document
```

---

## 3. Rendering Architecture (Two-Canvas CRT Pipeline)

```
┌─────────────────────────────────────────────────────────┐
│  Game World (Canvas2D — hidden from user)               │
│  WorldRenderer.draw(state, room, now)                   │
│  640×400 logical pixels, image-rendering: pixelated     │
│    • Background, shafts, elevator cab                   │
│    • Static platforms, ledge                            │
│    • Electrified zones (sparks, amber warning)          │
│    • Moving platforms (_rect mutated in-place)          │
│    • Furniture (?, searched state)                      │
│    • Terminal (TEL/CODE)                                │
│    • Robots (ellipse + eyes + FSM alert dot)            │
│    • Particles (pooled, alpha-faded squares)            │
│    • Agent (articulated sprite: head/torso/4 limbs)     │
│    • Interaction prompt (PRESS E / PRESS F)             │
│    • Floor label strip                                  │
└───────────────────┬─────────────────────────────────────┘
                    │  texImage2D upload each frame
                    ▼
┌─────────────────────────────────────────────────────────┐
│  WebGL2 CRT Post-Processor                              │
│  CRTRenderer.present(dt)                                │
│                                                         │
│  Vertex shader: fullscreen quad (2 triangles)           │
│  Fragment shader (GLSL 300 es):                         │
│    1. Barrel distortion  (strength: 0.12)               │
│    2. Chromatic aberration (offset: 0.006)              │
│    3. Bloom (5×5 box blur on bright pixels, th=0.55)    │
│    4. Scanlines (every other output row ×0.55)          │
│    5. Phosphor flicker (per-frame noise, 4%)            │
│    6. Vignette (pow(uv*(1-uv)*15, 0.32))                │
│                                                         │
│  Fallback: plain Canvas2D drawImage if WebGL2 missing   │
└───────────────────┬─────────────────────────────────────┘
                    │  composited to display canvas
                    ▼
┌─────────────────────────────────────────────────────────┐
│  DOM UI Layer (pointer-events: none except buttons)     │
│  UISystem — HUD, minimap, message toast, overlays       │
│  CRT bezel frame (CSS border-radius, box-shadow)        │
└─────────────────────────────────────────────────────────┘
```

### Why Two Canvases?

A single canvas cannot be both the WebGL draw target and the Canvas2D game
canvas simultaneously. The offscreen `#game-canvas` (640×400, `display:none`)
receives all Canvas2D game-world draw calls. `CRTRenderer` uploads it as a
WebGL texture each frame and blits it through the shader pipeline to the
visible `#display-canvas`, which scales to fill the CRT frame via CSS.

---

## 4. ECS Architecture

### Entity IDs
Entities are plain integers assigned sequentially by `World.create()`. There
are no entity classes — all data lives in component stores.

### Component Storage
```
World._components: Map<ComponentType, Map<EntityID, POD_Object>>
World._pools:      Map<ComponentType, POD_Object[]>
```

Components are Plain Old Data objects. When an entity is destroyed,
`World.destroy(id)` returns each component slot to its type's freelist
instead of letting it be garbage-collected.

### Current Component Types (Impossible Mission usage)
| Component   | Entity kind  | Fields                                      |
|-------------|--------------|---------------------------------------------|
| `Position`  | player/robot | x, y                                        |
| `Velocity`  | player       | vx, vy                                      |
| `Sprite`    | player/robot | facing, walkCycle, invuln                   |
| `RobotMind` | robot        | fsm, alerted, frozen, kind, minX, maxX, dir |
| `Platform`  | mover        | phase, startPhase, speed, axis, _rect       |

The ECS module (`ECS.js`) is included for structural completeness and
extensibility. The current game build uses it lightly — most state lives
in `State.js` plain objects for simplicity and snapshot/restore fidelity.
The ECS is the recommended expansion path for new entity types (orbs,
projectiles, co-op partner agent).

### System Execution Order (per frame)
```
1. PlatformSystem.update(room, dt)         — advance mover phases, mutate _rects
2. updateElectrifiedZones(room, dt)        — cycle live/dead timers
3. player.invuln -= dt
4. state.robotSnoozeActive -= dt
5. PlayerSystem.update(dt, room, sound)    — input + swept AABB physics
6. updateRobotFSM × N                     — FSM transitions, A* pursuit
7. checkRobotCollisions                    — AABB player vs each robot
8. updateParticles(dt)                     — age, move, return dead to pool
9. WorldRenderer.draw(state, room, now)    — Canvas2D game world
10. CRTRenderer.present(dt)               — WebGL CRT post-process
11. UISystem.updateHUD / renderMinimap     — DOM layer
```

---

## 5. Physics

### AABB Collision
`aabbOverlap(ax,ay,aw,ah, bx,by,bw,bh)` — strict (touching edges do not count).
Used for robot contact checks (player vs robot bounding boxes each frame).

### Swept AABB
`sweptAABB(px,py,pw,ph, vx,vy, bx,by,bw,bh) → t∈[0,1] | Infinity`
Used for platform landing detection: finds the earliest collision time between
the player's moving rect and a static platform rect, preventing tunnelling
through thin surfaces at high fall speeds.

### Platform Resolution (`groundPlatform`)
Uses a pre-allocated 16-slot candidate array (stack-allocated per call frame,
not heap-allocated) to avoid triggering GC inside the physics hot path.
Checks all static platforms, the optional ledge, and all active `mp._rect`
moving platform rects in a single loop.

### Quadtree
`Quadtree(level, bounds)` — splits at 6 objects per node, up to 5 levels deep.
`clear()` collapses children without allocating new node objects.
`retrieve(query, out)` pushes results into a caller-supplied pre-allocated
array — zero heap allocation on the call path.
Used for: robot proximity queries, future collision broadphase expansion.

---

## 6. AI: Robot Finite State Machine

```
          ┌──────────────────────────────────────────┐
          │                                          │
     [distance < ACOUSTIC_RADIUS AND sound event]    │
     [distance < ALERT_RADIUS AND LOS clear]         │
          │                                          │
   ┌──────▼──────┐    give-up range       ┌──────────┴──────┐
   │    IDLE     ├───────────────────────►│     ALERT       │
   │  (patrol)   │◄───────────────────────│   (A* pursuit)  │
   └──────┬──────┘    dist > 1.6×radius   └──────────┬──────┘
          │                                          │
     globalFreeze                             globalFreeze
     OR r.frozen > 0                         OR r.frozen > 0
          │                                          │
          └──────────────────┬───────────────────────┘
                             ▼
                      ┌─────────────┐
                      │   STUNNED   │
                      │ (frozen,    │
                      │  grey tint) │
                      └─────────────┘
                      exits when frozen
                      expires or snooze ends
```

### Line-of-Sight Raycasting
`hasLineOfSight(x1,y1, x2,y2, platforms)` samples the ray at 8px intervals.
Each platform is treated as an opaque column from its top surface downward.
Points above a platform's y are not blocked; points below (inside the column)
break the ray. This creates occlusion for the 2D side-view perspective.

### A* Pathfinding (`aStarNextX`)
1D A* on the room's 20px-wide horizontal grid (32 cells for a 640px room).
Blocked cells are furniture pieces that sit on the same platform row.
Returns the world-space x-coordinate of the next grid cell the robot should
move toward. Falls back to `goalX` (direct move) if the path is not found.

**Performance:** 8 concurrent hunter robots each running A* costs ~0.026ms
mean / 0.057ms P99 per frame — well within budget.

---

## 7. Audio Middleware

### Bus Topology
```
AudioContext.destination
    └── MasterGain (1.0)
           ├── MusicBus (0.18)   — ambient drone (55Hz + 58.5Hz beating)
           ├── SFXBus (0.70)     ─┬─ PannerNode (spatial, -1..1 per sound x)
           │                      └─ ConvolverNode ◄── procedural room IR (120ms decay)
           └── VoiceBus (0.60)   — speech synthesis (SpeechSynthesisUtterance)
```

### Room Impulse Response
Generated procedurally in `_buildRoomIR()` — exponentially-decaying white
noise (120ms, 2-channel, at `ctx.sampleRate`). No IR file required; the
character is "small underground room": short decay, slight diffusion.

### Spatial Panning
Every one-shot SFX accepts an optional `sourceX` parameter (world-space pixel
x, 0–640). It is mapped to a `StereoPannerNode` value `(sourceX/CW)*2-1`,
ranging from -1 (hard left elevator shaft) to +1 (hard right elevator shaft).

### Speech Synthesis
`SpeechSynthesis` is used for Atombender's intro taunt and in-game robot barks.
Rate=0.78, pitch=0.45 for the intro; rate=1.0, pitch=0.4 for combat barks.
A 14-second cooldown prevents repeated spam. Falls back silently if the
browser does not support `SpeechSynthesisUtterance`.

---

## 8. State Management & Determinism

### `createState()`
Returns a fully-initialized flat plain-object game state. Every field is
present at startup — no `undefined` checks needed in hot-path systems.

### `snapshot(state)` / `restore(state, snap)`
Produces a deep-clone of mutable state (player, timer, lives, per-room flags)
while structurally sharing the room geometry (platforms, furniture positions)
which never changes after level generation. Used for:
- Cloud save sync (POST to `/save`)
- Netcode rollback (future: restore to a prior tick, re-simulate)

### Determinism Guarantee
Given the same 32-bit `seed`, `RNG` produces an identical sequence. All
world generation (`LevelGen`), fragment placement (`PasswordSystem`), robot
starting state, and Simon sequences are derived purely from this RNG — no
`Math.random()` is ever called after the seed is set. This means:
- A saved snapshot + seed can reconstruct the entire game world
- Daily seeded challenges produce the same room layout for all players
- Co-op partners can share a seed and skip transmitting world state

---

## 9. Networking & Cloud Integration

### REST API (implemented in `Network.js`)
| Endpoint            | Method | Description                              |
|---------------------|--------|------------------------------------------|
| `/leaderboard`      | GET    | Top N entries by seed/mode               |
| `/leaderboard`      | POST   | Submit completed run + state snapshot    |
| `/save`             | POST   | Upload state snapshot (cloud save)       |
| `/save`             | GET    | Download last save for session           |
| `/daily-seed`       | GET    | Today's official challenge seed          |
| `/telemetry`        | POST   | Batch analytics events (30s flush)       |

All calls are non-blocking (`fetch`) with silent failure fallback so the
game is always fully playable offline.

### Cooperative Multiplayer (WebSocket design stub)
```
Client A                  Server                   Client B
───────                   ──────                   ────────
connect /coop?room=ABCD ──►
                          create room ABCD
◄── {type:"joined",seed:X}
                                        ◄── connect /coop?room=ABCD
                                            {type:"joined",seed:X} ──►

Both clients:
  1. Build world from shared seed X (deterministic — no world state transmitted)
  2. Each frame: send own player position only
     {type:"pos", x, y, facing, roomId}
  3. Render partner's last-known position as a ghost sprite (interpolated)

Lockstep model:
  • Input sequence number per frame (tick counter from State.tick)
  • Server echoes inputs to both clients with timestamp
  • On desync (roomId mismatch): request full snapshot from peer, restore()
```

**Status:** WebSocket connect/send/receive is implemented; the server-side
room broker and input echo are not included in this deliverable (out of scope
for a single-machine browser target). The `NetworkClient.connectCoop()` and
`sendPosition()` APIs are fully wired and ready to connect to a Node.js relay.

---

## 10. Performance Benchmarks (Node.js, pure logic only)

| Scenario                                    | Mean     | P95      | P99      | Max      | Over 16ms |
|---------------------------------------------|----------|----------|----------|----------|-----------|
| Full room sim (2 robots, movers, particles) | 0.019ms  | 0.016ms  | 0.126ms  | 4.073ms  | 0/1000    |
| LevelGen — new game generation ×100         | 0.297ms  | 1.075ms  | 4.461ms  | 4.461ms  | 0/100     |
| A* pathfinding (8 hunters/frame) ×1000      | 0.026ms  | 0.030ms  | 0.057ms  | 4.700ms  | 0/1000    |
| Quadtree (200 objects, rebuild+query) ×1000 | 0.100ms  | 0.216ms  | 1.049ms  | 8.502ms  | 0/1000    |
| Particle pool (70 particles) ×1000          | 0.004ms  | 0.009ms  | 0.021ms  | 1.963ms  | 0/1000    |

**All scenarios: zero frames exceeding the 16.67ms 60fps budget.**

Canvas2D / WebGL rendering costs are browser-dependent and not measured in
Node.js. Rendering budget headroom is substantial given that pure logic
(AI, physics, particles, world gen) consumes <1ms per frame combined.

---

## 11. Build & Deployment

### Development
```bash
npm install
npm run dev          # Vite dev server on :3000, HMR enabled
```

### Production
```bash
npm run build        # → dist/index.html + dist/assets/index-*.js
                     #   55.5 KB JS minified / 19.8 KB gzipped
```

### Single-machine deployment
```bash
npx serve dist       # or: python3 -m http.server --directory dist 8080
```

No server-side runtime is required for single-player. For cloud features,
point `VITE_API_BASE` and `VITE_WS_URL` at a Node.js/Serverless backend
that implements the REST endpoints above.

### Test & Benchmark
```bash
npm test             # Node.js test suite — 3061 assertions, all green
npm run bench        # Performance benchmarks — all within 16.67ms budget
```

---

## 12. Known Limitations & Future Work

| Area               | Current State                    | Recommended Next Step                          |
|--------------------|----------------------------------|------------------------------------------------|
| ECS usage          | Structural, not fully adopted    | Migrate robots to ECS entities for co-op       |
| Robot pathfinding  | 1D A* (horizontal only)          | 2D navmesh for vertical mover navigation       |
| Physics            | Swept AABB, single-axis carry    | Full 2D carry for vertical movers              |
| WebGPU             | Not implemented                  | Replace WebGL2 pipeline when broader support   |
| Co-op networking   | Client code only                 | Add Node.js relay server + lockstep sync       |
| Leaderboard backend| REST stubs only                  | Serverless function (Cloudflare/Vercel/Lambda) |
| TypeScript         | JSDoc type annotations           | Full TS migration for strictNullChecks         |
| Audio voices       | SpeechSynthesis only             | Custom recorded voice lines (licensing needed) |

---

📜 License

Impossible Mission is open-source software licensed under the MIT License.
