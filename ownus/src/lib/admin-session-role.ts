/**
 * Which administrator role is signed in, for deciding what the admin panel SHOWS.
 *
 * The role comes from the signed admin session token. The browser cannot verify that signature, so this is only ever used to hide or
 * block screens; it is never a security boundary. Every action that matters is checked again by the server with the verified role
 * (for example credits, pricing and refunds are SUPER_ADMIN-only in the API).
 */
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'DATA_MANAGER';

const KNOWN: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'ADMIN', 'DATA_MANAGER']);

/** The role claim of a JWT, or null when the token is missing, malformed, or names no known admin role. */
export function roleFromToken(token: string | null | undefined): AdminRole | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' && KNOWN.has(role) ? (role as AdminRole) : null;
  } catch {
    return null;
  }
}

/** The Roles & Permissions screen is for a Super Admin only. Anything else, including an unknown or missing role, is denied. */
export const canAccessRoles = (role: AdminRole | null | undefined): boolean => role === 'SUPER_ADMIN';
