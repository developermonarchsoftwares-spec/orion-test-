import type { Metadata } from 'next';
import Link from 'next/link';
import { FIDUCIARY, GRIEVANCE, LEGAL_REVIEW_PENDING, PURPOSES, RETENTION_TABLE, RIGHTS, THIRD_PARTIES } from '@/lib/compliance';

export const metadata: Metadata = {
  title: 'Privacy Notice (DPDP Act) | Orion',
  description: 'What personal data Orion collects, why, how long we keep it, who receives it, your rights under India’s Digital Personal Data Protection Act, and how to reach our Grievance Officer.',
};

const H2 = 'text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-4 pb-2 border-b border-gray-200 dark:border-neutral-800';
const CARD = 'p-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-950/50';

/** LEGAL REVIEW marker shown only while LEGAL_REVIEW_PENDING; every section below is a working draft written from what the code does. */
function Review({ children }: { children: React.ReactNode }) {
  if (!LEGAL_REVIEW_PENDING) return null;
  return (
    <p data-legal-review className="mt-3 text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">
      <strong>LEGAL REVIEW:</strong> {children}
    </p>
  );
}

export default function PrivacyNoticePage() {
  return (
    <div className="bg-white dark:bg-black text-gray-900 dark:text-gray-100 min-h-screen pt-28 pb-20 sm:pt-32 sm:pb-24">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        {LEGAL_REVIEW_PENDING && (
          <div role="note" className="mb-8 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 p-4 text-sm">
            <strong>Draft for legal review.</strong> This notice has not yet been approved by counsel. Items marked “LEGAL REVIEW” must be confirmed before launch.
          </div>
        )}
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight mb-4">Privacy Notice</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-2">
          This notice is given under India’s Digital Personal Data Protection Act, 2023 (“DPDP Act”). {FIDUCIARY.product}, a {FIDUCIARY.name} product, is the Data Fiduciary for the personal data described here.
          Our general <Link href="/privacy" className="underline">Privacy Policy</Link> and <Link href="/terms" className="underline">Terms of Service</Link> also apply.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-10">Version 2026-10-30 (draft). Available in English; versions in the other languages of the Eighth Schedule to the Constitution are not yet available.</p>
        <Review>Notice must be offered in English and the Eighth Schedule languages on request, and be understandable on its own (DPDP s.5, Rules). Translations are not done.</Review>

        <div className="space-y-12 text-sm sm:text-base leading-relaxed text-gray-700 dark:text-gray-300 mt-10">
          <section id="who">
            <h2 className={H2}>1. Who we are</h2>
            <p>{FIDUCIARY.name} (“we”) operates Orion. Registered address: {FIDUCIARY.address}.</p>
            <Review>Registered entity name and address; whether Orion is a Significant Data Fiduciary (which would require a DPO and audits).</Review>
          </section>

          <section id="data">
            <h2 className={H2}>2. What personal data we collect</h2>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-2">If you have an Orion account</h3>
            <ul className="list-disc pl-5 space-y-1.5 mb-4">
              <li><strong>Identity and contact:</strong> name, e-mail address, organisation, and a phone number if you add one.</li>
              <li><strong>Credentials:</strong> your password (stored only as a one-way hash) and, if you turn on two-step sign-in, an encrypted authenticator secret.</li>
              <li><strong>Sign-in and security records:</strong> IP address, browser and device details, session and sign-in times.</li>
              <li><strong>Use of the service:</strong> your searches, saved leads and searches, leads you unlock, exports, credit balance and activity.</li>
              <li><strong>Payments:</strong> order and invoice details and Razorpay payment identifiers. Card and UPI details go to Razorpay and never reach us.</li>
              <li><strong>Files you upload</strong> such as spreadsheets and a profile picture, and <strong>messages</strong> you send us.</li>
              <li><strong>Your consent records:</strong> what you agreed to or refused, when, and under which version of this notice.</li>
            </ul>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-2">If you are not a customer but appear in Orion</h3>
            <p className="mb-2">
              Orion is a business directory. It holds business details and, for decision makers, a name, job title, employer, work e-mail address, phone number and professional-profile link, gathered from public registries, company websites and data imports. Customers see contact values only after unlocking them with credits.
              You can ask us to correct or remove your details at any time through the <Link href="/data-rights" className="underline">data-rights form</Link>.
            </p>
            <Review>Lawful basis and notice duty for people who never dealt with us (DPDP s.4, s.5, s.7 and the exclusion for data the person made public, s.3(c)(ii)). This is the highest-risk area; counsel must decide how and when affected people are informed.</Review>
          </section>

          <section id="purposes">
            <h2 className={H2}>3. Why we use it (purposes)</h2>
            <ul className="space-y-3">
              {PURPOSES.map((p) => (
                <li key={p.id} className={CARD}>
                  <p className="font-semibold text-gray-900 dark:text-white">{p.title}</p>
                  <p className="text-sm">{p.text}</p>
                </li>
              ))}
            </ul>
            <p className="mt-4">We also use data without asking again where the law allows: to meet legal obligations (such as accounting and tax records), to keep Orion secure and prevent fraud and abuse, to respond to a court or authority, and for the payments you ask us to make. Marketing and analytics are never a condition of using Orion.</p>
            <Review>Which uses rest on consent and which on “certain legitimate uses” (DPDP s.7); wording of each consent purpose; whether sign-in security logging needs its own purpose.</Review>
          </section>

          <section id="retention">
            <h2 className={H2}>4. How long we keep it</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 dark:border-neutral-800">
                <thead className="bg-gray-100 dark:bg-neutral-900 text-left"><tr><th className="p-2">Data</th><th className="p-2">Kept for</th></tr></thead>
                <tbody>
                  {RETENTION_TABLE.map((r) => (
                    <tr key={r.data} className="border-t border-gray-200 dark:border-neutral-800"><td className="p-2 align-top">{r.data}</td><td className="p-2">{r.period}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Review>Every period. The tax and accounting period, the upload and import period and the directory-data retention are decisions still pending (docs/DATA_RETENTION_POLICY.md).</Review>
          </section>

          <section id="third-parties">
            <h2 className={H2}>5. Who receives your data</h2>
            <p className="mb-3">We do not sell personal data. These services process it for us or at your request:</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-200 dark:border-neutral-800">
                <thead className="bg-gray-100 dark:bg-neutral-900 text-left"><tr><th className="p-2">Service</th><th className="p-2">What for</th><th className="p-2">Data</th><th className="p-2">Where</th></tr></thead>
                <tbody>
                  {THIRD_PARTIES.map((t) => (
                    <tr key={t.name} className="border-t border-gray-200 dark:border-neutral-800 align-top"><td className="p-2 font-medium">{t.name}</td><td className="p-2">{t.role}</td><td className="p-2">{t.data}</td><td className="p-2">{t.where}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3">We may also disclose data to the authorities when the law requires it.</p>
            <Review>Processor contracts with each provider, transfer locations and any restricted-country rule (DPDP s.16), and the final list of providers once the production database host is chosen.</Review>
          </section>

          <section id="cookies">
            <h2 className={H2}>6. Cookies, device storage and trackers</h2>
            <p>We use storage that is essential to keep you signed in and secure. We load no advertising or analytics code today. If we add any, it will stay off until you say yes, and you can change your mind at any time with “Privacy choices” in the footer. Our sign-in and sign-up pages load Cloudflare’s bot check, and our payment step loads Razorpay’s checkout; both are needed for security and payment and are not optional.</p>
            <Review>Whether the bot check, which loads before a consent choice is possible, needs a disclosed legal basis of its own.</Review>
          </section>

          <section id="rights">
            <h2 className={H2}>7. Your rights</h2>
            <ul className="space-y-3">
              {RIGHTS.map((r) => (
                <li key={r.id}><strong className="text-gray-900 dark:text-white">{r.title}.</strong> {r.text}</li>
              ))}
            </ul>
            <p className="mt-4">
              Use the <Link href="/data-rights" className="underline font-medium">data-rights request form</Link>. We acknowledge within {GRIEVANCE.acknowledgeWithinDays} working days and respond within {GRIEVANCE.respondWithinDays} days. We may need to confirm who you are first.
              If you have a duty to give us accurate information, please keep your details up to date.
            </p>
            <Review>Response periods and identity-verification steps once the DPDP Rules timelines are confirmed; children’s data (Orion is a business service for adults; confirm no verifiable-parental-consent flow is needed).</Review>
          </section>

          <section id="grievance">
            <h2 className={H2}>8. Grievance Officer and the Data Protection Board</h2>
            <div className={CARD}>
              <p className="font-semibold text-gray-900 dark:text-white mb-1">{GRIEVANCE.officerName}</p>
              <p>E-mail: <a href={`mailto:${GRIEVANCE.email}`} className="underline font-medium">{GRIEVANCE.email}</a></p>
              <p>Address: {GRIEVANCE.address}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">We acknowledge within {GRIEVANCE.acknowledgeWithinDays} working days and aim to resolve within {GRIEVANCE.respondWithinDays} days.</p>
            </div>
            <p className="mt-3">If we do not resolve your grievance you may complain to the Data Protection Board of India.</p>
            <Review>Name and details of the Grievance Officer (must be appointed and published), and the Board’s complaint route.</Review>
          </section>

          <section id="breach">
            <h2 className={H2}>9. If something goes wrong</h2>
            <p>If a personal data breach affects you, we will tell you without delay, what happened, what it may mean for you, what we have done, and what you can do. We also report breaches to the Data Protection Board of India as the law requires.</p>
          </section>

          <section id="changes">
            <h2 className={H2}>10. Changes</h2>
            <p>When this notice changes in a way that matters we will update the version above and, where consent is involved, ask you again.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
