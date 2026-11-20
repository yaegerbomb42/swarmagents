# PROJECT AGL-CRAFT // DEFINITIVE SYSTEM ARCHITECTURE & MASTER SPECIFICATION
**Engine**: Recursive Agentic Grammar Language (AGL)  
**Target**: 100% Feature-Complete Offline Local Minecraft Replica (Zero Networking Overhead)  
**Execution Agent**: `claude-merc` (Mercury-3 @ 1,000 tokens/sec via `.claude/skills/agl-compiler/`)

---

## 1. Architectural Directive: 100% Local Play (Skip Networking / Zero Server Overhead)
* **Design Philosophy**: Traditional Minecraft dedicates 50%+ of its Java codebase to netty sockets, client-server packet serialization, chunk sync handshakes, and anti-cheat checks.
* **The AGL Advantage**: By designing strictly for **Local Single-Player**, the entire engine collapses into pure deterministic in-memory state:
  - Zero lag, zero network deserialization, instantaneous chunk loading.
  - World saves are content-addressed SHA-256 JSON dictionaries persisted locally via `(lvl:3:host_fs "write" ...)`.

---

## 2. Integrated Game Modes & Built-in Map Generators
The world generation selector allows instant loading into three distinct modes:
1. **Standard Infinite Procedural World**:
   - Multi-octave 3D Simplex/Perlin noise terrain.
   - Biomes: Plains, Forest, Mountains, Desert, Deep Ocean, Caves & Ravines.
   - Ore generation: Coal, Iron, Gold, Redstone, Diamond veins embedded by Y-coordinate depth rules.
2. **Skyblock Mode (Built-in Option)**:
   - Floating L-shaped island: 3x3x3 dirt/grass, 1 oak tree, 1 bedrock anchor block.
   - Starter chest containing: 1 Ice block, 1 Lava bucket (for cobblestone generator), 1 bone, sugar cane, pumpkin/melon seeds.
3. **OneBlock Mode (Built-in Option)**:
   - Player spawns on a single magic infinite regenerative block at coordinates `(0, 64, 0)`.
   - Breaking the block increments an AGL counter and immediately regenerates the next block through 10 progressive phases:
     - *Phase 1 (Plains)*: Dirt, Wood, Clay.
     - *Phase 2 (Underground)*: Cobblestone, Coal, Iron, Chests.
     - *Phase 3 (Winter / Desert / Jungle)*: Sand, Cactus, Ice, Snow.
     - *Phase 4 (Deep Dark / Nether)*: Netherrack, Quartz, Soul Sand.
     - *Phase 5 (The End)*: End Stone, Obsidian, Dragon Egg.

---

## 3. Complete Engine Subsystems (The 5 Core Pillars)

### Pillar 1: 3D Voxel Engine & Fast Greedy Mesher (`lvl:0` & `lvl:3`)
* **Chunk Coordinates**: $16 \times 16 \times 256$ blocks.
* **Greedy Meshing**: Quad-merging algorithm eliminates 95% of hidden interior faces, keeping the frame rate locked at 60 FPS on WebGL.
* **First-Person Physics Loop**:
  - Player AABB bounding box: $0.6 \times 1.8 \times 0.6$.
  - Gravity acceleration ($g = 32\text{ m/s}^2$), terminal velocity, ground collision friction, jumping, and sneaking (ledge fall prevention).
* **Voxel Raycasting (DDA / Fast Voxel Traversal)**:
  - 5-block reach distance. Computes exact targeted block coordinate and adjacent face normal for instant block breaking and placement.

### Pillar 2: 100% Deterministic Redstone Electrical Substrate (`lvl:0` & `lvl:1`)
* **Signal Strength ($0\text{--}15$)**: Discrete integer power levels updated in 20 Hz ticks ($50\text{ ms}$).
* **Full Wire & Logic Gate Rules**:
  - Redstone Dust: Cross, line, and ascending/descending step connections.
  - Redstone Torch: Inverter (`NOT` gate) with 1 redstone tick delay.
  - Repeater: Directional diode with 1, 2, 3, or 4 tick adjustable delay and wire lock mechanism.
  - Comparator: Signal comparison (`A >= B`), signal subtraction (`A - B`), and container fullness detection.
  - Pistons & Sticky Pistons: Push/pull mechanics up to 12 movable blocks (immovable blocks: obsidian, bedrock).
  - Observers: Emits 1-tick pulse upon block state change.
  - Redstone Lamp, Levers, Buttons, Pressure Plates, and Hopper item transfer pipelines.

### Pillar 3: Crafting, Inventory, Smelting & Durability (`lvl:0`)
* **Player Inventory**: 36 inventory slots + 4 armor slots + 1 offhand slot.
* **2x2 (Player) & 3x3 (Crafting Table) Grid**:
  - Exact 1-to-1 recipe matching against content-addressed recipe ledger (wooden tools -> stone -> iron -> diamond -> netherite).
* **Smelting & Fuel Matrix**:
  - Furnace state machine: Cook progress ($200\text{ ticks}$), fuel burn time (coal = $1600\text{ ticks}$, lava = $20000\text{ ticks}$).
* **Tool Durability & Mining Tiers**:
  - Wood (59), Stone (131), Iron (250), Diamond (1561), Netherite (2031).
  - Material harvest requirements (e.g. Diamond Pickaxe required for Obsidian).

### Pillar 4: Entities, Mobs & Combat State Automata (`lvl:1`)
* **Passive Mobs**: Cows, Sheep, Pigs, Chickens (Breeding, drop tables).
* **Hostile Mobs**:
  - Zombies (Melee tracking).
  - Skeletons (Bow trajectory raycasting).
  - Creepers (Proximity fuse timer with flash and explosive block damage).
  - Endermen (Teleportation and eye-contact aggro).
* **Player Survival Vitals**:
  - Health: 20 HP (10 hearts).
  - Hunger: 20 points (Saturation depletion, natural regeneration at 18+ hunger, starvation damage at 0 hunger).

### Pillar 5: Dimensions & Day/Night Celestial Cycle (`lvl:0` & `lvl:3`)
* **20-Minute Game Day**: 10 minutes day, 1.5 minutes sunset, 7 minutes night, 1.5 minutes sunrise.
* **Skybox & Lighting**:
  - Sky light ($0\text{--}15$) based on sun angle.
  - Block light ($0\text{--}15$) from torches, glowstone, and lava.
* **Dimensions**:
  - Nether Portal: Obsidian frame ignition -> Nether dimension chunk generation (lava oceans, nether fortresses).
  - End Portal: End frame activation -> The End island & Ender Dragon boss arena.

---

## 4. Free Open-Source Asset Drops (100% Royalty-Free)
All textures and sounds are CC0 / MIT drop-ins:
- Textures: Classic Faithful 16x Open Voxel Texture Atlas.
- Audio: Freesound.org CC0 footsteps, block breaking, eating, explosions.
- Music: Kevin MacLeod / Incompetech royalty-free ambient tracks.

---

## 5. Development Roadmap for `claude-merc`
* **Phase 1**: Voxel Engine, Greedy Mesher, Camera, Block Placement/Breaking, Mode Selector (Normal, Skyblock, OneBlock).
* **Phase 2**: Physics (Gravity, Collision, Sneaking) + Day/Night Light Cycle.
* **Phase 3**: 3x3 Crafting Table, Inventory Hotbar, Tool Durability & Furnace.
* **Phase 4**: Full Redstone Logic (Wires, Torches, Repeaters, Comparators, Pistons).
* **Phase 5**: Mob AI, Survival Health/Hunger, and Nether/End Portals.
