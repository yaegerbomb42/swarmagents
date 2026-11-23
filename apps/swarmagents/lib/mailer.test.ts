import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  buildMessage,
  mailConfigured,
  sendMail,
  setMailTransportForTests,
  smtpConfig,
  type MailMessage,
} from "./mailer.js";

/** Minimal scripted SMTP server: enough of RFC 5321 to exercise the client. */
interface FakeSmtp {
  port: number;
  commands: string[];
  dataPayload: string;
  close: () => Promise<void>;
}

function startFakeSmtp(options: { authCode?: number; greetingCode?: number } = {}): Promise<FakeSmtp> {
  const commands: string[] = [];
  let dataPayload = "";
  let inData = false;
  let dataBuffer = "";

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(`${options.greetingCode ?? 220} fake.local ESMTP ready\r\n`);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      if (inData) {
        dataBuffer += chunk;
        const end = dataBuffer.indexOf("\r\n.\r\n");
        if (end >= 0) {
          dataPayload = dataBuffer.slice(0, end);
          inData = false;
          dataBuffer = "";
          socket.write("250 OK queued\r\n");
        }
        return;
      }
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          socket.write("250-fake.local greets you\r\n250-AUTH LOGIN\r\n250 OK\r\n");
        } else if (upper === "AUTH LOGIN") {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          socket.write("250 OK\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && commands.length >= 2 && commands[commands.length - 2] === "AUTH LOGIN") {
          // AUTH LOGIN username step.
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // AUTH LOGIN password step.
          socket.write(`${options.authCode ?? 235} ${options.authCode === 535 ? "Authentication failed" : "Authentication successful"}\r\n`);
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        commands,
        get dataPayload() {
          return dataPayload;
        },
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function smtpEnv(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SWARM_SMTP_HOST: "127.0.0.1",
    SWARM_SMTP_PORT: String(port),
    SWARM_MAIL_FROM: "SwarmAgents <no-reply@example.com>",
    SWARM_SMTP_HELO: "test.local",
    ...extra,
  };
}

test.afterEach(() => {
  setMailTransportForTests(null);
});

test("smtpConfig: defaults, secure port, and unconfigured detection", () => {
  assert.equal(smtpConfig({}), null);
  assert.equal(smtpConfig({ SWARM_SMTP_HOST: "smtp.example.com" }), null, "FROM is required too");
  assert.equal(smtpConfig({ SWARM_MAIL_FROM: "a@b.co" }), null, "HOST is required too");

  const plain = smtpConfig({ SWARM_SMTP_HOST: "smtp.example.com", SWARM_MAIL_FROM: "a@b.co" });
  assert.ok(plain);
  assert.equal(plain.port, 587);
  assert.equal(plain.secure, false);
  assert.equal(plain.timeoutMs, 10_000);

  const secure = smtpConfig({
    SWARM_SMTP_HOST: "smtp.example.com",
    SWARM_MAIL_FROM: "a@b.co",
    SWARM_SMTP_SECURE: "1",
  });
  assert.ok(secure);
  assert.equal(secure.port, 465);
  assert.equal(secure.secure, true);

  assert.equal(mailConfigured({}), false);
  assert.equal(mailConfigured({ SWARM_SMTP_HOST: "h", SWARM_MAIL_FROM: "a@b.co" }), true);
});

test("sendMail delivers over SMTP with AUTH LOGIN and dot-stuffed body", async () => {
  const fake = await startFakeSmtp();
  try {
    const message: MailMessage = {
      to: "alice@example.com",
      subject: "Reset your SwarmAgents password",
      text: "Open this link:\nhttps://example.com/reset-password?token=pr1.abc\n.hidden line\nDone.",
    };
    const result = await sendMail(
      message,
      smtpEnv(fake.port, { SWARM_SMTP_USER: "mailer", SWARM_SMTP_PASS: "s3cret" }),
    );
    assert.deepEqual(result, { ok: true });

    // Envelope + auth conversation, in order.
    assert.ok(fake.commands[0].startsWith("EHLO test.local"), fake.commands.join(" | "));
    assert.ok(fake.commands.includes("AUTH LOGIN"));
    assert.ok(fake.commands.includes(Buffer.from("mailer").toString("base64")));
    assert.ok(fake.commands.includes(Buffer.from("s3cret").toString("base64")));
    assert.ok(fake.commands.includes("MAIL FROM:<no-reply@example.com>"), fake.commands.join(" | "));
    assert.ok(fake.commands.includes("RCPT TO:<alice@example.com>"));
    assert.ok(fake.commands.includes("DATA"));

    // Headers present; a body line starting with "." is dot-stuffed.
    assert.ok(fake.dataPayload.includes("From: SwarmAgents <no-reply@example.com>"));
    assert.ok(fake.dataPayload.includes("To: alice@example.com"));
    assert.ok(fake.dataPayload.includes("Subject: Reset your SwarmAgents password"));
    assert.ok(fake.dataPayload.includes("token=pr1.abc"));
    assert.ok(fake.dataPayload.includes("\r\n..hidden line"), "dot-stuffing applied");
  } finally {
    await fake.close();
  }
});

test("sendMail reports SMTP auth failure as a result, never throws", async () => {
  const fake = await startFakeSmtp({ authCode: 535 });
  try {
    const result = await sendMail(
      { to: "alice@example.com", subject: "x", text: "y" },
      smtpEnv(fake.port, { SWARM_SMTP_USER: "mailer", SWARM_SMTP_PASS: "wrong" }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /AUTH password failed/);
  } finally {
    await fake.close();
  }
});

test("sendMail reports an unreachable server as a result", async () => {
  // Port 1 on loopback: nothing listens there.
  const result = await sendMail(
    { to: "alice@example.com", subject: "x", text: "y" },
    { SWARM_SMTP_HOST: "127.0.0.1", SWARM_SMTP_PORT: "1", SWARM_MAIL_FROM: "a@b.co", SWARM_SMTP_TIMEOUT_MS: "2000" },
  );
  assert.equal(result.ok, false);
});

test("unconfigured mailer: local mode logs the message, server mode never logs the body", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const local = await sendMail(
      { to: "alice@example.com", subject: "Reset", text: "link https://x/reset?token=pr1.secret" },
      {},
    );
    assert.deepEqual(local, { ok: true }, "local console fallback counts as delivered");
    assert.ok(logs.join("\n").includes("pr1.secret"), "local operator sees the link");

    const server = await sendMail(
      { to: "alice@example.com", subject: "Reset", text: "link https://x/reset?token=pr1.secret" },
      { SWARM_SERVER_MODE: "1" },
    );
    assert.equal(server.ok, false);
    assert.ok(!errors.join("\n").includes("pr1.secret"), "server logs must never carry a live token");
    assert.ok(errors.join("\n").includes("SWARM_SMTP_HOST"), "the warning names the missing config");
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

test("buildMessage strips header injection and encodes non-ASCII subjects", () => {
  const built = buildMessage(
    { to: "alice@example.com\r\nBcc: victim@example.com", subject: "Hi\r\nX-Evil: 1", text: "body" },
    "from@example.com",
    new Date("2026-11-22T00:00:00Z"),
  );
  const headerBlock = built.split("\r\n\r\n")[0];
  const headerLines = headerBlock.split("\r\n");
  assert.ok(!headerLines.some((l) => l.startsWith("Bcc:")), "injected Bcc header cannot start a line");
  assert.ok(!headerLines.some((l) => l.startsWith("X-Evil:")), "injected header cannot start a line");
  assert.ok(headerBlock.includes("To: alice@example.com Bcc: victim@example.com"), "CR/LF collapsed to spaces");

  const unicode = buildMessage({ to: "a@b.co", subject: "Réinitialiser", text: "x" }, "f@b.co");
  assert.ok(unicode.includes("Subject: =?UTF-8?B?"), "non-ASCII subject is RFC 2047 encoded");
});

test("injected test transport receives the message verbatim", async () => {
  const seen: MailMessage[] = [];
  setMailTransportForTests(async (message) => {
    seen.push(message);
    return { ok: true };
  });
  const result = await sendMail({ to: "a@b.co", subject: "s", text: "t" }, {});
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [{ to: "a@b.co", subject: "s", text: "t" }]);
  assert.equal(mailConfigured({}), true, "a test transport counts as configured");
});
