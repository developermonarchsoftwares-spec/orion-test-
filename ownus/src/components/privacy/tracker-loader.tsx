"use client";

import { useEffect } from "react";
import { getLocalConsent } from "@/lib/consent";
import { flushPendingConsents } from "@/lib/consent-sync";
import { planTrackers } from "@/lib/trackers";

const ATTR = "data-orion-tracker";

/** Injects registered non-essential scripts only after consent, and reloads the page when consent for a loaded one is withdrawn (a running script cannot be unloaded). */
export function TrackerLoader() {
  useEffect(() => {
    const sync = () => {
      const loaded = new Set(Array.from(document.querySelectorAll(`script[${ATTR}]`)).map((el) => el.getAttribute(ATTR) as string));
      const { load, withdrawn } = planTrackers(getLocalConsent(), loaded);
      for (const t of load) {
        const el = document.createElement("script");
        el.src = t.src;
        el.async = true;
        el.setAttribute(ATTR, t.id);
        for (const [k, v] of Object.entries(t.attrs ?? {})) el.setAttribute(k, v);
        document.head.appendChild(el);
      }
      if (withdrawn.length) window.location.reload();
    };
    sync();
    void flushPendingConsents();
    window.addEventListener("orion:consent", sync);
    return () => window.removeEventListener("orion:consent", sync);
  }, []);
  return null;
}
