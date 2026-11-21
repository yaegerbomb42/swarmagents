# capability-atlas

Token-efficient local capability discovery, registry, and retrieval for the
SwarmAgents agent. Instead of injecting hundreds of MCP tool schemas, CLI
flags, and app definitions into a prompt, this module indexes what a machine
can do into a compact, zod-validated JSON registry and exposes two
high-signal operations:

- `find_capability(query, k)` — BM25 (+ optional local zero-network
  embeddings) returning compact one-line summaries (~15–25 tokens per result).
- `describe_capability(id)` — returns the full JSON schema / metadata for a
  single capability on demand.

```ts
import { scanAll } from "./discovery/index";
import { RegistryStore } from "./registry/store";
import { CapabilityRetriever } from "./retrieval/index";

// Pass an explicit per-user / per-workspace path. Never use the standalone
// default (~/.capability-atlas/registry.json) inside the app.
const store = new RegistryStore("/path/to/user/registry.json");
const entries = await scanAll({ verifyProviders: false });
await store.save(entries);

const retriever = new CapabilityRetriever(entries, { useLocalEmbeddings: true });
console.log(retriever.formatCompact(retriever.find_capability("open a GitHub PR", 3)));
console.log(retriever.describe_capability("cli:gh"));
```

## Secrets rules

- The providers scanner records environment variable **names** and status
  only — never key values. The `secrets.test.ts` test proves no key value
  serializes into a saved registry.
- `verifyProviders` stays off by default: verification makes a `/models`
  call with the user's key.
- MCP probing runs configured servers with a sandboxed environment
  (allowlisted safe keys + the server's own declared `env`) and a timeout,
  and never writes environment values into registry entries.

## Deliberately not ported

The standalone package's React panel, CLI, file watcher, and stdio MCP
server were not ported. The panel is a user-facing surface for internal
machinery, the app has no bin story, refresh is an explicit rescan, and the
find/describe wiring into the harness is a separate step that must follow
the harness's embedded-server pattern.

## Evaluation

`eval/run-eval.ts` measures retrieval quality on 30 fixed tasks against a
fixture machine (BM25 + local embeddings). The bar is ≥90% top-3 accuracy
at <250 average tokens per lookup; `eval.test.ts` enforces it.
