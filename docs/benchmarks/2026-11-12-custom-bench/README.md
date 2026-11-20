# Custom bench, 2026-11-12 (Omnexx vs OpenHands vs Cline)

Raw output of the Omnexx `bench/` harness (`jimmy10` suite, 10 tasks x 3 agents) run on 2026-11-12.
**Treat it as a harness smoke test, not a leaderboard:** `calls.jsonl` shows the Cline/OpenHands runs got HTTP 401 from the model gateway
and `2026-11-12.md` shows 0 tokens and 0 resolved for those rows, so the numbers only prove the plumbing. Per-task JSON/logs are in `live/`.
The 860 MB of per-task work trees were not kept. To rerun, see `apps/swarmagents/vendor/omnexx/bench/README` / `bench/run.ts`.
