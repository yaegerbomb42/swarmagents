/**
 * Key bookkeeping for the provider catalog.
 *
 * A provider's API keys live server-side (the providers config file or the
 * environment). Nothing that leaves the server may carry key material, so
 * every client-facing surface works with two things only: how many keys a
 * provider has, and a last-4 mask that identifies a slot without revealing
 * the secret.
 */

/** One key slot of a provider: its position plus a last-4 mask. */
export interface ProviderKeySlot {
  /** Zero-based position of the key inside the provider's key list. */
  index: number;
  /** Last-4 mask of the key (e.g. "••••a1b2"). Never the key itself. */
  mask: string;
}

/** Fixed prefix so the mask never leaks the key's length. */
const MASK_PREFIX = "••••";

/** Keys this short are masked completely — their last 4 would be the key. */
const MIN_MASKABLE_LENGTH = 5;

/**
 * Mask a key down to its last four characters. Short keys are masked
 * completely: showing four characters of a four-character key would leak it.
 */
export function maskProviderKey(key: string): string {
  const value = key.trim();
  if (value.length < MIN_MASKABLE_LENGTH) return MASK_PREFIX;
  return `${MASK_PREFIX}${value.slice(-4)}`;
}

/** Describe a provider's keys as slots. The values themselves stay server-side. */
export function providerKeySlots(keys: readonly string[] | undefined): ProviderKeySlot[] {
  return (keys ?? []).map((key, index) => ({ index, mask: maskProviderKey(key) }));
}
