import { DEFAULT_PART_SIZE, MiB, S3_MAX_PART_SIZE, S3_MAX_PARTS, S3_MIN_PART_SIZE } from './limits';

export interface PartPlan {
  fileSize: number;
  partSize: number;
  partCount: number;
}

export interface PlanOptions {
  preferredPartSize?: number;
  minPartSize?: number;
  maxPartSize?: number;
  maxParts?: number;
}

export interface PartRange {
  partNumber: number;
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  end: number;
  size: number;
}

export class PlanError extends Error {
  constructor(
    readonly code: 'EMPTY_FILE' | 'INVALID_SIZE' | 'TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * Choose a part size and count for a file, respecting S3's limits:
 * every part except the last must be >= 5 MiB, at most 10,000 parts, and a
 * part can't exceed 5 GiB. Part sizes are rounded up to whole MiB so the
 * plan is easy to reason about (and to reproduce on both sides of the wire).
 */
export function planParts(fileSize: number, options: PlanOptions = {}): PartPlan {
  const minPartSize = Math.max(options.minPartSize ?? S3_MIN_PART_SIZE, S3_MIN_PART_SIZE);
  const maxPartSize = Math.min(options.maxPartSize ?? S3_MAX_PART_SIZE, S3_MAX_PART_SIZE);
  const maxParts = Math.min(options.maxParts ?? S3_MAX_PARTS, S3_MAX_PARTS);
  const preferred = options.preferredPartSize ?? DEFAULT_PART_SIZE;

  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new PlanError('INVALID_SIZE', `File size must be a non-negative integer, got ${fileSize}`);
  }
  if (fileSize === 0) {
    throw new PlanError('EMPTY_FILE', 'Empty files cannot be uploaded with multipart upload');
  }

  const roundUpToMiB = (n: number) => Math.ceil(n / MiB) * MiB;
  // Smallest part size that still fits the file into `maxParts` parts.
  const sizeForMaxParts = roundUpToMiB(Math.ceil(fileSize / maxParts));
  const partSize = Math.max(roundUpToMiB(preferred), roundUpToMiB(minPartSize), sizeForMaxParts);

  if (partSize > maxPartSize) {
    throw new PlanError('TOO_LARGE', `File of ${fileSize} bytes needs ${partSize}-byte parts, above the ${maxPartSize}-byte limit`);
  }

  return { fileSize, partSize, partCount: Math.ceil(fileSize / partSize) };
}

/** Byte range for a 1-based part number. */
export function partRange(plan: PartPlan, partNumber: number): PartRange {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new RangeError(`Part number ${partNumber} outside 1..${plan.partCount}`);
  }
  const start = (partNumber - 1) * plan.partSize;
  const end = Math.min(start + plan.partSize, plan.fileSize);
  return { partNumber, start, end, size: end - start };
}

export function allPartNumbers(plan: PartPlan): number[] {
  return Array.from({ length: plan.partCount }, (_, i) => i + 1);
}
