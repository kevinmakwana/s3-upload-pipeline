import { HttpError } from './errors';
import type { UploadApi } from './engine';
import type { FileDto, InitUploadRequest, InitUploadResponse, ListPartsResponse, PresignPartResponse } from './types';

export interface HttpApiOptions {
  baseUrl: string;
  userId: string;
  fetch?: typeof fetch;
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

  async listFiles(): Promise<FileDto[]> {
    return (await this.request<{ files: FileDto[] }>('GET', '/files')).files;
  }

  async getFile(fileId: string): Promise<FileDto> {
    return this.request('GET', `/files/${fileId}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { 'x-user-id': this.options.userId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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
