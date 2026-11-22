/**
 * Outbound mail (FIX-39 password reset is the first consumer).
 *
 * A minimal SMTP client built on node:net / node:tls — no npm dependency,
 * so adding mail does not desync package-lock for `npm ci`. Configuration
 * is deployment env only (keys never live in code):
 *
 *   SWARM_SMTP_HOST        SMTP server host (required to enable mail)
 *   SWARM_SMTP_PORT        default 587 (465 when SWARM_SMTP_SECURE=1)
 *   SWARM_SMTP_SECURE      "1"/"true" = implicit TLS from connect
 *   SWARM_SMTP_USER        AUTH LOGIN username (optional)
 *   SWARM_SMTP_PASS        AUTH LOGIN password (optional)
 *   SWARM_MAIL_FROM        envelope/header From (required with HOST)
 *   SWARM_SMTP_TIMEOUT_MS  per-operation socket timeout (default 10000)
 *   SWARM_SMTP_HELO        EHLO name (default: os.hostname())
 *
 * When HOST is unset the mailer is unconfigured: in local mode (single
 * trusted user on loopback) the message is written to the server console
 * so the operator can still recover an account; in server mode only a
 * warning is logged — a live reset link must never land in server logs.
 *
 * sendMail never throws: delivery failure is a result, not an exception,
 * so callers (the reset-request route) can stay oracle-free.
 */

import net from "node:net";
import tls from "node:tls";
import os from "node:os";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendMailResult = { ok: true } | { ok: false; error: string };

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  helo: string;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

function positiveIntFrom(env: Env, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** SMTP config from env, or null when mail is not configured. */
export function smtpConfig(env: Env = process.env): SmtpConfig | null {
  const host = env.SWARM_SMTP_HOST?.trim();
  const from = env.SWARM_MAIL_FROM?.trim();
  if (!host || !from) return null;
  const secure = truthy(env.SWARM_SMTP_SECURE);
  return {
    host,
    port: positiveIntFrom(env, "SWARM_SMTP_PORT", secure ? 465 : 587),
    secure,
    user: env.SWARM_SMTP_USER?.trim() || undefined,
    pass: env.SWARM_SMTP_PASS || undefined,
    from,
    helo: env.SWARM_SMTP_HELO?.trim() || os.hostname() || "swarmagents.local",
    timeoutMs: positiveIntFrom(env, "SWARM_SMTP_TIMEOUT_MS", 10_000),
  };
}

/** True when an SMTP transport is configured (or a test transport is set). */
export function mailConfigured(env: Env = process.env): boolean {
  return testTransport !== null || smtpConfig(env) !== null;
}

type MailTransport = (message: MailMessage, config: SmtpConfig) => Promise<SendMailResult>;

let testTransport: MailTransport | null = null;

/** Test hook: replace the SMTP transport (pass null to restore). */
export function setMailTransportForTests(transport: MailTransport | null): void {
  testTransport = transport;
}

/** Local mode trusts loopback; server mode must never log message bodies. */
function serverModeFromEnv(env: Env): boolean {
  return truthy(env.SWARM_SERVER_MODE);
}

/**
 * Send one plain-text email. Never throws. When no transport is
 * configured: local mode logs the message to the console (the operator's
 * recovery path) and reports success; server mode logs a warning without
 * the body and reports failure — the caller decides what the user sees.
 */
export async function sendMail(message: MailMessage, env: Env = process.env): Promise<SendMailResult> {
  const config = smtpConfig(env);
  if (testTransport) {
    // Tests inject a transport even without full SMTP env; hand it a
    // placeholder config when env is unset.
    const effective = config ?? {
      host: "test.invalid",
      port: 587,
      secure: false,
      from: "swarmagents@test.invalid",
      helo: "test",
      timeoutMs: 1_000,
    };
    try {
      return await testTransport(message, effective);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "mail transport failed" };
    }
  }
  if (!config) {
    if (!serverModeFromEnv(env)) {
      console.log(
        `[mail:local] SMTP not configured; message for ${message.to} (subject: ${message.subject}):\n${message.text}`,
      );
      return { ok: true };
    }
    console.error(
      "[mail] SMTP not configured (SWARM_SMTP_HOST/SWARM_MAIL_FROM unset); outbound mail is disabled. " +
        "Password-reset email cannot be delivered in server mode until mail is configured — see DEPLOY.md.",
    );
    return { ok: false, error: "mail transport not configured" };
  }
  try {
    return await sendViaSmtp(message, config);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "smtp send failed" };
  }
}

/* ------------------------------------------------------------------ */
/* SMTP wire protocol                                                  */
/* ------------------------------------------------------------------ */

