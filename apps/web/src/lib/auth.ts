/**
 * Client-side auth helpers backed by Firebase Auth.
 *
 * Token lifecycle: Firebase ID token (JWT, 1h TTL) is minted on
 * sign-in/sign-up, cached in localStorage under `auth_token` + `auth_user`
 * so legacy consumers (api.ts, decompositionApi, etc.) keep working, and
 * refreshed transparently via `onIdTokenChanged`. The engine verifies the
 * token server-side (TASK-06b); the dashboard never validates it locally.
 */
import {
  PhoneAuthProvider,
  createUserWithEmailAndPassword,
  isSignInWithEmailLink,
  linkWithCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  RecaptchaVerifier,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile,
  type ConfirmationResult,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  getFacebookProvider,
  getFirebaseAuth,
  getGithubProvider,
  getGoogleProvider,
  isFirebaseConfigured,
} from '@/lib/firebase';

export type AuthUser = {
  id: string;
  email: string;
  display_name?: string | null;
};

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
};

export type AuthError = {
  error: string;
  code?: string;
  detail?: string | null;
};

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';
const APP_HOME = '/decomp';

/** After login/signup: never send people through the removed onboarding funnel. */
export function postAuthPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return APP_HOME;
  const path = raw.split('?')[0] ?? raw;
  if (path === '/onboarding' || path.startsWith('/onboarding/')) return APP_HOME;
  if (path === '/login' || path === '/signup' || path === '/auth/finish') return APP_HOME;
  return raw;
}

/** Wait for Firebase to restore IndexedDB session (avoids treating refresh as logged-out). */
export function waitForFirebaseUser(timeoutMs = 5000): Promise<FirebaseUser | null> {
  if (typeof window === 'undefined' || !isFirebaseConfigured()) {
    return Promise.resolve(null);
  }
  const auth = getFirebaseAuth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsub();
      resolve(auth.currentUser);
    }, timeoutMs);
    const unsub = onAuthStateChanged(auth, (user) => {
      window.clearTimeout(timer);
      unsub();
      resolve(user);
    });
  });
}

/** Same-origin proxy to FastAPI (next.config rewrites /api/engine → ENGINE_URL). */
export function engineApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') {
    const base = (process.env.ENGINE_URL || 'http://localhost:8400').replace(/\/$/, '');
    return `${base}${p}`;
  }
  if (process.env.NEXT_PUBLIC_ENGINE_URL) {
    return `${process.env.NEXT_PUBLIC_ENGINE_URL.replace(/\/$/, '')}${p}`;
  }
  return `/api/engine${p}`;
}

export function getToken(): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function toAuthUser(u: FirebaseUser): AuthUser {
  return {
    id: u.uid,
    email: u.email ?? '',
    display_name: u.displayName,
  };
}

/** Cache the Firebase ID token + profile so legacy localStorage consumers keep working. */
async function cacheFirebaseSession(user: FirebaseUser): Promise<TokenResponse> {
  const token = await user.getIdToken();
  const authUser = toAuthUser(user);
  setSession(token, authUser);
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600,
    user: authUser,
  };
}

/** Keep the localStorage cache in sync with Firebase token refreshes / sign-outs. */
let listenerStarted = false;
export function ensureAuthListener(): void {
  if (listenerStarted || typeof window === 'undefined') return;
  if (!isFirebaseConfigured()) return;
  listenerStarted = true;
  onIdTokenChanged(getFirebaseAuth(), async (user) => {
    if (!user) {
      clearSession();
      return;
    }
    try {
      await cacheFirebaseSession(user);
    } catch (e) {
      console.error('[auth] failed to cache refreshed ID token', e);
    }
  });
}

