"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, User, Building2, Loader2, Sparkles, AlertCircle, ArrowRight, ArrowLeft, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { OtpInput } from "@/components/auth/otp-input";
import { Turnstile, captchaEnabled, type TurnstileHandle } from "@/components/auth/turnstile";
import { OTP_LENGTH, describeOtpError, isCompleteOtp, maskEmailForDisplay, resendLabel } from "@/lib/otp-flow";

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

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Step 1 shows a visible challenge; the resend link on step 2 uses an invisible one that only appears if Cloudflare wants more. A token works once.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [resendCaptchaToken, setResendCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileHandle>(null);
  const resendCaptchaRef = useRef<TurnstileHandle>(null);
  const [existingAccountError, setExistingAccountError] = useState<string | null>(null);

  // E-mail verification: step 1 collects the details and sends a code; step 2 checks the code, then creates the account. The browser
  // only holds what it needs to display; the server decides whether a code or proof is valid.
  const [step, setStep] = useState<"details" | "verify">("details");
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [proof, setProof] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOAuthRegister = (provider: "google" | "microsoft") => {
    const url = provider === "google" 
      ? apiClient.auth.getGoogleUrl() 
      : apiClient.auth.getMicrosoftUrl();
    window.location.href = url;
  };

  const getPasswordStrength = (pass: string) => {
    let score = 0;
    if (pass.length > 7) score += 1;
    if (/[A-Z]/.test(pass)) score += 1;
    if (/[0-9]/.test(pass)) score += 1;
    if (/[^A-Za-z0-9]/.test(pass)) score += 1;
    return score;
  };

  const strength = getPasswordStrength(password);
  
  const getStrengthWidth = () => {
    if (password.length === 0) return "w-0";
    if (strength <= 1) return "w-1/4 bg-zinc-400 dark:bg-zinc-600";
    if (strength === 2) return "w-2/4 bg-zinc-600 dark:bg-zinc-400";
    if (strength === 3) return "w-3/4 bg-zinc-800 dark:bg-zinc-200";
    return "w-full bg-black dark:bg-white";
  };

  const startVerify = (res: any) => {
    setStep("verify");
    setOtp("");
    setOtpError(null);
    setProof(null);
    setMaskedEmail(res?.maskedEmail || maskEmailForDisplay(email));
    setCooldown(Number(res?.resendAfterSeconds) || 60);
    setFocusSignal((n) => n + 1);
  };

  /** Step 1: validate locally, then ask the server to e-mail a code. Nothing is created yet. */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    if (!agreeTerms) {
      toast.error("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters long.");
      return;
    }
    if (captchaEnabled && !captchaToken) {
      toast.error("Please complete the security check before continuing.");
      return;
    }
    busy.current = true;
    setIsLoading(true);
    setExistingAccountError(null);
    try {
      const res: any = await apiClient.auth.sendOtp(email.trim(), captchaToken);
      startVerify(res);
    } catch (err: any) {
      const f = describeOtpError(err);
      if (f.kind === "cooldown") {
        // a code was just sent for this address: go to the code screen with the wait that remains
        startVerify({ resendAfterSeconds: f.retryAfterSeconds });
        toast.info("A code was sent a moment ago. Enter it below.");
      } else {
        toast.error(f.message);
      }
    } finally {
      busy.current = false;
      setIsLoading(false);
      captchaRef.current?.reset();
    }
  };

  /** Creates the account with the one-time proof. The session is issued by the server only now. */
  const createAccount = async (token: string) => {
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || "User";
    const lastName = parts.slice(1).join(" ") || firstName;
    try {
      await register({
        email: email.trim(),
        password,
        firstName,
        lastName,
        displayName: name.trim(),
        organizationName: company,
        verificationToken: token,
      });
      toast.success("Email verified. Account created! 5 daily free credits allocated.");
      router.push("/dashboard");
    } catch (err: any) {
      const isAlreadyExists =
        err.statusCode === 409 ||
        err.details?.errorCode === "EMAIL_ALREADY_EXISTS" ||
        err.message?.toLowerCase().includes("already exists");
      if (isAlreadyExists) {
        setStep("details");
        setProof(null);
        setOtp("");
        setExistingAccountError(err.message || "An account with this email already exists.");
        toast.error("Account already exists. Please log in to continue.");
        return;
      }
      const f = describeOtpError(err);
      if (f.kind === "required") {
        setProof(null);
        setOtp("");
        setOtpError("Your email verification expired. Request a new code.");
        setFocusSignal((n) => n + 1);
        return;
      }
      // the address is verified and the proof is still unspent: keep it so the user can fix the problem and try again without a new code
      setProof(token);
      setOtpError(`Your email is verified, but the account could not be created: ${err.message || "please try again."}`);
    }
  };

  /** Step 2: check the code on the server (or reuse the proof if only account creation failed). */
  const handleVerify = async (code: string = otp) => {
    if (busy.current) return;
    if (!proof && !isCompleteOtp(code)) {
      setOtpError(`Enter the ${OTP_LENGTH}-digit code.`);
      setFocusSignal((n) => n + 1);
      return;
    }
    busy.current = true;
    setIsVerifying(true);
    setOtpError(null);
    try {
      let token = proof;
      if (!token) {
        const v: any = await apiClient.auth.verifyOtp(email.trim(), code);
        token = v?.verificationToken;
        if (!token) throw new Error("Verification failed. Please try again.");
      }
      await createAccount(token);
    } catch (err: any) {
      const f = describeOtpError(err);
      setOtpError(f.message);
      if (f.kind === "invalid" || f.kind === "expired" || f.kind === "locked") setOtp("");
      setFocusSignal((n) => n + 1);
    } finally {
      busy.current = false;
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (busy.current || cooldown > 0) return;
    if (captchaEnabled && !resendCaptchaToken) {
      setOtpError("Please complete the security check, then try again.");
      return;
    }
    busy.current = true;
    setIsResending(true);
    setOtpError(null);
    try {
      const res: any = await apiClient.auth.sendOtp(email.trim(), resendCaptchaToken);
      setOtp("");
      setProof(null);
      setCooldown(Number(res?.resendAfterSeconds) || 60);
      setFocusSignal((n) => n + 1);
      toast.success("A new code has been sent.");
    } catch (err: any) {
      const f = describeOtpError(err);
      if (f.kind === "cooldown") setCooldown(f.retryAfterSeconds || 60);
      setOtpError(f.message);
    } finally {
      busy.current = false;
      setIsResending(false);
      resendCaptchaRef.current?.reset();
    }
  };

  const handleChangeEmail = () => {
    setStep("details");
    setOtp("");
    setProof(null);
    setOtpError(null);
    setCooldown(0);
  };

  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[400px]">
      <div className="flex flex-col space-y-2 text-center">
        <div className="inline-flex items-center justify-center gap-1.5 mx-auto px-3 py-1 rounded-full text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700">
          <Sparkles className="h-3.5 w-3.5" />
          5 Free Daily Credits Included
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
          {step === "verify" ? "Verify your email" : "Create your account"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {step === "verify" ? "One more step before your account is created" : "Instant access to verified business intelligence"}
        </p>
      </div>

      {existingAccountError && (
        <div className="p-4 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 text-xs flex flex-col gap-3 animate-in fade-in-50 zoom-in-95 shadow-xs">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-zinc-500" />
            <div className="space-y-1 flex-1">
              <p className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                Account Already Exists
              </p>
              <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed text-xs">
                An account associated with <strong className="text-zinc-900 dark:text-white font-medium">{email}</strong> already exists. Please log in to access your dashboard.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-zinc-200 dark:border-zinc-800">
            <Link
              href={`/login?email=${encodeURIComponent(email)}`}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 transition-colors cursor-pointer shadow-xs"
            >
              <span>Login to continue</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {step === "details" && (
      <div className="grid gap-5">
        {/* Primary Enterprise OAuth Options */}
        <div className="grid grid-cols-1 gap-2.5">
          <button
            type="button"
            onClick={() => handleOAuthRegister("google")}
            className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-zinc-400 transition-all cursor-pointer"
          >
            <GoogleIcon className="h-4 w-4" />
            Sign up with Google
          </button>

          <button
            type="button"
            onClick={() => handleOAuthRegister("microsoft")}
            className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-zinc-400 transition-all cursor-pointer"
          >
            <MicrosoftIcon className="h-4 w-4" />
            Sign up with Microsoft
          </button>
        </div>

        {/* Divider */}
        <div className="relative my-1">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-gray-200 dark:border-gray-800" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-3 text-gray-400 dark:bg-black dark:text-gray-500">
              or register with email
            </span>
          </div>
        </div>

        {/* Registration Form */}
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Full Name
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                <User className="h-4 w-4" />
              </div>
              <input
                id="name"
                type="text"
                placeholder="Sarah Connor"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100"
                required
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="company" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Company Name <span className="text-xs text-gray-400 font-normal">(Optional)</span>
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                <Building2 className="h-4 w-4" />
              </div>
              <input
                id="company"
                type="text"
                placeholder="Acme Corp"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100"
              />
            </div>
          </div>

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
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (existingAccountError) setExistingAccountError(null);
                }}
                className="flex h-10 w-full rounded-md border border-gray-300 bg-transparent px-3 pl-10 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:border-transparent disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100"
                required
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="password" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Password
            </label>
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
            {password.length > 0 && (
              <div className="mt-1 h-1.5 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full transition-all duration-300 ${getStrengthWidth()}`} />
              </div>
            )}
          </div>

          <div className="flex items-start space-x-2 pt-1" suppressHydrationWarning>
            <input
              id="terms"
              type="checkbox"
              checked={agreeTerms}
              onChange={(e) => setAgreeTerms(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-zinc-900 focus:ring-zinc-400 dark:bg-gray-900 cursor-pointer"
              required
            />
            <label htmlFor="terms" className="text-xs leading-tight text-gray-600 dark:text-gray-400">
              I agree to the{" "}
              <Link href="/terms" className="text-zinc-900 dark:text-zinc-100 underline hover:opacity-80">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-zinc-900 dark:text-zinc-100 underline hover:opacity-80">
                Privacy Policy
              </Link>
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
            disabled={!agreeTerms || isLoading || (captchaEnabled && !captchaToken)}
            className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 px-4 py-2 text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending code...
              </>
            ) : (
              "Continue"
            )}
          </button>
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">
            We will email a 6-digit code to confirm this address before your account is created.
          </p>
        </form>
      </div>
      )}

      {step === "verify" && (
        <div className="grid gap-5" aria-live="polite">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
              <ShieldCheck className="h-6 w-6 text-zinc-700 dark:text-zinc-200" aria-hidden="true" />
            </div>
            <p id="otp-label" className="text-sm text-gray-600 dark:text-gray-300">
              Enter the {OTP_LENGTH}-digit code we sent to{" "}
              <strong className="font-semibold text-gray-900 dark:text-gray-50">{maskedEmail}</strong>. It expires in 5 minutes.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleVerify();
            }}
            className="grid gap-4"
          >
            <OtpInput
              value={otp}
              onChange={(v) => {
                setOtp(v);
                if (otpError) setOtpError(null);
              }}
              onComplete={(v) => void handleVerify(v)}
              disabled={isVerifying || isResending || !!proof}
              invalid={!!otpError}
              autoFocus
              labelledBy="otp-label"
              describedBy={otpError ? "otp-error" : undefined}
              focusSignal={focusSignal}
            />

            {otpError && (
              <p id="otp-error" role="alert" className="flex items-start justify-center gap-2 text-center text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{otpError}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={isVerifying || isResending || (!proof && !isCompleteOtp(otp))}
              className="inline-flex h-10 w-full items-center justify-center rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 px-4 py-2 text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : proof ? (
                "Create account"
              ) : (
                "Verify code"
              )}
            </button>
          </form>

          <div className="flex flex-col items-center gap-2 text-sm">
            <Turnstile ref={resendCaptchaRef} onToken={setResendCaptchaToken} appearance="interaction-only" className="flex justify-center" />
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={cooldown > 0 || isVerifying || isResending}
              className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline cursor-pointer"
            >
              {isResending ? "Sending..." : resendLabel(cooldown)}
            </button>
            <button
              type="button"
              onClick={handleChangeEmail}
              disabled={isVerifying || isResending}
              className="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-50 cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Change email
            </button>
            <p className="max-w-xs text-center text-xs text-gray-500 dark:text-gray-400">
              Nothing arrived? Check your spam folder. If you already have an account with this address, no code is sent;{" "}
              <Link href={`/login?email=${encodeURIComponent(email)}`} className="underline hover:opacity-80">sign in instead</Link>.
            </p>
          </div>
        </div>
      )}

      <p className="text-center text-sm text-gray-500 dark:text-gray-400">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
