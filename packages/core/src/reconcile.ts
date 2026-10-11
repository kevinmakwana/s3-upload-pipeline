import { PartPlan, allPartNumbers, partRange } from './planning';
import type { RemotePart } from './types';

export interface LocalPart {
  /** Base64 SHA-256 of the part, as computed by this client. */
  sha256: string;
  size: number;
}

export interface Reconciliation {
  /** Parts S3 has and that we trust: nothing to do. */
  done: number[];
  /** Parts that must be (re)uploaded. */
  upload: number[];
  /**
   * Parts S3 has with the right size but that we have no local hash for
   * (e.g. IndexedDB was cleared). The caller hashes the local slice and
   * compares it with the remote checksum before deciding.
   */
  verify: number[];
}

/**
 * Decide, per part, whether it needs uploading by comparing the server's
 * ListParts answer (source of truth) with what this browser remembers.
 *
 * - Missing remotely -> upload (local memory of it is stale).
 * - Wrong size remotely -> upload.
 * - Checksums known on both sides: equal -> done, different -> upload.
 * - Remote checksum but no local record -> verify against the file.
 * - Remote part has no checksum -> trust only if we hold a local record.
 */
export function reconcileParts(
  plan: PartPlan,
  remoteParts: readonly RemotePart[],
  localParts: Readonly<Record<number, LocalPart>>,
): Reconciliation {
  const remote = new Map(remoteParts.map((p) => [p.partNumber, p]));
  const result: Reconciliation = { done: [], upload: [], verify: [] };

  for (const partNumber of allPartNumbers(plan)) {
    const expectedSize = partRange(plan, partNumber).size;
    const r = remote.get(partNumber);
    const l = localParts[partNumber];

    if (!r || r.size !== expectedSize) {
      result.upload.push(partNumber);
    } else if (r.sha256 && l) {
      (r.sha256 === l.sha256 && l.size === expectedSize ? result.done : result.upload).push(partNumber);
    } else if (r.sha256) {
      result.verify.push(partNumber);
    } else if (l && l.size === expectedSize) {
      result.done.push(partNumber);
    } else {
      result.upload.push(partNumber);
    }
  }
  return result;
}
