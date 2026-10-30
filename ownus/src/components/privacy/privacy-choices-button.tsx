"use client";

/** Reopens the consent banner so any choice can be changed as easily as it was made (DPDP: withdrawal must be as easy as giving consent). */
export function PrivacyChoicesButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event("orion:open-consent"))}>
      Privacy choices
    </button>
  );
}
