import { HttpUploadApi, type HeaderProvider } from '@s3up/core';
import { createAuthHeaders } from './auth';
import { IndexedDbResumeStore } from './idb-store';
import { BrowserFileSource } from './browser-source';
import { UploadManager } from './manager';
import { XhrTransport } from './xhr-transport';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * Demo identity: a random id kept in localStorage, sent as x-user-id. It stands in for a real
 * login; the API scopes every object key and every lookup to it.
 */
export function demoUserId(): string {
  try {
    const existing = localStorage.getItem('s3up:user');
    if (existing) return existing;
    const created = `demo-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem('s3up:user', created);
    return created;
  } catch {
    return 'demo-user';
  }
}

export const authMode: 'demo' | 'bearer' = import.meta.env.VITE_AUTH_MODE === 'bearer' ? 'bearer' : 'demo';
export const userId = authMode === 'demo' ? demoUserId() : undefined;

export const getAuthHeaders: HeaderProvider = createAuthHeaders(
  authMode === 'bearer' ? { mode: 'bearer', getToken: () => window.s3upAuth?.getToken() } : { mode: 'demo', userId: userId! },
);

/** The link carries `Content-Disposition: attachment`, so clicking it saves the file and the page stays put. */
function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export const manager = new UploadManager({
  startDownload,
  api: new HttpUploadApi({ baseUrl: API_URL, getHeaders: getAuthHeaders }),
  transport: new XhrTransport(),
  store: new IndexedDbResumeStore(),
  makeSource: (file) => new BrowserFileSource(file),
  storage: (() => {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  })(),
});

// Handy for poking at uploads from the console while developing (not included in production builds).
if (import.meta.env.DEV) (window as unknown as { __s3up: UploadManager }).__s3up = manager;
