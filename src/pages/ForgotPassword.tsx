import { useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, CheckCircle2 } from "lucide-react";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const forgot = trpc.auth.forgotPassword.useMutation({
    onSuccess: () => setSent(true),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    forgot.mutate({ email: email.trim().toLowerCase() });
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
        className="w-full max-w-md"
      >
        <Link href="/login">
          <div className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-8 cursor-pointer text-sm">
            <ArrowLeft className="w-4 h-4" /> Back to login
          </div>
        </Link>

        <Link href="/">
          <div className="flex items-center gap-3 mb-8 cursor-pointer">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-lg">@</div>
            <span className="font-heading font-bold text-xl text-foreground">Anavitrade</span>
          </div>
        </Link>

        {sent ? (
          <div className="p-8 rounded-2xl glass-card text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-7 h-7 text-primary" />
            </div>
            <h2 className="text-xl font-heading font-bold text-foreground mb-2">Check your inbox</h2>
            <p className="text-muted-foreground text-sm mb-6">
              If an account exists for <strong className="text-foreground">{email}</strong>, you will receive a password reset link within a few minutes.
            </p>
            <Link href="/login">
              <button className="text-primary hover:underline text-sm font-medium">Return to login</button>
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-3xl font-heading font-bold text-foreground mb-2">Reset your password</h1>
            <p className="text-muted-foreground mb-8">Enter your email and we will send you a reset link.</p>

            <div className="p-8 rounded-2xl glass-card">
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="alex@example.com"
                    className="w-full px-4 py-3 rounded-xl bg-background border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                  />
                </div>
                <button
                  type="submit"
                  disabled={forgot.isPending || !email}
                  className="w-full py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all duration-150 shadow-lg shadow-primary/25 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {forgot.isPending ? "Sending..." : "Send Reset Link"}
                </button>
              </form>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
