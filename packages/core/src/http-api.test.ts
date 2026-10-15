import { HttpError } from './errors';
import { HttpUploadApi } from './http-api';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe('HttpUploadApi', () => {
  it('identifies the caller with x-user-id in demo mode', async () => {
    const { fn, calls } = fakeFetch(() => json({ files: [] }));
    await new HttpUploadApi({ baseUrl: 'http://api/', userId: 'alice', fetch: fn }).listFiles();
    expect(calls[0]!.url).toBe('http://api/files');
    expect(headersOf(calls[0]!)).toEqual({ 'x-user-id': 'alice' });
  });

  it('asks the header provider before every request (so refreshed tokens are picked up)', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => json({ files: [] }));
    const api = new HttpUploadApi({ baseUrl: 'http://api', getHeaders: async () => ({ authorization: `Bearer t${++n}` }), fetch: fn });
    await api.listFiles();
    await api.listFiles();
    expect(calls.map((c) => headersOf(c).authorization)).toEqual(['Bearer t1', 'Bearer t2']);
    expect(headersOf(calls[0]!)['x-user-id']).toBeUndefined();
  });

  it('turns a failing token provider into a non-retryable 401, without calling the API', async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const api = new HttpUploadApi({ baseUrl: 'http://api', getHeaders: () => Promise.reject(new Error('refresh failed')), fetch: fn });
    const err = await api.listFiles().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 401, retryable: false, message: 'refresh failed' });
    expect(calls).toHaveLength(0);
  });

  it('sends JSON bodies and unwraps responses', async () => {
    const { fn, calls } = fakeFetch(() => json({ file: { id: 'f1' } }, 201));
    const file = await new HttpUploadApi({ baseUrl: 'http://api', userId: 'a', fetch: fn }).init({ fileName: 'a.bin', fileSize: 1, contentType: 'application/octet-stream' });
    expect(file).toEqual({ id: 'f1' });
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ fileName: 'a.bin' });
  });

  it('surfaces server messages and statuses (joining validation lists)', async () => {
    const { fn } = fakeFetch(() => json({ statusCode: 400, message: ['fileSize: too big', 'fileName: empty'] }, 400));
    const err = await new HttpUploadApi({ baseUrl: 'http://api', userId: 'a', fetch: fn }).listFiles().catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: 'fileSize: too big; fileName: empty' });
  });

  it('treats a network failure as retryable (no status) and 5xx as retryable by default', async () => {
    const down = new HttpUploadApi({ baseUrl: 'http://api', userId: 'a', fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    expect(await down.listFiles().catch((e) => e)).toMatchObject({ status: undefined, message: 'fetch failed' });
    const { fn } = fakeFetch(() => new Response('oops', { status: 503 }));
    expect(await new HttpUploadApi({ baseUrl: 'http://api', userId: 'a', fetch: fn }).listFiles().catch((e) => e)).toMatchObject({ status: 503, message: 'HTTP 503' });
  });

  it('handles 204 No Content from abort()', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(new HttpUploadApi({ baseUrl: 'http://api', userId: 'a', fetch: fn }).abort('f1')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: 'http://api/uploads/f1', init: { method: 'DELETE' } });
  });

  it('requires some way to authenticate', async () => {
    const { fn } = fakeFetch(() => json({}));
    const err = await new HttpUploadApi({ baseUrl: 'http://api', fetch: fn }).listFiles().catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
  });
});
