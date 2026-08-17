/**
 * An admin setting somebody else's password reads it out over the phone more often than they type
 * it twice, so the alphabet leaves out the pairs that get misheard or mistyped: I l 1, O 0, and
 * every symbol. Twenty characters of the remaining 56 is about 116 bits, which is far more than
 * the thing it protects until its owner changes it.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export const GENERATED_PASSWORD_LENGTH = 20;

export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  // Bytes that would land in the short tail are thrown away rather than folded with a modulo,
  // which would make the first 32 characters of the alphabet likelier than the rest.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const out: string[] = [];

  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }

  return out.join("");
}
