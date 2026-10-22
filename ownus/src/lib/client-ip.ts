/**
 * The client address the gateway tells the API about.
 *
 * The API rate-limits per IP and, in production, trusts exactly ONE proxy hop (`trust proxy` = 1), which means it reads the right-most
 * `X-Forwarded-For` entry. The gateway used to copy the browser's own `X-Forwarded-For` through unchanged; unless a trusted proxy appends
 * to it, a client could then send a different value on every request and never hit a per-IP limit.
 *
 * On Vercel the platform sets `x-vercel-forwarded-for` itself and overwrites anything the client sends, so it is the one value that can be
 * trusted. When it is present the gateway forwards ONLY that address. Without it (local development, Docker) the headers are left as they
 * were, which is the previous behaviour.
 */
/** A copy of the incoming headers that is safe to send to the API: the client address is the platform's, when the platform provides one. */
export function headersForApi(incoming: Headers): Headers {
  const out = new Headers(incoming);
  const ip = trustedForwardedFor(incoming);
  if (ip) out.set('x-forwarded-for', ip);
  return out;
}

export function trustedForwardedFor(headers: { get(name: string): string | null }): string | null {
  const vercel = headers.get('x-vercel-forwarded-for');
  if (vercel) {
    const first = vercel.split(',')[0]?.trim();
    // an IPv4 / IPv6 literal only: never pass arbitrary text on to the API
    if (first && /^[0-9a-fA-F:.]{2,45}$/.test(first)) return first;
  }
  return null;
}
