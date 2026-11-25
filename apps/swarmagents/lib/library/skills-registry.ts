/**
 * Online Skills Registry client (lib/library/skills-registry.ts).
 *
 * Discovers 900+ real SKILL.md skills from online open-source repositories
 * (anthropics/skills, openai/skills, and ComposioHQ/awesome-claude-skills)
 * using GitHub Git Trees with an in-memory TTL cache and strict SSRF / path
 * validation so users and agents can search and install skills on demand
 * without bloating prompt context.
 */

export type OnlineSkillSourceId = "anthropic" | "openai" | "composio";

export interface OnlineSkillSummary {
  id: string;
  slug: string;
  name: string;
  sourceId: OnlineSkillSourceId;
  source: string;
  description: string;
  rawSkillUrl: string;
  htmlUrl: string;
}

export interface OnlineSkillsSearchResult {
  query: string;
  source: OnlineSkillSourceId | "all";
  total: number;
  skills: OnlineSkillSummary[];
}

interface RepoSourceSpec {
  id: OnlineSkillSourceId;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  extractSlug: (treePath: string) => string | null;
}

const SOURCES: readonly RepoSourceSpec[] = [
  {
    id: "anthropic",
    label: "anthropics/skills",
    owner: "anthropics",
    repo: "skills",
    branch: "main",
    extractSlug: (p) => /^skills\/([a-z0-9][a-z0-9._-]{0,64})\/SKILL\.md$/i.exec(p)?.[1] ?? null,
  },
  {
    id: "openai",
    label: "openai/skills",
    owner: "openai",
    repo: "skills",
    branch: "main",
    extractSlug: (p) =>
      /^skills\/\.(?:curated|experimental)\/([a-z0-9][a-z0-9._-]{0,64})\/SKILL\.md$/i.exec(p)?.[1] ?? null,
  },
  {
    id: "composio",
    label: "ComposioHQ/awesome-claude-skills",
    owner: "ComposioHQ",
    repo: "awesome-claude-skills",
    branch: "master",
    extractSlug: (p) =>
      /^(?:composio-skills\/)?([a-z0-9][a-z0-9._-]{0,64})\/SKILL\.md$/i.exec(p)?.[1] ?? null,
  },
];

const SOURCE_BY_ID = new Map<OnlineSkillSourceId, RepoSourceSpec>(
  SOURCES.map((s) => [s.id, s]),
);

const SKILLS_TTL_MS = 15 * 60 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,64}$/i;
const QUALIFIED_ID_RE = /^(?:(anthropic|openai|composio)\/)?([a-z0-9][a-z0-9._-]{0,64})$/i;

interface SkillsCacheEntry {
  expiresAt: number;
  skills: OnlineSkillSummary[];
}

let cache: SkillsCacheEntry | null = null;

function formatTitle(slug: string): string {
  return slug
    .replace(/^-+/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || slug;
}

function describeSkill(slug: string, sourceLabel: string, sourceId: OnlineSkillSourceId): string {
  const title = formatTitle(slug);
  if (sourceId === "anthropic") return `Official ${title} SKILL.md workflow from ${sourceLabel}.`;
  if (sourceId === "openai") return `Curated ${title} SKILL.md workflow from ${sourceLabel}.`;
  if (slug.endsWith("-automation")) {
    return `${formatTitle(slug.replace(/-automation$/, ""))} SaaS automation workflow from ${sourceLabel}.`;
  }
  return `${title} Claude/agent skill workflow from ${sourceLabel}.`;
}

async function fetchRepoTree(
  spec: RepoSourceSpec,
  fetchFn: typeof fetch,
): Promise<OnlineSkillSummary[]> {
  const apiUrl = `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${spec.branch}?recursive=1`;
  const res = await fetchFn(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "swarmagents-skills-registry",
    },
  });
  if (!res.ok) {
    throw new Error(`${spec.label} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { tree?: Array<{ path?: unknown; type?: unknown }> };
  const tree = Array.isArray(body?.tree) ? body.tree : [];
  const out: OnlineSkillSummary[] = [];
  const seen = new Set<string>();

  for (const node of tree) {
    if (!node || typeof node.path !== "string") continue;
    if (node.type && node.type !== "blob") continue;
    const slug = spec.extractSlug(node.path);
    if (!slug || !SLUG_RE.test(slug) || slug.includes("..")) continue;
    const id = `${spec.id}/${slug}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const encodedTreePath = node.path.split("/").map(encodeURIComponent).join("/");
    const dirTreePath = encodedTreePath.replace(/\/SKILL\.md$/i, "");
    out.push({
      id,
      slug,
      name: formatTitle(slug),
      sourceId: spec.id,
      source: spec.label,
      description: describeSkill(slug, spec.label, spec.id),
      rawSkillUrl: `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${spec.branch}/${encodedTreePath}`,
      htmlUrl: `https://github.com/${spec.owner}/${spec.repo}/tree/${spec.branch}/${dirTreePath}`,
    });
  }
  return out;
}

