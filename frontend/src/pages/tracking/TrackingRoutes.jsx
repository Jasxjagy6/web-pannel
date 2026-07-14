import { Routes, Route, Navigate } from 'react-router-dom';
import { Loader2, ShieldOff } from 'lucide-react';
import { TrackingAccessProvider, useTrackingAccess } from '../../context/TrackingAccessContext';
import TrackingDashboard from './TrackingDashboard';
import TrackingAccounts from './TrackingAccounts';
import TrackingAccountDetail from './TrackingAccountDetail';
import TrackingTeam from './TrackingTeam';

function TrackingGate({ children }) {
  const { loading, hasAccess } = useTrackingAccess();

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>;
  }
  if (!hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldOff className="h-10 w-10 text-gray-600 mb-4" />
        <h2 className="text-lg font-semibold text-white">No access to Tracking</h2>
        <p className="text-sm text-gray-400 mt-1 max-w-sm">
          You haven't been added to the Tracking team. Ask an owner to grant you access.
        </p>
      </div>
    );
  }
  return children;
}

function TrackingRoutesInner() {
  return (
    <Routes>
      <Route index element={<TrackingDashboard />} />
      <Route path="accounts" element={<TrackingAccounts />} />
      <Route path="accounts/:id" element={<TrackingAccountDetail />} />
      <Route path="team" element={<TrackingTeam />} />
      <Route path="*" element={<Navigate to="accounts" replace />} />
    </Routes>
  );
}

export default function TrackingRoutes() {
  return (
    <TrackingAccessProvider>
      <TrackingGate>
        <TrackingRoutesInner />
      </TrackingGate>
    </TrackingAccessProvider>
  );
}
