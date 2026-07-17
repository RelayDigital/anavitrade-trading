import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { Eye, EyeOff, ArrowRight, Shield, TrendingUp, Zap, Lock } from "lucide-react";
import { toast } from "sonner";

const TRUST_ITEMS = [
  { icon: TrendingUp, text: "Institutional-grade signals" },
  { icon: Zap, text: "Automated execution available" },
  { icon: Lock, text: "Non-custodial — your keys, your funds" },
  { icon: Shield, text: "AES-256 encrypted API keys" },
];

export default function Login() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ email: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const login = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success("Welcome back!");
      navigate("/dashboard");
    },
    onError: (e) => {
      const msg = e.message ?? "";
      if (msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("credentials")) {
        setError("Invalid email or password. Please try again.");
      } else {
        setError("Login failed. Please try again.");
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.email.trim()) { setError("Please enter your email address."); return; }
    if (!form.password) { setError("Please enter your password."); return; }
    login.mutate({ email: form.email.trim().toLowerCase(), password: form.password });
  }

  return (
    <div className="min-h-screen bg-background flex overflow-hidden">
      {/* Left panel — branding */}
      <div className="hidden lg:flex flex-col justify-between w-[45%] p-12 relative overflow-hidden">
        {/* Background orbs */}
        <div className="orb-azure" style={{ width: 500, height: 500, top: "-10%", left: "-15%" }} />
        <div className="orb-cyan" style={{ width: 300, height: 300, bottom: "10%", right: "-5%" }} />
        <div className="absolute inset-0 mesh-grid opacity-40" />

        {/* Logo */}
        <Link href="/">
          <div className="flex items-center gap-3 cursor-pointer group relative z-10">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-lg group-hover:scale-105 transition-transform glow-azure">@</div>
            <span className="font-heading font-bold text-xl text-foreground">Anavitrade</span>
          </div>
        </Link>

        {/* Main copy */}
        <div className="relative z-10">
          <h2 className="text-4xl font-heading font-bold leading-tight mb-6">
            <span className="text-foreground">Welcome</span><br />
            <span className="text-foreground">back to</span><br />
            <span className="gradient-text">Anavitrade</span>
          </h2>
          <p className="text-muted-foreground text-lg leading-relaxed mb-10 max-w-sm">
            Your quantitative trading signals are waiting. Access your dashboard and stay ahead of the market.
          </p>

          <div className="space-y-4">
            {TRUST_ITEMS.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg glass flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">{text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom note */}
        <div className="relative z-10 text-xs text-muted-foreground/60">
          Secured with TLS encryption · Non-custodial architecture
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative">
        {/* Mobile ambient glow */}
        <div className="lg:hidden absolute top-0 left-0 right-0 h-64 pointer-events-none">
          <div className="orb-azure" style={{ width: 400, height: 400, top: "-20%", left: "50%", transform: "translateX(-50%)" }} />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="w-full max-w-md relative z-10"
        >
          {/* Mobile logo */}
          <Link href="/">
            <div className="flex items-center gap-3 mb-10 cursor-pointer group lg:hidden">
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-lg group-hover:scale-105 transition-transform">@</div>
              <span className="font-heading font-bold text-xl text-foreground">Anavitrade</span>
            </div>
          </Link>

          <h1 className="text-3xl font-heading font-bold text-foreground mb-2">Welcome back</h1>
          <p className="text-muted-foreground mb-8">
            No account yet?{" "}
            <Link href="/register" className="text-primary hover:underline font-medium">Create one free</Link>
          </p>

          <div className="glass-card p-8 rounded-2xl">
            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              {/* Email */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Email Address</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => { setError(""); setForm({ ...form, email: e.target.value }); }}
                  placeholder="alex@example.com"
                  autoComplete="email"
                  disabled={login.isPending}
                  className="w-full px-4 py-3 rounded-xl bg-background/60 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all disabled:opacity-60"
                />
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-foreground">Password</label>
                  <Link href="/forgot-password" className="text-xs text-primary hover:underline">Forgot password?</Link>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => { setError(""); setForm({ ...form, password: e.target.value }); }}
                    placeholder="Your password"
                    autoComplete="current-password"
                    disabled={login.isPending}
                    className="w-full px-4 py-3 pr-12 rounded-xl bg-background/60 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm leading-relaxed"
                >
                  {error}
                </motion.div>
              )}

              {/* Submit */}
              <motion.button
                type="submit"
                disabled={login.isPending}
                whileHover={{ scale: login.isPending ? 1 : 1.01 }}
                whileTap={{ scale: login.isPending ? 1 : 0.98 }}
                className="btn-azure w-full py-3.5 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {login.isPending ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>Sign In <ArrowRight className="w-4 h-4" /></>
                )}
              </motion.button>
            </form>
          </div>

          {/* Security note */}
          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Shield className="w-3.5 h-3.5 text-primary" />
            <span>Secured with TLS · Non-custodial</span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
