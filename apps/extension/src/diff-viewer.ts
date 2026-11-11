/**
 * Side-by-side patch diff review (Phase 9, brief 9.3): a proposed patch as a
 * virtual document (`omnexx-patch://`), opened in VS Code's native side-by-side
 * diff, with CodeLens Accept Patch / Reject & Re-roll buttons at the top.
 *
 * Follows the InlineDiffReviewProvider pattern (inline-diff-review.ts): the
 * documents are served in-memory, no temp files are written. Accept writes the
 * proposed text to the file on disk (or delegates to the queue-task
 * reviewApprove() CLI flow when the patch belongs to a task); Reject closes
 * the diff and either delegates to reviewReject() for a task or posts a
 * re-roll prompt to the chat. The existing queue-task approve/reject commands
 * are untouched.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { reviewApprove, reviewReject } from './cli.js';
import { primaryFolder } from './tree.js';

export const PATCH_SCHEME = 'omnexx-patch';

export interface PatchData {
  id: string;
  file: string;
  original: string;
  proposed: string;
  taskId?: string;
}

export interface PatchReviewHost {
  /** Post a message to the chat as if the user typed it (re-roll prompt). */
  postToChat(text: string): void;
}

export interface OpenPatchOptions {
  file: string;
  original: string;
  proposed: string;
  taskId?: string;
}

/** In-memory patches, keyed by id; the content provider serves from here. */
const patches = new Map<string, PatchData>();

/** `omnexx-patch://original/<id>` and `omnexx-patch://modified/<id>`. */
function patchUris(id: string): { left: vscode.Uri; right: vscode.Uri } {
  return {
    left: vscode.Uri.from({ scheme: PATCH_SCHEME, authority: 'original', path: `/${id}` }),
    right: vscode.Uri.from({ scheme: PATCH_SCHEME, authority: 'modified', path: `/${id}` }),
  };
}

export function patchIdOf(uri: vscode.Uri): string | null {
  if (uri.scheme !== PATCH_SCHEME) return null;
  if (uri.authority !== 'original' && uri.authority !== 'modified') return null;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(uri.path);
  return match?.[1] ?? null;
}

/** Serves the virtual patch documents from the in-memory store. */
export class PatchDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = patchIdOf(uri);
    const patch = id ? patches.get(id) : undefined;
    if (!patch) return '(no patch for this diff)';
    return uri.authority === 'original' ? patch.original : patch.proposed;
  }
}

/** Accept / Reject & Re-roll lenses on every omnexx-patch document. */
export class PatchCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const id = patchIdOf(document.uri);
    if (!id) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        command: 'omnexx.acceptPatch',
        title: '$(check) Accept Patch',
        arguments: [id],
      }),
      new vscode.CodeLens(range, {
        command: 'omnexx.rejectPatch',
        title: '$(circle-slash) Reject & Re-roll',
        arguments: [id],
      }),
    ];
  }
}

/** Open a patch as a native side-by-side diff; returns the patch id. */
export async function openPatchDiff(options: OpenPatchOptions): Promise<string> {
  const id = `patch-${randomBytes(6).toString('hex')}`;
  const patch: PatchData = {
    id,
    file: options.file,
    original: options.original,
    proposed: options.proposed,
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
  patches.set(id, patch);
  const { left, right } = patchUris(id);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${options.file} (proposed)`);
  return id;
}

/**
 * Open a patch in the virtualized split-diff webview panel (Phase 9,
 * roadmap 9.3); returns the patch id. The panel is a separate id in the
 * patches map from any native diff of the same patch, so accepting or
 * rejecting in one surface never closes the other. Accept/Reject come back
 * as webview messages and reuse acceptPatch/rejectPatch, so the semantics
 * are identical to the native diff; the panel closes once the patch is
 * resolved (a cancelled reject prompt leaves it open). Closing the panel
 * by hand drops its patch entry.
 */
export function openSplitDiffViewer(
  options: OpenPatchOptions,
  host: PatchReviewHost,
  extensionUri: vscode.Uri,
): string {
  const id = `patch-${randomBytes(6).toString('hex')}`;
  const patch: PatchData = {
    id,
    file: options.file,
    original: options.original,
    proposed: options.proposed,
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
  patches.set(id, patch);
  const panel = vscode.window.createWebviewPanel(
    'omnexxSplitDiff',
    `${options.file} (split diff)`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'out'),
      ],
    },
  );
  panel.webview.html = splitDiffHtml(panel.webview, extensionUri);
  panel.webview.onDidReceiveMessage((m: { type?: unknown } & Record<string, unknown>) => {
    const type = typeof m.type === 'string' ? m.type : '';
    void (async () => {
      try {
        if (type === 'ready') {
          await panel.webview.postMessage({
            type: 'diff',
            id,
            file: patch.file,
            original: patch.original,
            proposed: patch.proposed,
          });
        } else if (type === 'accept') {
          await acceptPatch(id);
          if (!patches.has(id)) panel.dispose();
        } else if (type === 'reject') {
          await rejectPatch(id, host);
          if (!patches.has(id)) panel.dispose();
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `omnexx: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });
  panel.onDidDispose(() => {
    patches.delete(id);
  });
  return id;
}

