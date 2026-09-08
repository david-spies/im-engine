<div align="center">

<img src="assets/banner.png" alt="Browser game remake of the Commodore 64 classic *Impossible Mission*" width="100%"/>

<br/>
<br/>

<p align="center">
  <img src="https://img.shields.io/badge/Engine-v2.0-blueviolet?style=for-the-badge&logo=javascript" alt="Engine Version">
  <img src="https://img.shields.io/badge/Target-60%20FPS-success?style=for-the-badge&logo=opengl" alt="Target FPS">
  <img src="https://img.shields.io/badge/Architecture-ECS%20%2B%20Two--Canvas-orange?style=for-the-badge" alt="Architecture">
  <img src="https://img.shields.io/badge/Tests-3061%20Assertions-informational?style=for-the-badge&logo=mocha" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License">
</p>

# Impossible Mission: Agent 4125 — Engine v2.0

> A high-performance, modular ES6 browser game remake of the Commodore 64 classic *Impossible Mission*, targeting a locked 60 FPS with WebGL CRT post-processing, FSM-driven robot AI with A* pathfinding, zero-allocation hot-path physics, and a rich audio middleware layer.

---

## 🚀 Overview

**Impossible Mission: Agent 4125 — Engine v2.0** is an enterprise-grade web game engine engineered for retro precision. It replicates the classic atmosphere of espionage, platforming, and puzzle assembly while modernizing the under-the-hood systems:

- **Two-Canvas Rendering Architecture:** Hidden Canvas2D offscreen buffer (640×400) rendered every frame via WebGL2 CRT post-processing (barrel distortion, chromatic aberration, scanlines, bloom, and phosphor flicker).
- **Deterministic Simulation:** Seeded XOR-shift random number generator guarantees exact world reconstruction, daily seeded challenges, and snapshot-based state restoration.
- **High-Performance Physics & AI:** Zero-allocation quadtrees, swept AABB collision detection, and 1D A* pathfinding running entirely within sub-millisecond budgets.
- **Modular Design & Audio:** Complete Web Audio API integration with spatial panning, procedural room impulse response reverberation, and speech synthesis barks.

---

## 📂 Directory Architecture

```
im-engine/
├── assets/
│   └── banner.svg
├── index.html                 # Application shell (two-canvas CRT setup)
├── vite.config.js             # Vite build configuration
├── package.json               # Dependency and script management
├── src/
│   ├── main.js                # Entry point — DOM wiring, Game instantiation
│   ├── Game.js                # Central orchestrator — pure coordination
│   ├── engine/
│   │   ├── ECS.js             # Entity-Component-System core + object pool
│   │   ├── State.js           # Centralized game state + snapshot/restore
│   │   ├── RNG.js             # Seeded XOR-shift RNG + daily seed
│   │   └── Pool.js            # Object pools: Vec2, Rect, Particle
│   ├── entities/
│   │   ├── LevelGen.js        # Procedural room generator (32 rooms, 4 floors)
│   │   └── PasswordSystem.js  # Password + fragment management
│   ├── physics/
│   │   └── Physics.js         # AABB, swept AABB, Quadtree, platform/hazard queries
│   ├── ai/
│   │   └── RobotAI.js         # FSM (IDLE/ALERT/STUNNED), LOS raycasting, 1D A*
│   ├── audio/
│   │   └── AudioMiddleware.js # Web Audio API middleware: buses, spatial pan, reverb IR
│   ├── renderer/
│   │   ├── CRTRenderer.js     # WebGL2 post-processor: barrel, CA, scanlines, bloom
│   │   └── WorldRenderer.js   # Canvas2D game-world renderer (offscreen 640×400)
│   ├── systems/
│   │   ├── PlatformSystem.js  # Moving platform animation + Lift Reset
│   │   └── PlayerSystem.js    # Frame-rate-independent player physics + input
│   ├── ui/
│   │   └── UISystem.js        # HUD, minimap, overlays, puzzle/Simon UI
│   └── network/
│       └── Network.js         # REST leaderboard, cloud save, co-op WebSocket stub
├── tests/
│   ├── run.js                 # Node.js test suite (3061 assertions)
│   └── bench.js               # Performance benchmarks (5 scenarios)
└── docs/
    └── TDD.md                 # Full Technical Design Document
```

🖥️ Rendering Pipeline (Two-Canvas CRT Setup)

The rendering pipeline decouples game logic from visual styling:

>Game World (Canvas2D): Renders the 640×400 logical viewport (backgrounds, shafts, platforms, hazards, furniture, terminals, robots, particles, and the agent) offscreen.
>WebGL2 CRT Post-Processor: Samples the offscreen canvas texture via texImage2D and applies an advanced GLSL fragment shader pipeline:
* Barrel distortion ($strength = 0.12$)
* Chromatic aberration ($offset = 0.006$)
* Bright-pixel bloom ($5\times5$ box blur, threshold $0.55$)
* Scanlines and 4% phosphor flicker noise
* Vignette shading
> DOM UI Layer: Overlay displaying HUD items, minimaps, notifications, and the CRT physical bezel wrapper.


⚙️ Core Technical Highlights

1. Zero-Allocation ECS & PhysicsComponent Storage: Plain Old Data (POD) objects backed by custom freelists (World._pools) to eliminate garbage collection pauses during gameplay loops.Swept AABB & Quadtree: Prevents high-speed tunneling through thin surfaces and enables fast $O(N \log N)$ spatial queries for robot proximity and hazard detection.

2. Robot AI Finite State MachineStates: IDLE (patrolling), ALERT (A* grid pursuit triggered by line-of-sight or acoustic radii), and STUNNED (frozen via EMP / snooze).Performance: 8 concurrent hunter robots complete pathfinding routines in a mean execution time of $0.026\text{ms}$ per frame.

3. Audio MiddlewareBuilt directly on the Web Audio API with dedicated buses for Music ($55\text{Hz} + 58.5\text{Hz}$ beating drone), SFX (spatial panning via StereoPannerNode and procedural $120\text{ms}$ room impulse response convolution), and Voice (Atombender speech synthesis).🛠️ Setup & InstructionsPrerequisitesNode.js (v18+ recommended)npm or yarnInstallationClone the repository and install dependencies:

Bash

git clone [https://github.com/david-spies/im-engine.git](https://github.com/david-spies/im-engine.git)
cd im-engine
npm install
Development Server

Launch the local Vite development server with Hot Module Replacement (HMR):

Bash

npm run dev

Open your browser and navigate to http://localhost:3000.Production BuildBundle, transpile, and minify the engine for production distribution:Bashnpm run build
The production assets will be built into the dist/ folder (~55.5 KB JS minified / ~19.8 KB gzipped). You can serve it locally using:Bashnpx serve dist
Running Tests & Benchmarks

Execute the full Node.js test suite (3,061 assertions) and logic performance benchmark suite:

Bash

npm test
npm run bench

🌐 Networking & Cloud Integration

The engine comes equipped with fully wired API client stubs (Network.js) ready to integrate with any backend supporting:REST Endpoints: /leaderboard (GET/POST), /save (GET/POST), /daily-seed, and /telemetry.Cooperative Multiplayer: WebSocket client stubs supporting lockstep synchronization and ghost-sprite interpolation.📜 LicenseImpossible Mission: Agent 4125 is open-source software licensed under the MIT License.
