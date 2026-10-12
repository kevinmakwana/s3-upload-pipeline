import { HttpError, type PartTransport, type PutRequest } from '@s3up/core';

/** XMLHttpRequest instead of fetch, because only XHR reports upload progress. */
export class XhrTransport implements PartTransport {
  put({ url, headers, body, signal, onProgress }: PutRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

      const onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const done = () => signal.removeEventListener('abort', onAbort);

      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        // 400 = S3 saw different bytes than the signed checksum, 403 = signature expired: both
        // are fixed by re-reading, re-hashing and re-signing, so they are worth retrying.
        const retryable = xhr.status === 400 || xhr.status === 403 ? true : undefined;
        reject(new HttpError(`S3 rejected part (HTTP ${xhr.status})`, xhr.status, retryable));
      };
      xhr.onerror = () => {
        done();
        reject(new HttpError('Network error while uploading a part'));
      };
      xhr.onabort = () => {
        done();
        reject(abortError());
      };
      xhr.send(body as Uint8Array<ArrayBuffer>);
    });
  }
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
