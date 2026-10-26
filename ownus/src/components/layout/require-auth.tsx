'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/**
 * Pages in the signed-in area that can be browsed without an account. Discovery works anonymously (results are masked until a lead is
 * unlocked, and unlocking needs a login), and the landing page links straight to it.
 */
const PUBLIC_PREFIXES = ['/discover'];

/**
 * Keeps signed-out visitors out of the signed-in pages (dashboard, credits, leads, saved searches, settings). Without it those pages
 * rendered for anyone, with their data calls failing "No auth token" instead of sending the visitor to the login page. The API still
 * enforces access on every call; this is about not showing a broken shell, and about Sign Out actually leaving the page.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '';
  // user / isLoading change when a session is established or ended, which is when the token has to be looked at again
  const { user, isLoading } = useAuth();
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (isPublic) {
      setAllowed(true);
      return;
    }
    let hasToken = false;
    try {
      hasToken = !!localStorage.getItem('orion_access_token');
    } catch {
      /* storage unavailable: treated as signed out */
    }
    setAllowed(hasToken);
    if (!hasToken) router.replace('/login');
  }, [isPublic, pathname, user, isLoading, router]);

  return allowed ? <>{children}</> : null;
}
