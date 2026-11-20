# AGL — Agentic Grammar Language

An ultra-compact, token-minimized, S-expression based execution substrate engineered for high-performance AI agent runtimes and multi-agent coordination.

## Features
- **360 Cryptographically Verified Primitives**: Immutable, SHA-256 content-addressable AST nodes across Levels 0 to 4 (`agl_ledger.json`).
- **Zero-Token Discovery & Execution**: Native mathematical functions, matrix math, bitwise ops, data structures, and pipeline combinators.
- **Level 2 Concurrency**: Built-in primitives for `pipeline`, `parallel`, `fan_out`, and `swarm_consensus`.
- **Level 3 Agentic Interop**: In-language agent dispatch with API pooling, UI widget rendering, and safe sandbox evaluations.
- **Level 4 Metaprogramming**: Turing-complete self-hosting, code synthesis, fuzz verification, and dynamic module loading.
- **Configurable Gas & Metering**: EVM-style execution budgets with unbounded loop execution in production.

---

## Quickstart

Run directly via `npx` or with the local CLI:

```bash
# Run an AGL script
npx agl-run examples/hypercube_3d.agl

# Or install globally
npm install -g agl-lang
agl-run examples/snake_game.agl
```

---

## Interactive Examples
Check the `/examples` directory:
- `hypercube_3d.agl`: Real-time 3D vertex projection pipeline and canvas widget.
- `snake_game.agl`: Full interactive WebGL/HTML5 snake game running via AGL synthesis.
- `swarmagents_minimal_ui.agl`: Parallel multi-agent pipeline and consensus aggregator.
- `autonomous_token_arb.agl`: Microsecond token arbitrage math and liquidity simulation.

---

## Architecture Spec
See [MINECRAFT_SPEC.md](./MINECRAFT_SPEC.md) for the complete blueprint of procedural block world generation (Skyblock, OneBlock, local game loops) compiled to AGL.
