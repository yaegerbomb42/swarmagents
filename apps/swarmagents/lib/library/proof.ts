/**
 * F4 — Signed proof-of-run bundles for the Public Library.
 *
 * When a skill/connector is published, the publisher may attach the
 * RunReport of a run that exercised it. The bundle is a signed, version-bound
 * copy of that report: prompt, condensed steps, artifact diff, cost, exit
 * status and a sampled set of screenshots. Browsers see a "verified
 * proof-of-run" badge only when the signature checks out *and* the bundle is
 * bound to the exact version on display; anything else stays "unreviewed".
 *
 * Signing — HMAC-SHA256 keyed by `SWARM_SESSION_SECRET`, the server secret
 * already used for session cookies (lib/auth.ts). No new key-management
 * scheme is introduced: the same secret the server already guards signs
 * these bundles too. The signing input is domain-separated
 * (`swarmagents:proof:v1:...`) so a proof MAC can never validate as a
 * session token and vice versa. Verification is timing-safe.
 *
 * Trust model, stated plainly: the signature proves *this server* produced
 * the bundle from a run it executed — it is not the publisher's signature,
 * and a bundle signed on one instance will not verify on another instance
 * with a different secret. If `SWARM_SESSION_SECRET` is unset, signing
 * refuses outright (an empty key would be worse than no badge).
 *
 * Screenshots live outside the catalog: the bundle in `catalog.json` carries
 * shot metadata only, while the (sampled, size-capped) image bytes are stored
 * under `<data>/public-library/proofs/<publicId>/v<version>/` and served by
 * the proof-shots route, which re-verifies the bundle before serving.
 *
 * Known gap: a RunReport does not record which VM image the run used, so
 * the bundle asserts the default image (`swarm-vm:claude`) rather than
 * proving it. Recording the image in the report is the follow-up that would
 * close this.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRunReport, readShotBytes, sampleShotIndices } from "../runtime/run-report";
import { getRunsDir } from "../telemetry/paths";
import type { ReportArtifact, ReportStatus, ReportStep, RunReport } from "../runtime/run-report-types";
import { resolveLibraryDataDir, type LibraryStoreOptions } from "./user-store";
import type { LibraryKind, LibraryPayload } from "./types";

/** Bundle format marker; bump if the signed payload shape ever changes. */
export const PROOF_FORMAT = "swarmagents.proof/v1";
/** Domain separator for the HMAC input (see module doc). */
export const PROOF_DOMAIN = "swarmagents:proof:v1";
/** VM image a proof run is asserted to have used (see module doc: gap). */
export const PROOF_VM_IMAGE = "swarm-vm:claude";
/** Max screenshots stored with a bundle (sampled across the run). */
export const MAX_PROOF_SHOTS = 8;
/** A single proof screenshot larger than this is skipped, not stored. */
export const MAX_PROOF_SHOT_BYTES = 1 * 1024 * 1024;
/** Max steps copied into a bundle. */
export const MAX_PROOF_STEPS = 500;
/** Max artifacts copied into a bundle. */
export const MAX_PROOF_ARTIFACTS = 200;
/** Max prompt characters copied into a bundle. */
export const MAX_PROOF_PROMPT_CHARS = 4000;

export interface ProofShot {
  /** Index into the bundle's shots array (also the file served by the route). */
  index: number;
  /** File name under the proof shots dir (server-generated, `NNN.png|jpg`). */
  file: string;
  mime: string;
  seq: number;
  ts: number;
  label: string;
  size: number;
  /** Public URL for the stored shot. */
  url: string;
}

export interface ProofBundle {
  format: string;
  /** Public catalog id the bundle proves. */
  publicId: string;
  /** Exact catalog version the bundle ran against. */
  version: number;
  kind: LibraryKind;
  name: string;
  /** sha256 of the canonical payload JSON — binds the bundle to the code. */
  payloadHash: string;
  runId: string;
  runStatus: ReportStatus;
  vmImage: string;
  prompt: string;
  createdAt: number;
  finishedAt: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  providers: string[];
  steps: ReportStep[];
  artifacts: ReportArtifact[];
  /** sha256 of the canonical artifacts list. */
  artifactDigest: string;
  shots: ProofShot[];
  /** Total screenshots the source report held (stored count may be lower). */
  shotsTotal: number;
  issuedAt: number;
  /** Hex HMAC-SHA256 over the canonical bundle (minus this field). */
  signature: string;
}

