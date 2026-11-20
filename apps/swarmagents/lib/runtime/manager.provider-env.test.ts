import test from "node:test";
import assert from "node:assert/strict";
import { envFallback } from "./manager";

test("server mode never forwards host provider credentials to a run without providers", () => {
  const prev = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = "sk-host-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "host-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-oauth";
    process.env.ANTHROPIC_MODEL = "claude-x";
    process.env.SWARM_SERVER_MODE = "1";
    const server = envFallback();
    assert.equal(server.ANTHROPIC_API_KEY, undefined);
    assert.equal(server.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(server.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(server.ANTHROPIC_MODEL, "claude-x", "non-credential settings still pass");

    delete process.env.SWARM_SERVER_MODE;
    const local = envFallback();
    assert.equal(local.ANTHROPIC_API_KEY, "sk-host-key", "local mode keeps the machine's own env");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});
