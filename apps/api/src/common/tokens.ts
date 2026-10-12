export const CONFIG = Symbol('CONFIG');
/** S3 client for API-side calls (CreateMultipartUpload, ListParts, ...). */
export const S3 = Symbol('S3');
/** S3 client whose endpoint is the one the browser can reach; used only to sign URLs. */
export const S3_PRESIGNER = Symbol('S3_PRESIGNER');
export const FILES = Symbol('FILES');
export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
