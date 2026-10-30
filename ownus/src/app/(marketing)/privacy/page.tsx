import type { Metadata } from 'next';
import Link from 'next/link';
import { Shield, Lock, FileText, Database, UserCheck, RefreshCw, Key, CheckCircle, Mail } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Privacy Policy | Orion',
  description: 'Learn how Orion and Monarch Softwares collect, process, safeguard, and manage your account data, business intelligence, CSV uploads, and user rights.',
};

export default function PrivacyPage() {
  const lastUpdated = 'October 7, 2026';

  const sections = [
    { id: 'overview', title: '1. Overview & Scope' },
    { id: 'account-data', title: '2. Account Data We Collect' },
    { id: 'google-oauth', title: '3. Google OAuth & Third-Party Auth' },
    { id: 'lead-data', title: '4. Business & Lead Intelligence Data' },
    { id: 'csv-uploads', title: '5. CSV Uploads & Customer Datasets' },
    { id: 'credits-payments', title: '6. Credits, Billing & Payments' },
    { id: 'data-usage', title: '7. How We Use Your Data' },
    { id: 'security', title: '8. Data Security & Storage Safeguards' },
    { id: 'retention-deletion', title: '9. Data Retention & Deletion' },
    { id: 'user-rights', title: '10. Your Rights & Choices' },
    { id: 'contact', title: '11. Contacting Us' },
  ];

  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-gray-100 min-h-screen pt-28 pb-20 sm:pt-32 sm:pb-24">
      {/* Header Banner */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-neutral-900 text-gray-700 dark:text-neutral-300 border border-gray-200 dark:border-neutral-800 mb-4">
          <Shield className="w-3.5 h-3.5 text-gray-900 dark:text-white" />
          <span>Legal & Transparency</span>
        </div>
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-gray-900 dark:text-white mb-4">
          Privacy Policy
        </h1>
        <p className="text-base sm:text-lg text-gray-600 dark:text-gray-400 max-w-3xl leading-relaxed">
          Orion (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;), a Monarch Softwares product, is committed to safeguarding your privacy and ensuring transparent handling of your personal and business data.
        </p>
        <div className="mt-4 flex items-center gap-4 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
          <span>Last Updated: <strong className="text-gray-900 dark:text-white font-medium">{lastUpdated}</strong></span>
          <span>&bull;</span>
          <span>Effective Date: September 1, 2026</span>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          {/* Quick Navigation Sidebar (Desktop) */}
          <aside className="hidden lg:block lg:col-span-4">
            <div className="sticky top-28 p-5 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-950/50 backdrop-blur-sm">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 mb-3">
                Contents
              </h3>
              <nav className="flex flex-col space-y-1.5 text-sm">
                {sections.map((sec) => (
                  <a
                    key={sec.id}
                    href={`#${sec.id}`}
                    className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors py-1 hover:translate-x-0.5 duration-150"
                  >
                    {sec.title}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Policy Document Content */}
          <main className="lg:col-span-8 space-y-12 text-sm sm:text-base leading-relaxed text-gray-700 dark:text-gray-300">
            {/* Section 1: Overview & Scope */}
            <section id="overview" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <FileText className="w-5 h-5 text-gray-900 dark:text-white" />
                1. Overview & Scope
              </h2>
              <p className="mb-3">
                This Privacy Policy describes how Orion collects, stores, uses, and protects information when you access or use our websites, API endpoints, web applications, and related services (collectively, the &quot;Platform&quot;).
              </p>
              <p>
                By signing up for an account, authenticating via single sign-on, uploading business files, or consuming Orion lead discovery services, you acknowledge the data handling practices described in this document.
              </p>
            </section>

            {/* Section 2: Account Data We Collect */}
            <section id="account-data" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-gray-900 dark:text-white" />
                2. Account Data We Collect
              </h2>
              <p className="mb-3">
                When you register, create a profile, or configure workspace preferences, we collect information necessary to identify and maintain your account:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Identity & Profile Information:</strong> Name, email address, password hash (salted and encrypted), organization or company name, and avatar image (if provided).</li>
                <li><strong className="text-gray-900 dark:text-white">Account Preferences:</strong> Notification choices, UI display themes, saved search filters, and tag configurations.</li>
                <li><strong className="text-gray-900 dark:text-white">Usage & Telemetry:</strong> Log data including IP addresses, browser types, session timestamps, and page request counts strictly for fraud mitigation and rate limiting.</li>
              </ul>
            </section>

            {/* Section 3: Google OAuth & Third-Party Auth */}
            <section id="google-oauth" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Key className="w-5 h-5 text-gray-900 dark:text-white" />
                3. Google OAuth & Third-Party Auth
              </h2>
              <p className="mb-3">
                Orion offers authentication via Google OAuth 2.0. When you choose to authenticate using Google:
              </p>
              <div className="p-4 rounded-lg bg-gray-50 dark:bg-neutral-900/60 border border-gray-200 dark:border-neutral-800 mb-4 space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                  <span>We only request basic profile permissions (email address, full name, profile picture) required to verify your identity and populate your user profile.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                  <span>We do not request or store access to your private Google Drive files, Gmail inbox, contacts, or calendar data.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                  <span>Orion&apos;s use and transfer of information received from Google APIs adheres to the <strong className="text-gray-900 dark:text-white">Google API Services User Data Policy</strong>, including the Limited Use requirements.</span>
                </div>
              </div>
              <p>
                Tokens received from OAuth providers are encrypted and handled exclusively by our backend authentication exchange to issue scoped Orion session tokens.
              </p>
            </section>

            {/* Section 4: Business & Lead Intelligence Data */}
            <section id="lead-data" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Database className="w-5 h-5 text-gray-900 dark:text-white" />
                4. Business & Lead Intelligence Data
              </h2>
              <p className="mb-3">
                Orion is an AI-powered B2B intelligence engine. We process company details to enable business discovery:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Public Registry Information:</strong> Official corporate registration filings, registered business entity names, incorporation dates, business classifications (NIC/NAICS), and public registrar statuses.</li>
                <li><strong className="text-gray-900 dark:text-white">Digital Presence Signals:</strong> Public business websites, professional profiles, verified business emails, official telephone lines, and company locations.</li>
                <li><strong className="text-gray-900 dark:text-white">Lead Unlocking & Masking:</strong> Contact details in search results remain masked until an authorized user spends credits to unlock the lead. Unlocked records are saved to the user&apos;s private workspace.</li>
              </ul>
            </section>

            {/* Section 5: CSV Uploads & Customer Datasets */}
            <section id="csv-uploads" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <FileText className="w-5 h-5 text-gray-900 dark:text-white" />
                5. CSV Uploads & Customer Datasets
              </h2>
              <p className="mb-3">
                Users may upload CSV spreadsheets to import prospective accounts, match existing contacts, or request lead enrichment:
              </p>
              <div className="p-4 rounded-lg bg-gray-50 dark:bg-neutral-900/60 border border-gray-200 dark:border-neutral-800 space-y-2 text-sm mb-4">
                <p className="font-semibold text-gray-900 dark:text-white">Strict Tenant Isolation & Confidentiality:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Your uploaded CSV spreadsheets are stored in isolated private storage buckets and associated strictly with your organization account.</li>
                  <li>We do <strong className="text-gray-900 dark:text-white">not</strong> sell, rent, or cross-pool your uploaded customer lists or proprietary prospecting spreadsheets with other users.</li>
                  <li>CSV files are sanitized prior to parsing to prevent formula injection attacks, and temporary parsing artifacts are deleted post-processing.</li>
                </ul>
              </div>
            </section>

            {/* Section 6: Credits, Billing & Payments */}
            <section id="credits-payments" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Lock className="w-5 h-5 text-gray-900 dark:text-white" />
                6. Credits, Billing & Payments
              </h2>
              <p className="mb-3">
                Orion utilizes a credit ledger mechanism to govern lead unlocking and premium intelligence reports:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Credit Balances:</strong> We maintain a cryptographic transactional ledger tracking daily credit allocations, purchased credit packs, and credit deductions for unlocked records.</li>
                <li><strong className="text-gray-900 dark:text-white">Payment Processing:</strong> All commercial transactions and credit purchases are processed directly through certified third-party payment gateways. Orion never receives or stores your full credit card numbers or security CVV codes.</li>
                <li><strong className="text-gray-900 dark:text-white">Billing History:</strong> Invoices, payment IDs, and transaction timestamps are preserved for accounting, dispute management, and tax compliance.</li>
              </ul>
            </section>

            {/* Section 7: How We Use Your Data */}
            <section id="data-usage" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-gray-900 dark:text-white" />
                7. How We Use Your Data
              </h2>
              <p className="mb-3">We process collected data exclusively for lawful purposes:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li>Operating, maintaining, and enhancing the Orion platform features.</li>
                <li>Authenticating user sessions and enforcing role-based permissions.</li>
                <li>Facilitating search queries, filter indexing, and AI opportunity scoring.</li>
                <li>Processing credit purchases, balance deductions, and invoices.</li>
                <li>Protecting against malicious traffic, abuse, scraping, and security breaches.</li>
                <li>Sending essential administrative notices, transactional receipts, and security alerts.</li>
              </ul>
            </section>

            {/* Section 8: Data Security & Storage Safeguards */}
            <section id="security" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Shield className="w-5 h-5 text-gray-900 dark:text-white" />
                8. Data Security & Storage Safeguards
              </h2>
              <p className="mb-3">
                We implement industry-standard software safeguards to defend your data against unauthorized access, alteration, or disclosure:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Transport Security:</strong> All client-to-server traffic is encrypted using modern TLS (HTTPS) with secure cipher suites.</li>
                <li><strong className="text-gray-900 dark:text-white">Session Security:</strong> Access and refresh tokens are signed with high-entropy secrets and transported in secure, HTTP-only cookies to defend against XSS exfiltration.</li>
                <li><strong className="text-gray-900 dark:text-white">Administrative Protection:</strong> The internal administration console is guarded behind a two-factor OTP authentication gateway.</li>
                <li><strong className="text-gray-900 dark:text-white">Tenant Isolation:</strong> Database queries enforce relational tenant boundary constraints, ensuring accounts cannot query data belonging to other organizations.</li>
              </ul>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                For detailed information on our defensive engineering measures, review our dedicated <Link href="/security" className="underline hover:text-gray-900 dark:hover:text-white">Security Architecture Overview</Link>.
              </p>
            </section>

            {/* Section 9: Data Retention & Deletion */}
            <section id="retention-deletion" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Database className="w-5 h-5 text-gray-900 dark:text-white" />
                9. Data Retention & Deletion
              </h2>
              <p className="mb-3">
                We keep personal data only as long as we need it for the purpose it was collected for, or as the law requires. When that period ends we delete it or remove the details that identify you.
              </p>
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm border border-gray-200 dark:border-neutral-800 rounded-lg">
                  <thead className="bg-gray-50 dark:bg-neutral-950 text-left">
                    <tr><th className="p-2 font-semibold">Data</th><th className="p-2 font-semibold">How long we keep it</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-neutral-800">
                    <tr><td className="p-2">Account profile, saved searches and leads, API keys, integrations</td><td className="p-2">While your account is open; erased after you delete it</td></tr>
                    <tr><td className="p-2">Sign-in sessions and one-time tokens</td><td className="p-2">Until they expire; stale entries are purged hourly</td></tr>
                    <tr><td className="p-2">Activity (audit) log IP address and device details</td><td className="p-2">180 days, then removed from the record</td></tr>
                    <tr><td className="p-2">Consent records</td><td className="p-2">Kept as proof of your choices; IP address removed after 3 years</td></tr>
                    <tr><td className="p-2">Uploaded CSV files</td><td className="p-2">Up to 30 days</td></tr>
                    <tr><td className="p-2">Integration delivery logs and background job records</td><td className="p-2">30 days</td></tr>
                    <tr><td className="p-2">Orders, invoices, refunds and the credit ledger</td><td className="p-2">The statutory minimum required by tax and accounting law, without your identifying details once your account is deleted</td></tr>
                    <tr><td className="p-2">Records of your privacy requests</td><td className="p-2">3 years</td></tr>
                    <tr><td className="p-2">Backups</td><td className="p-2">Up to 12 months; deleted data ages out of backups on that schedule and is not restored into live systems</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="mb-3">
                <strong className="text-gray-900 dark:text-white">Deleting your account.</strong> Go to Settings &rarr; Privacy &amp; Data &rarr; Delete account. After a 7-day cooling-off period (during which you can cancel) your profile, saved searches and leads, API keys and integrations are permanently erased and your account is anonymised. We complete every deletion request within 30 days.
              </p>
            </section>

            {/* Section 10: Your Rights & Choices */}
            <section id="user-rights" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-gray-900 dark:text-white" />
                10. Your Rights & Choices
              </h2>
              <p className="mb-3">
                You can use most of these rights yourself in <Link href="/settings" className="underline">Settings &rarr; Privacy &amp; Data</Link>, or write to us (section 11). We reply within 30 days. We may need to verify your identity first.
              </p>
              <h3 className="font-semibold text-gray-900 dark:text-white mt-4 mb-2">Everyone</h3>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Access &amp; portability:</strong> download all the personal data we hold about you as a JSON file. Passwords and secret keys are never included.</li>
                <li><strong className="text-gray-900 dark:text-white">Rectification:</strong> correct your profile details in Settings.</li>
                <li><strong className="text-gray-900 dark:text-white">Erasure:</strong> delete your account as described in section 9.</li>
                <li><strong className="text-gray-900 dark:text-white">Consent:</strong> optional uses of your data (analytics, marketing, product updates) are off until you turn them on, and you can withdraw consent at any time with the same ease. Withdrawing does not affect earlier processing.</li>
              </ul>
              <h3 className="font-semibold text-gray-900 dark:text-white mt-4 mb-2">EEA, UK and Switzerland (GDPR)</h3>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Legal bases:</strong> we process your account and billing data to perform our contract with you; security logs and service improvement under our legitimate interests; optional analytics and marketing only with your consent; and tax records to meet legal obligations.</li>
                <li>You also have the right to restrict or object to processing, and to complain to your local data protection authority.</li>
                <li>Where data is transferred outside your region, we rely on recognised safeguards such as Standard Contractual Clauses.</li>
              </ul>
              <h3 className="font-semibold text-gray-900 dark:text-white mt-4 mb-2">California and other US states (CCPA/CPRA)</h3>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Right to know and delete:</strong> available as described above. The categories we collect are listed in sections 2 to 6.</li>
                <li><strong className="text-gray-900 dark:text-white">We do not sell your personal information</strong> and do not share it for cross-context behavioural advertising. The &ldquo;Sale or sharing&rdquo; switch in Settings records your opt-out choice, and it is off by default.</li>
                <li><strong className="text-gray-900 dark:text-white">Non-discrimination:</strong> we will not deny service, change prices or reduce quality because you exercise these rights.</li>
                <li>You may use an authorised agent to submit a request; we will ask for proof of authorisation.</li>
              </ul>
              <h3 className="font-semibold text-gray-900 dark:text-white mt-4 mb-2">Cookies and similar storage</h3>
              <p className="mb-3">
                We use essential storage to keep you signed in and remember your theme. Analytics runs only if you choose &ldquo;Accept analytics&rdquo; in the privacy banner, and you can change that choice at any time in Settings.
              </p>
            </section>

            {/* Section 11: Contacting Us */}
            <section id="contact" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Mail className="w-5 h-5 text-gray-900 dark:text-white" />
                11. Contacting Us
              </h2>
              <p className="mb-3">
                If you have questions, concerns, or requests regarding this Privacy Policy or our data practices, please reach out to our privacy compliance team:
              </p>
              <div className="p-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-950/50">
                <p className="font-semibold text-gray-900 dark:text-white mb-1">Monarch Softwares &ndash; Orion Privacy Office</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Email: <a href="mailto:privacy@monarchsoftwares.com" className="text-gray-900 dark:text-white underline font-medium">privacy@monarchsoftwares.com</a></p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  We acknowledge requests within 3 business days and complete them within 30 days.
                </p>
              </div>
              <p className="mt-3 text-sm">
                Under India&apos;s DPDP Act you also have the right to a named Grievance Officer. See the <Link href="/privacy-notice" className="underline">Privacy Notice (DPDP)</Link> for the officer&apos;s details, and use the <Link href="/data-rights" className="underline">data-rights form</Link> to make a request. {/* LEGAL REVIEW: reconcile this Policy with the Notice */}
              </p>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
