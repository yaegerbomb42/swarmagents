import { AGLValue, ExecutionContext, HookOverride } from './context.ts';

export class ExecutionContextWithSuppression extends ExecutionContext {
  private activeHooks = new Set<string>();

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

  public override clone(): ExecutionContextWithSuppression {
    const next = new ExecutionContextWithSuppression(this);
    next.activeHooks = new Set(this.activeHooks);
    return next;
  }
}
