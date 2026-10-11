import { MiB } from './limits';
import { planParts } from './planning';
import { reconcileParts } from './reconcile';

const plan = planParts(5 * 64 * MiB + 10 * MiB); // 6 parts, last is 10 MiB
const size = plan.partSize;
const last = 10 * MiB;

describe('reconcileParts', () => {
  it('uploads everything for a brand-new session', () => {
    expect(reconcileParts(plan, [], {})).toEqual({ done: [], upload: [1, 2, 3, 4, 5, 6], verify: [] });
  });

  it('keeps parts that match on both sides', () => {
    const r = reconcileParts(
      plan,
      [
        { partNumber: 1, size, sha256: 'a' },
        { partNumber: 2, size, sha256: 'b' },
      ],
      { 1: { sha256: 'a', size }, 2: { sha256: 'b', size } },
    );
    expect(r.done).toEqual([1, 2]);
    expect(r.upload).toEqual([3, 4, 5, 6]);
  });

  it('re-uploads parts whose checksum differs from what the browser sent', () => {
    const r = reconcileParts(plan, [{ partNumber: 1, size, sha256: 'server' }], { 1: { sha256: 'local', size } });
    expect(r.upload).toContain(1);
    expect(r.done).not.toContain(1);
  });

  it('re-uploads parts S3 holds with the wrong size', () => {
    const r = reconcileParts(plan, [{ partNumber: 3, size: size - 1, sha256: 'a' }], { 3: { sha256: 'a', size } });
    expect(r.upload).toContain(3);
  });

  it('forgets local parts that S3 no longer has (e.g. lifecycle abort + restart)', () => {
    const r = reconcileParts(plan, [], { 1: { sha256: 'a', size } });
    expect(r.done).toEqual([]);
    expect(r.upload).toContain(1);
  });

  it('asks for verification when local state was lost but S3 still has the part', () => {
    const r = reconcileParts(plan, [{ partNumber: 2, size, sha256: 'a' }], {});
    expect(r.verify).toEqual([2]);
  });

  it('handles the short final part', () => {
    const ok = reconcileParts(plan, [{ partNumber: 6, size: last, sha256: 'z' }], { 6: { sha256: 'z', size: last } });
    expect(ok.done).toEqual([6]);
    const wrong = reconcileParts(plan, [{ partNumber: 6, size, sha256: 'z' }], { 6: { sha256: 'z', size: last } });
    expect(wrong.upload).toContain(6);
  });

  it('ignores remote parts outside the plan', () => {
    const r = reconcileParts(plan, [{ partNumber: 99, size, sha256: 'a' }], {});
    expect([...r.done, ...r.upload, ...r.verify].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('trusts a local record when S3 reports no checksum', () => {
    const r = reconcileParts(plan, [{ partNumber: 1, size }], { 1: { sha256: 'a', size } });
    expect(r.done).toEqual([1]);
    const r2 = reconcileParts(plan, [{ partNumber: 1, size }], {});
    expect(r2.upload).toContain(1);
  });
});
