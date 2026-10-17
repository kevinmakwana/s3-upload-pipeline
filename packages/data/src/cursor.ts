/**
 * Pagination cursors for FileStore.listByUser. A cursor names the last record a caller has seen
 * (its id and createdAt) and nothing else: the store rebuilds the position from the *caller's*
 * user id, so a forged cursor can never reach another user's records or inject key attributes.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface CursorPosition {
  id: string;
  createdAt: string;
}

const MAX_CURSOR_LENGTH = 512;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ i: position.id, c: position.createdAt })).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const { i, c } = (parsed ?? {}) as { i?: unknown; c?: unknown };
  if (typeof i !== 'string' || typeof c !== 'string' || !ID.test(i) || !TIMESTAMP.test(c)) throw new InvalidCursorError();
  return { id: i, createdAt: c };
}

export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_LIST_LIMIT = 100;

/** Whole numbers from 1 to MAX_LIST_LIMIT; anything else falls back to the default or the nearest bound. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}
