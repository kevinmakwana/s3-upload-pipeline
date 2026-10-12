import { IndexedDbResumeStore } from './idb-store';
import { BrowserFileSource } from './browser-source';
import { createHttpApi, UploadManager } from './manager';
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

export const userId = demoUserId();

export const manager = new UploadManager({
  api: createHttpApi(API_URL, userId),
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
