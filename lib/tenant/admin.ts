// The admin account and the admin-only views (Jimmy, 20:47 CT).
//
// bootstrapAdmin() runs once at server start. If SWARM_ADMIN_EMAIL and SWARM_ADMIN_PASSWORD_FILE (preferred) or
// SWARM_ADMIN_PASSWORD are set and no account has that email, it creates one as admin (scrypt-hashed like every
// password). It is idempotent, never promotes an existing account (a squatter can't become admin), and never logs,
// returns or keeps the password: the env copy is deleted from process.env once read, so agent children can't see it.
// Sign-up can't set an email at all, so the admin's address can only ever come from here.

import fs from "node:fs";
import { createUser, findUserByEmail, transaction, usernameTaken, validateCredentials, type User } from "../users";

export type BootstrapResult = { status: "created" | "exists" | "conflict" | "skipped"; reason?: string; username?: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const adminEmail = () => (process.env.SWARM_ADMIN_EMAIL ?? "").trim().toLowerCase();

let fileError = "";

function readPassword(): string {
  const file = process.env.SWARM_ADMIN_PASSWORD_FILE;
  let pw = "";
  fileError = "";
  if (file) {
    try {
      pw = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch (e) {
      pw = "";
      fileError = `can't read SWARM_ADMIN_PASSWORD_FILE (${(e as NodeJS.ErrnoException).code ?? "error"})`; // never the contents
    }
  }
  if (!pw) pw = process.env.SWARM_ADMIN_PASSWORD ?? "";
  delete process.env.SWARM_ADMIN_PASSWORD; // read once; nothing spawned later inherits it
  return pw;
}

/** A free username for the admin, from the email's local part. */
function usernameFor(email: string): string {
  const base = (email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 26) || "admin").padEnd(3, "0");
  if (!usernameTaken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!usernameTaken(`${base}-${i}`)) return `${base}-${i}`;
  return `admin-${Date.now().toString(36)}`;
}

export function bootstrapAdmin(log: (s: string) => void = (s) => console.log(s)): BootstrapResult {
  if (process.env.SWARM_MODE !== "server") return { status: "skipped", reason: "not a server" };
  const email = adminEmail();
  if (!email) return { status: "skipped", reason: "SWARM_ADMIN_EMAIL not set" };
  const password = readPassword();
  if (!EMAIL.test(email)) return { status: "skipped", reason: "SWARM_ADMIN_EMAIL is not an email address" };
  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.isAdmin) return { status: "exists", username: existing.username };
    log(`[admin] WARNING: ${email} belongs to a non-admin account; it was NOT promoted. Fix it by hand.`);
    return { status: "conflict", reason: "a non-admin account has that email" };
  }
  if (!password) return { status: "skipped", reason: fileError || "no admin password configured" };
  const bad = validateCredentials("admin", password, { lengthOnly: true }); // never lock out an existing admin password
  if (bad) return { status: "skipped", reason: bad };
  const made = transaction((): User | null => (findUserByEmail(email) ? null : createUser(usernameFor(email), password, true, email)));
  if (!made) return { status: "exists" };
  log(`[admin] created the admin account for ${email} (username ${made.username}).`);
  return { status: "created", username: made.username };
}