/** Strip CR/LF (and other controls) so a value can never inject headers. */
function cleanHeader(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Bare addr-spec from a "Display Name <addr>" value, for the envelope. */
function envelopeAddress(value: string): string {
  const cleaned = cleanHeader(value);
  const m = /<([^<>]+)>/.exec(cleaned);
  return (m ? m[1] : cleaned).trim();
}

/** RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through. */
function encodeSubject(subject: string): string {
  const cleaned = cleanHeader(subject);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(cleaned)) return cleaned;
  return `=?UTF-8?B?${Buffer.from(cleaned, "utf8").toString("base64")}?=`;
}

/** Full RFC 5322 message (headers + body) with CRLF line endings. */
export function buildMessage(message: MailMessage, from: string, date: Date = new Date()): string {
  const body = message.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const headers = [
    `From: ${cleanHeader(from)}`,
    `To: ${cleanHeader(message.to)}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Dot-stuff lines starting with "." so body content can't end DATA early. */
function dotStuff(text: string): string {
  return text
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

interface SmtpReply {
  code: number;
  lines: string[];
}

/** Line-buffered SMTP conversation over one socket (upgradable to TLS). */
class SmtpSession {
  private buffer = "";
  private waiters: Array<{ resolve: (r: SmtpReply) => void; reject: (e: Error) => void }> = [];
  private pendingLines: string[] = [];
  private failure: Error | null = null;

  constructor(
    private socket: net.Socket,
    private timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("timeout", () => this.fail(new Error("smtp socket timed out")));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => {
      if (this.waiters.length > 0) this.fail(new Error("smtp connection closed"));
    });
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(this.failure);
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.pendingLines.push(line);
      // Final line of a reply: "250 text" (space), continuations are "250-text".
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const code = Number(line.slice(0, 3));
        const lines = this.pendingLines;
        this.pendingLines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve({ code, lines });
      }
    }
  }

  /** Read the next complete reply. */
  readReply(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Send one command line and read its reply. */
  async command(line: string): Promise<SmtpReply> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
    return this.readReply();
  }

  /** Write raw bytes (the DATA payload) without expecting a reply yet. */
  writeRaw(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  /** Swap the underlying socket (STARTTLS upgrade) and keep buffering. */
  upgradeToTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("timeout");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      const secure = tls.connect({ socket: plain, servername }, () => resolve());
      secure.once("error", reject);
      this.socket = secure;
      this.attach(secure);
    });
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }
}

function expect(reply: SmtpReply, codes: number[], what: string): void {
  if (!codes.includes(reply.code)) {
    throw new Error(`smtp ${what} failed: ${reply.lines.join(" ").slice(0, 200)}`);
  }
}

/** Extensions advertised in an EHLO reply (uppercased first word per line). */
function ehloExtensions(reply: SmtpReply): Set<string> {
  const exts = new Set<string>();
  for (const line of reply.lines) {
    const word = line.slice(4).trim().split(/\s+/)[0]?.toUpperCase();
    if (word) exts.add(word);
  }
  return exts;
}

function connectSocket(config: SmtpConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("smtp connect timed out"));
    }, config.timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once(config.secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

/** Deliver one message over SMTP. Throws on failure (sendMail converts). */
async function sendViaSmtp(message: MailMessage, config: SmtpConfig): Promise<SendMailResult> {
  const socket = await connectSocket(config);
  const session = new SmtpSession(socket, config.timeoutMs);
  try {
    expect(await session.readReply(), [220], "greeting");

    let ehlo = await session.command(`EHLO ${config.helo}`);
    expect(ehlo, [250], "EHLO");
    let extensions = ehloExtensions(ehlo);

    if (!config.secure && extensions.has("STARTTLS")) {
      expect(await session.command("STARTTLS"), [220], "STARTTLS");
      await session.upgradeToTls(config.host);
      ehlo = await session.command(`EHLO ${config.helo}`);
      expect(ehlo, [250], "EHLO after STARTTLS");
      extensions = ehloExtensions(ehlo);
    }

    if (config.user) {
      expect(await session.command("AUTH LOGIN"), [334], "AUTH LOGIN");
      expect(await session.command(Buffer.from(config.user, "utf8").toString("base64")), [334], "AUTH username");
      expect(
        await session.command(Buffer.from(config.pass ?? "", "utf8").toString("base64")),
        [235],
        "AUTH password",
      );
    }

    expect(await session.command(`MAIL FROM:<${envelopeAddress(config.from)}>`), [250], "MAIL FROM");
    expect(await session.command(`RCPT TO:<${envelopeAddress(message.to)}>`), [250, 251], "RCPT TO");
    expect(await session.command("DATA"), [354], "DATA");
    session.writeRaw(`${dotStuff(buildMessage(message, config.from))}\r\n.\r\n`);
    expect(await session.readReply(), [250], "message body");

    await session.command("QUIT").catch(() => undefined);
    return { ok: true };
  } finally {
    session.close();
  }
}
