"use client";

import Link from "next/link";
import type { ConsentPurposeId, IPurpose } from "@/lib/compliance";

export type ConsentChoices = Partial<Record<ConsentPurposeId, boolean>>;

interface Props {
  purposes: readonly IPurpose[];
  value: ConsentChoices;
  onChange: (next: ConsentChoices) => void;
  idPrefix?: string;
}

/**
 * One checkbox per purpose, never pre-ticked, never bundled with the Terms. A purpose the service cannot run without is marked required but
 * is still its own explicit choice. The parent owns the state; nothing is stored here (see lib/consent-sync.ts for the ledger write).
 */
export function ConsentCheckboxes({ purposes, value, onChange, idPrefix = "consent" }: Props) {
  return (
    <fieldset className="space-y-2.5 pt-1">
      <legend className="sr-only">Your consent choices</legend>
      {purposes.map((p) => {
        const id = `${idPrefix}-${p.id}`;
        return (
          <div key={p.id} className="flex items-start space-x-2">
            <input
              id={id}
              type="checkbox"
              checked={value[p.id] === true}
              onChange={(e) => onChange({ ...value, [p.id]: e.target.checked })}
              required={p.required}
              aria-describedby={`${id}-text`}
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 dark:border-gray-700 text-zinc-900 focus:ring-zinc-400 dark:bg-gray-900 cursor-pointer"
            />
            <label htmlFor={id} className="text-xs leading-tight text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-900 dark:text-gray-100">{p.title}</span>
              {p.required ? <span className="text-red-600"> *</span> : null}
              <span id={`${id}-text`} className="block mt-0.5">
                {p.text}{" "}
                <Link href="/privacy-notice" className="underline" target="_blank">Privacy Notice</Link>
              </span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