/** Webview panel HTML: tokens.css first, then diff.css, then the diff bundle. */
function splitDiffHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const tokensCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tokens.css'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'diff.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'diff.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${tokensCss.toString()}">
<link rel="stylesheet" href="${css.toString()}">
<title>omnexx split diff</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js.toString()}"></script>
</body>
</html>`;
}

/** Validate a patch payload passed to omnexx.reviewDiff (e.g. from the chat). */
export function patchOptionsFromArg(arg: unknown): OpenPatchOptions | null {
  if (!arg || typeof arg !== 'object') return null;
  const o = arg as { file?: unknown; original?: unknown; proposed?: unknown; taskId?: unknown };
  if (
    typeof o.file !== 'string' ||
    typeof o.original !== 'string' ||
    typeof o.proposed !== 'string'
  )
    return null;
  return {
    file: o.file,
    original: o.original,
    proposed: o.proposed,
    ...(typeof o.taskId === 'string' ? { taskId: o.taskId } : {}),
  };
}

/** A patch id from a CodeLens argument, a { patchId } object, or the open diff editor. */
export function patchIdFromArg(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'patchId' in arg) {
    const id = (arg as { patchId?: unknown }).patchId;
    if (typeof id === 'string') return id;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? patchIdOf(active) : null;
}

/** The patch file on disk, relative to the workspace root unless absolute. */
function resolvePatchFile(file: string): vscode.Uri {
  if (isAbsolute(file)) return vscode.Uri.file(file);
  const folder = primaryFolder();
  if (!folder) throw new Error('Open a folder first: the patch file is relative to the workspace.');
  return vscode.Uri.file(join(folder, file));
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Close the open diff tabs for one patch (both sides share its id). */
async function closePatchEditors(id: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => [...g.tabs]);
  for (const tab of tabs) {
    const input = tab.input;
    if (typeof input !== 'object' || input === null) continue;
    if (input instanceof vscode.TabInputTextDiff) {
      if (patchIdOf(input.original) === id || patchIdOf(input.modified) === id)
        await vscode.window.tabGroups.close(tab);
    } else if (input instanceof vscode.TabInputText) {
      if (patchIdOf(input.uri) === id) await vscode.window.tabGroups.close(tab);
    }
  }
}

/**
 * Accept a patch from a CodeLens, the command palette, or the open diff editor.
 * A task patch delegates to the reviewApprove() CLI flow; otherwise the
 * proposed text is written to the file on disk (skipped when it already
 * matches). Either way the diff editors close.
 */
export async function acceptPatch(arg: unknown, done?: () => void): Promise<void> {
  const id = patchIdFromArg(arg);
  const patch = id ? patches.get(id) : undefined;
  if (!patch) throw new Error('Pick a patch diff to accept first.');
  if (patch.taskId) {
    const message = await reviewApprove(patch.taskId, primaryFolder());
    if (message) void vscode.window.showInformationMessage(`omnexx: ${message}`);
    done?.();
  } else {
    const uri = resolvePatchFile(patch.file);
    const current = await readFileText(uri);
    if (current !== patch.proposed) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(patch.proposed));
      void vscode.window.showInformationMessage(`omnexx: patch accepted — wrote ${patch.file}`);
    } else {
      void vscode.window.showInformationMessage(`omnexx: ${patch.file} already matches the patch`);
    }
  }
  await closePatchEditors(patch.id);
  patches.delete(patch.id);
}

/**
 * Reject a patch from a CodeLens, the command palette, or the open diff editor.
 * A task patch delegates to the reviewReject() CLI flow (asks for a reason);
 * otherwise the diff closes and a re-roll prompt goes to the chat. Cancelling
 * the reason prompt aborts the reject.
 */
export async function rejectPatch(
  arg: unknown,
  host: PatchReviewHost,
  done?: () => void,
): Promise<void> {
  const id = patchIdFromArg(arg);
  const patch = id ? patches.get(id) : undefined;
  if (!patch) throw new Error('Pick a patch diff to reject first.');
  if (patch.taskId) {
    const reason = await vscode.window.showInputBox({
      title: `omnexx: reject ${patch.taskId}`,
      prompt: 'Why is this patch rejected? (saved to learned_patterns)',
      placeHolder: 'e.g. duplicates the work in #412',
    });
    if (reason === undefined) return;
    const message = await reviewReject(patch.taskId, reason, primaryFolder());
    if (message) void vscode.window.showInformationMessage(`omnexx: ${message}`);
    done?.();
  } else {
    const reason = await vscode.window.showInputBox({
      title: `omnexx: reject patch for ${patch.file}`,
      prompt: 'Why reject this patch? (optional — included in the re-roll prompt)',
      placeHolder: 'e.g. too broad, keep the change minimal',
    });
    if (reason === undefined) return;
    const note = reason.trim() ? ` Reason: ${reason.trim()}` : '';
    host.postToChat(
      `The patch for ${patch.file} was rejected. Please re-roll it with a different approach.${note}`,
    );
    void vscode.window.showInformationMessage(
      `omnexx: re-roll requested in chat for ${patch.file}`,
    );
  }
  await closePatchEditors(patch.id);
  patches.delete(patch.id);
}
