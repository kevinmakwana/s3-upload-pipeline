export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;

/** Hard S3 multipart limits (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html). */
export const S3_MIN_PART_SIZE = 5 * MiB;
export const S3_MAX_PART_SIZE = 5 * GiB;
export const S3_MAX_PARTS = 10_000;

/** Defaults used by this project. 64 MiB keeps a 15 GiB file at 240 parts. */
export const DEFAULT_PART_SIZE = 64 * MiB;
export const DEFAULT_MAX_FILE_SIZE = 20 * GiB;
