import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { Mail, CheckCircle2, RefreshCw, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { consumeSensitiveQueryParams } from "./authQuery";

export default function VerifyEmail() {
  useLocation();
  const [{ token, email }] = useState(() => {
    const values = consumeSensitiveQueryParams(["token"]);
    return {
      token: values.token,
      email: new URLSearchParams(window.location.search).get("email"),
    };
  });

  const [verified, setVerified] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const verify = trpc.auth.verifyEmail.useMutation({
    onSuccess: () => setVerified(true),
    onError: (e: { message?: string }) => toast.error(e.message || "Verification failed. The link may have expired."),
  });

  const resend = trpc.auth.resendVerification.useMutation({
    onSuccess: () => {
      toast.success("Verification email resent. Check your inbox.");
      setResendCooldown(60);
    },
    onError: (e: { message?: string }) => toast.error(e.message || "Failed to resend. Please try again."),
  });

  useEffect(() => {
    if (token) verify.mutate({ token });
  }, [token]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Radial glow */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[120px]" />
      </div>

      {/* Nav */}
      <div className="px-6 py-5 flex items-center justify-between relative z-10">
        <Link href="/">
          <div className="flex items-center gap-3 cursor-pointer">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-base">@</div>
            <span className="font-heading font-bold text-foreground text-lg">Anavitrade</span>
          </div>
        </Link>
        <Link href="/login">
          <button className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to login
          </button>
        </Link>
      </div>

      <div className="flex-1 flex items-center justify-center px-6 py-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="w-full max-w-md text-center"
        >
          {token ? (
            /* Token present — show verification result */
            verified ? (
              <>
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
                  className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6"
                >
                  <CheckCircle2 className="w-9 h-9 text-primary" />
                </motion.div>
                <h1 className="text-3xl font-heading font-bold text-foreground mb-3">Email verified!</h1>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  Your account is now active. You can sign in and start setting up your Aster execution account.
                </p>
                <Link href="/login">
                  <button className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all active:scale-[0.97]">
                    Sign In to Your Account
                  </button>
                </Link>
              </>
            ) : verify.isPending ? (
              <>
                <div className="w-20 h-20 rounded-full bg-card border border-border flex items-center justify-center mx-auto mb-6">
                  <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" />
                </div>
                <h1 className="text-2xl font-heading font-bold text-foreground mb-2">Verifying your email…</h1>
                <p className="text-muted-foreground text-sm">Please wait a moment.</p>
              </>
            ) : (
              <>
                <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-6">
                  <Mail className="w-9 h-9 text-red-400" />
                </div>
                <h1 className="text-2xl font-heading font-bold text-foreground mb-3">Link expired</h1>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  This verification link has expired or already been used. Request a new one below.
                </p>
                {email && (
                  <button
                    onClick={() => resend.mutate({ email })}
                    disabled={resend.isPending || resendCooldown > 0}
                    className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all active:scale-[0.97] disabled:opacity-50"
                  >
                    {resend.isPending ? "Sending…" : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Verification Email"}
                  </button>
                )}
              </>
            )
          ) : (
            /* No token — check your email state */
            <>
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
                className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6"
              >
                <Mail className="w-9 h-9 text-primary" />
              </motion.div>
              <h1 className="text-3xl font-heading font-bold text-foreground mb-3">Check your inbox</h1>
              <p className="text-muted-foreground mb-2 leading-relaxed">
                We sent a verification link to
              </p>
              {email && (
                <p className="text-foreground font-semibold mb-6">{email}</p>
              )}
              <p className="text-muted-foreground text-sm mb-8 leading-relaxed">
                Click the link in the email to activate your account. The link expires in 24 hours.
              </p>

              <div className="p-4 rounded-2xl glass-card mb-6 text-left">
                <p className="text-xs text-muted-foreground mb-2 font-medium">Didn't receive it?</p>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>• Check your spam or junk folder</li>
                  <li>• Make sure you entered the correct email</li>
                  <li>• Allow a few minutes for delivery</li>
                </ul>
              </div>

              {email && (
                <button
                  onClick={() => resend.mutate({ email })}
                  disabled={resend.isPending || resendCooldown > 0}
                  className="w-full py-3.5 rounded-2xl border border-border text-foreground font-semibold text-sm hover:bg-card transition-all active:scale-[0.97] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${resend.isPending ? "animate-spin" : ""}`} />
                  {resend.isPending ? "Sending…" : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Verification Email"}
                </button>
              )}
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}
