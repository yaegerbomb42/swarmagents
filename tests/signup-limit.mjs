// Sign-up abuse limits (finish-launch, item 5): 5 accounts/IP/hour, 60/hour server-wide.
// Pure logic, no server. Run: node tests/signup-limit.mjs (also via npm test if wired).
import { signupBlocked, noteSignup } from "../lib/tenant/signup-limit.ts";

let pass = 0,
  fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name}`);
  }
};

const T0 = Date.now();
delete process.env.SWARM_SIGNUP_PER_IP_HOUR;
delete process.env.SWARM_SIGNUP_PER_HOUR;

// Fresh client may sign up.
ok(signupBlocked("9.9.9.9", T0) === null, "fresh IP allowed");
// Five succeed, sixth refused.
for (let i = 0; i < 5; i++) {
  ok(signupBlocked("9.9.9.9", T0 + i) === null, `signup ${i + 1}/5 allowed`);
  noteSignup("9.9.9.9", T0 + i);
}
const sixth = signupBlocked("9.9.9.9", T0 + 5);
ok(typeof sixth === "string" && /hour/.test(sixth), "6th signup from same IP refused with 429 message");
// A different IP is unaffected by the first IP's burst.
ok(signupBlocked("8.8.8.8", T0 + 6) === null, "other IP unaffected");
// Window slides: an hour later the first IP may sign up again.
ok(signupBlocked("9.9.9.9", T0 + 3_601_000) === null, "limit resets after an hour");
// Server-wide cap: 60 sign-ups from distinct IPs, 61st refused.
for (let i = 0; i < 60; i++) {
  noteSignup(`10.0.0.${i}`, T0 + 3_700_000 + i);
}
ok(signupBlocked("11.0.0.1", T0 + 3_800_000) !== null, "61st signup server-wide refused");

console.log(`\nsignup-limit: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