/** Client-safe view of a verified bundle (signature stripped). */
export type ProofView = Omit<ProofBundle, "signature" | "payloadHash" | "artifactDigest"> & {
  verified: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server secret that signs bundles (same secret as session cookies). */
export function proofSecret(): string {
  return process.env.SWARM_SESSION_SECRET ?? "";
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash binding a bundle to the exact published payload. */
export function payloadHash(payload: LibraryPayload): string {
  return sha256Hex(canonicalJson(payload));
}

function artifactDigest(artifacts: readonly ReportArtifact[]): string {
  return sha256Hex(canonicalJson(artifacts));
}

/** The exact bytes the HMAC covers: domain + canonical bundle, no signature. */
export function proofSigningInput(bundle: Omit<ProofBundle, "signature">): string {
  return `${PROOF_DOMAIN}:${canonicalJson(bundle)}`;
}

/**
 * Sign an unsigned bundle. Throws when the server secret is unset — a
 * bundle signed with an empty key would be worse than no bundle at all.
 */
export function signProofBundle(bundle: Omit<ProofBundle, "signature">): ProofBundle {
  const secret = proofSecret();
  if (!secret) {
    throw new Error(
      "Proof signing is not configured on this server (SWARM_SESSION_SECRET is unset).",
    );
  }
  const signature = createHmac("sha256", secret).update(proofSigningInput(bundle)).digest("hex");
  return { ...bundle, signature };
}

/**
 * Verify a stored bundle against the item it claims to prove. Every check
 * must pass: format, public id, exact version, payload hash, and the HMAC.
 * Any failure — unsigned, tampered, stale version, wrong secret — is simply
 * "not verified"; the caller never shows it as verified.
 */
export function verifyProofBundle(
  bundle: unknown,
  expected: { publicId: string; version: number; payload: LibraryPayload },
): bundle is ProofBundle {
  if (!isRecord(bundle)) return false;
  if (bundle.format !== PROOF_FORMAT) return false;
  if (bundle.publicId !== expected.publicId) return false;
  if (bundle.version !== expected.version) return false;
  if (typeof bundle.payloadHash !== "string") return false;
  if (bundle.payloadHash !== payloadHash(expected.payload)) return false;
  if (typeof bundle.signature !== "string" || !/^[0-9a-f]{64}$/.test(bundle.signature)) {
    return false;
  }
  const secret = proofSecret();
  if (!secret) return false;
  const { signature, ...unsigned } = bundle as unknown as ProofBundle;
  const expectedMac = createHmac("sha256", secret)
    .update(proofSigningInput(unsigned as Omit<ProofBundle, "signature">))
    .digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expectedMac, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strict shape check for a bundle read back from the catalog file. */
export function parseProofBundle(value: unknown): ProofBundle | null {
  if (!isRecord(value)) return null;
  if (value.format !== PROOF_FORMAT) return null;
  if (typeof value.publicId !== "string" || !value.publicId) return null;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version)) return null;
  if (typeof value.name !== "string") return null;
  if (typeof value.payloadHash !== "string") return null;
  if (typeof value.runId !== "string" || !value.runId) return null;
  if (value.runStatus !== "finished" && value.runStatus !== "error" && value.runStatus !== "cancelled") {
    return null;
  }
  if (!Array.isArray(value.steps) || !Array.isArray(value.artifacts) || !Array.isArray(value.shots)) {
    return null;
  }
  if (typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)) return null;
  return value as unknown as ProofBundle;
}

/** Client-safe view: everything the UI needs, without the signature/hashes. */
export function proofView(bundle: ProofBundle): ProofView {
  const { signature: _signature, payloadHash: _payloadHash, artifactDigest: _digest, ...rest } =
    bundle;
  return { ...rest, verified: true };
}

// --- shot storage -----------------------------------------------------------

export function proofShotsDir(
  publicId: string,
  version: number,
  options: LibraryStoreOptions = {},
): string {
  return path.join(
    resolveLibraryDataDir(options),
    "public-library",
    "proofs",
    publicId,
    `v${version}`,
  );
}

/** Public URL for one stored proof shot. */
export function proofShotUrl(publicId: string, index: number): string {
  return `/api/library/public/${encodeURIComponent(publicId)}/proof/shots/${index}`;
}

/** Write the sampled shot bytes under the proof shots dir (mode 0600). */
export function storeProofShots(
  publicId: string,
  version: number,
  shots: Array<{ meta: ProofShot; bytes: Buffer }>,
  options: LibraryStoreOptions = {},
): void {
  const dir = proofShotsDir(publicId, version, options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const shot of shots) {
    const file = path.join(dir, shot.meta.file);
    fs.writeFileSync(file, shot.bytes, { mode: 0o600 });
  }
}

/** Read one stored proof shot, or null when it is missing/unreadable. */
export function readProofShot(
  publicId: string,
  version: number,
  index: number,
  options: LibraryStoreOptions = {},
): { bytes: Buffer; mime: string; name: string } | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const dir = proofShotsDir(publicId, version, options);
  for (const ext of ["png", "jpg"]) {
    const name = `${String(index).padStart(3, "0")}.${ext}`;
    try {
      const bytes = fs.readFileSync(path.join(dir, name));
      return { bytes, mime: ext === "png" ? "image/png" : "image/jpeg", name };
    } catch {
      /* try the other extension */
    }
  }
  return null;
}

