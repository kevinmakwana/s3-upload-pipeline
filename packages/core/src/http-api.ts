import { HttpError } from './errors';
import type { UploadApi } from './engine';
import type { FileDto, FilePage, InitUploadRequest, InitUploadResponse, ListPartsResponse, PresignPartResponse } from './types';

export type HeaderProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface HttpApiOptions {
  baseUrl: string;
  /** Demo auth: sent as x-user-id. Ignored when `getHeaders` is given. */
  userId?: string;
  /** Real auth: called before every request, e.g. to return `{ authorization: 'Bearer <token>' }`. */
  getHeaders?: HeaderProvider;
  fetch?: typeof fetch;
}

/** Headers that identify the caller, from whichever auth method is configured. */
export function authHeaders(options: Pick<HttpApiOptions, 'userId' | 'getHeaders'>): Promise<Record<string, string>> | Record<string, string> {
  if (options.getHeaders) return options.getHeaders();
  if (!options.userId) throw new Error('HttpUploadApi needs either userId or getHeaders');
  return { 'x-user-id': options.userId };
}

/** UploadApi over the Nest HTTP API. Works in browsers and Node (global fetch). */
export class HttpUploadApi implements UploadApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HttpApiOptions) {
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async init(req: InitUploadRequest): Promise<FileDto> {
    return (await this.request<InitUploadResponse>('POST', '/uploads', req)).file;
  }

  listParts(fileId: string): Promise<ListPartsResponse> {
    return this.request('GET', `/uploads/${fileId}/parts`);
  }

  presignPart(fileId: string, partNumber: number, sha256: string): Promise<PresignPartResponse> {
    return this.request('POST', `/uploads/${fileId}/parts/${partNumber}/presign`, { sha256 });
  }

  async complete(fileId: string): Promise<FileDto> {
    return (await this.request<{ file: FileDto }>('POST', `/uploads/${fileId}/complete`)).file;
  }

  async abort(fileId: string): Promise<void> {
    await this.request('DELETE', `/uploads/${fileId}`);
  }

  /** One page of files, newest first. Pass the previous page's `nextCursor` to continue. */
  async listFilesPage(options: { limit?: number; cursor?: string } = {}): Promise<FilePage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const suffix = query.size ? `?${query}` : '';
    return this.request<FilePage>('GET', `/files${suffix}`);
  }

  /** The newest page of files only; use `listFilesPage` to go further back. */
  async listFiles(): Promise<FileDto[]> {
    return (await this.listFilesPage()).files;
  }

  async getFile(fileId: string): Promise<FileDto> {
    return this.request('GET', `/files/${fileId}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let auth: Record<string, string>;
    try {
      auth = await authHeaders(this.options);
    } catch (err) {
      // e.g. the token could not be refreshed: signing in again is the fix, so don't retry blindly.
      throw new HttpError(err instanceof Error ? err.message : 'Not signed in', 401, false);
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new HttpError(err instanceof Error ? err.message : 'Network error'); // no status: retryable
    }
    if (!res.ok) throw new HttpError(await errorMessage(res), res.status);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const m = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return m ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
