import type { Metadata } from 'next';
import Link from 'next/link';
import { Scale, Zap, ShieldAlert, FileCheck, Coins, Ban, AlertTriangle, HelpCircle, Building } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Terms of Service | Orion',
  description: 'Read the terms and conditions governing access, credits, lead unlocking, CSV uploads, and acceptable use of the Orion platform.',
};

export default function TermsPage() {
  const lastUpdated = 'October 7, 2026';

  const sections = [
    { id: 'acceptance', title: '1. Acceptance of Terms' },
    { id: 'account-eligibility', title: '2. Account Registration & Eligibility' },
    { id: 'credits-system', title: '3. The Orion Credit System' },
    { id: 'lead-unlocking', title: '4. Lead Unlocking & Data Usage License' },
    { id: 'csv-uploads', title: '5. CSV Uploads & Customer Content' },
    { id: 'prohibited-activities', title: '6. Prohibited Activities & Abuse' },
    { id: 'intellectual-property', title: '7. Intellectual Property Rights' },
    { id: 'payments-billing', title: '8. Payments, Billing & Refunds' },
    { id: 'suspension-termination', title: '9. Suspension & Termination' },
    { id: 'disclaimers-liability', title: '10. Disclaimers & Limitation of Liability' },
    { id: 'governing-law', title: '11. Governing Law & Dispute Resolution' },
    { id: 'contact', title: '12. Legal Questions & Notices' },
    { id: 'data-protection', title: '13. Data Protection (DPDP Act)' },
  ];

  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-gray-100 min-h-screen pt-28 pb-20 sm:pt-32 sm:pb-24">
      {/* Header Banner */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-neutral-900 text-gray-700 dark:text-neutral-300 border border-gray-200 dark:border-neutral-800 mb-4">
          <Scale className="w-3.5 h-3.5 text-gray-900 dark:text-white" />
          <span>User Agreement</span>
        </div>
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-gray-900 dark:text-white mb-4">
          Terms of Service
        </h1>
        <p className="text-base sm:text-lg text-gray-600 dark:text-gray-400 max-w-3xl leading-relaxed">
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of Orion, an AI-powered business discovery platform provided by Monarch Softwares.
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

          {/* Terms Document Content */}
          <main className="lg:col-span-8 space-y-12 text-sm sm:text-base leading-relaxed text-gray-700 dark:text-gray-300">
            {/* Section 1: Acceptance of Terms */}
            <section id="acceptance" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-gray-900 dark:text-white" />
                1. Acceptance of Terms
              </h2>
              <p className="mb-3">
                By creating an account, browsing business records, purchasing credits, uploading CSV datasets, or utilizing our APIs, you enter into a legally binding agreement with Monarch Softwares and agree to be bound by these Terms and our <Link href="/privacy" className="text-gray-900 dark:text-white underline font-medium">Privacy Policy</Link>.
              </p>
              <p>
                If you are entering into these Terms on behalf of an enterprise or other legal entity, you represent and warrant that you possess the authority to bind such entity to these conditions.
              </p>
            </section>

            {/* Section 2: Account Registration & Eligibility */}
            <section id="account-eligibility" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Building className="w-5 h-5 text-gray-900 dark:text-white" />
                2. Account Registration & Eligibility
              </h2>
              <p className="mb-3">
                To access Orion&apos;s lead intelligence capabilities, you must register for an account. You agree to:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li>Provide accurate, current, and verifiable registration details.</li>
                <li>Safeguard and maintain the confidentiality of your credentials (including single-sign-on tokens and password).</li>
                <li>Promptly notify Orion of any suspected security incident, credential compromise, or unauthorized access.</li>
                <li>Accept sole responsibility for all operations, queries, and credit expenditures occurring under your account.</li>
              </ul>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You must be at least 18 years of age or the age of legal majority in your jurisdiction to utilize Orion.
              </p>
            </section>

            {/* Section 3: The Orion Credit System */}
            <section id="credits-system" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Coins className="w-5 h-5 text-gray-900 dark:text-white" />
                3. The Orion Credit System
              </h2>
              <p className="mb-3">
                Orion operates on a digital credit consumption model governing data retrieval and profile unlocking:
              </p>
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-neutral-900/60 border border-gray-200 dark:border-neutral-800 space-y-3 mb-4 text-sm">
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Daily Free Credits</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Accounts may receive recurring daily promotional credits according to their tier. Daily credits do not accumulate indefinitely and reset daily at 00:00 UTC.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Purchased Credits</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Paid credit packs are credited directly to your workspace wallet and remain active for the duration of an active paid subscription or promotional validity period.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Deduction & Non-Refundability</h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Credits are deducted at the precise moment a lead or detailed company report is unlocked. Once spent to expose verified contact information, credits are non-refundable and non-reversible.
                  </p>
                </div>
              </div>
            </section>

            {/* Section 4: Lead Unlocking & Data Usage License */}
            <section id="lead-unlocking" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Zap className="w-5 h-5 text-gray-900 dark:text-white" />
                4. Lead Unlocking & Data Usage License
              </h2>
              <p className="mb-3">
                Upon unlocking a company profile with credits, Orion grants you a limited, non-exclusive, non-transferable, revocable license to view and export the unlocked intelligence data for your internal business prospecting:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Permitted B2B Uses:</strong> Direct B2B sales outreach, commercial relationship discovery, market research, and vendor qualification.</li>
                <li><strong className="text-gray-900 dark:text-white">Compliance With Outreach Laws:</strong> You are solely responsible for ensuring your outreach complies with applicable telemarketing, anti-spam, and privacy regulations (including CAN-SPAM, GDPR, and CASL).</li>
                <li><strong className="text-gray-900 dark:text-white">No Reselling or Syndication:</strong> You may not republish, sublicense, broadcast, or resell Orion data as a competitive lead intelligence repository or data broker service.</li>
              </ul>
            </section>

            {/* Section 5: CSV Uploads & Customer Content */}
            <section id="csv-uploads" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-gray-900 dark:text-white" />
                5. CSV Uploads & Customer Content
              </h2>
              <p className="mb-3">
                Orion allows customers to upload spreadsheets (CSV format) for custom batch enrichment, contact matching, and prospect importing:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Ownership & Warranties:</strong> You retain ownership of your uploaded customer records. You warrant that you have obtained all necessary consents to upload and process the data.</li>
                <li><strong className="text-gray-900 dark:text-white">Processing Authorization:</strong> You grant Orion a limited license to store, parse, index, and analyze uploaded spreadsheets solely to perform the requested enrichment or matching tasks.</li>
                <li><strong className="text-gray-900 dark:text-white">Prohibited Content:</strong> You must not upload files containing malicious code, formula injection payloads, healthcare identifiers (PHI), financial account numbers, or data acquired through unlawful hacking.</li>
              </ul>
            </section>

            {/* Section 6: Prohibited Activities & Abuse */}
            <section id="prohibited-activities" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Ban className="w-5 h-5 text-gray-900 dark:text-white" />
                6. Prohibited Activities & Abuse
              </h2>
              <p className="mb-3">When accessing Orion, you expressly agree NOT to:</p>
              <div className="p-4 rounded-xl border border-red-200 dark:border-red-950/60 bg-red-50/30 dark:bg-red-950/10 space-y-2 text-sm mb-4">
                <ul className="list-disc pl-5 space-y-1.5 text-gray-800 dark:text-gray-200">
                  <li>Deploy automated bots, headless scrapers, or scripts to systematically crawl or extract data from Orion outside of authorized API quotas.</li>
                  <li>Circumvent or attempt to bypass credit limits, payment gates, rate limiting mechanisms, or authorization barriers.</li>
                  <li>Reverse engineer, decompile, disassemble, or derive source code from any portion of the Orion platform.</li>
                  <li>Interfere with system performance, overload server infrastructure, or execute denial-of-service attempts.</li>
                  <li>Use uncovered contact information to transmit unsolicited spam, unlawful marketing, or harassment.</li>
                  <li>Probe, scan, or test the vulnerability of our systems without explicit written authorization.</li>
                </ul>
              </div>
            </section>

            {/* Section 7: Intellectual Property Rights */}
            <section id="intellectual-property" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Scale className="w-5 h-5 text-gray-900 dark:text-white" />
                7. Intellectual Property Rights
              </h2>
              <p className="mb-3">
                All platform interfaces, designs, software code, algorithms, scoring heuristics, databases, logos, and trademarks (&quot;Orion&quot; and &quot;Monarch Softwares&quot;) are and remain the exclusive intellectual property of Monarch Softwares.
              </p>
              <p>
                Nothing in these Terms conveys to you any ownership rights in or to the Orion platform, except for the limited access rights expressly granted herein.
              </p>
            </section>

            {/* Section 8: Payments, Billing & Refunds */}
            <section id="payments-billing" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Coins className="w-5 h-5 text-gray-900 dark:text-white" />
                8. Payments, Billing & Refunds
              </h2>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Fees:</strong> Subscription fees and credit pack pricing are billed in advance as described on our pricing schedule. All listed fees exclude applicable taxes.</li>
                <li><strong className="text-gray-900 dark:text-white">Payment Authorizations:</strong> You authorize Orion and our third-party billing providers to charge your chosen payment method for recurring subscriptions and on-demand credit purchases.</li>
                <li><strong className="text-gray-900 dark:text-white">Refund Policy:</strong> Due to the immediate delivery of digital intelligence and credit provisioning, subscription fees and unlocked credit expenditures are non-refundable except where required by statutory law.</li>
              </ul>
            </section>

            {/* Section 9: Suspension & Termination */}
            <section id="suspension-termination" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-gray-900 dark:text-white" />
                9. Suspension & Termination
              </h2>
              <p className="mb-3">
                We reserve the right to suspend or terminate your account access immediately, without prior notice or liability, if:
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li>You breach or threaten to breach any provision of these Terms.</li>
                <li>We detect fraudulent billing, payment chargebacks, or suspicious credit manipulation.</li>
                <li>Your usage imposes an abnormal burden on our platform infrastructure or endangers system security.</li>
              </ul>
              <p>
                You may terminate your account at any time by contacting support or deleting your account in Settings → Privacy & Data. Deletion takes effect after a 7-day cooling-off period, handles your personal data as described in our <Link href="/privacy" className="underline">Privacy Policy</Link>, and does not release unpaid amounts or remove records we must keep by law.
              </p>
            </section>

            {/* Section 10: Disclaimers & Limitation of Liability */}
            <section id="disclaimers-liability" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-gray-900 dark:text-white" />
                10. Disclaimers & Limitation of Liability
              </h2>
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-neutral-900/60 border border-gray-200 dark:border-neutral-800 space-y-2 text-sm mb-4">
                <p><strong className="text-gray-900 dark:text-white">&quot;AS IS&quot; Provision:</strong> The Orion platform, AI opportunity scoring, and lead contact records are provided on an &quot;as is&quot; and &quot;as available&quot; basis without warranties of any kind.</p>
                <p><strong className="text-gray-900 dark:text-white">Public Record Accuracy:</strong> While Orion uses advanced crawling and validation models, public registry records change frequently. We do not guarantee 100% accuracy, completeness, or deliverability of contact details.</p>
                <p><strong className="text-gray-900 dark:text-white">Damage Cap:</strong> To the maximum extent permitted by applicable law, in no event shall Monarch Softwares be liable for indirect, incidental, special, or consequential damages. Our aggregate liability shall not exceed the amount paid by you to Orion in the twelve (12) months preceding the claim.</p>
              </div>
            </section>

            {/* Section 11: Governing Law & Dispute Resolution */}
            <section id="governing-law" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <Scale className="w-5 h-5 text-gray-900 dark:text-white" />
                11. Governing Law & Dispute Resolution
              </h2>
              <p className="mb-3">
                These Terms are governed by and construed in accordance with the laws of the jurisdiction in which Monarch Softwares is organized, without giving effect to conflict-of-law principles.
              </p>
              <p>
                Any dispute arising from or relating to these Terms shall be resolved first through informal good-faith negotiation, followed by binding arbitration or competent courts having jurisdiction.
              </p>
            </section>

            {/* Section 12: Legal Questions & Notices */}
            <section id="contact" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <HelpCircle className="w-5 h-5 text-gray-900 dark:text-white" />
                12. Legal Questions & Notices
              </h2>
              <p className="mb-3">
                For formal legal notices or inquiries concerning these Terms of Service, please reach out to:
              </p>
              <div className="p-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-950/50">
                <p className="font-semibold text-gray-900 dark:text-white mb-1">Monarch Softwares &ndash; Legal Department</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Email: <a href="mailto:legal@monarchsoftwares.com" className="text-gray-900 dark:text-white underline font-medium">legal@monarchsoftwares.com</a></p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Orion Platform &bull; Monarch Softwares Product Portfolio
                </p>
              </div>
            </section>
            <section id="data-protection" className="scroll-mt-28">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800 flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-gray-900 dark:text-white" />
                13. Data Protection (DPDP Act)
              </h2>
              {/* LEGAL REVIEW: draft clause. Counsel to confirm roles (fiduciary / processor), the customer warranty and the liability wording. */}
              <p className="mb-3 text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">
                <strong>LEGAL REVIEW:</strong> this clause is a draft and has not been approved by counsel.
              </p>
              <ul className="list-disc pl-5 space-y-2 mb-4">
                <li><strong className="text-gray-900 dark:text-white">Our role:</strong> for your account data, Orion acts as the Data Fiduciary under India&apos;s Digital Personal Data Protection Act, 2023 (&quot;DPDP Act&quot;) and handles it as described in our <Link href="/privacy-notice" className="underline">Privacy Notice</Link>.</li>
                <li><strong className="text-gray-900 dark:text-white">Your obligations:</strong> you must use personal data you obtain through Orion (including unlocked contact details) only for lawful business outreach, honour any request by a person to stop contacting them, and comply with the DPDP Act and other laws that apply to your use, including laws on unsolicited communications. You are responsible for your own lawful basis and notices to those you contact.</li>
                <li><strong className="text-gray-900 dark:text-white">Data you upload:</strong> you confirm that you have the right and any required consent to give us the personal data you upload, and that you will tell us if a person withdraws consent or asks for erasure so we can act on it.</li>
                <li><strong className="text-gray-900 dark:text-white">Your rights and complaints:</strong> you and anyone whose details appear in Orion may exercise their rights, withdraw consent or complain through the <Link href="/data-rights" className="underline">data-rights form</Link> or our Grievance Officer. Removal requests may stop a contact from appearing, including in your saved or exported lists.</li>
                <li><strong className="text-gray-900 dark:text-white">Security and breaches:</strong> we use reasonable safeguards and will notify you and the Data Protection Board of India of a personal data breach as the law requires. You must tell us promptly if you suspect your account was misused.</li>
                <li><strong className="text-gray-900 dark:text-white">Withdrawing consent:</strong> you may withdraw a consent at any time. If you withdraw the consent that lets us run your account, we will close the account, and what is already done remains lawful.</li>
              </ul>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
