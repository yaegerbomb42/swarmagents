import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Loader2, LogOut, Plus, Sparkles, Trash2, X, Zap,
} from 'lucide-react';
import {
  type ActiveRole, type ApiFormat, MAX_ROLES, MIN_ROLES, PROVIDERS, type ProviderConfig, ROLES, uid,
} from '../data';
import { callProvider } from '../engine';
import { RoleIcon } from './RoleIcon';
import { ComputersSettings } from './ComputersSettings';
import { AutopilotIdle } from './AutopilotIdle';
import { removeRole, moveRole } from '../utils/pipeline';
import { parseBudgetInput } from '../utils/budget';
import { DEFAULT_MASCOT_VARIANT, MASCOT_VARIANTS, type MascotVariant } from '../../../components/mascot/variant';

type Tab = 'general' | 'providers' | 'agent' | 'computers' | 'appearance' | 'account' | 'memory';
export type SettingsTab = Tab;
const DEFAULT_TABS: Tab[] = ['general', 'providers', 'computers', 'appearance', 'account', 'memory'];
const NO_ROLES: ActiveRole[] = [];
const keepRoles = () => {};
type Accent = 'cyan' | 'emerald' | 'violet';

/** Total providers configured for this user: BYO providers saved in this
 *  browser plus providers configured on their account on the server. The
 *  server count is what the tab used to miss, reading "0" while the account
 *  had providers configured. */
export function countConfiguredProviders(localCount: number, serverConfiguredCount: number) {
  return localCount + serverConfiguredCount;
}

/* Active-tab / toggle accent per selection — full class literals so Tailwind picks them up. */
const ACCENTS: Record<Accent, { tab: string; toggleOn: string; swatchRing: string; swatch: string }> = {
  cyan: { tab: 'bg-cyan-400 text-black', toggleOn: 'bg-cyan-400', swatchRing: 'ring-cyan-400/70', swatch: 'bg-cyan-400' },
  emerald: { tab: 'bg-emerald-400 text-black', toggleOn: 'bg-emerald-400', swatchRing: 'ring-emerald-400/70', swatch: 'bg-emerald-400' },
  violet: { tab: 'bg-violet-400 text-black', toggleOn: 'bg-violet-400', swatchRing: 'ring-violet-400/70', swatch: 'bg-violet-400' },
};
const ACCENT_OPTIONS: { id: Accent; name: string }[] = [
  { id: 'cyan', name: 'Cyan' },
  { id: 'emerald', name: 'Emerald' },
  { id: 'violet', name: 'Violet' },
];
type AccentStyle = (typeof ACCENTS)[Accent];

