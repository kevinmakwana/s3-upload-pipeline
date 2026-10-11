import { DEFAULT_MAX_FILE_SIZE } from './limits';
import { sanitizeFileName } from './keys';

/** Allowed content types and the file extensions accepted for each. */
export const DEFAULT_ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'application/gzip': ['gz', 'tgz'],
  'application/x-tar': ['tar'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov'],
  'text/csv': ['csv'],
  'text/plain': ['txt', 'log'],
  'application/octet-stream': ['bin', 'dat'],
};

export interface ValidationRules {
  maxFileSize: number;
  allowedTypes: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_RULES: ValidationRules = {
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  allowedTypes: DEFAULT_ALLOWED_TYPES,
};

export interface UploadCandidate {
  fileName: string;
  fileSize: number;
  contentType: string;
}

/** Returns a list of human-readable problems; empty means the file is acceptable. */
export function validateUpload(candidate: UploadCandidate, rules: ValidationRules = DEFAULT_RULES): string[] {
  const problems: string[] = [];
  const { fileName, fileSize, contentType } = candidate;

  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    problems.push('File must not be empty');
  } else if (fileSize > rules.maxFileSize) {
    problems.push(`File is ${fileSize} bytes; the maximum is ${rules.maxFileSize} bytes`);
  }

  const extensions = rules.allowedTypes[contentType.toLowerCase()];
  if (!extensions) {
    problems.push(`Content type "${contentType}" is not allowed`);
  } else {
    const ext = fileExtension(sanitizeFileName(fileName));
    if (!ext || !extensions.includes(ext)) {
      problems.push(`Extension ".${ext}" does not match content type ${contentType} (expected ${extensions.map((e) => `.${e}`).join(', ')})`);
    }
  }
  return problems;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}
