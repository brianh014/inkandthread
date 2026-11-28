/** Base64 for pictures sent to and from image APIs, in Bun and in the browser alike, as the phone app has no Buffer (ADR 0006). */

// Small enough for String.fromCharCode's argument limit, large enough to stay fast on a several-megabyte picture.
const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
