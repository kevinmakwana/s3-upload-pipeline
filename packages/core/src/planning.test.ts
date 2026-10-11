import { GiB, MiB, S3_MAX_PARTS, S3_MIN_PART_SIZE } from './limits';
import { PlanError, partRange, planParts } from './planning';

describe('planParts', () => {
  it('uses the preferred part size for typical files', () => {
    const plan = planParts(1 * GiB);
    expect(plan.partSize).toBe(64 * MiB);
    expect(plan.partCount).toBe(16);
  });

  it('plans 15 GiB comfortably under the part limit', () => {
    const plan = planParts(15 * GiB);
    expect(plan.partCount).toBe(240);
    expect(plan.partCount).toBeLessThanOrEqual(S3_MAX_PARTS);
  });

  it('never goes below the 5 MiB minimum, even if asked to', () => {
    const plan = planParts(100 * MiB, { preferredPartSize: 1 * MiB });
    expect(plan.partSize).toBe(S3_MIN_PART_SIZE);
    expect(plan.partCount).toBe(20);
  });

  it('uses a single (short) part for files smaller than the minimum', () => {
    const plan = planParts(1234);
    expect(plan.partCount).toBe(1);
    expect(partRange(plan, 1)).toMatchObject({ start: 0, end: 1234, size: 1234 });
  });

  it('grows the part size so the count never exceeds 10,000', () => {
    // 5 MiB parts would need 20,000 parts for 100,000 MiB.
    const fileSize = 100_000 * MiB;
    const plan = planParts(fileSize, { preferredPartSize: 5 * MiB });
    expect(plan.partCount).toBeLessThanOrEqual(S3_MAX_PARTS);
    expect(plan.partSize).toBe(10 * MiB);
    expect(plan.partCount * plan.partSize).toBeGreaterThanOrEqual(fileSize);
  });

  it('lands exactly on the limit boundary', () => {
    const fileSize = S3_MAX_PARTS * 5 * MiB;
    const plan = planParts(fileSize, { preferredPartSize: 5 * MiB });
    expect(plan).toEqual({ fileSize, partSize: 5 * MiB, partCount: S3_MAX_PARTS });
    const plusOne = planParts(fileSize + 1, { preferredPartSize: 5 * MiB });
    expect(plusOne.partCount).toBeLessThanOrEqual(S3_MAX_PARTS);
    expect(plusOne.partSize).toBe(6 * MiB);
  });

  it('rejects empty and invalid sizes', () => {
    expect(() => planParts(0)).toThrow(PlanError);
    expect(() => planParts(-1)).toThrow(PlanError);
    expect(() => planParts(1.5)).toThrow(PlanError);
    expect(() => planParts(Number.NaN)).toThrow(PlanError);
  });

  it('rejects files that cannot fit within the 5 GiB part limit', () => {
    expect(() => planParts(60_000 * GiB)).toThrow(/limit/);
  });

  it('produces plans whose parts exactly tile the file', () => {
    for (const size of [1, 5 * MiB, 5 * MiB + 1, 64 * MiB, 64 * MiB + 1, 3 * GiB + 12345]) {
      const plan = planParts(size);
      let covered = 0;
      for (let n = 1; n <= plan.partCount; n++) {
        const r = partRange(plan, n);
        expect(r.start).toBe(covered);
        covered += r.size;
        if (n < plan.partCount) expect(r.size).toBeGreaterThanOrEqual(S3_MIN_PART_SIZE);
      }
      expect(covered).toBe(size);
    }
  });
});

describe('partRange', () => {
  it('rejects out-of-range part numbers', () => {
    const plan = planParts(200 * MiB);
    expect(() => partRange(plan, 0)).toThrow(RangeError);
    expect(() => partRange(plan, plan.partCount + 1)).toThrow(RangeError);
    expect(() => partRange(plan, 1.5)).toThrow(RangeError);
  });
});
