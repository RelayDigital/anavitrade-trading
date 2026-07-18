import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { Eye, EyeOff, ArrowRight, Shield, CheckCircle2, TrendingUp, Zap } from "lucide-react";
import { toast } from "sonner";

const CAPITAL_OPTIONS = [
  { label: "$1,000", value: 1000 },
  { label: "$5,000", value: 5000 },
  { label: "$10,000", value: 10000 },
  { label: "$25,000", value: 25000 },
  { label: "$50,000", value: 50000 },
  { label: "$100,000", value: 100000 },
];

const PERKS = [
  "No withdrawal access — ever",
  "Trade-only API wallet architecture",
  "Revoke access anytime",
  "Ledger Nano compatible",
];

export default function Register() {
  const [, navigate] = useLocation();

  // ?demo=true pre-selects demo mode (from "Start Demo Account" CTA)
  const params = new URLSearchParams(window.location.search);
  const [wantDemo, setWantDemo] = useState(params.get("demo") === "true");
  const [demoCapital, setDemoCapital] = useState(10000);

  const [step, setStep] = useState<"account" | "demo-capital">("account");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });

  // Registration starts email verification and intentionally does not authenticate.
  const register = trpc.auth.register.useMutation({
    onSuccess: (user) => {
      const developmentVerificationUrl = "developmentVerificationUrl" in user
        ? user.developmentVerificationUrl
        : undefined;
      if (developmentVerificationUrl) {
        navigate(new URL(developmentVerificationUrl).pathname + new URL(developmentVerificationUrl).search);
        return;
      }
      toast.success("Account created. Check your inbox to verify your email.");
      navigate(`/verify-email?email=${encodeURIComponent(user.email ?? form.email)}`);
    },
    onError: (e) => {
      const msg = e.message ?? "";
      if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("exist")) {
        setErrors({ email: "An account with this email already exists. Sign in instead." });
      } else if (msg.toLowerCase().includes("password")) {
        setErrors({ password: "Password must be at least 8 characters." });
      } else {
        setErrors({ _: msg || "Registration failed. Please try again." });
      }
    },
  });

  // Step 2 (optional): attach a demo portfolio to the new account
  const createDemo = trpc.demo.create.useMutation({
    onSuccess: () => {
      toast.success("Demo account ready! Let's go.");
      navigate("/dashboard");
    },
    onError: () => {
      // Account already created — just go to dashboard even if demo creation fails
      navigate("/dashboard");
    },
  });

  function validate() {
    const errs: Record<string, string> = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = "Name must be at least 2 characters.";
    if (!form.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) errs.email = "Enter a valid email address.";
    if (form.password.length < 8) errs.password = "Password must be at least 8 characters.";
    if (form.password !== form.confirm) errs.confirm = "Passwords do not match.";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleAccountSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    register.mutate({ name: form.name.trim(), email: form.email.trim().toLowerCase(), password: form.password });
  }

  const fadeUp = {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -12 },
    transition: { duration: 0.4, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] },
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* ── Left panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-background" />
        <div className="absolute inset-0 noise-overlay" />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer group">
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-lg group-hover:scale-105 transition-transform">@</div>
              <span className="font-heading font-bold text-xl text-foreground">Anavitrade</span>
            </div>
          </Link>
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}>
            <h2 className="text-4xl font-heading font-bold text-foreground mb-4 leading-tight">
              Your funds.<br />Your custody.<br /><span className="text-primary">Our execution.</span>
            </h2>
            <p className="text-muted-foreground text-lg mb-10 leading-relaxed">
              Anavitrade mirrors institutional-grade trade signals onto your own Aster account. You keep full control - always.
            </p>
            <div className="space-y-3">
              {PERKS.map((p) => (
                <div key={p} className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                  <span className="text-foreground/80 text-sm">{p}</span>
                </div>
              ))}
            </div>
          </motion.div>
          <div className="flex items-center gap-3 p-4 rounded-xl glass">
            <Shield className="w-5 h-5 text-primary shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              We never request your seed phrase, private key, or withdrawal access. Your capital stays in your own account.
            </p>
          </div>
        </div>
      </div>

      {/* ── Right panel — form ── */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative">
        {/* Ambient glow */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] rounded-full opacity-[0.04] pointer-events-none"
          style={{ background: "radial-gradient(circle, hsl(var(--primary)) 0%, transparent 70%)" }} />

        <div className="w-full max-w-md relative z-10">
          {/* Mobile logo */}
          <Link href="/">
            <div className="flex items-center gap-3 mb-8 lg:hidden cursor-pointer group">
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-lg group-hover:scale-105 transition-transform">@</div>
              <span className="font-heading font-bold text-xl text-foreground">Anavitrade</span>
            </div>
          </Link>

          <AnimatePresence mode="wait">

            {/* ── STEP 1: Account details ── */}
            {step === "account" && (
              <motion.div key="account" {...fadeUp}>
                <h1 className="text-3xl font-heading font-bold text-foreground mb-2">Create your account</h1>
                <p className="text-muted-foreground mb-7">
                  Already have an account?{" "}
                  <Link href="/login" className="text-primary hover:underline font-medium">Sign in</Link>
                </p>

                {/* Demo toggle */}
                <button
                  type="button"
                  onClick={() => setWantDemo(!wantDemo)}
                  className={`w-full flex items-center gap-3 p-4 rounded-xl border mb-6 text-left transition-all duration-200 ${
                    wantDemo
                      ? "bg-primary/10 border-primary/40"
                      : "bg-card border-border/50 hover:border-border"
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${wantDemo ? "border-primary bg-primary" : "border-muted-foreground/40"}`}>
                    {wantDemo && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Start with a demo account</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Practice with simulated capital — no real funds needed</p>
                  </div>
                </button>

                <form onSubmit={handleAccountSubmit} className="space-y-5" noValidate>
                  <div className="p-6 rounded-2xl bg-card border border-border/50 space-y-4" style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>

                    {/* Name */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Full Name</label>
                      <input
                        type="text"
                        autoComplete="name"
                        placeholder="Jane Smith"
                        value={form.name}
                        onChange={(e) => { setErrors({}); setForm({ ...form, name: e.target.value }); }}
                        className={`w-full px-4 py-3 rounded-xl bg-background border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all ${errors.name ? "border-red-500/70" : "border-border"}`}
                      />
                      {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
                    </div>

                    {/* Email */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Email Address</label>
                      <input
                        type="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={form.email}
                        onChange={(e) => { setErrors({}); setForm({ ...form, email: e.target.value }); }}
                        className={`w-full px-4 py-3 rounded-xl bg-background border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all ${errors.email ? "border-red-500/70" : "border-border"}`}
                      />
                      {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
                    </div>

                    {/* Password */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Password</label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          autoComplete="new-password"
                          placeholder="Min 8 characters"
                          value={form.password}
                          onChange={(e) => { setErrors({}); setForm({ ...form, password: e.target.value }); }}
                          className={`w-full px-4 py-3 pr-11 rounded-xl bg-background border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all ${errors.password ? "border-red-500/70" : "border-border"}`}
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {errors.password && <p className="text-red-400 text-xs mt-1">{errors.password}</p>}
                    </div>

                    {/* Confirm Password */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1.5">Confirm Password</label>
                      <div className="relative">
                        <input
                          type={showConfirm ? "text" : "password"}
                          autoComplete="new-password"
                          placeholder="Re-enter your password"
                          value={form.confirm}
                          onChange={(e) => { setErrors({}); setForm({ ...form, confirm: e.target.value }); }}
                          className={`w-full px-4 py-3 pr-11 rounded-xl bg-background border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all ${errors.confirm ? "border-red-500/70" : "border-border"}`}
                        />
                        <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                          {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {errors.confirm && <p className="text-red-400 text-xs mt-1">{errors.confirm}</p>}
                    </div>

                  </div>

                  {errors._ && <p className="text-red-400 text-xs text-center">{errors._}</p>}

                  <button
                    type="submit"
                    disabled={register.isPending}
                    className="btn-azure w-full h-12 rounded-xl font-semibold text-sm transition-all disabled:opacity-50"
                  >
                    {register.isPending ? "Creating account..." : (wantDemo ? "Create Account & Set Up Demo" : "Create Account")}
                  </button>
                </form>
              </motion.div>
            )}

            {/* ── STEP 2: Demo capital selection ── */}
            {step === "demo-capital" && (
              <motion.div key="demo-capital" {...fadeUp}>
                <h1 className="text-3xl font-heading font-bold text-foreground mb-2">Choose your demo capital</h1>
                <p className="text-muted-foreground mb-7">Start with simulated capital to explore the platform risk-free.</p>

                <div className="grid grid-cols-2 gap-3 mb-8">
                  {CAPITAL_OPTIONS.map((opt) => {
                    const selected = demoCapital === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setDemoCapital(opt.value)}
                        className={`p-4 rounded-xl border text-center transition-all ${
                          selected
                            ? "bg-primary/10 border-primary/50 text-primary shadow-[0_0_16px_oklch(0.65_0.2_255/0.12)]"
                            : "bg-card border-border/50 text-foreground hover:border-border"
                        }`}
                      >
                        <span className="font-heading font-bold text-lg">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-3 mb-8 p-4 rounded-xl bg-primary/5 border border-primary/20">
                  <TrendingUp className="w-5 h-5 text-primary shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    This demo account mirrors live signals with simulated $10,000 in capital. You can adjust position size, leverage, and strategy tier anytime.
                  </p>
                </div>

                <button
                  onClick={() => createDemo.mutate({ startingCapital: demoCapital })}
                  disabled={createDemo.isPending}
                  className="btn-azure w-full h-12 rounded-xl font-semibold text-sm transition-all disabled:opacity-50"
                >
                  {createDemo.isPending ? "Setting up demo..." : `Start with ${CAPITAL_OPTIONS.find((o) => o.value === demoCapital)?.label}`}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground/50 mt-8">
            By creating an account you agree to our{" "}
            <Link href="/terms" className="underline hover:text-muted-foreground">Terms</Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline hover:text-muted-foreground">Privacy Policy</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
