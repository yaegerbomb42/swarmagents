// Pending OAuth PKCE verifiers, kept on globalThis so dev hot-reloads don't drop an in-flight login.
const g = globalThis as unknown as { __orVerifiers?: Map<string, number> };
export const verifiers = (g.__orVerifiers ??= new Map());
