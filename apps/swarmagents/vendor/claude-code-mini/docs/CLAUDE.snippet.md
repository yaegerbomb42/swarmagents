# Claude Code Project Guidelines & Coprocessor Instructions

## Core Principles
- Operate with professional rigor, safety, and deterministic precision.
- Preserve context window bandwidth and reduce latency on all routine operations.

## Mini Execution Coprocessor (`mini`)
The `mini` MCP server (`claude-code-mini` v0.5.0) is connected and available over stdio.
Whenever working on code tasks:

1. **Surgical Bug Fixes & Type Corrections (`mini_fast_patch`)**:
   - For localized bug fixes, null checks, type errors, or single-function refactors, ALWAYS prioritize calling `mini_fast_patch(filePath, instruction, targetLine)`.
   - Mini extracts the innermost AST slice, injects local/cross-file signatures, and runs sub-15ms semantic in-memory TypeScript verification in RAM before touching disk.
   - This keeps your 200k conversation context clean and eliminates quadratic KV-cache compute.

2. **Zero-Token Multi-File Exploration (`mini_ast_tree`)**:
   - Instead of reading 5–10 full files to understand a module or interface graph, call `mini_ast_tree(filePaths)`.
   - Mini deterministically builds a lossless AST outline in <10ms with 0 LLM tokens, fitting up to 80k tokens of code into a compact ~3,000-token directory.

3. **Autonomous Test Healing Loops (`mini_auto_repair`)**:
   - For failing tests or compiler errors, call `mini_auto_repair(command, filePath)` to let Mini iterate, diagnose, and heal until exit code 0 with anti-oscillation protection.

4. **Atomic Rollback (`mini_undo`)**:
   - If a candidate patch causes an unintended regression, invoke `mini_undo` to instantly revert via Git blob checkpoints.