export function mapFirebaseError(e: unknown): AuthError {
  const code =
    typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : 'auth/unknown';
  const friendly: Record<string, string> = {
    'auth/invalid-credential': 'Invalid email or password',
    'auth/wrong-password': 'Invalid email or password',
    'auth/user-not-found': 'No account found for that email',
    'auth/email-already-in-use': 'An account already exists for that email',
    'auth/weak-password': 'Password is too weak (min 6 characters)',
    'auth/invalid-email': 'That email address is invalid',
    'auth/popup-closed-by-user': 'Sign-in was cancelled',
    'auth/popup-blocked': 'Your browser blocked the sign-in popup',
    'auth/account-exists-with-different-credential':
      'An account already exists with this email under a different sign-in method',
    'auth/cancelled-popup-request': 'Sign-in was cancelled',
    'auth/provider-already-linked': 'This sign-in provider is already linked to the account',
    'auth/invalid-phone-number': 'That phone number is invalid — use +15551234567 format',
    'auth/missing-phone-number': 'Enter a phone number',
    'auth/quota-exceeded': 'SMS quota exceeded — try again later',
    'auth/invalid-verification-code': 'Wrong verification code — check the SMS and try again',
    'auth/code-expired': 'Code expired — request a new one',
    'auth/captcha-check-failed': 'reCAPTCHA failed — try again',
    'auth/web-storage-unsupported': 'Your browser is blocking storage needed for phone sign-in',
    'auth/too-many-requests': 'Too many attempts — try again later',
    'auth/network-request-failed': 'Network error — check your connection',
  };
  return {
    error: friendly[code] ?? (e instanceof Error ? e.message : 'Authentication failed'),
    code,
  };
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<{ ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }> {
  if (!isFirebaseConfigured()) {
    // Sandbox / Founder Demo Session
    const demoUser: AuthUser = {
      id: 'demo-founder',
      email: input.email.trim() || 'founder@swarmagents.codes',
      display_name: 'Founder / Architect',
    };
    const data: TokenResponse = {
      access_token: 'sandbox-jwt-session',
      token_type: 'Bearer',
      expires_in: 86400,
      user: demoUser,
    };
    setSession(data.access_token, demoUser);
    return { ok: true, data };
  }
  try {
    const cred = await signInWithEmailAndPassword(getFirebaseAuth(), input.email, input.password);
    const data = await cacheFirebaseSession(cred.user);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 401, error: mapFirebaseError(e) };
  }
}

export async function loginWithGoogle(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  if (!isFirebaseConfigured()) {
    const demoUser: AuthUser = {
      id: 'demo-google-user',
      email: 'founder@swarmagents.codes',
      display_name: 'Founder (Google Session)',
    };
    const data: TokenResponse = {
      access_token: 'sandbox-jwt-session',
      token_type: 'Bearer',
      expires_in: 86400,
      user: demoUser,
    };
    setSession(data.access_token, demoUser);
    return { ok: true, data };
  }
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), getGoogleProvider());
    const data = await cacheFirebaseSession(cred.user);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 401, error: mapFirebaseError(e) };
  }
}

/**
 * Ask the engine to provision a user row + free credits. Implemented by
 * TASK-06b; a 404 (engine not deployed yet) is tolerated silently — log only.
 */
export async function provisionUser(): Promise<boolean> {
  try {
    const res = await fetch(engineApiUrl('/auth/provision'), {
      method: 'POST',
      headers: authHeaders(),
    });
    if (res.status === 404) {
      console.info('[auth] /auth/provision not available yet (engine 06b pending) — continuing');
      return false;
    }
    if (!res.ok) {
      console.warn('[auth] /auth/provision failed', res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[auth] /auth/provision request error', e);
    return false;
  }
}

export async function signup(input: {
  email: string;
  password: string;
  display_name?: string;
}): Promise<{ ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }> {
  if (!isFirebaseConfigured()) {
    const demoUser: AuthUser = {
      id: 'demo-founder',
      email: input.email.trim() || 'founder@swarmagents.codes',
      display_name: input.display_name?.trim() || 'Founder / Architect',
    };
    const data: TokenResponse = {
      access_token: 'sandbox-jwt-session',
      token_type: 'Bearer',
      expires_in: 86400,
      user: demoUser,
    };
    setSession(data.access_token, demoUser);
    return { ok: true, data };
  }
  try {
    const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), input.email, input.password);
    if (input.display_name) {
      try {
        await updateProfile(cred.user, { displayName: input.display_name });
      } catch (e) {
        console.warn('[auth] updateProfile failed; continuing', e);
      }
    }
    const data = await cacheFirebaseSession(cred.user);
    await provisionUser();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

export async function signupWithGoogle(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  const result = await loginWithGoogle();
  if (result.ok) await provisionUser();
  return result;
}

export async function loginWithFacebook(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), getFacebookProvider());
    const data = await cacheFirebaseSession(cred.user);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 401, error: mapFirebaseError(e) };
  }
}

export async function signupWithFacebook(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  const result = await loginWithFacebook();
  if (result.ok) await provisionUser();
  return result;
}

export async function loginWithGithub(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), getGithubProvider());
    const data = await cacheFirebaseSession(cred.user);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 401, error: mapFirebaseError(e) };
  }
}

export async function signupWithGithub(): Promise<
  { ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }
> {
  const result = await loginWithGithub();
  if (result.ok) await provisionUser();
  return result;
}

// ----------------------------------------------------------------------------
// Passwordless email-link auth
// ----------------------------------------------------------------------------
// Firebase emails a one-time link; clicking it on any device completes sign-in.
// If completed on the same device, we skip the email re-prompt by stashing the
// address in localStorage (per Firebase docs — safer than URL params).
const EMAIL_FOR_SIGNIN_KEY = 'emailForSignIn';

