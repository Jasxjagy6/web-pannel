import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { PlatformProvider, PLATFORMS, DEFAULT_PLATFORM, PLATFORM_FEATURE_FLAG_KEY } from './context/PlatformContext';
import { ToastContainer } from './components/common/Toast';
import MissingApiCredsModal from './components/common/MissingApiCredsModal';
import RouteFallback from './components/common/RouteFallback';
import { useAuth } from './hooks/useAuth';
import Layout from './components/layout/Layout';

// Always-eager pages — Login / Register / Pending are tiny and on the
// critical path of the very first paint. Everything else is lazy-loaded
// so the initial bundle stays small at the 500-700 concurrent user
// target (and now 1000+ with the multiplatform expansion).
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
const Threads = lazy(() => import('./pages/Threads'));
const Billing = lazy(() => import('./pages/Billing'));

// Instagram-specific page components — used by PlatformPage to render the
// IG-themed pink experience for /instagram/<route> URLs. Telegram still
// renders the original (steel-blue) component on /telegram/<route>.
const InstagramDashboard      = lazy(() => import('./pages/instagram/Dashboard'));
const InstagramSessions       = lazy(() => import('./pages/instagram/Sessions'));
const InstagramCreateSession  = lazy(() => import('./pages/instagram/CreateSession'));
const InstagramScrape         = lazy(() => import('./pages/instagram/Scrape'));

/**
 * Picks the right page component based on the active panel platform.
 * The platform is taken from the URL (:platform) so that /telegram/dashboard
 * always renders the Telegram (steel-blue) page and /instagram/dashboard
 * always renders the Instagram (pink) page, regardless of what the user
 * last visited. Falls back to the TG version when no IG implementation
 * is supplied (shared pages like Reports, Privacy, Groups, etc.).
 */
function PlatformPage({ tg: TgComponent, ig: IgComponent }) {
  const { platform } = useParams();
  if (platform === 'instagram' && IgComponent) return <IgComponent />;
  return <TgComponent />;
}

/**
 * Predicate: does the user have an active paid subscription or running
 * trial right now on the requested platform? Admins always pass. We
 * mirror the backend `entitlementFor()` here so the UI can route
 * correctly without an extra request roundtrip.
 *
 * Reads `user.subscriptions[platform]` if available (post-v9), falls
 * back to the legacy single `user.subscription` mirror (Telegram only).
 */
function hasEntitlement(user, platform = DEFAULT_PLATFORM) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  // Per-platform subscriptions (v9+).
  const subsByPlatform = user.subscriptions || {};
  const sub = subsByPlatform[platform];
  if (sub) {
    if (sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) {
      return true;
    }
    if (sub.trial?.expiresAt && new Date(sub.trial.expiresAt) > new Date()) return true;
    return false;
  }

  // Legacy single-subscription shape (still mirrored for Telegram during
  // the transition window).
  if (platform === 'telegram') {
    const legacy = user.subscription || {};
    if (legacy.status === 'active' && legacy.expiresAt && new Date(legacy.expiresAt) > new Date()) {
      return true;
    }
    const trial = user.trial || {};
    if (trial.expiresAt && new Date(trial.expiresAt) > new Date()) return true;
  }
  return false;
}

function isPlatformAvailable(platform) {
  if (platform === 'telegram') return true;
  if (platform === 'instagram') {
    // Default-on; only hide if the operator has explicitly opted out
    // by setting the feature flag to "0". Mirrors the helper in
    // PlatformContext so route guards and the toggle stay in sync.
    try { return localStorage.getItem(PLATFORM_FEATURE_FLAG_KEY) !== '0'; } catch (_) { return true; }
  }
  return false;
}

/**
 * Validates :platform against the enabled set. Bounces unknown / disabled
 * platforms to the default. Used as a wrapper around every per-platform
 * route so we never render with `platform = 'twitter'`.
 */
