import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, ShieldOff, ArrowLeft } from 'lucide-react';
import { TrackingAccessProvider, useTrackingAccess } from '../../context/TrackingAccessContext';
import TrackingLayout from '../../components/tracking/TrackingLayout';
import TrackingDashboard from './TrackingDashboard';
import TrackingAccounts from './TrackingAccounts';
import TrackingAccountDetail from './TrackingAccountDetail';
import TrackingTeam from './TrackingTeam';

const TITLES = [
  { match: (p) => p === '/tracking' || p === '/tracking/', title: 'Dashboard' },
  { match: (p) => p.startsWith('/tracking/accounts'), title: 'Accounts' },
  { match: (p) => p.startsWith('/tracking/team'), title: 'Team' },
];

function AccessDenied() {
  const navigate = useNavigate();
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-[#04100c] text-center text-emerald-50 px-6">
      <ShieldOff className="h-10 w-10 text-emerald-300/60 mb-4" />
      <h2 className="text-lg font-semibold text-white">No access to Tracking</h2>
      <p className="text-sm text-emerald-200/70 mt-1 max-w-sm">
        You haven't been added to the Tracking team. Ask an owner to grant you access.
      </p>
      <button
        onClick={() => navigate('/telegram/dashboard')}
        className="mt-6 inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-emerald-100 hover:bg-white/5"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Telegram panel
      </button>
    </div>
  );
}

function TrackingShell() {
  const { loading, hasAccess } = useTrackingAccess();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#04100c]">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
      </div>
    );
  }
  if (!hasAccess) return <AccessDenied />;

  const title = (TITLES.find((t) => t.match(location.pathname)) || {}).title || 'Tracking';

  return (
    <TrackingLayout title={title}>
      <Routes>
        <Route index element={<TrackingDashboard />} />
        <Route path="accounts" element={<TrackingAccounts />} />
        <Route path="accounts/:id" element={<TrackingAccountDetail />} />
        <Route path="team" element={<TrackingTeam />} />
        <Route path="*" element={<Navigate to="/tracking" replace />} />
      </Routes>
    </TrackingLayout>
  );
}

export default function TrackingRoutes() {
  return (
    <TrackingAccessProvider>
      <TrackingShell />
    </TrackingAccessProvider>
  );
}
