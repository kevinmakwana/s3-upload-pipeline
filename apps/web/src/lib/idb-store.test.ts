import 'fake-indexeddb/auto';
import { IndexedDbResumeStore } from './idb-store';

const upload = (fileId: string) => ({
  fileId,
  fileName: 'big.bin',
  contentType: 'application/octet-stream',
  fileSize: 100,
  lastModified: 1,
  partSize: 10,
  partCount: 10,
  parts: { 1: { sha256: 'a', size: 10 }, 2: { sha256: 'b', size: 10 } },
  createdAt: 't',
  updatedAt: 't',
});

describe('IndexedDbResumeStore', () => {
  it('persists, lists and deletes upload sessions (what a reload relies on)', async () => {
    const writer = new IndexedDbResumeStore('t1');
    await writer.put(upload('f1'));
    await writer.put(upload('f2'));

    // A second instance stands in for the page after a refresh: same database, no shared memory.
    const reloaded = new IndexedDbResumeStore('t1');
    expect((await reloaded.list()).map((u) => u.fileId).sort()).toEqual(['f1', 'f2']);
    expect((await reloaded.get('f1'))?.parts[2]).toEqual({ sha256: 'b', size: 10 });

    await reloaded.delete('f1');
    expect(await writer.get('f1')).toBeUndefined();
    expect((await writer.list()).map((u) => u.fileId)).toEqual(['f2']);
  });

  it('overwrites a session as parts complete', async () => {
    const store = new IndexedDbResumeStore('t2');
    await store.put(upload('f1'));
    await store.put({ ...upload('f1'), parts: { 1: { sha256: 'a', size: 10 } } });
    expect(Object.keys((await store.get('f1'))!.parts)).toEqual(['1']);
  });
});
