import { buildThumbnailKey, parseObjectKey } from '@s3up/core';
import { createDocClient, createS3Client, deleteAllVersions, DynamoFileStore, type FileStore } from '@s3up/data';

/** The part of GuardDuty's "Malware Protection Object Scan Result" event this function reads. */
export interface ScanResultEvent {
  'detail-type'?: string;
  source?: string;
  detail: {
    scanStatus?: string;
    s3ObjectDetails?: { bucketName?: string; objectKey?: string; versionId?: string };
    scanResultDetails?: { scanResultStatus?: string; threats?: { name?: string }[] | null; statusReasons?: string[] | null };
  };
}

export interface ScanResultDeps {
  files: FileStore;
  bucket: string;
  /** Removes every version of a key from the bucket. */
  deleteAllVersions(key: string): Promise<void>;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type ScanOutcome =
  | { type: 'quarantined'; fileId: string }
  | { type: 'recorded'; status: string }
  | { type: 'ignored'; reason: string };

/** The longest reason kept on the record. */
const MAX_REASON = 280;

/**
 * Acts on GuardDuty's verdict for one uploaded object. A clean (or unscannable) result changes nothing:
 * the API decides downloads from the object's scan tag. A threat takes the file out of service first and
 * deletes its stored bytes second, so if the delete fails the event is retried with the file already
 * unreachable. Safe to run twice for the same event.
 */
export async function handleScanResult(event: ScanResultEvent, deps: ScanResultDeps): Promise<ScanOutcome> {
  const log = deps.log ?? (() => undefined);
  const status = event?.detail?.scanResultDetails?.scanResultStatus;
  const key = event?.detail?.s3ObjectDetails?.objectKey;
  const bucket = event?.detail?.s3ObjectDetails?.bucketName;
  if (!status || !key || !bucket) throw new Error('Not a malware scan result event');

  if (bucket !== deps.bucket) return { type: 'ignored', reason: 'another bucket' };
  const parsed = parseObjectKey(key);
  if (!parsed) return { type: 'ignored', reason: 'key outside uploads layout' };

  if (status !== 'THREATS_FOUND') {
    // UNSUPPORTED (say, a password-protected archive), ACCESS_DENIED and FAILED mean no verdict: the API refuses
    // to serve such a file, and someone should know about it.
    log(status === 'NO_THREATS_FOUND' ? 'scan result' : 'file could not be scanned', { key, status, reasons: event.detail.scanResultDetails?.statusReasons });
    return { type: 'recorded', status };
  }

  const file = await deps.files.get(parsed.fileId);
  if (!file || file.userId !== parsed.userId || file.s3Key !== key) {
    log('no matching file record', { key });
    return { type: 'ignored', reason: 'no matching file record' };
  }
  const thumbnailKey = file.result?.thumbnailKey ?? buildThumbnailKey(file.userId, file.id);

  const reason = describeThreats(event.detail.scanResultDetails?.threats);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  if (!(await deps.files.markQuarantined(file.id, reason, now))) return { type: 'ignored', reason: 'upload was aborted' };

  await deps.deleteAllVersions(key);
  await deps.deleteAllVersions(thumbnailKey);
  log('quarantined', { key, fileId: file.id, reason });
  return { type: 'quarantined', fileId: file.id };
}

function describeThreats(threats: { name?: string }[] | null | undefined): string {
  const names = (threats ?? []).map((t) => t.name).filter((n): n is string => !!n);
  const text = names.length ? `Malware found: ${names.join(', ')}` : 'Malware found';
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

let cached: ScanResultDeps | undefined;

/** Built lazily so importing the module (e.g. in tests) needs no AWS configuration. */
function defaultDeps(): ScanResultDeps {
  if (cached) return cached;
  const table = requiredEnv('TABLE_NAME');
  const bucket = requiredEnv('BUCKET_NAME');
  const s3 = createS3Client();
  cached = {
    files: new DynamoFileStore(createDocClient(), table),
    bucket,
    deleteAllVersions: (key) => deleteAllVersions(s3, bucket, key),
    log: (message, fields = {}) => console.log(JSON.stringify({ message, ...fields })),
  };
  return cached;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const handler = (event: ScanResultEvent): Promise<ScanOutcome> => handleScanResult(event, defaultDeps());
