// Caps on *successful* sign-ups (deploy lane, Grok Bot (deploy); announced in GROUP_CHAT 21:30). lib/auth throttled()
// only counts failures, so with SWARM_SIGNUP=open one client could otherwise mint unlimited accounts (each gets an
// OS uid, a workspace and a storage quota). Per client IP (lib/auth clientIp, proxy-hop aware) and server-wide, per
// rolling hour; in memory, so a restart resets it. Override with SWARM_SIGNUP_PER_IP_HOUR / SWARM_SIGNUP_PER_HOUR.

const HOUR = 60 * 60 * 1000;
const perIp = new Map<string, number[]>();
let all: number[] = [];

const limit = (v: string | undefined, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};

function recent(list: number[], now: number) {
  return list.filter((t) => now - t < HOUR);
}

/** null when this client may create another account now; otherwise the message for a 429. */
export function signupBlocked(ip: string, now = Date.now()): string | null {
  all = recent(all, now);
  const mine = recent(perIp.get(ip) ?? [], now);
  if (mine.length) perIp.set(ip, mine);
  else perIp.delete(ip);
  if (mine.length >= limit(process.env.SWARM_SIGNUP_PER_IP_HOUR, 5)) return "Too many new accounts from your network. Try again in an hour.";
  if (all.length >= limit(process.env.SWARM_SIGNUP_PER_HOUR, 60)) return "Sign-ups are busy right now. Try again later.";
  return null;
}

/** Record one successful sign-up for this client. */
export function noteSignup(ip: string, now = Date.now()) {
  if (perIp.size > 50_000) perIp.clear();
  perIp.set(ip, [...recent(perIp.get(ip) ?? [], now), now]);
  all = [...recent(all, now), now];
}
