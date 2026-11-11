import type { Page } from '@playwright/test';

/**
 * Route-mocks the Firebase Identity Toolkit REST endpoints that the
 * Firebase JS SDK (signInWithEmailAndPassword) calls, plus the securetoken
 * refresh endpoint. Lets the real firebase/auth client code run end-to-end
 * without any real Firebase project or credentials.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.e2e`;
}

export const E2E_ID_TOKEN = fakeJwt({
  iss: 'https://securetoken.google.com/e2e-fake-project',
  aud: 'e2e-fake-project',
  auth_time: Math.floor(Date.now() / 1000),
  user_id: 'e2e-user-1',
  sub: 'e2e-user-1',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: 'e2e@swarmagents.dev',
  email_verified: true,
  firebase: { identities: { email: ['e2e@swarmagents.dev'] }, sign_in_provider: 'password' },
});

export async function mockFirebaseAuth(page: Page): Promise<void> {
  // NOTE: Playwright matches routes in reverse registration order — specific
  // endpoints are registered first so the catch-all in the spec (or here)
  // never shadows them.
  await page.route('**/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'identitytoolkit#VerifyPasswordResponse',
        localId: 'e2e-user-1',
        email: 'e2e@swarmagents.dev',
        displayName: 'E2E User',
        // A syntactically valid unsigned JWT — the SDK parses payload claims
        // (it never verifies the signature client-side), and the dashboard
        // forwards it verbatim as the Bearer token.
        idToken: E2E_ID_TOKEN,
        registered: true,
        refreshToken: 'e2e-fake-refresh-token',
        expiresIn: '3600',
      }),
    }),
  );

  await page.route('**/securetoken.googleapis.com/v1/token**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: E2E_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'e2e-fake-refresh-token',
        id_token: E2E_ID_TOKEN,
        user_id: 'e2e-user-1',
        project_id: 'e2e-fake-project',
      }),
    }),
  );

  // After sign-in the SDK reloads the user profile via accounts:lookup.
  await page.route('**/identitytoolkit.googleapis.com/v1/accounts:lookup**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'identitytoolkit#GetAccountInfoResponse',
        users: [
          {
            localId: 'e2e-user-1',
            email: 'e2e@swarmagents.dev',
            displayName: 'E2E User',
            emailVerified: true,
            createdAt: '1700000000000',
            lastLoginAt: Date.now().toString(),
            providerUserInfo: [],
            passwordHash: 'e2e',
            validSince: '1700000000',
          },
        ],
      }),
    }),
  );

  // SDK v12 fetches reCAPTCHA config before password sign-in; a well-formed
  // response keeps RecaptchaConfig parsing happy with every provider unset.
  await page.route('**/identitytoolkit.googleapis.com/v2/recaptchaConfig**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recaptchaKey: 'projects/e2e-fake-project/keys/e2e-site-key',
        recaptchaEnforcementState: [],
      }),
    }),
  );

  // Any other Google-hosted auth call (installations, etc.) — succeed empty.
  await page.route('**/firebaseinstallations.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
}