async function loadAllOnlineSkills(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): Promise<OnlineSkillSummary[]> {
  const now = options.now ?? Date.now;
  if (cache && cache.expiresAt > now()) {
    return cache.skills;
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const settled = await Promise.allSettled(SOURCES.map((spec) => fetchRepoTree(spec, fetchFn)));

  const skills: OnlineSkillSummary[] = [];
  const errors: string[] = [];
  for (const res of settled) {
    if (res.status === "fulfilled") {
      skills.push(...res.value);
    } else {
      errors.push(res.reason instanceof Error ? res.reason.message : String(res.reason));
    }
  }
  if (skills.length === 0 && errors.length > 0) {
    throw new Error(`Online skills registries unavailable: ${errors.join("; ")}`);
  }

  cache = { expiresAt: now() + SKILLS_TTL_MS, skills };
  return skills;
}

export async function searchOnlineSkills(
  query = "",
  options: {
    source?: OnlineSkillSourceId | "all";
    limit?: number;
    offset?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<OnlineSkillsSearchResult> {
  const all = await loadAllOnlineSkills(options);
  const source: OnlineSkillSourceId | "all" =
    options.source && SOURCE_BY_ID.has(options.source as OnlineSkillSourceId)
      ? (options.source as OnlineSkillSourceId)
      : "all";

  const bySource = source === "all" ? all : all.filter((s) => s.sourceId === source);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? bySource.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.source.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : bySource;

  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  return {
    query,
    source,
    total: filtered.length,
    skills: filtered.slice(offset, offset + limit),
  };
}

export async function listOnlineSkills(
  query = "",
  options: {
    source?: OnlineSkillSourceId | "all";
    fetchImpl?: typeof fetch;
    now?: () => number;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OnlineSkillSummary[]> {
  const res = await searchOnlineSkills(query, options);
  return res.skills;
}

export async function fetchOnlineSkillMd(
  skillId: string,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<{
  id: string;
  slug: string;
  sourceId: OnlineSkillSourceId;
  source: string;
  name: string;
  description: string;
  skillMd: string;
}> {
  const trimmed = skillId.trim();
  const match = QUALIFIED_ID_RE.exec(trimmed);
  if (!match || trimmed.includes("..")) {
    throw new Error("Invalid skill id.");
  }
  const sourceId = (match[1]?.toLowerCase() ?? "anthropic") as OnlineSkillSourceId;
  const slug = match[2];
  const qualifiedId = `${sourceId}/${slug}`;
  const spec = SOURCE_BY_ID.get(sourceId) ?? SOURCES[0];

  // Try matching against cache (or refresh once) so nested OpenAI/Composio paths resolve cleanly.
  const fetchFn = options.fetchImpl ?? fetch;
  let candidateUrls: string[] = [];
  if (cache && cache.expiresAt > (options.now ?? Date.now)()) {
    const hit = cache.skills.find((s) => s.id === qualifiedId);
    if (hit) candidateUrls.push(hit.rawSkillUrl);
  }
  if (candidateUrls.length === 0) {
    if (sourceId === "anthropic") {
      candidateUrls = [`https://raw.githubusercontent.com/anthropics/skills/main/skills/${encodeURIComponent(slug)}/SKILL.md`];
    } else {
      try {
        const all = await loadAllOnlineSkills(options);
        const hit = all.find((s) => s.id === qualifiedId);
        if (hit) candidateUrls.push(hit.rawSkillUrl);
      } catch {
        // Fall through to standard candidate paths below.
      }
      if (candidateUrls.length === 0) {
        if (sourceId === "openai") {
          candidateUrls = [
            `https://raw.githubusercontent.com/openai/skills/main/skills/.curated/${encodeURIComponent(slug)}/SKILL.md`,
            `https://raw.githubusercontent.com/openai/skills/main/skills/.experimental/${encodeURIComponent(slug)}/SKILL.md`,
          ];
        } else {
          candidateUrls = [
            `https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master/composio-skills/${encodeURIComponent(slug)}/SKILL.md`,
            `https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master/${encodeURIComponent(slug)}/SKILL.md`,
          ];
        }
      }
    }
  }

  let skillMd = "";
  let lastStatus = 0;
  for (const url of candidateUrls) {
    const res = await fetchFn(url, {
      headers: { "User-Agent": "swarmagents-skills-registry" },
    });
    lastStatus = res.status;
    if (res.ok) {
      skillMd = await res.text();
      break;
    }
  }

  if (!skillMd.trim() || skillMd.length > 200_000) {
    throw new Error(
      skillMd.length > 200_000
        ? "Fetched SKILL.md exceeds size limit."
        : `Could not fetch SKILL.md for "${qualifiedId}" (HTTP ${lastStatus || 404}).`,
    );
  }

  const descMatch = skillMd.match(/^description:\s*(.+)$/m);
  const description =
    descMatch?.[1]?.trim().replace(/^["']|["']$/g, "").slice(0, 240) ||
    describeSkill(slug, spec.label, spec.id);

  return {
    id: qualifiedId,
    slug,
    sourceId,
    source: spec.label,
    name: formatTitle(slug),
    description,
    skillMd,
  };
}

export function clearOnlineSkillsCache(): void {
  cache = null;
}
