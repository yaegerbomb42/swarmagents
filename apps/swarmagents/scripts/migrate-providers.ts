/**
 * One-off: move the legacy server-wide providers.json into the owner's
 * account (encrypted), then rename it to providers.json.migrated.
 *
 *   SWARM_HOME=/data SWARM_KEYS_SECRET=... npx tsx scripts/migrate-providers.ts [--owner email] [--force]
 *
 * Run it with the same SWARM_HOME / SWARM_KEYS_SECRET / SWARM_SESSION_SECRET
 * the server uses, or the server will not be able to decrypt the keys.
 * --force skips the "owner account exists" check. The server also runs this
 * automatically at startup; the script is for doing it by hand.
 * Prints provider ids only, never keys.
 */

import { migrateLegacyProviders } from "../lib/providers/migrate";

const args = process.argv.slice(2);
const ownerIndex = args.indexOf("--owner");
const ownerEmail = ownerIndex >= 0 ? args[ownerIndex + 1] : undefined;
const force = args.includes("--force");

const result = migrateLegacyProviders({ ownerEmail, force });
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "migrated" || result.status === "no-legacy-file" ? 0 : 1);
