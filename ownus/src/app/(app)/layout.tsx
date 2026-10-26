import { Topbar } from '@/components/layout/topbar';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black text-gray-900 dark:text-gray-100 flex flex-col">
      <Topbar />
      <div className="flex-1 mt-14 flex flex-col">
        <RequireAuth>{children}</RequireAuth>
      </div>
    </div>
  );
}
