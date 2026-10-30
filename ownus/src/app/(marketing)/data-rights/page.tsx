import type { Metadata } from 'next';
import Link from 'next/link';
import { GRIEVANCE, LEGAL_REVIEW_PENDING, RIGHTS } from '@/lib/compliance';
import { RightsRequestForm } from '@/components/privacy/rights-request-form';

export const metadata: Metadata = {
  title: 'Data Rights Request | Orion',
  description: 'Ask Orion to show, correct or erase your personal data, withdraw consent, make a complaint or nominate a person, under India’s DPDP Act.',
};

export default function DataRightsPage() {
  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-gray-100 min-h-screen pt-28 pb-20 sm:pt-32 sm:pb-24">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">Data rights request</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          You do not need an Orion account to use this form. If you do have one, you can also download your data and delete your account yourself in Settings &rarr; Privacy.
          Read what we collect and why in the <Link href="/privacy-notice" className="underline">Privacy Notice</Link>.
        </p>
        {LEGAL_REVIEW_PENDING && (
          <p role="note" className="mb-6 text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">
            <strong>LEGAL REVIEW:</strong> response periods and the identity checks we ask for are drafts.
          </p>
        )}
        <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1 mb-8 list-disc pl-5">
          {RIGHTS.map((r) => <li key={r.id}><strong className="text-gray-900 dark:text-white">{r.title}:</strong> {r.text}</li>)}
        </ul>
        <RightsRequestForm />
        <p className="mt-8 text-xs text-gray-500 dark:text-gray-400">
          Prefer to write? Contact {GRIEVANCE.officerName} at <a href={`mailto:${GRIEVANCE.email}`} className="underline">{GRIEVANCE.email}</a>.
          We acknowledge within {GRIEVANCE.acknowledgeWithinDays} working days and respond within {GRIEVANCE.respondWithinDays} days.
        </p>
      </div>
    </div>
  );
}
