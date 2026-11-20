import { Level4Engine } from "./kernel_l4.ts";
import { Level3Engine } from "./kernel_l3.ts";
import { Level2Engine } from "./kernel_l2.ts";
import { ASTNode } from '../parser.ts';
import { AGLValue, ExecutionContext, HookOverride } from './context.ts';
import { L0_PRIMITIVES } from './kernel_l0.ts';
import { Parser } from '../parser.ts';

export interface UserFunction {
  params: string[];
  body: ASTNode;
  closureCtx: ExecutionContext;
}

export class Evaluator {
  private functions = new Map<string, UserFunction>();
  private l2Engine = new Level2Engine(this);
  private l3Engine = new Level3Engine(this);
  private l4Engine = new Level4Engine(this);

  constructor(private readonly registry?: Map<string, ASTNode>) {}

  public registerFn(name: string, fn: UserFunction): void {
    this.functions.set(name, fn);
  }

  public async evaluate(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue> {
    ctx.currentDepth++;
    if (ctx.currentDepth > ctx.maxDepth) {
      ctx.currentDepth--;
      throw new Error(`Execution call stack depth limit (${ctx.maxDepth}) exceeded`);
    }

    try {
      if (node.type === 'LITERAL') {
        return node.value ?? null;
      }

      if (node.type === 'VARIABLE') {
        const name = String(node.value);
        return ctx.get(name);
      }

      if (node.type === 'HASH_REFERENCE') {
        const hash = node.hash;
        if (this.registry && this.registry.has(hash)) {
          const targetNode = this.registry.get(hash)!;
          return this.evaluate(targetNode, ctx);
        }
        throw new Error(`Referenced AST hash not found in registry: sha256:${hash}`);
      }

      if (node.type === 'EXPRESSION') {
        const level = node.level ?? 0;
        const op = node.op ?? 'noop';
        const qualifiedOp = `lvl:${level}:${op}`;

        // --- SPECIAL FORMS (LAZY EVALUATION / CONTROL FLOW) ---

        // (lvl:0:if cond t f) -> evaluate condition first, then ONLY the matching branch!
        if (level === 0 && op === 'if') {
          if (!node.args || node.args.length < 2) return null;
          const condVal = await this.evaluate(node.args[0], ctx);
          if (Boolean(condVal)) {
            return await this.evaluate(node.args[1], ctx);
          } else if (node.args.length >= 3) {
            return await this.evaluate(node.args[2], ctx);
          }
          return null;
        }

        // (lvl:0:while cond body) -> Professional Turing-Complete Loop
        // Production mode (maxIterations == 0): Unbounded native execution
        // Sandboxed/Eval mode: Governed by gasLimit or maxIterations to prevent denial-of-service
        if (level === 0 && op === 'while') {
          if (!node.args || node.args.length < 2) return null;
          const condNode = node.args[0];
          const bodyNode = node.args[1];
          let lastVal: AGLValue = null;
          let loopCount = 0;

          while (Boolean(await this.evaluate(condNode, ctx))) {
            loopCount++;
            if (ctx.gasLimit > 0) {
              ctx.gasUsed += 1;
              if (ctx.gasUsed > ctx.gasLimit) {
                throw new Error(`OutOfGasError: Execution halted after consuming ${ctx.gasUsed} gas units`);
              }
            } else if (ctx.maxIterations > 0 && loopCount > ctx.maxIterations) {
              throw new Error(`IterationLimitExceeded: while-loop exceeded configured bound of ${ctx.maxIterations} iterations`);
            }
            lastVal = await this.evaluate(bodyNode, ctx);
          }
          return lastVal;
        }

        // (lvl:0:fn (p1 p2 ...) body) or (lvl:0:def name (p1 p2 ...) body)
        if (level === 0 && (op === 'fn' || op === 'def')) {
          if (!node.args || node.args.length < 2) throw new Error('Invalid fn/def syntax');
          let fnName = '';
          let paramNodes: ASTNode[] = [];
          let bodyNode: ASTNode;

          let rawParams: ASTNode;
          if (op === 'def') {
            fnName = String(node.args[0].value);
            rawParams = node.args[1];
            bodyNode = node.args[2];
          } else {
            rawParams = node.args[0];
            bodyNode = node.args[1];
          }

          const params: string[] = [];
          if (rawParams.op) params.push(rawParams.op);
          if (rawParams.args) {
            for (const a of rawParams.args) {
              if (a.value !== undefined) params.push(String(a.value));
              else if (a.op) params.push(a.op);
            }
          }
          const fnObj: UserFunction = {
            params,
            body: bodyNode,
            closureCtx: ctx.clone()
          };

          if (fnName) {
            this.registerFn(fnName, fnObj);
            ctx.set(fnName, fnName);
            return fnName;
          }
          return fnObj as any;
        }

        // (lvl:0:call fn_name arg1 arg2 ...) -> Invoke user defined closure/function
        if (level === 0 && op === 'call') {
          if (!node.args || node.args.length < 1) throw new Error('Call requires function name');
          const fnTarget = await this.evaluate(node.args[0], ctx);
          const fnName = typeof fnTarget === 'string' ? fnTarget : String(node.args[0].value);
          const fn = this.functions.get(fnName);
          if (!fn) throw new Error(`Unknown user function in lvl:0:call: ${fnName}`);

          const callCtx = fn.closureCtx.clone();
          for (let i = 0; i < fn.params.length; i++) {
            const argVal = (i + 1 < node.args.length) ? await this.evaluate(node.args[i + 1], ctx) : null;
            callCtx.set(fn.params[i], argVal);
          }
          return await this.evaluate(fn.body, callCtx);
        }

        // (lvl:0:block e1 e2 e3 ...) -> Sequential evaluation of expressions in child scope
        if (level === 0 && op === 'block') {
          let lastVal: AGLValue = null;
          if (node.args) {
            for (const step of node.args) {
              lastVal = await this.evaluate(step, ctx);
            }
          }
          return lastVal;
        }

        // (lvl:1:modify target spec hash)
        if (level === 1 && op === 'modify') {
          return this.handleL1Modify(node, ctx);
        }

        // --- LEVEL 2 ENGINE DISPATCH ---
        if (level === 2) {
          if (op === 'pipeline') return await this.l2Engine.executePipeline(node, ctx);
          if (op === 'parallel') return await this.l2Engine.executeParallel(node, ctx);
          if (op === 'fan_out') return await this.l2Engine.executeFanOut(node, ctx);
          if (op === 'swarm_consensus') return await this.l2Engine.executeSwarmConsensus(node, ctx);
        }

        // --- LEVEL 3 ACTUATION & ENVIRONMENT DISPATCH ---
        if (level === 3) {
          if (op === 'render_ui') return await this.l3Engine.executeRenderUI(node, ctx);
          if (op === 'agent_dispatch') return await this.l3Engine.executeAgentDispatch(node, ctx);
          if (op === 'host_fs') return await this.l3Engine.executeHostFS(node, ctx);
          if (op === 'fetch') return await this.l3Engine.executeFetch(node, ctx);
        }

        // --- LEVEL 4 AUTONOMOUS GENESIS & SELF-HOSTING DISPATCH ---
        if (level === 4) {
          if (op === 'synthesize_module') return await this.l4Engine.executeSynthesizeModule(node, ctx);
          if (op === 'fuzz_and_verify') return await this.l4Engine.executeFuzzAndVerify(node, ctx);
          if (op === 'self_host_patch') return await this.l4Engine.executeSelfHostPatch(node, ctx);
        }

        // Evaluate arguments left-to-right for standard operators
        const evaluatedArgs: AGLValue[] = [];
        if (node.args) {
          for (const argNode of node.args) {
            evaluatedArgs.push(await this.evaluate(argNode, ctx));
          }
        }

        // Interceptor hooks
        if (!ctx.isHookActive(qualifiedOp)) {
          const hooks = ctx.getHooks(qualifiedOp);
          if (hooks.length > 0) {
            ctx.setHookActive(qualifiedOp, true);
            try {
              return await this.executeHookChain(hooks, qualifiedOp, evaluatedArgs, ctx);
            } finally {
              ctx.setHookActive(qualifiedOp, false);
            }
          }
        }

        // Direct user function call syntax: (my_fn 10 20)
        if (this.functions.has(op)) {
          const fn = this.functions.get(op)!;
          const callCtx = fn.closureCtx.clone();
          for (let i = 0; i < fn.params.length; i++) {
            callCtx.set(fn.params[i], evaluatedArgs[i] ?? null);
          }
          return await this.evaluate(fn.body, callCtx);
        }

        // L0 Primitive execution
        if (level === 0) {
          const prim = L0_PRIMITIVES[op];
          if (!prim) {
            throw new Error(`Undefined Level 0 primitive: ${op}`);
          }
          return await prim(evaluatedArgs, ctx);
        }

        // Registry alias lookup (e.g. lvl:2:square_and_add)
        if (this.registry) {
          const alias = this.registry.get(node.hash);
          if (alias) {
            return await this.evaluate(alias, ctx);
          }
        }

        throw new Error(`Unresolved operation: ${qualifiedOp}`);
      }

      return null;
    } finally {
      ctx.currentDepth--;
    }
  }

  private async executeHookChain(
    hooks: HookOverride[],
    qualifiedOp: string,
    args: AGLValue[],
    ctx: ExecutionContext
  ): Promise<AGLValue> {
    let index = 0;
    const next = async (): Promise<AGLValue> => {
      if (index < hooks.length) {
        const hook = hooks[index++];
        return hook.handler(args, ctx, next);
      }
      const parts = qualifiedOp.split(':');
      const op = parts[parts.length - 1];
      const baseFn = L0_PRIMITIVES[op];
      if (baseFn) {
        return baseFn(args, ctx);
      }
      throw new Error(`Base execution failed for ${qualifiedOp}`);
    };
    return next();
  }

  private async handleL1Modify(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue> {
    const rawTarget = node.args?.[0]?.value || '';
    const rawSpec = node.args?.[1]?.value || '';
    const rawHash = node.args?.[2]?.value || '';
    const targetOp = String(rawTarget);
    const spec = String(rawSpec);
    const verificationHash = String(rawHash);

    const parser = new Parser(spec);
    const parsedSpecAST = parser.parse();

    const override: HookOverride = {
      spec,
      verificationHash,
      handler: async (args, subCtx, next) => {
        const childCtx = subCtx.clone();
        childCtx.set('$args', args);
        childCtx.set('$a', args[0] ?? null);
        childCtx.set('$b', args[1] ?? null);
        childCtx.set('$next', async () => next());
        return this.evaluate(parsedSpecAST, childCtx);
      }
    };

    ctx.registerHook(targetOp, override);
    return true;
  }

  private async handleL2Pipeline(node: ASTNode, ctx: ExecutionContext): Promise<AGLValue> {
    let currentInput: AGLValue = null;
    if (node.args) {
      for (const step of node.args) {
        if (currentInput !== null) {
          ctx.set('$in', currentInput);
        }
        currentInput = await this.evaluate(step, ctx);
      }
    }
    return currentInput;
  }
}
