import type { S3Client } from '@aws-sdk/client-s3';
import { MemoryFileStore, type FileRecord, type FileStore } from '@s3up/data';
import { Subject, type Subscription } from 'rxjs';
import { newRecord } from '../../../../packages/data/src/testing/contract';
import { FakeS3 } from '../testing/fake-s3';
import { offlinePresigner, testConfig } from '../testing/harness';
import type { ChangeFeed } from './change-feed';
import { FilesService } from './files.service';

/** A feed the test wakes by hand. */
class ManualFeed implements ChangeFeed {
  private readonly wakes = new Subject<void>();
  changes() {
    return this.wakes.asObservable();
  }
  wake() {
    this.wakes.next();
  }
}

/** Counts how often the list is read. */
class CountingStore extends MemoryFileStore {
  reads = 0;
  override async listByUser(...args: Parameters<FileStore['listByUser']>) {
    this.reads++;
    return super.listByUser(...args);
  }
}

const open: Subscription[] = [];
afterEach(() => open.splice(0).forEach((s) => s.unsubscribe()));

function setup() {
  const files = new CountingStore();
  const feed = new ManualFeed();
  const service = new FilesService(testConfig, new FakeS3() as unknown as S3Client, offlinePresigner(), files, feed);
  const events: { type: string; data: { files?: { id: string; status: string }[] } }[] = [];
  const watch = (userId = 'alice') => open.push(service.stream(userId).subscribe((e) => events.push(e as (typeof events)[number])));
  const add = async (overrides: Partial<FileRecord> = {}) => {
    const record = newRecord({ userId: 'alice', status: 'uploading', ...overrides });
    await files.create(record);
    return record;
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { files, feed, service, events, watch, add, settle };
}

describe('FilesService.stream', () => {
  it('sends an empty list too when a connection opens, so a client with no files (or one that reconnects after deleting them all) is told', async () => {
    const { events, watch, settle } = setup();
    watch();
    await settle();
    expect(events).toEqual([{ type: 'files', data: { files: [] } }]);
  });

  it('sends the current list when a connection opens, even if it is empty', async () => {
    const { events, watch, add, settle } = setup();
    const file = await add();
    watch();
    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'files', data: { files: [{ id: file.id, status: 'uploading' }] } });
  });

  it('reads the list again only when the feed says something changed, not on a timer of its own', async () => {
    const { files, feed, events, watch, add, settle } = setup();
    await add();
    watch();
    await settle();
    const readsAfterOpen = files.reads;

    await settle();
    await settle();
    expect(files.reads).toBe(readsAfterOpen); // idle connections cost nothing

    feed.wake();
    await settle();
    expect(files.reads).toBe(readsAfterOpen + 1);
    expect(events).toHaveLength(1); // read, but nothing differed, so nothing was sent
  });

  it('sends a new event when a wake-up finds that the list changed', async () => {
    const { files, feed, events, watch, add, settle } = setup();
    const file = await add();
    watch();
    await settle();

    await files.markUploaded(file.id, { at: new Date().toISOString() });
    feed.wake();
    await settle();

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ data: { files: [{ id: file.id, status: 'uploaded' }] } });
  });

  it('sends a changed list once however many wake-ups follow it', async () => {
    const { files, feed, events, watch, add, settle } = setup();
    const file = await add();
    watch();
    await settle();
    await files.markUploaded(file.id, { at: new Date().toISOString() });
    for (let i = 0; i < 5; i++) feed.wake();
    await settle();
    expect(events).toHaveLength(2);
  });

  it('never misses a change that arrives while an earlier read is still going', async () => {
    const { files, feed, events, watch, add } = setup();
    const file = await add();
    const real = files.listByUser.bind(files);
    // The first read after opening is slow and returns the old list; the change lands meanwhile.
    let slow = true;
    files.listByUser = async (...args) => {
      const result = await real(...args);
      if (slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 40));
      }
      return result;
    };
    watch();
    await new Promise((r) => setTimeout(r, 5));
    await files.markUploaded(file.id, { at: new Date().toISOString() });
    feed.wake(); // arrives while the slow read is in flight
    await new Promise((r) => setTimeout(r, 120));

    expect(events.at(-1)).toMatchObject({ data: { files: [{ id: file.id, status: 'uploaded' }] } });
  });

  it("does not show one user another user's changes", async () => {
    const { feed, events, watch, add, settle } = setup();
    await add({ userId: 'bob' });
    watch('alice');
    await settle();
    feed.wake();
    await settle();
    expect(events.every((e) => e.data.files?.length === 0)).toBe(true);
  });

  it('ends with the error when the list cannot be read, so the client reconnects', async () => {
    const { files, service, settle } = setup();
    files.listByUser = async () => {
      throw new Error('DynamoDB is down');
    };
    const errors: unknown[] = [];
    open.push(service.stream('alice').subscribe({ error: (e) => errors.push(e) }));
    await settle();
    expect(errors).toEqual([expect.objectContaining({ message: 'DynamoDB is down' })]);
  });
});
