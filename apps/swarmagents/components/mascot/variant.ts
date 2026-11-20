/**
 * Which Jimmy renders on the main page.
 *
 * `sprite` is the original 8x8 sprite sheet (Mascot.tsx); `svg` is the
 * procedural port (MascotSvg.tsx). This module is the single source of truth
 * for choosing and persisting the variant.
 *
 * Precedence: a valid `?mascot=svg|sprite` query param wins, then the stored
 * preference, then `svg`. The SVG port is the default because it needs no
 * external asset, so the mascot never shows a broken image when the sprite
 * sheet's LFS pointer is unresolved. DOM-free so the resolution rules are
 * unit testable without a browser.
 */

export type MascotVariant = "sprite" | "svg";

export const MASCOT_VARIANTS: readonly MascotVariant[] = ["sprite", "svg"];

export const DEFAULT_MASCOT_VARIANT: MascotVariant = "svg";

export const MASCOT_VARIANT_STORAGE_KEY = "jimmy.mascotVariant";

export const MASCOT_VARIANT_QUERY_PARAM = "mascot";

/** Minimal storage surface, so tests can pass a fake. */
export interface MascotVariantStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isMascotVariant(value: unknown): value is MascotVariant {
  return value === "sprite" || value === "svg";
}

/** Read `?mascot=` from a query string (with or without the leading "?"). */
export function parseMascotVariantQuery(search: string): MascotVariant | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const value = params.get(MASCOT_VARIANT_QUERY_PARAM);
  return isMascotVariant(value) ? value : null;
}

/** Read the preference localStorage holds, ignoring malformed values. */
export function readStoredMascotVariant(
  storage: MascotVariantStorage | null | undefined,
): MascotVariant | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(MASCOT_VARIANT_STORAGE_KEY);
    return isMascotVariant(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pick the variant. The query param overrides the stored preference; invalid
 * values on either side are ignored so a typo never breaks the mascot.
 */
export function resolveMascotVariant({
  queryParam,
  stored,
}: {
  queryParam?: MascotVariant | string | null;
  stored?: MascotVariant | string | null;
} = {}): MascotVariant {
  if (isMascotVariant(queryParam)) return queryParam;
  if (isMascotVariant(stored)) return stored;
  return DEFAULT_MASCOT_VARIANT;
}

/** Resolve from `window.location.search` plus `window.localStorage`. */
export function mascotVariantFromLocation(
  search: string,
  storage: MascotVariantStorage | null | undefined,
): MascotVariant {
  return resolveMascotVariant({
    queryParam: parseMascotVariantQuery(search),
    stored: readStoredMascotVariant(storage),
  });
}

/** Store the chosen variant. Storage failures (private mode) are non-fatal. */
export function persistMascotVariant(
  variant: MascotVariant,
  storage: MascotVariantStorage | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(MASCOT_VARIANT_STORAGE_KEY, variant);
  } catch {
    // The page still honours the in-memory choice for this session.
  }
}
