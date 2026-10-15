import { HttpError, type HeaderProvider } from '@s3up/core';

export type AuthSetup =
  | { mode: 'demo'; userId: string }
  | { mode: 'bearer'; getToken?: () => string | undefined | Promise<string | undefined> };

/**
 * The headers that identify the caller, asked for before every request.
 * demo:   x-user-id, a random id kept in localStorage.
 * bearer: Authorization: Bearer <token>, with the token supplied by your login code through
 *         window.s3upAuth.getToken() (refresh it there).
 */
export function createAuthHeaders(setup: AuthSetup): HeaderProvider {
  if (setup.mode === 'demo') return () => ({ 'x-user-id': setup.userId });
  return async () => {
    const token = await setup.getToken?.();
    if (!token) throw new HttpError('Not signed in: window.s3upAuth.getToken() returned no token', 401, false);
    return { authorization: `Bearer ${token}` };
  };
}