// --- building a bundle from a run report ------------------------------------

export interface BuildProofInput {
  publicId: string;
  version: number;
  kind: LibraryKind;
  name: string;
  payload: LibraryPayload;
  /** The publisher's own finished run report. */
  report: RunReport;
  runsDir?: string | null;
}

/**
 * Build (and sign) a bundle from a finished run report, sampling at most
 * MAX_PROOF_SHOTS screenshots. Throws when the report is not a finished run
 * or the server secret is unset. Returns the signed bundle plus the shot
 * bytes the caller must persist with {@link storeProofShots}.
 *
 * Only a `finished` run proves success: an errored or cancelled run is
 * refused here, so a verified badge always means "this exact version ran to
 * completion in a clean VM".
 */
export function buildProofBundle(input: BuildProofInput): {
  bundle: ProofBundle;
  shots: Array<{ meta: ProofShot; bytes: Buffer }>;
} {
  const { report } = input;
  if (report.status !== "finished") {
    throw new Error("Only a finished run can be attached as proof of a successful run.");
  }
  const sampled = sampleShotIndices(report.shots.length, MAX_PROOF_SHOTS);
  const shots: Array<{ meta: ProofShot; bytes: Buffer }> = [];
  for (const shotIndex of sampled) {
    const shot = report.shots[shotIndex];
    if (!shot || shot.size > MAX_PROOF_SHOT_BYTES) continue;
    const stored = readShotBytes(
      report.runId,
      shotIndex,
      input.runsDir === undefined ? getRunsDir() : input.runsDir,
    );
    if (!stored) continue;
    const file = `${String(shots.length).padStart(3, "0")}.${shot.mime === "image/jpeg" ? "jpg" : "png"}`;
    shots.push({
      meta: {
        index: shots.length,
        file,
        mime: shot.mime,
        seq: shot.seq,
        ts: shot.ts,
        label: shot.label,
        size: stored.bytes.length,
        url: proofShotUrl(input.publicId, shots.length),
      },
      bytes: stored.bytes,
    });
  }
  const artifacts = report.artifacts.slice(0, MAX_PROOF_ARTIFACTS);
  const unsigned: Omit<ProofBundle, "signature"> = {
    format: PROOF_FORMAT,
    publicId: input.publicId,
    version: input.version,
    kind: input.kind,
    name: input.name,
    payloadHash: payloadHash(input.payload),
    runId: report.runId,
    runStatus: report.status,
    vmImage: PROOF_VM_IMAGE,
    prompt: report.prompt.slice(0, MAX_PROOF_PROMPT_CHARS),
    createdAt: report.createdAt,
    finishedAt: report.finishedAt,
    ...(report.meta.costUsd !== undefined ? { costUsd: report.meta.costUsd } : {}),
    ...(report.meta.durationMs !== undefined ? { durationMs: report.meta.durationMs } : {}),
    ...(report.meta.model ? { model: report.meta.model } : {}),
    providers: report.meta.providers,
    steps: report.steps.slice(0, MAX_PROOF_STEPS),
    artifacts,
    artifactDigest: artifactDigest(artifacts),
    shots: shots.map((shot) => shot.meta),
    shotsTotal: report.shots.length,
    issuedAt: Date.now(),
  };
  return { bundle: signProofBundle(unsigned), shots };
}

/**
 * Attach a signed proof bundle to a publish: load the publisher's own run
 * report, verify ownership, build + sign the bundle, and persist its shots.
 * Returns the signed bundle (the caller then records it on the version via
 * `setVersionProof` in public-store). Throws a plain Error the route turns
 * into a `proofError` on an otherwise successful publish.
 */
export function buildProofForPublish(input: {
  ownerId: string;
  publicId: string;
  version: number;
  kind: LibraryKind;
  name: string;
  payload: LibraryPayload;
  proofRunId: string;
  runsDir?: string | null;
  storeOptions?: LibraryStoreOptions;
}): { bundle: ProofBundle; shots: Array<{ meta: ProofShot; bytes: Buffer }> } {
  const report = readRunReport(
    input.proofRunId,
    input.runsDir === undefined ? getRunsDir() : input.runsDir,
  );
  if (!report) {
    throw new Error(`No run report found for run ${input.proofRunId}.`);
  }
  if (report.userId !== input.ownerId) {
    throw new Error("Only your own runs can be attached as proof.");
  }
  const built = buildProofBundle({
    publicId: input.publicId,
    version: input.version,
    kind: input.kind,
    name: input.name,
    payload: input.payload,
    report,
    runsDir: input.runsDir === undefined ? getRunsDir() : input.runsDir,
  });
  storeProofShots(input.publicId, input.version, built.shots, input.storeOptions ?? {});
  return built;
}

/** Random id suffix, e.g. for snapshot labels (no `crypto.randomUUID` in tests). */
export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}