export function Settings({
  open,
  onClose,
  providers,
  setProviders,
  serverProviderCount = 0,
  roles = NO_ROLES,
  setRoles = keepRoles,
  mascotVariant = DEFAULT_MASCOT_VARIANT,
  onMascotVariantChange,
  embedded,
  tabs = DEFAULT_TABS,
  initialTab,
  agentPanel,
}: {
  open: boolean;
  onClose: () => void;
  providers: ProviderConfig[];
  setProviders: (fn: (p: ProviderConfig[]) => ProviderConfig[]) => void;
  /** Providers configured on the user's account on the server (per-account
   *  keys). Counted in the tab label alongside the BYO providers below. */
  serverProviderCount?: number;
  /** The legacy agent pipeline (General tab). Optional: the workspace does not show that tab. */
  roles?: ActiveRole[];
  setRoles?: (fn: (r: ActiveRole[]) => ActiveRole[]) => void;
  /** Which Jimmy renderer the main page shows. */
  mascotVariant?: MascotVariant;
  onMascotVariantChange?: (variant: MascotVariant) => void;
  /**
   * Render inline inside the settings drawer (minimal main page). No backdrop
   * and no fixed positioning; `open` is ignored in this mode.
   */
  embedded?: boolean;
  /** Which tabs to show, in order. Defaults to the classic set. */
  tabs?: Tab[];
  /** The tab selected when the panel mounts. Defaults to the first of `tabs`. */
  initialTab?: Tab;
  /** Content of the 'agent' tab: the run settings the workspace supplies. */
  agentPanel?: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? tabs[0] ?? 'general');
  const [accent, setAccent] = useState<Accent>('cyan');
  const [showHelpers, setShowHelpers] = useState(true);
  const a = ACCENTS[accent];

  // Close on Escape while open (embedded mode: the drawer owns Escape close).
  useEffect(() => {
    if (!open && !embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, embedded, onClose]);

  // Unmounted when closed: a translated-off-screen panel would leave its
  // text in the page DOM (and innerText) while "closed".
  if (!open && !embedded) return null;

  const panel = (
      <aside
        className={
          embedded
            ? 'flex h-full min-h-0 flex-col overflow-hidden'
            : 'glass fixed inset-y-3 right-3 z-50 flex w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-3xl'
        }
      >
        {/* Sticky header: title, close, tabs — stays put while content scrolls beneath. */}
        <div className={embedded ? 'sticky top-0 z-10 border-b border-sa-line bg-sa-panel pb-3' : 'sticky top-0 z-10 border-b border-white/[0.06] bg-[#0a0a0d]/85 backdrop-blur-xl'}>
          {/* Embedded: the sheet that hosts this panel already has the title and close button. */}
          {!embedded && <div className="flex items-center justify-between px-5 pt-5">
            <div className="flex items-center gap-2 text-sm font-medium tracking-wide text-white/90">
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
              Settings
            </div>
            <button onClick={onClose} aria-label="Close settings" className="rounded-full p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60">
              <X className="h-4 w-4" />
            </button>
          </div>}
          <div role="tablist" aria-label="Settings sections" className={embedded ? 'mx-4 mt-3 flex gap-0.5 rounded-[10px] border border-sa-line bg-sa-bg p-0.5' : 'mx-5 mt-4 flex gap-1 rounded-full bg-white/5 p-1 ring-1 ring-white/10'}>
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                data-testid={`settings-tab-${t}`}
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                title={
                  t === 'providers'
                    ? 'Your configured providers — saved in this browser plus your account on the server'
                    : t === 'memory'
                      ? 'The long-term memory your agent keeps for your account'
                      : undefined
                }
                className={embedded
                  ? `h-8 flex-1 truncate rounded-lg px-1 text-[13px] font-medium capitalize transition-colors ${tab === t ? 'bg-sa-hover text-sa-fg' : 'text-sa-fg2 hover:text-sa-fg'}`
                  : `flex-1 truncate rounded-full py-1.5 text-xs capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
                  tab === t ? a.tab : 'text-white/60 hover:text-white'
                }`}
              >
                {t === 'providers' ? `Providers · ${countConfiguredProviders(providers.length, serverProviderCount)}` : t === 'computers' ? 'Computers' : t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5 scrollbar-thin">
          {tab === 'general' && <General roles={roles} setRoles={setRoles} providers={providers} setProviders={setProviders} showHelpers={showHelpers} />}
          {tab === 'providers' && <Providers providers={providers} setProviders={setProviders} accent={a} showHelpers={showHelpers} serverProviderCount={serverProviderCount} />}
          {tab === 'agent' && agentPanel}
          {tab === 'computers' && <ComputersSettings />}
          {tab === 'appearance' && <Appearance accent={accent} setAccent={setAccent} showHelpers={showHelpers} setShowHelpers={setShowHelpers} mascotVariant={mascotVariant} onMascotVariantChange={onMascotVariantChange} />}
          {tab === 'account' && <Account />}
          {tab === 'memory' && <Memory />}
        </div>
      </aside>
  );

  if (embedded) return panel;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
      />
      {panel}
    </>
  );
}

/* ---------------- General (agent pipeline) ---------------- */

function General({
  roles,
  setRoles,
  providers,
  setProviders,
  showHelpers,
}: {
  roles: ActiveRole[];
  setRoles: (fn: (r: ActiveRole[]) => ActiveRole[]) => void;
  providers: ProviderConfig[];
  setProviders: (fn: (p: ProviderConfig[]) => ProviderConfig[]) => void;
  showHelpers: boolean;
}) {
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [dragPreset, setDragPreset] = useState<string | null>(null);
  const [overGap, setOverGap] = useState<number | null>(null);
  const [overLib, setOverLib] = useState(false);
  const [capHit, setCapHit] = useState(false);
  const full = roles.length >= MAX_ROLES;
  const defaultProv = providers.find((p) => p.enabled)?.uid ?? 'sim';
  const listRef = useRef<HTMLDivElement>(null);

  const flashCap = useCallback(() => {
    setCapHit(true);
    const t = setTimeout(() => setCapHit(false), 1200);
    return () => clearTimeout(t);
  }, []);

  const addPreset = (id: string) => {
    const preset = ROLES.find((r) => r.id === id);
    if (!preset) return;
    setRoles((l) => {
      if (l.length >= MAX_ROLES) return l;
      return [...l, { ...preset, uid: uid(), providerUid: defaultProv }];
    });
  };

  const addPresetAt = (id: string, at: number) => {
    if (roles.length >= MAX_ROLES) {
      flashCap();
      return;
    }
    const preset = ROLES.find((r) => r.id === id);
    if (!preset) return;
    setRoles((l) => {
      if (l.length >= MAX_ROLES) return l;
      const n = [...l];
      n.splice(Math.min(at, n.length), 0, { ...preset, uid: uid(), providerUid: defaultProv });
      return n;
    });
  };

  const remove = (u: string) => setRoles((l) => removeRole(l, u));
  const moveUp = (u: string) =>
    setRoles((l) => {
      const idx = l.findIndex((r) => r.uid === u);
      if (idx <= 0) return l;
      return moveRole(l, u, idx - 1);
    });
  const moveDown = (u: string) =>
    setRoles((l) => {
      const idx = l.findIndex((r) => r.uid === u);
      if (idx < 0 || idx >= l.length - 1) return l;
      return moveRole(l, u, idx + 2);
    });

  /* ---- pointer-based drag-and-drop (mouse + touch) ----
   * Mouse: grab anywhere on a row/card. Touch: only the grip handle starts a
   * drag, so the panel can still scroll from the rest of the row. Pipeline rows
   * can be dropped onto a row boundary (gap between rows) to reorder, or drag
   * to the library zone to remove. Library cards drag into the pipeline the
   * same way. */
  const handlePointerDown = (e: React.PointerEvent, kind: 'row' | 'library', id: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, select')) return;
    if (e.pointerType === 'touch' && !target.closest('[data-grip]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (kind === 'row') {
      setDragUid(id);
    } else if (!full) {
      setDragPreset(id);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragUid && !dragPreset) return;
    e.preventDefault();
    const list = listRef.current;
    if (!list) return;
    // Nearest row boundary (top/bottom edge) defines the drop gap.
    const children = Array.from(list.children) as HTMLElement[];
    let gap: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const dTop = Math.abs(e.clientY - rect.top);
      if (dTop < bestDist) {
        bestDist = dTop;
        gap = i;
      }
      const dBottom = Math.abs(e.clientY - rect.bottom);
      if (dBottom < bestDist) {
        bestDist = dBottom;
        gap = i + 1;
      }
    }
    setOverGap(gap);

    // Hit-test the library zone (drag here to remove).
    const libEl = document.getElementById('role-library-zone');
    if (libEl) {
      const r = libEl.getBoundingClientRect();
      setOverLib(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
    }
  };

  const endDrag = () => {
    setDragUid(null);
    setDragPreset(null);
    setOverGap(null);
    setOverLib(false);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragUid) {
      e.preventDefault();
      if (overLib) {
        remove(dragUid);
      } else if (overGap !== null && overGap >= 0) {
        setRoles((l) => moveRole(l, dragUid, overGap));
      }
    } else if (dragPreset && !overLib) {
      e.preventDefault();
      if (overGap !== null && overGap >= 0) {
        addPresetAt(dragPreset, overGap);
      }
    }
    endDrag();
  };

  return (
    <div className="space-y-6">
      <AutopilotIdle />
      <section>
        <div className="mb-2 flex items-center justify-between">
          <Label className="mb-0">Agent roles</Label>
          <span className={`font-mono text-[10px] ${roles.length < MIN_ROLES ? 'text-amber-300/80' : capHit ? 'text-red-300/80' : 'text-white/40'}`}>
            {roles.length}/{MAX_ROLES} {roles.length < MIN_ROLES && `· add ${MIN_ROLES - roles.length} more`}
          </span>
        </div>
        {capHit && (
          <div className="mb-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300/80 ring-1 ring-red-400/20">
            Pipeline is full ({MAX_ROLES}/{MAX_ROLES}). Remove a role before adding another.
          </div>
        )}
        <div
          ref={listRef}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={endDrag}
          className={`min-h-28 space-y-1.5 rounded-2xl border border-dashed p-2 transition ${
            dragUid || dragPreset ? 'border-white/40 bg-white/[0.06]' : 'border-white/10'
          }`}
        >
          {roles.length === 0 && (
            <div className="grid h-24 place-items-center text-xs text-white/35">
              Add roles from the library below
            </div>
          )}
          {roles.map((r, i) => {
            const dropHere = overGap !== null && (dragUid || dragPreset) && dragUid !== r.uid && (i === overGap || i === overGap - 1);
            return (
            <div
              key={r.uid}
              onPointerDown={(e) => handlePointerDown(e, 'row', r.uid)}
              className={`group flex cursor-grab items-center gap-2 rounded-xl bg-white/[0.05] px-2.5 py-2 ring-1 ring-white/10 transition select-none ${
                dragUid === r.uid ? 'opacity-40' : ''
              } ${dropHere ? 'ring-white/30 bg-white/[0.08]' : ''}`}
            >
              <span
                data-grip
                className="flex shrink-0 cursor-grab active:cursor-grabbing"
                style={{ touchAction: 'none' }}
              >
                <GripVertical className="h-3.5 w-3.5 text-white/25" />
              </span>
              <span className="w-4 shrink-0 font-mono text-[10px] text-white/30">{i + 1}</span>
              <div
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                style={{ background: `hsl(${r.hue} 70% 60% / .14)`, color: `hsl(${r.hue} 85% 75%)` }}
              >
                <RoleIcon name={r.icon} className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-white/90">{r.name}</div>
                <div className="truncate text-[10px] text-white/35">
                  {i === 0 ? 'runs first' : i === roles.length - 1 && roles.length > 2 ? 'runs last · sees all' : 'parallel'}
                </div>
              </div>
              <select
                value={providers.some((p) => p.uid === r.providerUid) ? r.providerUid : 'sim'}
                onChange={(e) =>
                  setRoles((l) => l.map((x) => (x.uid === r.uid ? { ...x, providerUid: e.target.value } : x)))
                }
                onMouseDown={(e) => e.stopPropagation()}
                title="Live · your VM runs use the live VM runtime. Dispatch failures are reported as errors; they never fall back to text-only or simulated completion."
                className="max-w-28 shrink-0 truncate rounded-lg bg-black/25 px-2 py-1 text-[10px] text-white/70 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
              >
                {/* The 'sim' value is the live VM runtime, not a simulation.
                    A failed dispatch is an error and never starts a local
                    fallback that could look like completed VM work. */}
                <option value="sim">Live · your VM</option>
                {providers.map((p) => (
                  <option key={p.uid} value={p.uid} disabled={!p.enabled}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => moveUp(r.uid)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="rounded-md p-1 text-white/30 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  onClick={() => moveDown(r.uid)}
                  disabled={i === roles.length - 1}
                  aria-label="Move down"
                  className="rounded-md p-1 text-white/30 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-20"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
                <button
                  onClick={() => remove(r.uid)}
                  aria-label="Remove role"
                  className="rounded-md p-1 text-white/30 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            );
          })}
        </div>
      </section>

      <section>
        <Label>
          Role library{' '}
          {full && <span className="normal-case tracking-normal text-white/30">· pipeline full</span>}
        </Label>
        <div
          id="role-library-zone"
          className={`grid grid-cols-2 gap-1.5 rounded-2xl p-1 transition sm:grid-cols-3 ${
            overLib && (dragUid || dragPreset) ? 'bg-red-500/5 ring-1 ring-red-400/20' : ''
          }`}
        >
          {ROLES.map((r) => {
            const count = roles.filter((x) => x.id === r.id).length;
            return (
              <div
                key={r.id}
                data-grip
                onPointerDown={(e) => handlePointerDown(e, 'library', r.id)}
                className={`group relative flex select-none flex-col items-start gap-1.5 rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/[0.07] transition hover:bg-white/[0.08] focus-within:ring-2 focus-within:ring-cyan-400/60 ${
                  dragPreset === r.id ? 'opacity-60' : ''
                } ${full ? '' : 'cursor-grab active:cursor-grabbing'}`}
              >
                <div className="flex w-full items-center gap-2">
                  <RoleIcon name={r.icon} className="h-3.5 w-3.5" />
                  <span className="text-xs text-white/85">{r.name}</span>
                  {count > 0 && (
                    <span className="ml-auto font-mono text-[9px] text-white/40">×{count}</span>
                  )}
                </div>
                {showHelpers && (
                  <span className="text-[10px] leading-tight text-white/35">{r.blurb}</span>
                )}
                <button
                  onClick={() => {
                    if (full) {
                      flashCap();
                    } else {
                      addPreset(r.id);
                    }
                  }}
                  aria-label={`Add ${r.name}`}
                  className={`absolute right-2 top-2 flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50 ring-1 ring-white/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
                    full
                      ? 'cursor-not-allowed opacity-30 hover:bg-white/5 hover:text-white/50'
                      : 'hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
            );
          })}
        </div>
        {showHelpers && (
          <p className="mt-3 text-[11px] text-white/30">
            Click <strong>Add</strong> to insert a role, drag to reorder, or drag to the library to remove.
          </p>
        )}
      </section>

      <DangerZone
        title="Reset settings"
        description="Clears the agent pipeline, configured providers and appearance preferences from this browser."
        onAction={() => {
          setRoles(() => []);
          setProviders(() => []);
        }}
      />

      <p className="text-center text-[11px] text-white/25">Press ? anywhere for keyboard shortcuts.</p>
    </div>
  );
}

/* ---------------- Providers ---------------- */

/** Server-held provider row (GET /api/providers) — never contains keys. */
interface ServerProviderRow {
  id: string;
  label?: string;
  keyCount: number;
  enabled: boolean;
  isFree: boolean;
  apiStyle?: string;
  baseUrl?: string;
  authScheme?: string;
  authHeaderName?: string;
  headerNames?: string[];
  needsKey?: boolean;
  model?: string;
  models?: string[];
  availableModels?: string[];
  capabilities?: Record<string, { vision: boolean; tools: boolean; computerUse: boolean; contextWindow?: number }>;
  capabilityOverrides?: string[];
  inputPricePer1mTokens?: number;
  outputPricePer1mTokens?: number;
  quotaCoolingDownUntil?: number;
}

type BillingPatch = {
  isFree?: boolean;
  inputPricePer1mTokens?: number;
  outputPricePer1mTokens?: number;
};

const fmtQuotaTime = (until: number): string => {
  const d = new Date(until);
  return `~${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function Providers({
  providers,
  setProviders,
  accent,
  showHelpers,
  serverProviderCount = 0,
}: {
  providers: ProviderConfig[];
  setProviders: (fn: (p: ProviderConfig[]) => ProviderConfig[]) => void;
  accent: AccentStyle;
  showHelpers: boolean;
  serverProviderCount?: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preferFree, setPreferFree] = useState<boolean | null>(null);
  const [injectCodebaseContext, setInjectCodebaseContext] = useState<boolean | null>(null);
  const [allowPaidProviders, setAllowPaidProviders] = useState<boolean>(false);
  const [perRunBudget, setPerRunBudget] = useState<string>('');
  const [perDayBudget, setPerDayBudget] = useState<string>('');
  const [todaySpend, setTodaySpend] = useState<number | null>(null);
  const [spendingError, setSpendingError] = useState<string | null>(null);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>('http://127.0.0.1:11434');
  const [serverRows, setServerRows] = useState<ServerProviderRow[] | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Load server-side routing preference + provider rows (quota cooldowns,
  // free flags, prices) once. Silent when unreachable — the local flow still
  // works without the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settingsRes = await fetch('/api/providers/settings', { headers: { Accept: 'application/json' } });
        if (settingsRes.ok && !cancelled) {
          const body = (await settingsRes.json()) as {
            preferFreeProviders?: unknown;
            injectCodebaseContext?: unknown;
            ollamaBaseUrl?: unknown;
            allowPaidProviders?: unknown;
            perRunBudgetUsd?: unknown;
            perDayBudgetUsd?: unknown;
          };
          if (typeof body.preferFreeProviders === 'boolean') setPreferFree(body.preferFreeProviders);
          if (typeof body.injectCodebaseContext === 'boolean') setInjectCodebaseContext(body.injectCodebaseContext);
          if (typeof body.ollamaBaseUrl === 'string') setOllamaBaseUrl(body.ollamaBaseUrl);
          if (typeof body.allowPaidProviders === 'boolean') {
            setAllowPaidProviders(body.allowPaidProviders);
          } else {
            setAllowPaidProviders(false);
          }
          if (typeof body.perRunBudgetUsd === 'number') {
            setPerRunBudget(String(body.perRunBudgetUsd));
          } else {
            setPerRunBudget('');
          }
          if (typeof body.perDayBudgetUsd === 'number') {
            setPerDayBudget(String(body.perDayBudgetUsd));
          } else {
            setPerDayBudget('');
          }
        }
      } catch {
        // offline / unsigned — leave the toggle hidden
      }
      try {
        const usageRes = await fetch('/api/runtime/usage?days=1', { headers: { Accept: 'application/json' } });
        if (usageRes.ok && !cancelled) {
          const usageBody = (await usageRes.json()) as {
            days?: Array<{ date: string; costUsd: number }>;
          };
          if (Array.isArray(usageBody.days) && usageBody.days.length > 0) {
            setTodaySpend(usageBody.days[0]?.costUsd ?? 0);
          } else {
            setTodaySpend(0);
          }
        }
      } catch {
        // usage endpoint optional/unreachable
      }
      try {
        const res = await fetch('/api/providers', { headers: { Accept: 'application/json' } });
        if (res.ok && !cancelled) {
          const body = (await res.json()) as { providers?: unknown };
          if (Array.isArray(body.providers)) setServerRows(body.providers as ServerProviderRow[]);
        }
      } catch {
        // offline / unsigned — leave rows hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const saveRouterSettings = async (patch: {
    allowPaidProviders?: boolean;
    perRunBudgetUsd?: number | null;
    perDayBudgetUsd?: number | null;
  }) => {
    setSpendingError(null);
    try {
      const res = await fetch('/api/providers/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setSpendingError(err.error || 'Could not save spending settings.');
        return false;
      }
      return true;
    } catch {
      setSpendingError('Could not save spending settings.');
      return false;
    }
  };

  const setPreferFreeRemote = async (v: boolean) => {
    setSettingsError(null);
    try {
      const res = await fetch('/api/providers/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferFreeProviders: v }),
      });
      if (!res.ok) {
        setSettingsError('Could not save routing preference.');
        return;
      }
      setPreferFree(v);
    } catch {
      setSettingsError('Could not save routing preference.');
    }
  };

  const setInjectCodebaseContextRemote = async (v: boolean) => {
    setSettingsError(null);
    try {
      const res = await fetch('/api/providers/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ injectCodebaseContext: v }),
      });
      if (!res.ok) {
        setSettingsError('Could not save codebase context setting.');
        return;
      }
      setInjectCodebaseContext(v);
    } catch {
      setSettingsError('Could not save codebase context setting.');
    }
  };

  const patchServerBilling = async (id: string, patch: BillingPatch, row?: ServerProviderRow) => {
    setSettingsError(null);
    let body: Record<string, unknown>;
    if ('isFree' in patch) {
      // Shorthand {isFree: bool} is understood by the server mutation.
      body = { isFree: patch.isFree };
    } else {
      // set-prices needs both numbers; inherit the row's other side.
      body = {
        action: 'set-prices',
        inputPricePer1mTokens: patch.inputPricePer1mTokens ?? row?.inputPricePer1mTokens ?? 0,
        outputPricePer1mTokens: patch.outputPricePer1mTokens ?? row?.outputPricePer1mTokens ?? 0,
      };
    }
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setSettingsError('Could not update provider billing.');
        return;
      }
      setServerRows((rows) =>
        (rows ?? []).map((r) =>
          r.id === id
            ? {
                ...r,
                ...('isFree' in patch ? { isFree: Boolean(patch.isFree) } : {}),
                ...(patch.inputPricePer1mTokens !== undefined ? { inputPricePer1mTokens: patch.inputPricePer1mTokens } : {}),
                ...(patch.outputPricePer1mTokens !== undefined ? { outputPricePer1mTokens: patch.outputPricePer1mTokens } : {}),
              }
            : r,
        ),
      );
    } catch {
      setSettingsError('Could not update provider billing.');
    }
  };

  const add = (presetId: string) => {
    const p = PROVIDERS.find((x) => x.id === presetId)!;
    const cfg: ProviderConfig = {
      uid: uid(), presetId, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '', format: p.format, color: p.color, enabled: true,
    };
    setProviders((l) => [...l, cfg]);
    setExpanded(cfg.uid);
  };

  const patch = (id: string, v: Partial<ProviderConfig>) => setProviders((l) => l.map((x) => (x.uid === id ? { ...x, ...v } : x)));

  return (
    <div className="space-y-6">
      {preferFree !== null && (
        <section>
          <div className="space-y-2 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-white/85">Prefer free providers</div>
                <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                  Route LLM calls through providers marked free before paid ones (rank order is kept inside each group).
                </div>
              </div>
              <Toggle on={preferFree} onChange={(v) => void setPreferFreeRemote(v)} accent={accent} />
            </div>
            {injectCodebaseContext !== null && (
              <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2">
                <div>
                  <div className="text-xs text-white/85">Inject codebase context</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                    Auto-prepend the repo codebase map/context pack to each run (token budget enforced).
                  </div>
                </div>
                <Toggle on={injectCodebaseContext} onChange={(v) => void setInjectCodebaseContextRemote(v)} accent={accent} />
              </div>
            )}
            {settingsError && <div className="mt-2 text-[10px] text-red-300/80">{settingsError}</div>}
          </div>
        </section>
      )}

      <section data-testid="settings-spending-section">
        <Label>Spending</Label>
        <div className="space-y-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-white/85">Allow paid providers</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                Allow providers not marked free when no free provider is usable.
              </div>
            </div>
            <Toggle
              on={allowPaidProviders}
              onChange={(v) => {
                setAllowPaidProviders(v);
                void saveRouterSettings({ allowPaidProviders: v });
              }}
              accent={accent}
            />
          </div>

          {allowPaidProviders && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-300/90 ring-1 ring-amber-500/20">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>Paid providers are enabled. LLM calls may incur charges based on your configured provider rates.</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">Per-run budget (USD)</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="No cap"
                value={perRunBudget}
                data-testid="spending-per-run-budget"
                onChange={(e) => {
                  const val = e.target.value;
                  setPerRunBudget(val);
                  const parsed = parseBudgetInput(val);
                  if (parsed.valid) {
                    setSpendingError(null);
                    void saveRouterSettings({ perRunBudgetUsd: parsed.value });
                  } else {
                    setSpendingError(parsed.error ?? 'Invalid per-run budget');
                  }
                }}
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 transition placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
              />
              <span className="mt-1 block text-[10px] text-white/30">Blank = no cap, validated &ge; 0</span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">Per-day budget (USD)</span>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="No cap"
                value={perDayBudget}
                data-testid="spending-per-day-budget"
                onChange={(e) => {
                  const val = e.target.value;
                  setPerDayBudget(val);
                  const parsed = parseBudgetInput(val);
                  if (parsed.valid) {
                    setSpendingError(null);
                    void saveRouterSettings({ perDayBudgetUsd: parsed.value });
                  } else {
                    setSpendingError(parsed.error ?? 'Invalid per-day budget');
                  }
                }}
                className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 transition placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
              />
              <span className="mt-1 block text-[10px] text-white/30">Blank = no cap, validated &ge; 0</span>
            </label>
          </div>

          <div className="flex items-center justify-between border-t border-white/10 pt-2 text-[11px] text-white/40">
            <span>Today&apos;s spend:</span>
            <span className="font-mono text-xs text-white/85" data-testid="spending-today-spend">
              ${(todaySpend ?? 0).toFixed(2)}
              {perDayBudget.trim() !== '' && !Number.isNaN(Number(perDayBudget)) && Number(perDayBudget) >= 0 ? (
                <span className="text-white/40"> / ${Number(perDayBudget).toFixed(2)} cap</span>
              ) : (
                <span className="text-white/40"> (no daily cap)</span>
              )}
            </span>
          </div>

          {spendingError && (
            <div data-testid="spending-error" className="mt-1 text-[11px] text-red-400">
              {spendingError}
            </div>
          )}
        </div>
      </section>

      {serverRows && serverRows.length > 0 && (
        <section>
          <Label>Server providers · free &amp; quota</Label>
          <div className="space-y-2">
            {serverRows.map((row) => (
              <div key={row.id} className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-white/85">{row.id}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-white/35">
                      {row.keyCount} key{row.keyCount === 1 ? '' : 's'}
                      {row.quotaCoolingDownUntil
                        ? ` · out of free usage until ${fmtQuotaTime(row.quotaCoolingDownUntil)}`
                        : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[10px] ${row.isFree ? 'text-emerald-300/80' : 'text-white/35'}`}>
                      {row.isFree ? 'free' : 'paid'}
                    </span>
                    <Toggle on={row.isFree} onChange={(v) => void patchServerBilling(row.id, { isFree: v }, row)} accent={accent} />
                  </div>
                </div>
                {row.inputPricePer1mTokens !== undefined && row.outputPricePer1mTokens !== undefined && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <NumberField
                        label="$/1M in"
                        value={row.inputPricePer1mTokens}
                        onChange={(v) => void patchServerBilling(row.id, { inputPricePer1mTokens: v }, row)}
                      />
                    </div>
                    <div>
                      <NumberField
                        label="$/1M out"
                        value={row.outputPricePer1mTokens}
                        onChange={(v) => void patchServerBilling(row.id, { outputPricePer1mTokens: v }, row)}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <ServerEndpoints
        rows={serverRows ?? []}
        accent={accent}
        initialOllamaUrl={ollamaBaseUrl}
        onChanged={() => setReloadTick((t) => t + 1)}
      />

      <section>
        <Label>Add provider</Label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => add(p.id)}
              className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs text-white/70 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
              {p.name}
              <Plus className="h-3 w-3 opacity-50" />
            </button>
          ))}
        </div>
      </section>

      <section>
        <Label>Configured</Label>
        {serverProviderCount > 0 && (
          <p className="mb-2 text-[11px] leading-relaxed text-white/40">
            {serverProviderCount} provider{serverProviderCount === 1 ? '' : 's'} configured on your account —
            runs use the live VM runtime and your server providers. Manage them on the Providers page.
          </p>
        )}
        {providers.length === 0 && serverProviderCount === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
            No providers yet — runs use the live VM runtime.
          </div>
        )}
        <div className="space-y-2">
          {providers.map((p) => (
            <ProviderCard
              key={p.uid}
              p={p}
              accent={accent}
              open={expanded === p.uid}
              toggle={() => setExpanded(expanded === p.uid ? null : p.uid)}
              patch={(v) => patch(p.uid, v)}
              remove={() => setProviders((l) => l.filter((x) => x.uid !== p.uid))}
              showHelpers={showHelpers}
            />
          ))}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-white/30">
          Keys are stored per-account on the server, encrypted at rest. Any OpenAI-compatible API works via &quot;Custom endpoint&quot;.
        </p>
      </section>

      <DangerZone
        title="Remove all providers"
        description="Deletes every provider saved in this browser. Server providers on your account are unaffected — remove those on the Providers page."
        onAction={() => setProviders(() => [])}
        disabled={providers.length === 0}
      />
    </div>
  );
}

const API_STYLES: { id: string; name: string }[] = [
  { id: 'openai-chat', name: 'OpenAI Chat Completions' },
  { id: 'openai-responses', name: 'OpenAI Responses' },
  { id: 'anthropic', name: 'Anthropic Messages' },
  { id: 'gemini', name: 'Gemini generateContent' },
  { id: 'ollama', name: 'Ollama native' },
];

const AUTH_SCHEMES: { id: string; name: string }[] = [
  { id: 'bearer', name: 'Bearer token' },
  { id: 'x-api-key', name: 'x-api-key header' },
  { id: 'x-goog-api-key', name: 'x-goog-api-key' },
  { id: 'custom-header', name: 'Custom header' },
  { id: 'basic', name: 'Basic auth' },
  { id: 'none', name: 'No auth' },
];

interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  capabilities?: { vision: boolean; tools: boolean; computerUse: boolean; contextWindow?: number };
}

interface EndpointDraft {
  id: string;
  apiStyle: string;
  baseUrl: string;
  model: string;
  models: string;
  apiKey: string;
  authScheme: string;
  authHeaderName: string;
  headersText: string;
  ollamaUrl: string;
}

const splitList = (value: string): string[] =>
  value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

const parseHeaderLines = (value: string): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (name) out[name] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

function ServerEndpoints({
  rows,
  accent,
  initialOllamaUrl,
  onChanged,
}: {
  rows: ServerProviderRow[];
  accent: AccentStyle;
  initialOllamaUrl: string;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<EndpointDraft>({
    id: '',
    apiStyle: 'openai-chat',
    baseUrl: '',
    model: '',
    models: '',
    apiKey: '',
    authScheme: 'bearer',
    authHeaderName: '',
    headersText: '',
    ollamaUrl: initialOllamaUrl,
  });
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [capBusy, setCapBusy] = useState<string | null>(null);

  useEffect(() => {
    setDraft((d) => ({ ...d, ollamaUrl: initialOllamaUrl }));
  }, [initialOllamaUrl]);

  const patch = (v: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...v }));

  const wireBody = () => {
    const auth: Record<string, string> = { scheme: draft.authScheme };
    if (draft.authScheme === 'custom-header') auth.headerName = draft.authHeaderName || 'Authorization';
    const headers = parseHeaderLines(draft.headersText);
    return {
      id: draft.id.trim() || (draft.apiStyle === 'ollama' ? 'ollama' : 'custom'),
      apiStyle: draft.apiStyle,
      auth,
      ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(splitList(draft.models).length > 0 ? { models: splitList(draft.models) } : {}),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(headers ? { headers } : {}),
    };
  };

  const call = async (path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return { ok: res.ok, data };
  };

  const discover = async (body: Record<string, unknown> = wireBody(), label = 'discover') => {
    setBusy(label);
    setResult(null);
    try {
      const { ok, data } = await call('/api/providers/discover', body);
      if (!ok) {
        setResult({ ok: false, text: String(data.error ?? 'Discovery failed.') });
        return;
      }
      const models = Array.isArray(data.models) ? (data.models as DiscoveredModel[]) : [];
      setDiscovered(models);
      if (models.length > 0 && splitList(draft.models).length === 0) {
        patch({ models: models.map((m) => m.id).join('\n') });
      }
      setResult({
        ok: true,
        text: `Found ${models.length} model${models.length === 1 ? '' : 's'}${data.persisted ? ' · saved' : ''}.`,
      });
      if (data.persisted) onChanged();
    } catch {
      setResult({ ok: false, text: 'Could not reach the discovery endpoint.' });
    } finally {
      setBusy(null);
    }
  };

  // A saved Ollama endpoint is probed as soon as the tab opens so its
  // installed models (and capabilities) are registered without another click.
  // Failures stay silent: the explicit Detect button reports them.
  const autoDetected = useRef(false);
  useEffect(() => {
    if (autoDetected.current) return;
    const row = rows.find((r) => r.apiStyle === 'ollama');
    if (!row) return;
    autoDetected.current = true;
    if ((row.availableModels?.length ?? 0) > 0) return;
    setBusy(`auto:${row.id}`);
    void (async () => {
      try {
        const { ok, data } = await call('/api/providers/discover', {
          id: row.id,
          apiStyle: 'ollama',
          baseUrl: row.baseUrl ?? initialOllamaUrl,
          models: row.models,
        });
        if (ok && Array.isArray(data.models)) {
          const models = data.models as DiscoveredModel[];
          setDiscovered(models);
          if (data.persisted) onChanged();
        }
      } finally {
        setBusy(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const test = async (body: Record<string, unknown> = wireBody(), label = 'test') => {
    setBusy(label);
    setResult(null);
    try {
      const { ok, data } = await call('/api/providers/test', body);
      if (!ok || data.ok === false) {
        setResult({ ok: false, text: String(data.error ?? 'Connection test failed.') });
        return;
      }
      const text = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : '(empty reply)';
      setResult({
        ok: true,
        text: `${String(data.model ?? 'model')} replied in ${Number(data.latencyMs ?? 0)}ms: ${text}`,
      });
    } catch {
      setResult({ ok: false, text: 'Could not reach the test endpoint.' });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setResult(null);
    try {
      const body = wireBody();
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setResult({ ok: false, text: String(data.error ?? 'Could not save the endpoint.') });
        return;
      }
      setResult({ ok: true, text: `Saved ${String(body.id)}.` });
      onChanged();
    } catch {
      setResult({ ok: false, text: 'Could not save the endpoint.' });
    } finally {
      setBusy(null);
    }
  };

  const detectOllama = async () => {
    setBusy('ollama');
    setResult(null);
    try {
      const baseUrl = draft.ollamaUrl.trim() || 'http://127.0.0.1:11434';
      const id = draft.id.trim() || 'ollama';
      await fetch('/api/providers/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ollamaBaseUrl: baseUrl }),
      });
      // Save the local endpoint first so discovery persists the installed
      // models (and their /api/show capabilities) as selectable models.
      await call('/api/providers', {
        id,
        apiStyle: 'ollama',
        auth: { scheme: 'none' },
        baseUrl,
      });
      patch({ apiStyle: 'ollama', baseUrl, id });
      await discover(
        { id, apiStyle: 'ollama', baseUrl, auth: { scheme: 'none' }, models: splitList(draft.models) },
        'ollama',
      );
      onChanged();
    } catch {
      setResult({ ok: false, text: 'Could not reach the Ollama endpoint.' });
      setBusy(null);
    }
  };

  const setCapability = async (
    row: ServerProviderRow,
    model: string,
    field: 'vision' | 'tools' | 'computerUse',
    value: boolean,
  ) => {
    const current = row.capabilities?.[model] ?? { vision: false, tools: true, computerUse: false };
    const next = {
      vision: field === 'vision' ? value : current.vision,
      tools: field === 'tools' ? value : current.tools,
      computerUse: field === 'computerUse' ? value : current.computerUse,
    };
    if (!next.vision || !next.tools) next.computerUse = false;
    setCapBusy(`${row.id}:${model}`);
    try {
      // Only explicit overrides are persisted; sending the merged preset map
      // would freeze today's guesses as if the user had chosen them.
      const overrides = Object.fromEntries(
        (row.capabilityOverrides ?? [])
          .map((id) => [id, row.capabilities?.[id]] as const)
          .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1])),
      );
      await fetch('/api/providers', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: row.id,
          action: 'set-capabilities',
          modelCapabilities: { ...overrides, [model]: next },
        }),
      });
      onChanged();
    } finally {
      setCapBusy(null);
    }
  };

  const detailsFor = (row: ServerProviderRow): string => {
    const bits = [row.apiStyle ?? 'openai-chat', row.authScheme ?? 'bearer'];
    if (row.needsKey === false) bits.push('no key');
    return bits.join(' · ');
  };

  return (
    <section data-testid="server-endpoints">
      <Label>Endpoints &amp; models</Label>
      <div className="space-y-2">
        {rows.map((row) => {
          const models = (row.availableModels && row.availableModels.length > 0
            ? row.availableModels
            : row.models ?? []
          ).slice(0, 60);
          return (
            <div key={row.id} className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs text-white/85">{row.label ?? row.id}</div>
                  <div className="truncate font-mono text-[10px] text-white/35">{row.baseUrl ?? row.id}</div>
                  <div className="truncate text-[10px] text-white/30">
                    {detailsFor(row)}
                    {row.authHeaderName ? ` (${row.authHeaderName})` : ''}
                    {(row.headerNames?.length ?? 0) > 0 ? ` · ${row.headerNames!.length} static header(s)` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() =>
                      void discover(
                        { id: row.id, apiStyle: row.apiStyle, baseUrl: row.baseUrl ?? '', models: row.models },
                        `discover:${row.id}`,
                      )
                    }
                    disabled={busy !== null}
                    className="rounded-lg bg-white/5 px-2 py-1 text-[10px] text-white/60 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
                  >
                    {busy === `discover:${row.id}` ? '…' : 'Refresh models'}
                  </button>
                  <button
                    onClick={() =>
                      void test(
                        { id: row.id, apiStyle: row.apiStyle, baseUrl: row.baseUrl, models: row.models, model: row.model },
                        `test:${row.id}`,
                      )
                    }
                    disabled={busy !== null}
                    className="rounded-lg bg-white/5 px-2 py-1 text-[10px] text-white/60 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
                  >
                    {busy === `test:${row.id}` ? '…' : 'Test'}
                  </button>
                </div>
              </div>
              {models.length > 0 && (
                <div className="mt-2 max-h-36 space-y-1 overflow-auto">
                  {models.map((model) => {
                    const caps = row.capabilities?.[model];
                    return (
                      <div key={model} className="flex items-center justify-between gap-2 rounded-lg bg-black/10 px-2 py-1">
                        <span className="truncate font-mono text-[10px] text-white/50">{model}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <CapCheck
                            label="vision"
                            on={caps?.vision === true}
                            disabled={capBusy === `${row.id}:${model}`}
                            onChange={(v) => void setCapability(row, model, 'vision', v)}
                          />
                          <CapCheck
                            label="tools"
                            on={caps?.tools === true}
                            disabled={capBusy === `${row.id}:${model}`}
                            onChange={(v) => void setCapability(row, model, 'tools', v)}
                          />
                          <CapCheck
                            label="computer"
                            on={caps?.computerUse === true}
                            disabled={capBusy === `${row.id}:${model}`}
                            onChange={(v) => void setCapability(row, model, 'computerUse', v)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-2 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
        <div className="text-xs text-white/85">Add or edit an endpoint</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Provider id" value={draft.id} onChange={(v) => patch({ id: v })} mono helper="Slug, e.g. my-gateway" testId="endpoint-id" />
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">API style</span>
            <select
              value={draft.apiStyle}
              onChange={(e) => patch({ apiStyle: e.target.value })}
              data-testid="endpoint-api-style"
              className="w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
            >
              {API_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <Field label="Base URL" value={draft.baseUrl} onChange={(v) => patch({ baseUrl: v })} mono helper="https for public hosts; http only for your local/BYOC node." testId="endpoint-base-url" />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">Auth</span>
            <select
              value={draft.authScheme}
              onChange={(e) => patch({ authScheme: e.target.value })}
              data-testid="endpoint-auth"
              className="w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
            >
              {AUTH_SCHEMES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <Field
            label={draft.authScheme === 'custom-header' ? 'Header name' : draft.authScheme === 'basic' ? 'user:password' : 'API key / token'}
            value={draft.authScheme === 'custom-header' ? draft.authHeaderName : draft.apiKey}
            onChange={(v) => patch(draft.authScheme === 'custom-header' ? { authHeaderName: v } : { apiKey: v })}
            mono
            helper={draft.authScheme === 'none' ? 'No credential is sent.' : 'Stored encrypted; never returned.'}
          />
        </div>
        <Field label="Default model" value={draft.model} onChange={(v) => patch({ model: v })} mono testId="endpoint-model" />
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">Models (one per line or comma-separated)</span>
          <textarea
            value={draft.models}
            onChange={(e) => patch({ models: e.target.value })}
            data-testid="endpoint-models"
            rows={3}
            className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-[11px] text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">Extra static headers (Name: value, one per line)</span>
          <textarea
            value={draft.headersText}
            onChange={(e) => patch({ headersText: e.target.value })}
            data-testid="endpoint-headers"
            rows={2}
            className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-[11px] text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
          />
        </label>

        <div className="rounded-xl bg-black/10 p-2 ring-1 ring-white/5">
          <div className="text-[10px] uppercase tracking-widest text-white/35">Ollama auto-detection</div>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={draft.ollamaUrl}
              onChange={(e) => patch({ ollamaUrl: e.target.value })}
              placeholder="http://127.0.0.1:11434"
              className="min-w-0 flex-1 rounded-lg bg-black/20 px-2 py-1.5 font-mono text-[11px] text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
            />
            <button
              onClick={() => void detectOllama()}
              disabled={busy !== null}
              data-testid="endpoint-ollama-detect"
              className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-[10px] text-white/75 ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-40"
            >
              {busy === 'ollama' ? 'Detecting…' : 'Detect'}
            </button>
          </div>
          <div className="mt-1 text-[10px] text-white/30">
            Calls /api/tags and /api/show to list installed models and detect vision, tools and context length.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void discover()}
              disabled={busy !== null}
              data-testid="endpoint-list"
              className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] text-white/70 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            >
              {busy === 'discover' ? 'Listing…' : 'List models'}
            </button>
            <button
              onClick={() => void test()}
              disabled={busy !== null}
              data-testid="endpoint-test"
              className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] text-white/70 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button
              onClick={() => void save()}
              disabled={busy !== null}
              data-testid="endpoint-save"
              className="rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/85 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-40"
            >
              {busy === 'save' ? 'Saving…' : 'Save endpoint'}
            </button>
          {discovered.length > 0 && (
            <span className="text-[10px] text-white/30">{discovered.length} discovered</span>
          )}
        </div>
        {result && (
          <div data-testid="endpoint-result" className={`text-[10px] ${result.ok ? 'text-emerald-300/80' : 'text-red-300/80'}`}>{result.text}</div>
        )}
      </div>
    </section>
  );
}

function CapCheck({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[9px] text-white/40">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-cyan-400"
      />
      {label}
    </label>
  );
}

function ProviderCard({
  p, accent, open, toggle, patch, remove, showHelpers,
}: {
  p: ProviderConfig;
  accent: AccentStyle;
  open: boolean;
  toggle: () => void;
  patch: (v: Partial<ProviderConfig>) => void;
  remove: () => void;
  showHelpers: boolean;
}) {
  const [show, setShow] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ state: 'idle' });
  const preset = PROVIDERS.find((x) => x.id === p.presetId);

  const runTest = async () => {
    setTest({ state: 'busy' });
    const ctrl = new AbortController();
    const t0 = performance.now();
    try {
      await callProvider(p, 'Reply with "ok".', 'ping', [], ctrl.signal);
      setTest({ state: 'ok', msg: `${Math.round(performance.now() - t0)}ms` });
    } catch (e) {
      setTest({ state: 'err', msg: (e as Error).message });
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl bg-white/[0.04] ring-1 ring-white/10">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="h-2 w-2 rounded-full" style={{ background: p.color, opacity: p.enabled ? 1 : 0.3 }} />
        <button onClick={toggle} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-white/90">{p.name}</div>
          <div className="truncate font-mono text-[10px] text-white/35">
            {p.model} {p.apiKey ? '· key set' : preset?.local ? '· local' : '· no key'}
          </div>
        </button>
        <Toggle on={p.enabled} onChange={(v) => patch({ enabled: v })} accent={accent} />
        <button onClick={toggle} className="p-1 text-white/40 hover:text-white">
          <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-white/5 px-4 py-4">
          <Field label="Display name" value={p.name} onChange={(v) => patch({ name: v })} helper={showHelpers ? 'How this provider appears across the app.' : undefined} />
          <Field label="Base URL" value={p.baseUrl} onChange={(v) => patch({ baseUrl: v })} mono helper={showHelpers ? 'Endpoint that receives API requests.' : undefined} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model" value={p.model} onChange={(v) => patch({ model: v })} mono helper={showHelpers ? 'Model identifier sent with each request.' : undefined} />
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">API format</span>
              <select
                value={p.format}
                onChange={(e) => patch({ format: e.target.value as ApiFormat })}
                className="w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
                <option value="cohere">Cohere v2</option>
              </select>
              {showHelpers && <span className="mt-1 block text-[10px] text-white/30">Protocol used to talk to this endpoint.</span>}
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">API key</span>
            <div className="flex items-center rounded-xl bg-black/20 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-cyan-400/60">
              <input
                type={show ? 'text' : 'password'}
                value={p.apiKey}
                placeholder={preset?.keyHint}
                onChange={(e) => patch({ apiKey: e.target.value })}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-xs text-white/85 placeholder:text-white/25 focus:outline-none"
              />
              <button onClick={() => setShow(!show)} className="px-3 text-white/40 hover:text-white">
                {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            {showHelpers && <span className="mt-1 block text-[10px] text-white/30">Stored per-account, encrypted server-side.</span>}
          </label>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={runTest}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
              {test.state === 'busy' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
              Test
            </button>
            {test.state === 'ok' && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-300/80">
                <Check className="h-3 w-3" /> {test.msg}
              </span>
            )}
            {test.state === 'err' && <span className="truncate text-[11px] text-red-300/80">{test.msg}</span>}
            <button onClick={remove} className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-white/40 hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60">
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Appearance ---------------- */

function Appearance({ accent, setAccent, showHelpers, setShowHelpers, mascotVariant, onMascotVariantChange }: { accent: Accent; setAccent: (a: Accent) => void; showHelpers: boolean; setShowHelpers: (v: boolean) => void; mascotVariant: MascotVariant; onMascotVariantChange?: (variant: MascotVariant) => void }) {
  const variantLabel: Record<MascotVariant, string> = { sprite: 'Sprite sheet', svg: 'SVG' };
  return (
    <div className="space-y-6">
      <section>
        <Label>Accent</Label>
        <div className="flex items-center gap-2.5">
          {ACCENT_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => setAccent(o.id)}
              aria-pressed={accent === o.id}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
                accent === o.id ? `bg-white/10 text-white ring-2 ${ACCENTS[o.id].swatchRing}` : 'bg-white/5 text-white/60 ring-1 ring-white/10 hover:bg-white/10 hover:text-white'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${ACCENTS[o.id].swatch}`} />
              {o.name}
              {accent === o.id && <Check className="h-3 w-3" />}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-white/30">Highlights the active tab and toggles in this panel.</p>
      </section>

      <section>
        <Label>Mascot style</Label>
        <div className="flex items-center gap-2.5">
          {MASCOT_VARIANTS.map((variant) => (
            <button
              key={variant}
              type="button"
              onClick={() => onMascotVariantChange?.(variant)}
              aria-pressed={mascotVariant === variant}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
                mascotVariant === variant ? `bg-white/10 text-white ring-2 ${ACCENTS[accent].swatchRing}` : 'bg-white/5 text-white/60 ring-1 ring-white/10 hover:bg-white/10 hover:text-white'
              }`}
            >
              {variantLabel[variant]}
              {mascotVariant === variant && <Check className="h-3 w-3" />}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-white/30">How Jimmy animates on the main page. You can also use ?mascot=svg or ?mascot=sprite in the URL.</p>
      </section>

      <section>
        <Label>Field hints</Label>
        <div className="rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-white/85">Show helper text</div>
              <div className="mt-0.5 text-[10px] text-white/35">Display the hint line under each input.</div>
            </div>
            <Toggle on={showHelpers} onChange={setShowHelpers} accent={ACCENTS[accent]} />
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Account ---------------- */

function Account() {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const res = await fetch('/api/logout', { method: 'POST' });
      if (res.ok) {
        window.location.href = '/login';
        return;
      }
      setSignOutError('Could not sign out.');
    } catch {
      setSignOutError('Could not sign out.');
    }
    setSigningOut(false);
  };

  // Show the signed-in account (per-account; never another user's data).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
        if (res.ok && !cancelled) {
          const body = (await res.json()) as { user?: { email?: string } | null };
          setEmail(body.user?.email ?? null);
        }
      } catch {
        // offline / unsigned — leave the address unknown
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/revoke-sessions', { method: 'POST' });
      if (!res.ok) {
        setError('Could not sign out everywhere.');
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setError('Could not sign out everywhere.');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <section>
        <Label>Account</Label>
        <div className="rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-white/85">{email ?? '…'}</div>
              <div className="mt-0.5 text-[10px] text-white/35">Signed into this device.</div>
            </div>
            <button
              onClick={() => void signOut()}
              disabled={signingOut}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {signingOut ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
              Sign out
            </button>
          </div>
          {signOutError && <div className="mt-2 text-[10px] text-red-300/80">{signOutError}</div>}
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-red-300/90">
          <LogOut className="h-3.5 w-3.5" /> Sign out everywhere
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/40">
          Revokes every session for this account — this browser and all other devices — so anyone holding a saved session must sign in again.
        </p>
        {done ? (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300/80">
            <Check className="h-3.5 w-3.5" /> Signed out everywhere. You&apos;ll need to sign in again on each device.
          </div>
        ) : (
          <>
            <button
              onClick={() => void revoke()}
              disabled={busy}
              className="mt-3 flex items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 py-1.5 text-xs text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
              Sign out everywhere
            </button>
            {error && <div className="mt-2 text-[10px] text-red-300/80">{error}</div>}
          </>
        )}
      </section>
    </div>
  );
}

/* ---------------- Long-term memory ---------------- */

/** One stored memory, as the settings screen sees it. */
type MemoryRow = {
  id: string;
  fact: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  score?: number;
};

const fmtWhen = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
};

function Memory() {
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async (q: string) => {
    try {
      const res = await fetch(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setError('Could not load your memories.');
        setMemories([]);
        return;
      }
      const body = (await res.json()) as { memories?: MemoryRow[] };
      setMemories(Array.isArray(body.memories) ? body.memories : []);
      setError(null);
    } catch {
      setError('Could not load your memories.');
      setMemories([]);
    }
  }, []);

  // The list is server-searched: the query is debounced so typing does not
  // hammer the API.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(query.trim());
    }, 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  const forget = async (id: string) => {
    try {
      await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      setError('Could not forget that memory.');
    }
    await load(query.trim());
  };

  const clearAll = async () => {
    try {
      await fetch('/api/memory', { method: 'DELETE' });
      setConfirmClear(false);
    } catch {
      setError('Could not clear your memories.');
    }
    await load('');
  };

  return (
    <div className="space-y-6" data-testid="memory-panel">
      <section>
        <Label>Long-term memory</Label>
        <p className="mb-3 text-[11px] leading-relaxed text-white/35">
          What your agent remembers between runs. The memories live in your account (outside the VM),
          so they survive a VM reset. Secrets are redacted before anything is stored.
        </p>
        <input
          data-testid="memory-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your memories…"
          aria-label="Search memories"
          className="w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 transition placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
        />
      </section>

      {error && <div className="text-[11px] text-red-300/80">{error}</div>}

      <section className="space-y-2">
        {memories === null ? (
          <div className="flex items-center gap-2 text-[11px] text-white/35">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading your memories…
          </div>
        ) : memories.length === 0 ? (
          <div
            data-testid="memory-empty"
            className="rounded-2xl bg-white/[0.03] p-4 text-[11px] leading-relaxed text-white/35 ring-1 ring-white/10"
          >
            {query.trim()
              ? 'No memory matches that search.'
              : 'Nothing remembered yet. Tell your agent a preference and it will remember it here.'}
          </div>
        ) : (
          memories.map((memory) => (
            <div
              key={memory.id}
              data-testid="memory-row"
              className="flex items-start gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs leading-relaxed text-white/85">{memory.fact}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-white/35">
                  {memory.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-white/5 px-2 py-0.5 ring-1 ring-white/10">
                      {tag}
                    </span>
                  ))}
                  <span>{fmtWhen(memory.updatedAt || memory.createdAt)}</span>
                </div>
              </div>
              <button
                data-testid="memory-delete"
                onClick={() => void forget(memory.id)}
                aria-label={`Forget memory: ${memory.fact}`}
                title="Forget this memory"
                className="rounded-full p-1.5 text-white/40 transition hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-red-300/90">
          <Trash2 className="h-3.5 w-3.5" /> Clear all
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/40">
          Forget every memory of this account. The agent starts from a clean slate.
        </p>
        {confirmClear ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              data-testid="memory-clear-confirm"
              onClick={() => void clearAll()}
              className="rounded-full bg-red-500/20 px-3.5 py-1.5 text-xs text-red-200 ring-1 ring-red-500/40 transition hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              Yes, clear everything
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="rounded-full bg-white/5 px-3.5 py-1.5 text-xs text-white/60 ring-1 ring-white/10 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
              Keep them
            </button>
          </div>
        ) : (
          <button
            data-testid="memory-clear"
            onClick={() => setConfirmClear(true)}
            disabled={!memories || memories.length === 0}
            className="mt-3 flex items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 py-1.5 text-xs text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
          >
            <Trash2 className="h-3 w-3" /> Clear all
          </button>
        )}
      </section>
    </div>
  );
}

/* ---------------- Danger zone ---------------- */

function DangerZone({
  title,
  description,
  onAction,
  disabled = false,
}: {
  title: string;
  description: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-red-300/90">
        <Trash2 className="h-3.5 w-3.5" /> Danger zone
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/40">{description}</p>
      <button
        onClick={onAction}
        disabled={disabled}
        className="mt-3 flex items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 py-1.5 text-xs text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
      >
        <Trash2 className="h-3 w-3" /> {title}
      </button>
    </section>
  );
}

/* ---------------- primitives ---------------- */

function Label({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mb-2 text-[10px] uppercase tracking-[0.2em] text-white/40 ${className}`}>{children}</div>;
}

function Field({ label, value, onChange, mono, helper, testId }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; helper?: string; testId?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className={`w-full rounded-xl bg-black/20 px-3 py-2 text-xs text-white/85 ring-1 ring-white/10 transition focus:outline-none focus:ring-2 focus:ring-cyan-400/60 ${mono ? 'font-mono' : ''}`}
      />
      {helper && <span className="mt-1 block text-[10px] text-white/30">{helper}</span>}
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-widest text-white/35">{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
        className="w-full rounded-xl bg-black/20 px-3 py-2 font-mono text-xs text-white/85 ring-1 ring-white/10 transition focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
      />
    </label>
  );
}

function Toggle({ on, onChange, accent }: { on: boolean; onChange?: (v: boolean) => void; accent?: AccentStyle }) {
  return (
    <button
      onClick={onChange ? () => onChange(!on) : undefined}
      aria-checked={on}
      role="switch"
      className={`relative h-5 w-9 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${on ? (accent ? accent.toggleOn : 'bg-white/80') : 'bg-white/15'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${on ? 'left-[18px] bg-black' : 'left-0.5 bg-white/70'}`} />
    </button>
  );
}
