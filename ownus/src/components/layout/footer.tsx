import Link from 'next/link';
import { GRIEVANCE } from '@/lib/compliance';
import { PrivacyChoicesButton } from '@/components/privacy/privacy-choices-button';

export function Footer() {
  return (
    <footer className="bg-gray-50 dark:bg-black text-gray-900 dark:text-white border-t border-gray-200 dark:border-neutral-900">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
          {/* Column 1: Brand */}
          <div className="flex flex-col gap-4">
            <Link href="/" className="flex flex-col items-start gap-1">
              <div className="flex items-center">
                <img src="/white.png" alt="Orion Logo" className="h-8 w-auto dark:hidden" />
                <img src="/black.png" alt="Orion Logo" className="h-8 w-auto hidden dark:block" />
              </div>
              <span className="text-[9px] font-semibold tracking-[0.2em] text-gray-400 dark:text-neutral-500 uppercase select-none">
                A MONARCH SOFTWARES PRODUCT
              </span>
            </Link>
            <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed max-w-xs">
              AI-powered business discovery and lead intelligence platform for modern revenue teams.
            </p>
            <div className="flex gap-4 mt-2">
              <a href="#" className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors">
                <span className="sr-only">Twitter</span>
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
                </svg>
              </a>
              <a href="#" className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors">
                <span className="sr-only">LinkedIn</span>
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path fillRule="evenodd" d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" clipRule="evenodd" />
                </svg>
              </a>
            </div>
          </div>

          {/* Column 2: Product */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-wider uppercase mb-4">Product</h3>
            <ul className="flex flex-col gap-3">
              <li><Link href="#features" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Features</Link></li>
              <li><Link href="#pricing" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Pricing</Link></li>
              <li><Link href="/api-docs" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">API</Link></li>
              <li><Link href="/integrations" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Integrations</Link></li>
            </ul>
          </div>

          {/* Column 3: Company */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-wider uppercase mb-4">Company</h3>
            <ul className="flex flex-col gap-3">
              <li><Link href="/about" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">About</Link></li>
              <li><Link href="/blog" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Blog</Link></li>
              <li><Link href="/careers" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Careers</Link></li>
              <li><Link href="/contact" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Contact</Link></li>
            </ul>
          </div>

          {/* Column 4: Legal */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-wider uppercase mb-4">Legal</h3>
            <ul className="flex flex-col gap-3">
              <li><Link href="/privacy" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Privacy Policy</Link></li>
              <li><Link href="/privacy-notice" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Privacy Notice (DPDP)</Link></li>
              <li><Link href="/data-rights" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Data rights request</Link></li>
              <li><PrivacyChoicesButton className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors cursor-pointer" /></li>
              <li><Link href="/terms" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Terms of Service</Link></li>
              <li><Link href="/security" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">Security</Link></li>
              <li><Link href="/status" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white text-sm transition-colors">System Status</Link></li>
            </ul>
          </div>
        </div>

        {/* Grievance Officer (DPDP Act): published here and in the Privacy Notice */}
        <div className="mt-10 pt-6 border-t border-gray-200 dark:border-neutral-900 text-xs text-gray-500 dark:text-gray-400" aria-label="Grievance Officer">
          <p><strong className="text-gray-700 dark:text-gray-300">Grievance Officer:</strong> {GRIEVANCE.officerName} &middot; <a href={`mailto:${GRIEVANCE.email}`} className="underline">{GRIEVANCE.email}</a> &middot; <Link href="/data-rights" className="underline">Make a data-rights request</Link></p>
        </div>

        {/* Big Logo in bottom footer section */}
        <div className="mt-16 pt-10 border-t border-gray-200 dark:border-neutral-900 flex flex-col justify-center items-center gap-3">
          <Link href="/" className="inline-flex flex-col items-center gap-3 transition-transform hover:scale-105">
            <img src="/white.png" alt="Orion Logo" className="h-16 sm:h-20 md:h-24 w-auto dark:hidden object-contain" />
            <img src="/black.png" alt="Orion Logo" className="h-16 sm:h-20 md:h-24 w-auto hidden dark:block object-contain" />
            <span className="text-[10px] sm:text-xs tracking-[0.25em] font-semibold text-gray-500 dark:text-neutral-400 uppercase select-none text-center">
              A MONARCH SOFTWARES PRODUCT
            </span>
          </Link>
        </div>
      </div>
    </footer>
  );
}
