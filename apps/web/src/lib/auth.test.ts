import { HttpError } from '@s3up/core';
import { createAuthHeaders } from './auth';

describe('createAuthHeaders', () => {
  it('demo mode sends the demo user id', async () => {
    const headers = createAuthHeaders({ mode: 'demo', userId: 'demo-1' });
    expect(await headers()).toEqual({ 'x-user-id': 'demo-1' });
  });

  it('bearer mode sends the token, asking for a fresh one every time', async () => {
    let n = 0;
    const headers = createAuthHeaders({ mode: 'bearer', getToken: async () => `tok${++n}` });
    expect(await headers()).toEqual({ authorization: 'Bearer tok1' });
    expect(await headers()).toEqual({ authorization: 'Bearer tok2' });
  });

  it('bearer mode accepts a synchronous token provider and never sends x-user-id', async () => {
    const headers = createAuthHeaders({ mode: 'bearer', getToken: () => 'abc' });
    expect(await headers()).toEqual({ authorization: 'Bearer abc' });
  });

  it.each([
    ['no provider is installed', undefined],
    ['the provider returns an empty token', () => ''],
  ])('bearer mode fails with a non-retryable 401 when %s', async (_name, getToken) => {
    const err = await Promise.resolve(createAuthHeaders({ mode: 'bearer', getToken })()).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(err.message).toMatch(/not signed in/i);
  });

  it('bearer mode lets a rejecting provider surface its own error', async () => {
    const headers = createAuthHeaders({ mode: 'bearer', getToken: () => Promise.reject(new Error('refresh failed')) });
    await expect(headers()).rejects.toThrow('refresh failed');
  });
});
