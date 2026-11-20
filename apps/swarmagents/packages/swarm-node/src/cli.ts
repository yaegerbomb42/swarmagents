#!/usr/bin/env node
/**
 * swarm-node — run a SwarmAgents sandbox on your own machine and connect it
 * to the server.
 *
 *   swarm-node --pair ABCD-1234
 *   swarm-node --host-mode            # run commands directly on this machine
 *
 * The node dials OUTBOUND to the server, so no port has to be opened on the
 * user's side: it works from a laptop behind NAT, a home server or a Docker
 * host.
 */

import os from "node:os";
import { DEFAULT_SERVER_URL, SwarmNode } from "./node";
import { defaultCredentialsFile } from "./credentials";
import { startHostDesktop } from "./host-desktop";
import { ContainerBackend, HostBackend, hasDocker, resolveDesktopPassword } from "./backend";

interface CliOptions {
  server: string;
  pair?: string;
  token?: string;
  name: string;
  hostMode: boolean;
  image?: string;
  stateFile: string;
  help: boolean;
}

const USAGE = `swarm-node — connect this machine to a SwarmAgents server

Usage:
  swarm-node [options]

Options:
  --server <url>     Server websocket (default ${DEFAULT_SERVER_URL},
                     or SWARM_NODE_SERVER).
  --pair <code>      One-time pairing code from the app (Settings → Nodes).
  --token <token>    Use an existing device token instead of pairing.
  --name <name>      Name shown in the app (default: the hostname).
  --host-mode        Run commands directly on this machine. Off by default:
                     without it every command runs inside a local container.
  --image <image>    Container image for the sandbox (default swarm-vm:desktop).
  --state <file>     Where the device token is cached
                     (default: ~/.swarm-node/credentials.json).
  --help             Show this help.

The node never opens an inbound port: it connects out to the server over an
authenticated websocket and relays commands, terminal output and the desktop
back through that one connection.
`;

/** Parse the command line. */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    server: process.env.SWARM_NODE_SERVER ?? DEFAULT_SERVER_URL,
    name: os.hostname(),
    hostMode: false,
    stateFile: defaultCredentialsFile(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      return value;
    };
    switch (arg) {
      case "--server":
        options.server = next();
        break;
      case "--pair":
      case "--pairing-code":
        options.pair = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--name":
        options.name = next();
        break;
      case "--host-mode":
        options.hostMode = true;
        break;
      case "--image":
        options.image = next();
        break;
      case "--state":
        options.stateFile = next();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exit(2);
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const log = (message: string) => console.log(`[swarm-node] ${message}`);

  if (options.hostMode) {
    log("host mode is ON — commands run directly on this machine.");
  } else {
    log("container mode — commands run inside a local container.");
  }

  let backend = undefined;
  let hasDesktop = true;
  if (options.hostMode) {
    const desktop = await startHostDesktop({ password: resolveDesktopPassword() });
    backend = new HostBackend({ desktop });
    hasDesktop = desktop !== null;
    if (!desktop) log("no desktop available on this machine (Xvfb/x11vnc/websockify missing).");
  } else {
    if (!hasDocker()) {
      log("warning: the docker CLI was not found on PATH; commands cannot run in the sandbox.");
      log("         install Docker, or start with --host-mode to run directly on this machine.");
    }
    backend = new ContainerBackend({ image: options.image });
  }

  const node = new SwarmNode({
    server: options.server,
    token: options.token,
    pairingCode: options.pair,
    name: options.name,
    hostMode: options.hostMode,
    image: options.image,
    credentialsFile: options.stateFile,
    log,
    backend,
    desktop: hasDesktop,
  });

  node.on("paired", () => log("paired — device token stored."));
  node.on("connected", () => log("connected to the server."));
  node.on("disconnected", () => log("disconnected — reconnecting…"));
  node.on("revoked", (reason: string) => {
    log(`revoked: ${reason}`);
    process.exit(0);
  });
  node.on("error", (err: Error) => log(`error: ${err.message}`));

  const shutdown = () => {
    void node.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await node.start();
  } catch (err) {
    console.error(`[swarm-node] ${(err as Error).message}`);
    process.exit(1);
  }
}

/** True when this file is the process entry point (CommonJS and ESM safe). */
function isDirectRun(): boolean {
  try {
    if (typeof require !== "undefined" && typeof module !== "undefined") {
      return require.main === module;
    }
  } catch {
    /* not a CommonJS module */
  }
  const entry = process.argv[1] ?? "";
  return /swarm-node[\\/](dist|src)[\\/]cli\.(js|ts)$/.test(entry);
}

if (isDirectRun()) {
  void main();
}
