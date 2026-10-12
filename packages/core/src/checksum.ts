export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Base64 SHA-256 of `data` using WebCrypto (browser and Node >= 20). */
export async function sha256Base64(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return bytesToBase64(new Uint8Array(digest));
}
