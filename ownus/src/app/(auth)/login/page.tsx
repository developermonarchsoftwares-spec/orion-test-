"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, Loader2, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { Turnstile, captchaEnabled, type TurnstileHandle } from "@/components/auth/turnstile";

function GoogleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.41 7.33 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.98 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.59 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
      />
    </svg>
  );
}

function MicrosoftIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileHandle>(null);

  const errorParam = searchParams.get("error");
  const emailParam = searchParams.get("email");
  const resetParam = searchParams.get("reset");

  useEffect(() => {
    if (resetParam === "success") {
      toast.success("Password reset successfully! Please log in with your new password.");
    }
  }, [resetParam]);

  useEffect(() => {
    if (errorParam) {
      toast.error(decodeURIComponent(errorParam));
    }
  }, [errorParam]);

  useEffect(() => {
    if (emailParam) {
      setEmail(decodeURIComponent(emailParam));
    }
  }, [emailParam]);

  const handleOAuthLogin = (provider: "google" | "microsoft") => {
    const url = provider === "google" 
      ? apiClient.auth.getGoogleUrl() 
      : apiClient.auth.getMicrosoftUrl();
    window.location.href = url;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (captchaEnabled && !captchaToken) {
      toast.error("Please complete the security check before signing in.");
      return;
    }
    setIsLoading(true);
    try {
      await login(email, password, captchaToken);
      toast.success("Welcome back to Orion!");
      router.push("/dashboard");
    } catch (err: any) {
      toast.error(err.message || "Failed to sign in. Please check your credentials.");
      // a CAPTCHA token works once: whatever went wrong, the next attempt needs a fresh challenge
      captchaRef.current?.reset();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[360px]">
      <div className="flex flex-col space-y-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
          Welcome back
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Sign in to your Orion intelligence platform
        </p>
      </div>

      {errorParam && (
        <div className="p-3.5 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 text-xs flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-zinc-500" />
          <div>
            <p className="font-semibold">Authentication Notice</p>
            <p className="mt-0.5 text-zinc-600 dark:text-zinc-300 leading-relaxed">
              {decodeURIComponent(errorParam)}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-5">
        {/* Primary Enterprise OAuth Options */}
        <div className="grid grid-cols-1 gap-2.5">
          <button
            type="button"
            onClick={() => handleOAuthLogin("google")}
            className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-zinc-400 transition-all cursor-pointer"
          >
            <GoogleIcon className="h-4 w-4" />
            Continue with Google
          </button>

          <button
            type="button"
            onClick={() => handleOAuthLogin("microsoft")}
            className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-zinc-400 transition-all cursor-pointer"
          >
            <MicrosoftIcon className="h-4 w-4" />
            Continue with Microsoft
          </button>
        </div>

        {/* Divider */}
        <div className="relative my-1">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-gray-200 dark:border-gray-800" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-3 text-gray-400 dark:bg-black dark:text-gray-500">
              or continue with email
            </span>
          </div>
        </div>

        {/* Traditional Credentials Form */}
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="email" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Work Email
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
                className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100"
                required
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-zinc-900 dark:text-zinc-100 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                <Lock className="h-4 w-4" />
              </div>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 pr-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          
          <div className="flex items-center space-x-2" suppressHydrationWarning>
            <input
              id="remember"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-zinc-900 focus:ring-zinc-400 dark:bg-gray-900 cursor-pointer"
            />
            <label
              htmlFor="remember"
              className="text-sm font-medium leading-none text-gray-600 dark:text-gray-400 cursor-pointer"
            >
              Remember me
            </label>
          </div>

          <Turnstile
            ref={captchaRef}
            onToken={setCaptchaToken}
            onUnavailable={() => toast.error("The security check could not load. Disable any content blockers for this site, check your connection and reload the page.")}
            className="flex justify-center"
          />

          <button
            type="submit"
            disabled={isLoading || (captchaEnabled && !captchaToken)}
            className="mt-1 inline-flex h-10 w-full items-center justify-center rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 px-4 py-2 text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing In...
              </>
            ) : (
              "Sign In with Email"
            )}
          </button>
        </form>
      </div>

      <p className="text-center text-sm text-gray-500 dark:text-gray-400">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-900 dark:text-zinc-100" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
