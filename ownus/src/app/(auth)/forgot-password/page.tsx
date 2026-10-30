"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Mail, ArrowLeft, CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { Turnstile, captchaEnabled, type TurnstileHandle } from "@/components/auth/turnstile";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  // a Turnstile token works once; the widget is reset after every attempt
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileHandle>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    if (captchaEnabled && !captchaToken) {
      setErrorMsg("Please complete the security check before continuing.");
      return;
    }

    setIsLoading(true);
    setErrorMsg("");

    try {
      await apiClient.auth.forgotPassword(email, captchaToken);
      setIsSubmitted(true);
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to send password reset email. Please check your address and try again.");
    } finally {
      setIsLoading(false);
      captchaRef.current?.reset();
    }
  };

  if (isSubmitted) {
    return (
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px] text-center">
        <div className="flex justify-center mb-4">
          <div className="rounded-full bg-zinc-100 p-3 dark:bg-zinc-800">
            <CheckCircle className="h-10 w-10 text-zinc-900 dark:text-zinc-100" />
          </div>
        </div>
        <div className="flex flex-col space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
            Check your email
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            We sent a password reset link to <span className="font-medium text-gray-900 dark:text-gray-100">{email}</span>
          </p>
        </div>
        
        <div className="pt-4 text-sm text-gray-500 dark:text-gray-400">
          Didn&apos;t receive the email?{" "}
          <button
            onClick={() => setIsSubmitted(false)}
            className="font-medium text-gray-900 dark:text-white underline hover:opacity-80 cursor-pointer"
          >
            Resend
          </button>
        </div>
        
        <Link
          href="/login"
          className="inline-flex items-center justify-center text-sm font-medium text-gray-900 dark:text-white underline hover:opacity-80 pt-2"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
      <div className="flex flex-col space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
          Reset your password
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Enter your email and we&apos;ll send you a reset link
        </p>
      </div>

      <div className="grid gap-6">
        {errorMsg && (
          <div className="rounded-md bg-red-50 p-3.5 text-xs text-red-600 dark:bg-red-950/50 dark:text-red-400 flex items-start gap-2 border border-red-200 dark:border-red-900/50">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Email
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                  <Mail className="h-4 w-4" />
                </div>
                <input
                  id="email"
                  type="email"
                  placeholder="name@company.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isLoading}
                  className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-50"
                  required
                />
              </div>
            </div>

            <Turnstile
              ref={captchaRef}
              onToken={setCaptchaToken}
              onUnavailable={() => setErrorMsg("The security check could not load. Disable any content blockers for this site, check your connection and reload the page.")}
              className="flex justify-center"
            />

            <button
              type="submit"
              disabled={isLoading || (captchaEnabled && !captchaToken)}
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md bg-black text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200 px-4 py-2 text-sm font-semibold shadow focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white focus:ring-offset-2 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending email...
                </span>
              ) : (
                "Send Reset Link"
              )}
            </button>
          </div>
        </form>

        <div className="flex justify-center">
          <Link
            href="/login"
            className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
