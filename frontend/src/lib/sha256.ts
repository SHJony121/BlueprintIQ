/**
 * SHA-256 of some bytes as lower-case hex, the form the backend reports
 * (`document.sha256`). Returns null where Web Crypto is unavailable (it needs a secure
 * context; 127.0.0.1 and localhost are), so callers can refuse rather than guess.
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
