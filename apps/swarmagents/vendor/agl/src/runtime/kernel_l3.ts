import { ASTNode } from '../parser.ts';
import { AGLValue, ExecutionContext } from './context.ts';
import { Evaluator } from './evaluator.ts';
import { KeyRotator } from '../llm/key_rotator.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export class Level3Engine {
  private rotator: KeyRotator | null = null;

  constructor(private evaluator: Evaluator) {}

  private getRotator(): KeyRotator {
    if (!this.rotator) {
      this.rotator = new KeyRotator('qwen/qwen3.8-27b', 2);
    }
    return this.rotator;
  }

  /**
   * (lvl:3:render_ui target_layout state_dict)
   * Produces an interactive, self-contained HTML/SVG Generative UI dashboard
   * Example: (lvl:3:render_ui "dashboard" (lvl:0:dict "agents" 14 "status" "HEALTHY"))
   */
  public async executeRenderUI(node: ASTNode, ctx: ExecutionContext): Promise<Record<string, any>> {
    if (!node.args || node.args.length < 1) throw new Error('render_ui requires target layout');
    
    const layout = String(await this.evaluator.evaluate(node.args[0], ctx));
    const state = node.args.length > 1 ? await this.evaluator.evaluate(node.args[1], ctx) : {};

    const stateJson = JSON.stringify(state, null, 2);
    const htmlWidget = `
<div class="agl-ui-widget" data-layout="${layout}" style="font-family: monospace; background: #0a0d14; color: #00ffcc; padding: 20px; border-radius: 8px; border: 1px solid #00ffcc33;">
  <div style="font-size: 14px; font-weight: bold; border-bottom: 1px solid #00ffcc33; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between;">
    <span>⚡ AGL RECURSIVE SUBSTRATE // ${layout.toUpperCase()}</span>
    <span style="color: #66ff66;">● LIVE SYNC</span>
  </div>
  <div class="agl-state-view">
    <pre style="margin: 0; font-size: 12px; color: #88ccff; overflow-x: auto;">${stateJson}</pre>
  </div>
</div>`.trim();

    return {
      ui_type: 'GENERATIVE_WIDGET',
      layout,
      state,
      rendered_html: htmlWidget,
      timestamp: Date.now()
    };
  }

  /**
   * (lvl:3:agent_dispatch role prompt_input)
   * Invokes an autonomous LLM swarm agent directly from within AGL code using the 14 Groq keys!
   */
  public async executeAgentDispatch(node: ASTNode, ctx: ExecutionContext): Promise<string> {
    if (!node.args || node.args.length < 2) throw new Error('agent_dispatch requires role and prompt');
    
    const role = String(await this.evaluator.evaluate(node.args[0], ctx));
    const promptInput = String(await this.evaluator.evaluate(node.args[1], ctx));

    const rotator = this.getRotator();
    const systemPrompt = `You are an autonomous sub-agent acting as: ${role}. Respond with clean, concise, high-density machine telemetry.`;

    const response = await rotator.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: promptInput }
    ], 0.1, 1024);

    return response.trim();
  }

  /**
   * (lvl:3:host_fs action path content)
   * Sandboxed file I/O operations (read, write, exists)
   */
  public async executeHostFS(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue> {
    if (!node.args || node.args.length < 2) throw new Error('host_fs requires action and path');
    
    const action = String(await this.evaluator.evaluate(node.args[0], ctx));
    const targetPath = String(await this.evaluator.evaluate(node.args[1], ctx));

    // Security guard: restrict paths to repository or brain
    const isAllowed = targetPath.startsWith('/Users/dev/swarmagents') || targetPath.startsWith('/Users/dev/.gemini');
    if (!isAllowed) {
      throw new Error(`Capability Security Violation: Path '${targetPath}' outside allowed workspace sandbox`);
    }

    if (action === 'exists') {
      return existsSync(targetPath);
    }
    if (action === 'read') {
      return existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : null;
    }
    if (action === 'write') {
      const content = node.args.length > 2 ? String(await this.evaluator.evaluate(node.args[2], ctx)) : '';
      writeFileSync(targetPath, content, 'utf-8');
      return true;
    }

    throw new Error(`Unknown host_fs action: ${action}`);
  }

  /**
   * (lvl:3:fetch url method headers body)
   * Secure capability HTTP client for external telemetry or webhooks
   */
  public async executeFetch(node: ASTNode, ctx: ExecutionContext): Promise<Record<string, any>> {
    if (!node.args || node.args.length < 1) throw new Error('fetch requires URL');
    
    const url = String(await this.evaluator.evaluate(node.args[0], ctx));
    const method = node.args.length > 1 ? String(await this.evaluator.evaluate(node.args[1], ctx)) : 'GET';
    const bodyVal = node.args.length > 3 ? await this.evaluator.evaluate(node.args[3], ctx) : undefined;

    try {
      const resp = await fetch(url, {
        method,
        headers: { 'User-Agent': 'AGL-HostBridge/1.0', 'Content-Type': 'application/json' },
        body: bodyVal ? JSON.stringify(bodyVal) : undefined
      });
      const text = await resp.text();
      let parsedData: any = text;
      try { parsedData = JSON.parse(text); } catch {}

      return {
        status: resp.status,
        ok: resp.ok,
        data: parsedData
      };
    } catch (err: any) {
      return {
        status: 500,
        ok: false,
        error: err.message
      };
    }
  }
}
