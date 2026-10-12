import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PersistedUpload, ResumeStore } from '@s3up/core';

interface Schema extends DBSchema {
  uploads: { key: string; value: PersistedUpload };
  handles: { key: string; value: FileSystemFileHandle };
}

/**
 * Upload sessions survive reloads here: the S3 upload id (via fileId) and the parts this
 * browser has finished. File handles are kept separately because only Chromium can store them.
 */
export class IndexedDbResumeStore implements ResumeStore {
  private db?: Promise<IDBPDatabase<Schema>>;

  constructor(private readonly name = 's3up') {}

  private open() {
    this.db ??= openDB<Schema>(this.name, 1, {
      upgrade(db) {
        db.createObjectStore('uploads', { keyPath: 'fileId' });
        db.createObjectStore('handles');
      },
    });
    return this.db;
  }

  async get(fileId: string) {
    return (await this.open()).get('uploads', fileId);
  }
  async put(upload: PersistedUpload) {
    await (await this.open()).put('uploads', upload);
  }
  async delete(fileId: string) {
    const db = await this.open();
    const tx = db.transaction(['uploads', 'handles'], 'readwrite');
    await Promise.all([tx.objectStore('uploads').delete(fileId), tx.objectStore('handles').delete(fileId), tx.done]);
  }
  async list(): Promise<PersistedUpload[]> {
    return (await this.open()).getAll('uploads');
  }
  async putHandle(fileId: string, handle: FileSystemFileHandle) {
    try {
      await (await this.open()).put('handles', handle, fileId);
    } catch {
      // Handles can't be structured-cloned outside Chromium; resuming then asks for the file again.
    }
  }
  async getHandle(fileId: string): Promise<FileSystemFileHandle | undefined> {
    try {
      return await (await this.open()).get('handles', fileId);
    } catch {
      return undefined;
    }
  }
}
