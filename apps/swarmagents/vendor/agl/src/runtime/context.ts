export type AGLValue = string | number | boolean | null | AGLValue[] | Record<string, any>;

export interface HookOverride {
  spec: string;
  verificationHash: string;
  handler: (args: AGLValue[], context: ExecutionContext, next: () => Promise<AGLValue>) => Promise<AGLValue>;
}

export class ExecutionContext {
  private variables: Map<string, AGLValue> = new Map();
  private hookTable: Map<string, HookOverride[]> = new Map();
  private activeHooks: Set<string> = new Set();
  public maxDepth = 2000;
  public currentDepth = 0;
  public maxIterations: number = 0; // 0 = unlimited / production mode
  public gasLimit: number = 0;       // 0 = unlimited, >0 = strict gas meter
  public gasUsed: number = 0;

  constructor(parent?: ExecutionContext) {
    if (parent) {
      this.variables = new Map(parent.variables);
      for (const [k, v] of parent.hookTable.entries()) {
        this.hookTable.set(k, [...v]);
      }
      this.activeHooks = new Set(parent.activeHooks);
      this.maxDepth = parent.maxDepth;
      this.currentDepth = parent.currentDepth;
    }
  }

  public clone(): ExecutionContext {
    return new ExecutionContext(this);
  }

  public get(name: string): AGLValue {
    if (this.variables.has(name)) {
      return this.variables.get(name)!;
    }
    return null;
  }

  public set(name: string, value: AGLValue): void {
    this.variables.set(name, value);
  }

  public registerHook(targetOp: string, override: HookOverride): void {
    const list = this.hookTable.get(targetOp) || [];
    list.unshift(override);
    this.hookTable.set(targetOp, list);
  }

  public getHooks(targetOp: string): HookOverride[] {
    return this.hookTable.get(targetOp) || [];
  }

  public isHookActive(targetOp: string): boolean {
    return this.activeHooks.has(targetOp);
  }

  public setHookActive(targetOp: string, active: boolean): void {
    if (active) {
      this.activeHooks.add(targetOp);
    } else {
      this.activeHooks.delete(targetOp);
    }
  }
}
