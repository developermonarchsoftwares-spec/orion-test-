import type { Metadata } from 'next';
import { ConfirmErasure } from '@/components/privacy/confirm-erasure';

export const metadata: Metadata = {
  title: 'Confirm removal | Orion',
  robots: { index: false, follow: false },
};

export default function ConfirmErasurePage() {
  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-gray-100 min-h-screen pt-28 pb-20 sm:pt-32 sm:pb-24">
      <div className="mx-auto max-w-xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">Confirm removal of your e-mail address</h1>
        <ConfirmErasure />
      </div>
    </div>
  );
}