function actionCodeSettings(next: string) {
  return {
    url: `${typeof window !== 'undefined' ? window.location.origin : ''}/auth/finish?next=${encodeURIComponent(next)}`,
    handleCodeInApp: true,
  };
}

export async function sendSignInLink(
  email: string,
  next: string = '/decomp',
): Promise<{ ok: true } | { ok: false; error: AuthError; status: number }> {
  try {
    await sendSignInLinkToEmail(getFirebaseAuth(), email, actionCodeSettings(next));
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(EMAIL_FOR_SIGNIN_KEY, email);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

/**
 * True when the current URL is a Firebase email-link deep link. Call on the
 * /auth/finish route before asking the user for a fallback email.
 */
export function isEmailLinkAuthFlow(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return isSignInWithEmailLink(getFirebaseAuth(), window.location.href);
  } catch {
    return false;
  }
}

/**
 * Complete the email-link sign-in flow. Reads the email from localStorage
 * (same-device flow) or requires the caller to pass it (cross-device flow).
 */
export async function completeSignInWithEmailLink(
  emailOverride?: string,
): Promise<{ ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }> {
  if (typeof window === 'undefined') {
    return { ok: false, status: 400, error: { error: 'Email link flow must complete in a browser', code: 'client_required' } };
  }
  try {
    const email = emailOverride ?? window.localStorage.getItem(EMAIL_FOR_SIGNIN_KEY) ?? '';
    if (!email) {
      return {
        ok: false,
        status: 400,
        error: { error: 'Email required to complete sign-in', code: 'email_required' },
      };
    }
    const cred = await signInWithEmailLink(getFirebaseAuth(), email, window.location.href);
    window.localStorage.removeItem(EMAIL_FOR_SIGNIN_KEY);
    const data = await cacheFirebaseSession(cred.user);
    await provisionUser();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

// ----------------------------------------------------------------------------
// Phone (SMS) sign-in via Firebase Phone Auth
// ----------------------------------------------------------------------------
// Two-step flow:
//   1. requestPhoneCode(phoneE164, verifier) → sends SMS, returns a confirmation
//   2. confirmPhoneCode(confirmation, code) → signs in + caches session
// RecaptchaVerifier is required by Firebase regardless of UX. We use the
// invisible variant (size:'invisible') attached to a hidden submit button id —
// Firebase runs the check programmatically on `signInWithPhoneNumber` without
// rendering a widget. If the check can't auto-solve, Firebase falls back to
// a visible modal challenge.
declare global {
  interface Window {
    __recaptchaVerifier?: RecaptchaVerifier;
  }
}

export function getRecaptchaVerifier(containerId: string): RecaptchaVerifier {
  if (typeof window === 'undefined') {
    throw new Error('RecaptchaVerifier must be constructed in the browser');
  }
  if (window.__recaptchaVerifier) {
    // Firebase recommends reusing a single instance across sign-in attempts.
    return window.__recaptchaVerifier;
  }
  const v = new RecaptchaVerifier(getFirebaseAuth(), containerId, {
    size: 'invisible',
    callback: () => {
      // Invisible reCAPTCHA solved — Firebase proceeds with the pending
      // phone-number operation automatically; nothing to do here.
    },
    'expired-callback': () => {
      resetRecaptchaVerifier();
    },
  });
  window.__recaptchaVerifier = v;
  return v;
}

export function resetRecaptchaVerifier(): void {
  if (typeof window !== 'undefined' && window.__recaptchaVerifier) {
    try {
      window.__recaptchaVerifier.clear();
    } catch {
      /* ok */
    }
    window.__recaptchaVerifier = undefined;
  }
}

/** Backend bookkeeping endpoint: reserve one SMS send against the user's quota.
 *
 * The engine is the source of truth for per-user SMS sends (the dashboard
 * ships the actual SMS via Firebase). Frontend calls this BEFORE triggering
 * signInWithPhoneNumber so the user sees the friendly 429 message *before*
 * Firebase's reCAPTCHA challenge. A 404 (older engine) is treated as
 * "allowed" — Firebase's own quota handles overage in that case.
 */
export async function reserveSmsSend(): Promise<
  { ok: true } | { ok: false; error: AuthError; status: number }
> {
  try {
    const res = await fetch(engineApiUrl('/auth/sms/send-record'), {
      method: 'POST',
      headers: authHeaders(),
    });
    if (res.status === 404) {
      return { ok: true };
    }
    if (res.status === 429) {
      let detail: { error?: string; code?: string; retry_after_seconds?: number } = {};
      try {
        detail = (await res.json())?.detail ?? {};
      } catch {
        /* body parse optional */
      }
      const retrySec = detail.retry_after_seconds ?? 86400;
      const retryHrs = Math.max(1, Math.ceil(retrySec / 3600));
      return {
        ok: false,
        status: 429,
        error: {
          error: `SMS quota reached — try again in ~${retryHrs}h`,
          code: (detail.code ?? detail.error ?? 'sms_ratelimit_exceeded') as string,
        },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: { error: `SMS quota check failed (${res.status})`, code: 'quota_check_failed' },
      };
    }
    return { ok: true };
  } catch (e) {
    // Network failure: do not block SMS just because our quota route is down.
    console.warn('[auth] reserveSmsSend network error — allowing', e);
    return { ok: true };
  }
}

/** E.164 format required by Firebase: +15551234567 */
export async function requestPhoneCode(
  phoneE164: string,
  verifier: RecaptchaVerifier,
  opts?: { skipQuotaCheck?: boolean },
): Promise<{ ok: true; data: ConfirmationResult } | { ok: false; error: AuthError; status: number }> {
  if (!opts?.skipQuotaCheck) {
    const quota = await reserveSmsSend();
    if (quota.ok === false) return { ok: false, status: quota.status, error: quota.error };
  }
  try {
    const result = await signInWithPhoneNumber(getFirebaseAuth(), phoneE164, verifier);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

export async function confirmPhoneCode(
  confirmation: ConfirmationResult,
  code: string,
): Promise<{ ok: true; data: TokenResponse } | { ok: false; error: AuthError; status: number }> {
  try {
    const cred = await confirmation.confirm(code);
    const data = await cacheFirebaseSession(cred.user);
    await provisionUser();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

/**
 * Attach a verified phone number to the currently signed-in Firebase user.
 *
 * Flow: caller runs the standard two-step SMS flow first (requestPhoneCode →
 * ConfirmationResult → user-supplied code), then hands us the confirmation +
 * code. We build a PhoneAuthCredential and call linkWithCredential so the
 * phone becomes an additional sign-in factor on the existing account rather
 * than a new identity.
 */
export async function linkPhoneToAccount(
  confirmation: ConfirmationResult,
  code: string,
): Promise<{ ok: true; phoneNumber: string } | { ok: false; error: AuthError; status: number }> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: { error: 'Sign in first to link a phone number', code: 'auth_required' },
    };
  }
  try {
    const credential = PhoneAuthProvider.credential(verificationIdFrom(confirmation), code.trim());
    const linked = await linkWithCredential(user, credential);
    return { ok: true, phoneNumber: linked.user.phoneNumber ?? '' };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

/** ConfirmationResult doesn't expose verificationId in the public TS types,
 *  but the underlying Firebase instance always has it. Narrow via structural
 *  check so we fail loudly if Firebase ever changes shape. */
function verificationIdFrom(confirmation: ConfirmationResult): string {
  const vid = (confirmation as unknown as { verificationId?: unknown }).verificationId;
  if (typeof vid !== 'string' || !vid) {
    throw new Error('Firebase ConfirmationResult missing verificationId');
  }
  return vid;
}

/** Return the phone number(s) linked to the current Firebase user, if any. */
export function getLinkedPhoneNumber(): string | null {
  if (typeof window === 'undefined') return null;
  const user = getFirebaseAuth().currentUser;
  return user?.phoneNumber ?? null;
}

export async function requestPasswordReset(
  email: string,
): Promise<{ ok: true } | { ok: false; error: AuthError; status: number }> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email);
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 400, error: mapFirebaseError(e) };
  }
}

export async function fetchMe(): Promise<
  { ok: true; data: AuthUser } | { ok: false; error: AuthError; status: number }
> {
  // Without Firebase config the founder sandbox session in localStorage is the session.
  const current = isFirebaseConfigured() ? getFirebaseAuth().currentUser : null;
  if (current) {
    const user = toAuthUser(current);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    return { ok: true, data: user };
  }
  const stored = getStoredUser();
  if (stored && getToken()) {
    return { ok: true, data: stored };
  }
  return { ok: false, status: 401, error: { error: 'Not authenticated', code: 'auth_required' } };
}

export function logout(): void {
  clearSession();
  if (isFirebaseConfigured()) {
    try {
      signOut(getFirebaseAuth()).catch((e) => console.warn('[auth] firebase signOut failed', e));
    } catch {}
  }
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

export function requireClientAuth(redirectTo = '/login'): boolean {
  if (typeof window === 'undefined') return false;
  if (!getToken()) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${redirectTo}?next=${next}`;
    return false;
  }
  return true;
}