function PlatformGate({ children }) {
  const { platform } = useParams();
  const location = useLocation();
  if (!PLATFORMS.includes(platform)) {
    return <Navigate to={`/${DEFAULT_PLATFORM}/dashboard`} replace />;
  }
  if (!isPlatformAvailable(platform)) {
    const fallback = location.pathname.replace(/^\/(telegram|instagram)/, `/${DEFAULT_PLATFORM}`);
    return <Navigate to={fallback || `/${DEFAULT_PLATFORM}/dashboard`} replace />;
  }
  return children;
}

/**
 * Gate that requires the user to be approved (or admin) before they can
 * see any feature route. Pending / banned users get bounced to /pending,
 * unauthenticated users to /login. Approved users without an active
 * subscription or trial on THIS PLATFORM are redirected to /:platform/billing.
 */
function ProtectedRoute({ children, title, requireAdmin = false, allowWithoutSubscription = false }) {
  const { isAuthenticated, user, isAdmin } = useAuth();
  const { platform = DEFAULT_PLATFORM } = useParams();

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.status === 'banned') return <Navigate to="/pending" replace />;
  if (requireAdmin && !isAdmin) {
    return <Navigate to={user?.isApproved ? `/${platform}/dashboard` : '/pending'} replace />;
  }
  if (!requireAdmin && !isAdmin) {
    if (!user?.isApproved || user?.status !== 'approved') {
      return <Navigate to="/pending" replace />;
    }
    if (!allowWithoutSubscription && !hasEntitlement(user, platform)) {
      return <Navigate to={`/${platform}/billing`} replace />;
    }
  }
  return <Layout title={title}>{children}</Layout>;
}

function PendingGate() {
  const { isAuthenticated, user, isAdmin } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  if (user?.status === 'approved' && user?.isApproved) {
    return <Navigate to={`/${DEFAULT_PLATFORM}/dashboard`} replace />;
  }
  return <Pending />;
}

/**
 * Lands the user on either /admin, /:platform/dashboard, /:platform/billing,
 * or /pending depending on their state. The platform comes from
 * localStorage (set by the last visit) or defaults to telegram.
 */
