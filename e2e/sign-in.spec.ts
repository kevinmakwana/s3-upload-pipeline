import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const IDP = 'http://localhost:9099'; // plain http is allowed for localhost, so no certificate is needed
const APP = 'http://localhost:5173';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Unsigned: the page only reads `exp`; verifying the signature is the API's job (covered by its own tests). */
const idToken = `${b64({ alg: 'none' })}.${b64({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

test('signs in through the hosted login page with PKCE, sends the ID token to the API, and signs out', async ({ page }) => {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        apiUrl: 'http://localhost:3001',
        auth: {
          mode: 'oidc',
          authorizeUrl: `${IDP}/oauth2/authorize`,
          tokenUrl: `${IDP}/oauth2/token`,
          logoutUrl: `${IDP}/logout`,
          clientId: 'client-1',
          scope: 'openid email',
        },
      },
    }),
  );

  let challenge = '';
  let authorizeParams = new URLSearchParams();
  await page.route(`${IDP}/oauth2/authorize*`, (route) => {
    authorizeParams = new URL(route.request().url()).searchParams;
    challenge = authorizeParams.get('code_challenge') ?? '';
    // What the login page does after the visitor signs in: send them back with a code and the same state.
    return route.fulfill({ status: 302, headers: { location: `${APP}/?code=the-code&state=${authorizeParams.get('state')}` } });
  });

  let tokenRequest = new URLSearchParams();
  await page.route(`${IDP}/oauth2/token`, (route) => {
    tokenRequest = new URLSearchParams(route.request().postData() ?? '');
    return route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { id_token: idToken, access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' },
    });
  });

  const apiCall = page.waitForRequest((r) => r.url().startsWith('http://localhost:3001/files'));
  await page.goto('/');

  // Back on the app, signed in, with the temporary values gone from the address bar.
  await expect(page.getByText('Signed in. Your files are private to your account.')).toBeVisible();
  expect(page.url()).toBe(`${APP}/`);

  expect(authorizeParams.get('response_type')).toBe('code');
  expect(authorizeParams.get('client_id')).toBe('client-1');
  expect(authorizeParams.get('code_challenge_method')).toBe('S256');
  expect(authorizeParams.get('redirect_uri')).toBe(`${APP}/`);

  // The code exchange proves possession of the verifier whose hash was sent in the first step.
  expect(tokenRequest.get('grant_type')).toBe('authorization_code');
  expect(tokenRequest.get('code')).toBe('the-code');
  expect(
    createHash('sha256')
      .update(tokenRequest.get('code_verifier') ?? '')
      .digest('base64url'),
  ).toBe(challenge);

  expect((await apiCall).headers()['authorization']).toBe(`Bearer ${idToken}`);

  // Signing out ends the login page's own session too, then returns to the app.
  const logout = page.waitForRequest((r) => r.url().startsWith(`${IDP}/logout`));
  await page.route(`${IDP}/logout*`, (route) => route.fulfill({ contentType: 'text/html', body: '<p>signed out</p>' }));
  await page.getByRole('button', { name: 'Sign out' }).click();
  const url = new URL((await logout).url());
  expect(url.searchParams.get('client_id')).toBe('client-1');
  expect(url.searchParams.get('logout_uri')).toBe(`${APP}/`);
  expect(await page.evaluate(() => sessionStorage.getItem('s3up:oidc:tokens'))).toBeNull();
});
