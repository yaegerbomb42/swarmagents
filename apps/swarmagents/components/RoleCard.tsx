"use client";
import type { KeyboardEvent, MouseEvent } from "react";
import type { RoleDefinition } from "@/lib/roles";
import {
  permissionLabels,
  roleCategoryLabel,
  roleModelLabel,
  ROLE_MCP_SERVER_REGISTRY,
  ROLE_SKILL_REGISTRY,
  toolLabel,
} from "@/lib/roles";

// One role in the catalog. Kept presentational so the same card can be reused
// in the role manager, a picker, or a settings summary.

export interface RoleCardProps {
  role: RoleDefinition;
  /** Highlights the card (for selection-style pickers). */
  active?: boolean;
  onSelect?: (role: RoleDefinition) => void;
  /** "Edit" for custom roles, "Customize" for built-ins. */
  onEdit?: (role: RoleDefinition) => void;
  onDuplicate?: (role: RoleDefinition) => void;
  onDelete?: (role: RoleDefinition) => void;
}

const modelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--color-text-faint)",
  margin: "4px 0 0",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const actionsStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginTop: "auto",
  paddingTop: 8,
  flexWrap: "wrap",
} as const;

export function RoleCard({ role, active, onSelect, onEdit, onDuplicate, onDelete }: RoleCardProps) {
  const permissions = permissionLabels(role.permissions);
  const visibleTools = role.tools.slice(0, 6);
  const remaining = role.tools.length - visibleTools.length;
  const mcpServers = role.mcpServers.map((id) => ROLE_MCP_SERVER_REGISTRY[id]?.label ?? id);
  const skills = role.skills.map((id) => ROLE_SKILL_REGISTRY[id]?.label ?? id);
  const interactive = Boolean(onSelect);

  const select = () => onSelect?.(role);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    select();
  };

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <article
      className="st-card"
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`${role.name} role`}
      aria-pressed={interactive ? Boolean(active) : undefined}
      onClick={interactive ? select : undefined}
      onKeyDown={onKeyDown}
      style={{
        height: "100%",
        cursor: interactive ? "pointer" : undefined,
        position: "relative",
        borderColor: active ? "var(--color-ok)" : undefined,
        boxShadow: active ? "0 0 0 2px var(--color-bg-elevated), 0 0 0 4px var(--color-ok)" : undefined,
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -7,
            right: -7,
            zIndex: 1,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--color-ok)",
            color: "var(--color-bg)",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 0 0 2px var(--color-bg-elevated)",
          }}
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )}
      <div className="st-card-top">
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              display: "grid",
              placeItems: "center",
              width: 24,
              height: 24,
              flexShrink: 0,
              borderRadius: 7,
              border: "1px solid var(--color-line)",
              background: "var(--color-bg-sunken)",
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            {role.glyph}
          </span>
          <span className="st-card-name">{role.name}</span>
        </span>
        <span className="st-badge">{role.builtin ? "Built-in" : "Custom"}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
        <span className="st-badge" title="Catalog category">{roleCategoryLabel(role.category)}</span>
        <span className="st-badge" title="Model">{roleModelLabel(role.model)}</span>
      </div>

      <p className="st-card-blurb" style={{ margin: "4px 0 0", WebkitLineClamp: 2 }}>
        {role.description || "No description."}
      </p>

      <div className="st-toollist" aria-label="Permissions" title={permissions.join(", ") || "No permissions"}>
        {permissions.length ? permissions.map((label) => <span key={label}>{label}</span>) : <span>no permissions</span>}
      </div>

      <div className="st-toollist" aria-label="Allowed tools" title={role.tools.map(toolLabel).join(", ") || "No tools"}>
        {visibleTools.map((name) => (
          <span key={name}>{toolLabel(name)}</span>
        ))}
        {remaining > 0 && <span title={role.tools.slice(visibleTools.length).map(toolLabel).join(", ")}>+{remaining}</span>}
        {!role.tools.length && <span>no tools</span>}
      </div>

      {mcpServers.length > 0 && (
        <div className="st-toollist" aria-label="MCP servers" title={`MCP: ${mcpServers.join(", ")}`}>
          {mcpServers.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}

      {skills.length > 0 && (
        <div className="st-toollist" aria-label="Skills" title={`Skills: ${skills.join(", ")}`}>
          {skills.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}

      {(onEdit || onDuplicate || onDelete) && (
        <div style={actionsStyle} onClick={stop}>
          {onEdit && (
            <button type="button" className="st-mini" onClick={() => onEdit(role)}>
              {role.builtin ? "Customize" : "Edit"}
            </button>
          )}
          {onDuplicate && (
            <button type="button" className="st-mini" onClick={() => onDuplicate(role)}>
              Duplicate
            </button>
          )}
          {onDelete && !role.builtin && (
            <button type="button" className="st-mini" style={{ color: "var(--color-err)" }} onClick={() => onDelete(role)}>
              Delete
            </button>
          )}
        </div>
      )}
    </article>
  );
}
