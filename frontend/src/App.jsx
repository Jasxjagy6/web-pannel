import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastContainer } from './components/common/Toast';
import MissingApiCredsModal from './components/common/MissingApiCredsModal';
import { useAuth } from './hooks/useAuth';
import Layout from './components/layout/Layout';

// Always-eager pages — Login / Register / Pending are tiny and on
// the critical path of the very first paint. Everything else is
// lazy-loaded so the initial bundle stays small at the 500-700
// concurrent user target.
import Login from './pages/Login';
import Register from './pages/Register';
import Pending from './pages/Pending';

const Admin = lazy(() => import('./pages/Admin'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Sessions = lazy(() => import('./pages/Sessions'));
const Scrape = lazy(() => import('./pages/Scrape'));
const Messaging = lazy(() => import('./pages/Messaging'));
const Groups = lazy(() => import('./pages/Groups'));
const Lists = lazy(() => import('./pages/Lists'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const AccountSettings = lazy(() => import('./pages/AccountSettings'));
const Change2FA = lazy(() => import('./pages/Change2FA'));
const GetOTP = lazy(() => import('./pages/GetOTP'));
const Proxies = lazy(() => import('./pages/Proxies'));
const CreateSession = lazy(() => import('./pages/CreateSession'));
const AntiDetect = lazy(() => import('./pages/AntiDetect'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Billing = lazy(() => import('./pages/Billing'));

function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center text-sm text-dark-300">
      Loading…
    </div>
  );
}

/**
 * Predicate: does the user have an active paid subscription or running
 * trial right now? Admins always pass. We mirror the backend
 * `entitlementFor()` here so the UI can route correctly without an
 * extra request roundtrip.
 */
function hasEntitlement(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const sub = user.subscription || {};
  if (sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) {
    return true;
  }
  const trial = user.trial || {};
  if (trial.expiresAt && new Date(trial.expiresAt) > new Date()) return true;
  return false;
}

/**
 * Gate that requires the user to be approved (or admin) before they can
 * see any feature route. Pending / banned users get bounced to /pending,
 * unauthenticated users to /login. As of the OxaPay rollout, approved
 * users without an active subscription or trial are redirected to
 * /billing where they can pay or start the free trial.
 */
function ProtectedRoute({ children, title, requireAdmin = false, allowWithoutSubscription = false }) {
  const { isAuthenticated, user, isAdmin } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (user?.status === 'banned') return <Navigate to="/pending" replace />;
  if (requireAdmin && !isAdmin) {
    // Non-admin trying to load /admin → bounce to their proper home.
    return <Navigate to={user?.isApproved ? '/dashboard' : '/pending'} replace />;
  }
  if (!requireAdmin && !isAdmin) {
    if (!user?.isApproved || user?.status !== 'approved') {
      return <Navigate to="/pending" replace />;
    }
    if (!allowWithoutSubscription && !hasEntitlement(user)) {
      return <Navigate to="/billing" replace />;
    }
  }
  return <Layout title={title}>{children}</Layout>;
}

/**
 * Pending guard — only shows the pending screen if the user is logged in
 * but not yet approved (or banned). Otherwise routes them home.
 */
function PendingGate() {
  const { isAuthenticated, user, isAdmin } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  if (user?.status === 'approved' && user?.isApproved) {
    return <Navigate to="/dashboard" replace />;
  }
  return <Pending />;
}

function HomeRedirect() {
  const { isAuthenticated, isAdmin, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  if (user?.status === 'approved' && user?.isApproved) {
    return hasEntitlement(user)
      ? <Navigate to="/dashboard" replace />
      : <Navigate to="/billing" replace />;
  }
  return <Navigate to="/pending" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastContainer />
        <MissingApiCredsModal />
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/pending" element={<PendingGate />} />
          <Route path="/admin" element={<ProtectedRoute title="Admin Panel" requireAdmin><Admin /></ProtectedRoute>} />
          <Route path="/billing" element={<ProtectedRoute title="Billing" allowWithoutSubscription><Billing /></ProtectedRoute>} />
          <Route path="/dashboard" element={<ProtectedRoute title="Dashboard"><Dashboard /></ProtectedRoute>} />
          <Route path="/sessions" element={<ProtectedRoute title="Sessions"><Sessions /></ProtectedRoute>} />
          <Route path="/create-session" element={<ProtectedRoute title="Create Session"><CreateSession /></ProtectedRoute>} />
          <Route path="/scrape" element={<ProtectedRoute title="Scrape"><Scrape /></ProtectedRoute>} />
          <Route path="/messaging" element={<ProtectedRoute title="Messaging"><Messaging /></ProtectedRoute>} />
          <Route path="/groups" element={<ProtectedRoute title="Groups"><Groups /></ProtectedRoute>} />
          <Route path="/lists" element={<ProtectedRoute title="Lists"><Lists /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute title="Reports"><Reports /></ProtectedRoute>} />
          <Route path="/account-settings" element={<ProtectedRoute title="Account Settings"><AccountSettings /></ProtectedRoute>} />
          <Route path="/change-2fa" element={<ProtectedRoute title="Change 2FA"><Change2FA /></ProtectedRoute>} />
          <Route path="/get-otp" element={<ProtectedRoute title="Get OTP"><GetOTP /></ProtectedRoute>} />
          <Route path="/proxies" element={<ProtectedRoute title="Proxies"><Proxies /></ProtectedRoute>} />
          <Route path="/anti-detect" element={<ProtectedRoute title="Anti-Detect"><AntiDetect /></ProtectedRoute>} />
          <Route path="/privacy" element={<ProtectedRoute title="Privacy"><Privacy /></ProtectedRoute>} />
          {/* Settings is reachable without an active subscription so the
              user can configure their Telegram API ID/Hash before paying.
              The credentials popup deep-links to /settings#api-credentials
              from anywhere in the app. */}
          <Route path="/settings" element={<ProtectedRoute title="Settings" allowWithoutSubscription><Settings /></ProtectedRoute>} />
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<HomeRedirect />} />
        </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
