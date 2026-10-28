"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** The public site key (shipped to every browser by design; the secret half only ever lives on the server). */
export const TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
/**
 * The challenge is mandatory: with a site key, forms wait for a token; in production without one they stay blocked (a missing key must not
 * quietly remove the protection). Only local development without a key lets a form through without a token.
 */
export const captchaEnabled = TURNSTILE_SITE_KEY.length > 0 || process.env.NODE_ENV === "production";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not initialise")));
      script.onerror = () => {
        scriptPromise = null; // allow a retry on the next mount
        reject(new Error("Turnstile script failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Discards the current token and asks for a new challenge. A token works once, so call this after every submit. */
  reset: () => void;
}

interface TurnstileProps {
  /** Called with a token when the visitor passes, and with null when it expires, errors or is reset. */
  onToken: (token: string | null) => void;
  /** Called when the widget cannot run at all (script blocked, offline), so the form can say so. */
  onUnavailable?: () => void;
  /** "interaction-only" stays invisible unless Cloudflare needs the visitor to do something. */
  appearance?: "always" | "interaction-only";
  className?: string;
}

/** Renders nothing when no site key is configured. */
export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { onToken, onUnavailable, appearance = "always", className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const onTokenRef = useRef(onToken);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onTokenRef.current = onToken;
    onUnavailableRef.current = onUnavailable;
  });

  useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null);
      if (apiRef.current && widgetId.current) apiRef.current.reset(widgetId.current);
    },
  }));

  useEffect(() => {
    if (!captchaEnabled || !containerRef.current) return;
    let cancelled = false;
    const el = containerRef.current;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        apiRef.current = api;
        widgetId.current = api.render(el, {
          sitekey: TURNSTILE_SITE_KEY,
          appearance,
          theme: "auto",
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "timeout-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            onUnavailableRef.current?.();
          },
        });
      })
      .catch(() => {
        if (!cancelled) onUnavailableRef.current?.();
      });
    return () => {
      cancelled = true;
      onTokenRef.current(null); // a token left over from an unmounted widget has been (or will be) spent
      if (apiRef.current && widgetId.current) apiRef.current.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [appearance]);

  if (!captchaEnabled) return null;
  if (!TURNSTILE_SITE_KEY) {
    return (
      <p role="alert" className="text-center text-xs text-red-600 dark:text-red-400" data-testid="captcha-unconfigured">
        The security check is not available right now, so this form is paused. Please try again later.
      </p>
    );
  }
  return <div ref={containerRef} className={className} data-testid="captcha-widget" />;
});
