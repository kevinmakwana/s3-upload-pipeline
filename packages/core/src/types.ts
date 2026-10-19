/**
 * Lifecycle of a file: uploading -> uploaded -> processing -> ready | failed (or aborted).
 * `quarantined` is final: a malware scan found a threat and the stored file was deleted.
 */
export const FILE_STATUSES = ['uploading', 'uploaded', 'processing', 'ready', 'failed', 'aborted', 'quarantined'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export interface ProcessingResult {
  /** Hex SHA-256 of the full object, computed by the worker. */
  sha256: string;
  size: number;
  /** Content type detected from magic bytes, when recognised. */
  detectedType?: string;
  width?: number;
  height?: number;
  thumbnailKey?: string;
  /** Why no thumbnail was produced (not an image, too large, ...). */
  thumbnailSkipped?: string;
}

export interface FileDto {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  status: FileStatus;
  partSize: number;
  partCount: number;
  createdAt: string;
  updatedAt: string;
  uploadedAt?: string;
  processedAt?: string;
  error?: string;
  result?: ProcessingResult;
  /** Short-lived presigned GET URL, only present for ready images with a thumbnail. */
  thumbnailUrl?: string;
}

/** One page of the file list, newest first. */
export interface FilePage {
  files: FileDto[];
  /** Pass back as `cursor` to get the next page. Absent on the last page. */
  nextCursor?: string;
}

/** A short-lived link that downloads the original file. */
export interface DownloadUrlResponse {
  url: string;
  expiresAt: string;
}

export interface InitUploadRequest {
  fileName: string;
  fileSize: number;
  contentType: string;
}

export interface InitUploadResponse {
  file: FileDto;
}

export interface PresignPartRequest {
  /** Base64 SHA-256 of the part bytes. */
  sha256: string;
}

export interface PresignPartResponse {
  url: string;
  method: 'PUT';
  /** Headers the browser MUST send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface RemotePart {
  partNumber: number;
  size: number;
  etag?: string;
  /** Base64 SHA-256 stored by S3 for this part. */
  sha256?: string;
}

export interface ListPartsResponse {
  file: FileDto;
  parts: RemotePart[];
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}
