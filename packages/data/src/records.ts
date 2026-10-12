import type { FileDto, FileStatus, ProcessingResult } from '@s3up/core';

/** The persisted shape of a file. A superset of FileDto: it also holds server-only fields. */
export interface FileRecord {
  id: string;
  userId: string;
  fileName: string;
  contentType: string;
  size: number;
  status: FileStatus;
  partSize: number;
  partCount: number;
  s3Key: string;
  s3UploadId: string;
  createdAt: string;
  updatedAt: string;
  uploadedAt?: string;
  processedAt?: string;
  etag?: string;
  versionId?: string;
  error?: string;
  result?: ProcessingResult;
  /** Epoch seconds, DynamoDB TTL. Cleared once the upload completes. */
  expiresAt?: number;
}

export function toDto(record: FileRecord, extras: Pick<FileDto, 'thumbnailUrl'> = {}): FileDto {
  const { id, fileName, contentType, size, status, partSize, partCount, createdAt, updatedAt } = record;
  return {
    id, fileName, contentType, size, status, partSize, partCount, createdAt, updatedAt,
    uploadedAt: record.uploadedAt,
    processedAt: record.processedAt,
    error: record.error,
    result: record.result,
    ...extras,
  };
}
