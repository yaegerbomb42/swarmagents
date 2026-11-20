# Local-model benchmarks (Jimmy's Mac, 2026-10-24)

Small, self-contained Python scripts (stdlib only) that measure local models on a Mac through Ollama (`:11434`) and `llama-server` (`:8080`).
They are the origin of the numbers behind the BYOC "bring your own computer" local-model work (see `docs/architecture/claude-code-byok-byoc.md`).

| Script | What it does |
|---|---|
| `run_bench.py` | 3 quick tests (trap-math, in-place `rotate(matrix)`, strict-JSON diff agent) across Ollama models and a `llama-server` GGUF. Writes `results/bench_results.json`. |
| `cline_bench.py` | 2 Cline-style agent tasks (refactor, rate limiter) and checks whether the model emitted write/exec tool calls. Writes `results/cline_bench_results.json`. |
| `run_puzzle.py` / `run_puzzle_unlimited.py` | Hard logic puzzle with a capped / uncapped token budget. Writes `results/puzzle_results.json`. |
| `bench_r1_70b.py` | Single-model run for a 70B R1-distill through Ollama. |

Configuration (all optional): `QWEN_GGUF` = path to the GGUF `llama-server` should load, `LLAMA_SERVER` = path to the binary (default: `llama-server` on `PATH`).
Model names in the `MODELS` list at the top of each script are what the Mac had pulled; edit them for your machine. Run from anywhere: results land in `results/` next to the script.

## Results snapshot (tokens/second, Apple Silicon Mac)

| Model | quick tests | Cline tasks |
|---|---|---|
| flint:latest | ~116 | ~116 |
| gemma:latest | 97-121 | n/a |
| qwen3.8:27b | 38-47 | 27-30 |
| bonsai-2:27b | 29-30 | 29-30 |
| Qwen3.8-Flash-Next-Coder (IQ1_M GGUF) | 25-28 | ~35 |

Raw per-test output, including responses, is in `results/`. These are single runs on one machine, not a rigorous comparison.

Secret scan: gitleaks clean. The scripts never use API keys; only local endpoints.
