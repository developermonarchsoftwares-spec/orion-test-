"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { handleOAuthTokens } = useAuth();
  const [status, setStatus] = useState<"processing" | "success" | "error">("processing");
  const [message, setMessage] = useState("Authenticating with Orion...");
  const executedRef = useRef(false);
  // Only a real unmount may stop the sign-in from finishing. A per-effect flag was cleared whenever the effect re-ran (router / search-params
  // identity changes after the profile loads), so the redirect to /dashboard never happened and the user stayed on "Securing Identity".
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (executedRef.current) return;
    executedRef.current = true;

    async function processAuth() {
      // The tokens arrive in the URL fragment, which a browser never sends to any server (not in logs, not in a Referer header). A
      // query-string copy is still read so a redirect issued by an older deployment keeps working.
      const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const read = (key: string) => fromHash.get(key) ?? searchParams.get(key);
      const error = read("error");
      const accessToken = read("accessToken");
      const refreshToken = read("refreshToken");
      const isNewUser = read("isNewUser") === "true";
      const linked = read("linked") === "true";
      const provider = read("provider");
      // take the tokens out of the address bar and the history entry as soon as they are read
      if (window.location.hash || searchParams.has("accessToken") || searchParams.has("refreshToken")) {
        window.history.replaceState(null, "", window.location.pathname);
      }

      if (error) {
        if (!mountedRef.current) return;
        setStatus("error");
        setMessage(decodeURIComponent(error));
        toast.error(decodeURIComponent(error));
        setTimeout(() => router.replace("/login"), 2500);
        return;
      }

      if (linked) {
        if (!mountedRef.current) return;
        setStatus("success");
        setMessage(`Successfully linked ${provider || "provider"} to your account!`);
        toast.success(`Successfully connected your ${provider || "social"} account.`);
        setTimeout(() => router.replace("/settings"), 1500);
        return;
      }

      if (accessToken && refreshToken) {
        try {
          if (!mountedRef.current) return;
          setMessage("Setting up your workspace & wallet...");
          await handleOAuthTokens(accessToken, refreshToken);

          if (!mountedRef.current) return;
          setStatus("success");

          if (isNewUser) {
            toast.success("Welcome to Orion! 5 free daily credits added to your wallet.");
          } else {
            toast.success("Welcome back to Orion!");
          }

          router.replace("/dashboard");
        } catch (err: any) {
          if (!mountedRef.current) return;
          setStatus("error");
          const errorMsg = err.message || "Failed to initialize session. Please try logging in again.";
          setMessage(errorMsg);
          toast.error(errorMsg);
          setTimeout(() => router.replace("/login"), 2500);
        }
        return;
      }

      // No relevant params found
      if (!mountedRef.current) return;
      setStatus("error");
      setMessage("No authentication tokens found. Redirecting to login...");
      setTimeout(() => router.replace("/login"), 1500);
    }

    processAuth();
  }, [searchParams, handleOAuthTokens, router]);

  return (
    <div className="flex flex-col items-center justify-center space-y-4 text-center p-8 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl max-w-md mx-auto">
      <div className="relative">
        <div className="h-16 w-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
          {status === "processing" && (
            <Loader2 className="h-8 w-8 animate-spin text-zinc-900 dark:text-zinc-100" />
          )}
          {status === "success" && (
            <CheckCircle2 className="h-8 w-8 text-zinc-900 dark:text-zinc-100" />
          )}
          {status === "error" && (
            <AlertCircle className="h-8 w-8 text-zinc-900 dark:text-zinc-100" />
          )}
        </div>
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
          {status === "processing" && "Securing Identity"}
          {status === "success" && "Authentication Successful"}
          {status === "error" && "Sign-In Failed"}
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {message}
        </p>
      </div>

      <div className="pt-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-900 dark:bg-white animate-pulse" />
          Orion Enterprise Identity
        </span>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-900 dark:text-zinc-100" />
        </div>
      }
    >
      <CallbackHandler />
    </Suspense>
  );
}
