import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, useLocation, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";

const NotFound = lazy(() => import("@/pages/NotFound"));
const Home = lazy(() => import("@/pages/Home"));
const DemoSignup = lazy(() => import("@/pages/DemoSignup"));
const DemoDashboard = lazy(() => import("@/pages/DemoDashboard"));
const PublicDemo = lazy(() => import("@/pages/PublicDemo"));
const Register = lazy(() => import("@/pages/Register"));
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const VerifyEmail = lazy(() => import("@/pages/VerifyEmail"));
const AsterOnboarding = lazy(() => import("@/pages/AsterOnboarding"));
const PancakeswapOnboarding = lazy(() => import("@/pages/PancakeswapOnboarding"));
const LedgerOnboarding = lazy(() => import("@/pages/LedgerOnboarding"));
const ExchangeOnboarding = lazy(() => import("@/pages/ExchangeOnboarding"));
const AccountSettings = lazy(() => import("@/pages/AccountSettings"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const HistoricalPerformance = lazy(() => import("@/pages/HistoricalPerformance"));
const Security = lazy(() => import("@/pages/Security"));
const RiskDisclosure = lazy(() => import("@/pages/RiskDisclosure"));
const LegalPage = lazy(() => import("@/pages/LegalPage"));

function PageFallback() {
  return (
    <div className="min-h-dvh bg-background p-4 sm:p-6" role="status" aria-live="polite" aria-label="Loading page">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Skeleton className="hidden h-[calc(100dvh-3rem)] w-64 rounded-2xl lg:block" />
        <div className="flex-1 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-7 w-48 rounded-lg" />
              <Skeleton className="h-4 w-64 max-w-[70vw]" />
            </div>
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <PageFallback />;
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <Component />;
}

function AnimatedRoutes() {
  const [location] = useLocation();
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    document.querySelector<HTMLElement>("main, [data-route-focus]")?.focus({ preventScroll: true });
  }, [location]);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location}
        data-route-focus
        tabIndex={-1}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.23, 1, 0.32, 1] }}
        className="outline-none"
      >
        <Suspense fallback={<PageFallback />}>
          <Switch location={location}>
            <Route path="/" component={Home} />
            <Route path="/register" component={Register} />
            <Route path="/login" component={Login} />
            <Route path="/forgot-password" component={ForgotPassword} />
            <Route path="/reset-password" component={ResetPassword} />
            <Route path="/verify-email" component={VerifyEmail} />

            <Route path="/demo" component={PublicDemo} />
            <Route path="/demo/signup" component={DemoSignup} />
            <Route path="/demo/dashboard/:token" component={DemoDashboard} />

            <Route path="/dashboard">
              {() => <ProtectedRoute component={Dashboard} />}
            </Route>
            <Route path="/performance">
              {() => <ProtectedRoute component={HistoricalPerformance} />}
            </Route>
            <Route path="/onboarding/aster">
              {() => <ProtectedRoute component={AsterOnboarding} />}
            </Route>
            <Route path="/onboarding/pancakeswap">
              {() => <ProtectedRoute component={PancakeswapOnboarding} />}
            </Route>
            <Route path="/onboarding/ledger">
              {() => <ProtectedRoute component={LedgerOnboarding} />}
            </Route>
            <Route path="/onboarding/exchange">
              {() => <ProtectedRoute component={ExchangeOnboarding} />}
            </Route>
            <Route path="/settings">
              {() => <ProtectedRoute component={AccountSettings} />}
            </Route>

            <Route path="/security" component={Security} />
            <Route path="/risk-disclosure" component={RiskDisclosure} />
            <Route path="/terms">{() => <LegalPage type="terms" />}</Route>
            <Route path="/privacy">{() => <LegalPage type="privacy" />}</Route>

            <Route path="/404" component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </motion.div>
    </AnimatePresence>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <AnimatedRoutes />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
