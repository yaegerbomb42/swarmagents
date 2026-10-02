// The one set of account-credential rules, shared by the server (lib/users.ts validateCredentials, /api/signup)
// and the sign-up form (app/login/page.tsx). It's pure, with no node imports, so the client bundle can import it too.
// If you change a rule here, both sides change together; never re-implement them in the UI.

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export interface PasswordCheck {
  id: "length" | "upper" | "lower" | "number" | "symbol";
  label: string;
  ok: boolean;
}

/** Every rule a new password must meet, in display order. */
export function passwordChecks(pw: string): PasswordCheck[] {
  return [
    { id: "length", label: `${PASSWORD_MIN}+ characters`, ok: pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX },
    { id: "upper", label: "An uppercase letter", ok: /[A-Z]/.test(pw) },
    { id: "lower", label: "A lowercase letter", ok: /[a-z]/.test(pw) },
    { id: "number", label: "A number", ok: /[0-9]/.test(pw) },
    { id: "symbol", label: "A symbol", ok: /[^A-Za-z0-9]/.test(pw) },
  ];
}

export function usernameError(username: string): string | null {
  return USERNAME_RE.test(username) ? null : "Username must be 3–32 letters, digits, dots, dashes or underscores.";
}

/** Length only. Used for the admin seeded from a password file at boot, so an existing password can't lock the admin out. */
export function passwordLengthError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return "Password is too long.";
  return null;
}

/** The full rule set for a new account's password: length plus upper, lower, number and symbol. */
export function newPasswordError(pw: string): string | null {
  const len = passwordLengthError(pw);
  if (len) return len;
  const missing = passwordChecks(pw).filter((c) => !c.ok && c.id !== "length");
  return missing.length ? `Password needs ${missing.map((c) => c.label.toLowerCase()).join(", ")}.` : null;
}

/** What /api/signup enforces. The sign-up form blocks submit on exactly this, so the two can't disagree. */
export function signupCredentialsError(username: string, password: string): string | null {
  return usernameError(username) ?? newPasswordError(password);
}