function HomeRedirect() {
  const { isAuthenticated, isAdmin, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  let platform = DEFAULT_PLATFORM;
  try {
    const stored = localStorage.getItem('panel_platform');
    if (stored && PLATFORMS.includes(stored) && isPlatformAvailable(stored)) platform = stored;
  } catch (_) { /* SSR / private mode */ }

  if (user?.status === 'approved' && user?.isApproved) {
    return hasEntitlement(user, platform)
      ? <Navigate to={`/${platform}/dashboard`} replace />
      : <Navigate to={`/${platform}/billing`} replace />;
  }
  return <Navigate to="/pending" replace />;
}

/**
 * Legacy /<page> URLs (e.g. /dashboard) get redirected to /:platform/<page>
 * with the user's last-known platform. This keeps existing bookmarks
 * working through the rollout.
 */
function LegacyRedirect({ to }) {
  let platform = DEFAULT_PLATFORM;
  try {
    const stored = localStorage.getItem('panel_platform');
    if (stored && PLATFORMS.includes(stored) && isPlatformAvailable(stored)) platform = stored;
  } catch (_) { /* SSR / private mode */ }
  return <Navigate to={`/${platform}${to}`} replace />;
}

/**
 * Group of platform-scoped routes. Mounted twice: once for /telegram/*
 * and once for /instagram/*. PlatformGate validates the URL param.
 */
function PlatformRoutes() {
  return (
    <Routes>
      <Route path="billing" element={<ProtectedRoute title="Billing" allowWithoutSubscription><Billing /></ProtectedRoute>} />
      <Route path="dashboard" element={<ProtectedRoute title="Dashboard"><PlatformPage tg={Dashboard} ig={InstagramDashboard} /></ProtectedRoute>} />
      <Route path="sessions" element={<ProtectedRoute title="Sessions"><PlatformPage tg={Sessions} ig={InstagramSessions} /></ProtectedRoute>} />
      <Route path="create-session" element={<ProtectedRoute title="Create Session"><PlatformPage tg={CreateSession} ig={InstagramCreateSession} /></ProtectedRoute>} />
      <Route path="scrape" element={<ProtectedRoute title="Scrape"><PlatformPage tg={Scrape} ig={InstagramScrape} /></ProtectedRoute>} />
      <Route path="messaging" element={<ProtectedRoute title="Messaging"><Messaging /></ProtectedRoute>} />
      <Route path="groups" element={<ProtectedRoute title="Groups"><Groups /></ProtectedRoute>} />
      <Route path="threads" element={<ProtectedRoute title="Threads"><Threads /></ProtectedRoute>} />
      <Route path="lists" element={<ProtectedRoute title="Lists"><Lists /></ProtectedRoute>} />
      <Route path="reports" element={<ProtectedRoute title="Reports"><Reports /></ProtectedRoute>} />
      <Route path="account-settings" element={<ProtectedRoute title="Account Settings"><AccountSettings /></ProtectedRoute>} />
      <Route path="change-2fa" element={<ProtectedRoute title="Change 2FA"><Change2FA /></ProtectedRoute>} />
      <Route path="get-otp" element={<ProtectedRoute title="Get OTP"><GetOTP /></ProtectedRoute>} />
      <Route path="proxies" element={<ProtectedRoute title="Proxies"><Proxies /></ProtectedRoute>} />
      <Route path="anti-detect" element={<ProtectedRoute title="Anti-Detect"><AntiDetect /></ProtectedRoute>} />
      <Route path="privacy" element={<ProtectedRoute title="Privacy"><Privacy /></ProtectedRoute>} />
      <Route path="settings" element={<ProtectedRoute title="Settings" allowWithoutSubscription><Settings /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PlatformProvider>
          <ToastContainer />
          <MissingApiCredsModal />
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/pending" element={<PendingGate />} />
              <Route path="/admin" element={<ProtectedRoute title="Admin Panel" requireAdmin><Admin /></ProtectedRoute>} />

              {/* Per-platform feature routes — :platform must be one of the
                  enabled set (validated by PlatformGate). */}
              <Route
                path="/:platform/*"
                element={<PlatformGate><PlatformRoutes /></PlatformGate>}
              />

              {/* Legacy URLs from before multi-platform — redirect to
                  /<lastUsedPlatform>/<page>. */}
              <Route path="/billing"           element={<LegacyRedirect to="/billing" />} />
              <Route path="/dashboard"         element={<LegacyRedirect to="/dashboard" />} />
              <Route path="/sessions"          element={<LegacyRedirect to="/sessions" />} />
              <Route path="/create-session"    element={<LegacyRedirect to="/create-session" />} />
              <Route path="/scrape"            element={<LegacyRedirect to="/scrape" />} />
              <Route path="/messaging"         element={<LegacyRedirect to="/messaging" />} />
              <Route path="/groups"            element={<LegacyRedirect to="/groups" />} />
              <Route path="/threads"           element={<LegacyRedirect to="/threads" />} />
              <Route path="/lists"             element={<LegacyRedirect to="/lists" />} />
              <Route path="/reports"           element={<LegacyRedirect to="/reports" />} />
              <Route path="/account-settings"  element={<LegacyRedirect to="/account-settings" />} />
              <Route path="/change-2fa"        element={<LegacyRedirect to="/change-2fa" />} />
              <Route path="/get-otp"           element={<LegacyRedirect to="/get-otp" />} />
              <Route path="/proxies"           element={<LegacyRedirect to="/proxies" />} />
              <Route path="/anti-detect"       element={<LegacyRedirect to="/anti-detect" />} />
              <Route path="/privacy"           element={<LegacyRedirect to="/privacy" />} />
              <Route path="/settings"          element={<LegacyRedirect to="/settings" />} />

              <Route path="/" element={<HomeRedirect />} />
              <Route path="*" element={<HomeRedirect />} />
            </Routes>
          </Suspense>
        </PlatformProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
