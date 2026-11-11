/**
 * Native VS Code Pseudoterminal Integration (Step 9.1).
 * Bridges VS Code's vscode.Pseudoterminal interface directly to Omnexx's PtyBridge
 * to stream compilers, test runners, and git commands live with ANSI color.
 */

import * as vscode from 'vscode';
import {
  spawnPty,
  type PtyBridge,
  type PtyBridgeOptions,
} from '../../../src/sandbox/pty-bridge.js';

export interface SandboxTerminalConfig extends Partial<PtyBridgeOptions> {
  readonly title?: string;
}

export class SandboxPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private bridge: PtyBridge | null = null;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  constructor(
    private readonly config: SandboxTerminalConfig = {},
    customBridge?: PtyBridge,
  ) {
    if (customBridge) {
      this.attachBridge(customBridge);
    }
  }

  private attachBridge(bridge: PtyBridge): void {
    this.bridge = bridge;
    this.unsubscribeData = bridge.onData((chunk) => {
      this.writeEmitter.fire(chunk);
    });
    this.unsubscribeExit = bridge.onExit((exitInfo) => {
      this.closeEmitter.fire(exitInfo.exitCode ?? 0);
    });
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (this.bridge) {
      if (initialDimensions) {
        this.bridge.resize(initialDimensions.columns, initialDimensions.rows);
      }
      return;
    }

    const defaultShell =
      process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    const bridgeOptions: PtyBridgeOptions = {
      command: this.config.command ?? defaultShell,
      ...(this.config.args ? { args: this.config.args } : {}),
      cwd: this.config.cwd ?? process.cwd(),
      ...(this.config.env ? { env: this.config.env } : {}),
      cols: initialDimensions?.columns ?? this.config.cols ?? 80,
      rows: initialDimensions?.rows ?? this.config.rows ?? 24,
      name: this.config.name ?? 'Omnexx: Sandbox',
    };

    const spawned = spawnPty(bridgeOptions);
    this.attachBridge(spawned);
  }

  close(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.bridge && !this.bridge.exited) {
      this.bridge.write(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.bridge && !this.bridge.exited) {
      this.bridge.resize(dimensions.columns, dimensions.rows);
    }
  }

  private cleanup(): void {
    if (this.unsubscribeData) {
      this.unsubscribeData();
      this.unsubscribeData = null;
    }
    if (this.unsubscribeExit) {
      this.unsubscribeExit();
      this.unsubscribeExit = null;
    }
    if (this.bridge) {
      void this.bridge.dispose();
      this.bridge = null;
    }
  }
}

/**
 * Creates and shows a dedicated native "Omnexx: Sandbox" terminal in VS Code.
 */
export function openSandboxTerminal(config: SandboxTerminalConfig = {}): vscode.Terminal {
  const pty = new SandboxPseudoterminal(config);
  const terminal = vscode.window.createTerminal({
    name: config.title ?? 'Omnexx: Sandbox',
    pty,
  });
  terminal.show();
  return terminal;
}
