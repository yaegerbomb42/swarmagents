import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { issueWsTicket, verifyAndConsumeWsTicket, WS_TICKET_TTL_MS } from "./ws-ticket";
import { POST } from "../../app/api/share/[token]/ws-ticket/route";
import {
  configureProjectStoreDir,
  createProject,
  createShareLink,
  revokeShareLink,
} from "../projects/store";

test("ws-ticket: issued ticket verifies once, rejects reuse, expiry, and tampering", () => {
  const consumed = new Map<string, number>();
  const now = 1_700_000_000_000;
  const secret = "test-ws-ticket-secret-0123456789abcdef";

  const { ticket, expiresAt } = issueWsTicket("owner_1", now, secret);
  assert.equal(expiresAt, now + WS_TICKET_TTL_MS);

  // First use succeeds.
  assert.deepEqual(verifyAndConsumeWsTicket(ticket, consumed, now + 1000, secret), {
    ownerId: "owner_1",
  });

  // Replay is rejected.
  assert.equal(verifyAndConsumeWsTicket(ticket, consumed, now + 2000, secret), null);

  // Tampered ticket is rejected.
  const tampered = ticket.slice(0, -1) + (ticket.endsWith("a") ? "b" : "a");
  assert.equal(verifyAndConsumeWsTicket(tampered, consumed, now + 2000, secret), null);

  // Expired ticket is rejected.
  const { ticket: freshTicket } = issueWsTicket("owner_2", now, secret);
  assert.equal(
    verifyAndConsumeWsTicket(freshTicket, consumed, now + WS_TICKET_TTL_MS + 1, secret),
    null,
  );
});

test("POST /api/share/[token]/ws-ticket issues a single-use ticket for valid shares and 404s unknown/revoked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-ticket-route-"));
  const prevSecret = process.env.SWARM_SESSION_SECRET;
  process.env.SWARM_SESSION_SECRET = "test-session-secret-for-ws-ticket-route-32bytes";
  try {
    configureProjectStoreDir(dir);
    const project = createProject("owner_a", { name: "Demo" });
    const share = createShareLink("owner_a", project.id);

    const res = await POST(new NextRequest(`http://localhost/api/share/${share.token}/ws-ticket`, { method: "POST" }), {
      params: Promise.resolve({ token: share.token }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { ticket: string; expiresAt: number };
    assert.equal(typeof body.ticket, "string");
    assert.ok(body.ticket.length > 20);
    assert.ok(!body.ticket.includes(share.token));

    const consumed = new Map<string, number>();
    assert.deepEqual(verifyAndConsumeWsTicket(body.ticket, consumed), { ownerId: "owner_a" });
    assert.equal(verifyAndConsumeWsTicket(body.ticket, consumed), null);

    // Revoked token -> 404.
    revokeShareLink("owner_a", project.id);
    const revokedRes = await POST(
      new NextRequest(`http://localhost/api/share/${share.token}/ws-ticket`, { method: "POST" }),
      { params: Promise.resolve({ token: share.token }) },
    );
    assert.equal(revokedRes.status, 404);
  } finally {
    if (prevSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = prevSecret;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
