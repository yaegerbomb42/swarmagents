import { BUILTIN_ROLES, ROLE_ALIASES } from './builtin-roles.js';
import { mergeRole } from './merge.js';
import { validateRole } from './validate.js';
import type { RoleDefinition } from './types.js';

export interface ResolveOptions {
  /** Unused; kept for compatibility with the first draft of this API. */
  keepUnknownTools?: boolean;
}

/**
 * A registry of declarative roles. Built-ins are pre-registered.
 * Custom roles loaded from YAML / JSON may extend built-ins or each
 * other; the registry resolves ancestry at `get()` time with cycle
 * detection. `coder` is an alias of `implementer` unless a custom role
 * is registered under that id.
 */
export class RoleRegistry {
  private readonly defs = new Map<string, RoleDefinition>();
  /** Previous definition for an id, used when a custom role extends its own id. */
  private readonly superseded = new Map<string, RoleDefinition>();
  private readonly resolved = new Map<string, RoleDefinition>();
  private readonly resolving = new Set<string>();

  constructor() {
    for (const r of BUILTIN_ROLES) {
      this.defs.set(r.id, r);
    }
  }

  private canonicalId(id: string): string {
    if (this.defs.has(id)) return id;
    return ROLE_ALIASES[id] ?? id;
  }

  /** Register a raw definition (unresolved). Overwrites an existing id, including aliases. */
  register(def: RoleDefinition): void {
    const previous = this.defs.get(def.id);
    if (previous && def.extends === def.id) {
      this.superseded.set(def.id, previous);
    } else {
      this.superseded.delete(def.id);
    }
    this.defs.set(def.id, def);
    this.resolved.delete(def.id);
    // Drop cached aliases that pointed at this id, and this id's previous resolution.
    for (const [alias, target] of Object.entries(ROLE_ALIASES)) {
      if (target === def.id || alias === def.id) this.resolved.delete(alias);
    }
  }

  /** True if a definition or built-in alias with this id exists. */
  has(id: string): boolean {
    return this.defs.has(id) || (ROLE_ALIASES[id] !== undefined && this.defs.has(ROLE_ALIASES[id]));
  }

  /** List every registered id (aliases are not listed unless registered). */
  list(): string[] {
    return [...this.defs.keys()];
  }

  /** Get the fully-resolved role, following aliases, or undefined if not found. */
  get(id: string, opts?: ResolveOptions): RoleDefinition | undefined {
    const key = this.canonicalId(id);
    const cached = this.resolved.get(key);
    if (cached) return cached;

    const raw = this.defs.get(key);
    if (!raw) return undefined;

    const resolved = this.resolve(raw, new Set(), opts);
    if (resolved) this.resolved.set(key, resolved);
    return resolved;
  }

  /** Resolve a definition with its ancestry, detecting cycles. */
  private resolve(
    def: RoleDefinition,
    seen: Set<string>,
    opts?: ResolveOptions,
  ): RoleDefinition | undefined {
    if (this.resolved.has(def.id)) return this.resolved.get(def.id);
    if (seen.has(def.id)) throw new RoleCycleError([...seen, def.id]);

    if (!def.extends) {
      const v = validateRole(def);
      if (!v.valid) throw new RoleValidationError(def.id, v.errors);
      return def;
    }

    seen.add(def.id);
    if (this.resolving.has(def.id)) throw new RoleCycleError([...seen]);
    this.resolving.add(def.id);

    try {
      // A custom role may `extends` its own id to override a built-in (or the
      // previously registered version) without creating a cycle. The previous
      // version is resolved against a fresh seen-set because it shares this id.
      let resolvedParent: RoleDefinition | undefined;
      if (def.extends === def.id) {
        const previous = this.superseded.get(def.id);
        if (!previous) throw new RoleParentError(def.id, def.extends);
        resolvedParent = previous.extends ? this.resolve(previous, new Set(), opts) : previous;
      } else {
        const parent = this.defs.get(this.canonicalId(def.extends));
        if (!parent) throw new RoleParentError(def.id, def.extends);
        resolvedParent = this.resolve(parent, seen, opts);
      }
      if (!resolvedParent) throw new RoleParentError(def.id, def.extends);

      const merged = mergeRole(resolvedParent, def);
      const v = validateRole(merged);
      if (!v.valid) throw new RoleValidationError(merged.id, v.errors);
      this.resolved.set(merged.id, merged);
      return merged;
    } finally {
      this.resolving.delete(def.id);
      seen.delete(def.id);
    }
  }

  /** Bulk register, typically after file loading. Later entries overwrite earlier ones. */
  registerMany(defs: readonly RoleDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  /** Clear all custom registrations (built-ins remain). */
  reset(): void {
    this.defs.clear();
    this.superseded.clear();
    this.resolved.clear();
    for (const r of BUILTIN_ROLES) {
      this.defs.set(r.id, r);
    }
  }
}

export class RoleCycleError extends Error {
  constructor(readonly chain: readonly string[]) {
    super(`Role inheritance cycle detected: ${chain.join(' -> ')}`);
    this.name = 'RoleCycleError';
  }
}

export class RoleParentError extends Error {
  constructor(
    readonly roleId: string,
    readonly parentId: string,
  ) {
    super(`Role "${roleId}" extends unknown parent "${parentId}"`);
    this.name = 'RoleParentError';
  }
}

export class RoleValidationError extends Error {
  constructor(
    readonly roleId: string,
    readonly errors: readonly string[],
  ) {
    super(`Role "${roleId}" validation failed: ${errors.join('; ')}`);
    this.name = 'RoleValidationError';
  }
}
