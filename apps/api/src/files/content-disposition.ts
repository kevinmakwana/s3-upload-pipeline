/** A half of a surrogate pair; encodeURIComponent throws on it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A Content-Disposition value that makes the browser save the file under its original name.
 * The name is user-controlled, so control characters (header injection) are dropped, the quoted
 * fallback loses anything that could end the quote, and the real name travels in RFC 5987 form.
 */
export function attachmentDisposition(fileName: string): string {
  const clean = fileName.replace(LONE_SURROGATE, '\ufffd').replace(/[\u0000-\u001f\u007f]/g, '');
  const fallback = clean.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
