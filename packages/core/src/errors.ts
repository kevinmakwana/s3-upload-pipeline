/** An HTTP-ish failure. `retryable` overrides the status-based default when set. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The multipart upload no longer exists server-side (expired / aborted). */
export class UploadGoneError extends Error {
  constructor(message = 'Upload no longer exists') {
    super(message);
    this.name = 'UploadGoneError';
  }
}

export class FileChangedError extends Error {
  constructor(message = 'The file changed since the upload started') {
    super(message);
    this.name = 'FileChangedError';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.retryable !== undefined) return err.retryable;
    if (err.status === undefined) return true; // network error
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return false;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
