// A live Checkout address carries a long fragment, which is why this is not the 2048 of an ordinary link
const MAX_LENGTH = 8192;

/** An address the browser is sent to for paying or managing a subscription: a web page over https, never something a script can run from */
export function paymentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
}
