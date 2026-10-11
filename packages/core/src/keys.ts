export const UPLOAD_PREFIX = 'uploads/';
export const THUMBNAIL_PREFIX = 'thumbnails/';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUserId(userId: string): boolean {
  return USER_ID.test(userId);
}

export function isValidFileId(fileId: string): boolean {
  return FILE_ID.test(fileId);
}

/** Strip any path, keep a conservative character set, cap the length. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '');
  const trimmed = cleaned.slice(-128);
  return trimmed || 'file';
}

/** Every object lives under its owner's prefix: uploads/<userId>/<fileId>/<name>. */
export function buildObjectKey(userId: string, fileId: string, fileName: string): string {
  if (!isValidUserId(userId)) throw new Error('Invalid user id');
  if (!isValidFileId(fileId)) throw new Error('Invalid file id');
  return `${UPLOAD_PREFIX}${userId}/${fileId}/${sanitizeFileName(fileName)}`;
}

export function buildThumbnailKey(userId: string, fileId: string): string {
  return `${THUMBNAIL_PREFIX}${userId}/${fileId}.jpg`;
}

export function userPrefix(userId: string): string {
  return `${UPLOAD_PREFIX}${userId}/`;
}

export interface ParsedObjectKey {
  userId: string;
  fileId: string;
  fileName: string;
}

/** Inverse of buildObjectKey. Returns undefined for keys that don't match the layout. */
export function parseObjectKey(key: string): ParsedObjectKey | undefined {
  if (!key.startsWith(UPLOAD_PREFIX)) return undefined;
  const parts = key.slice(UPLOAD_PREFIX.length).split('/');
  if (parts.length !== 3) return undefined;
  const [userId, fileId, fileName] = parts as [string, string, string];
  if (!isValidUserId(userId) || !isValidFileId(fileId) || !fileName) return undefined;
  return { userId, fileId, fileName };
}
