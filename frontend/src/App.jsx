import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastContainer } from './components/common/Toast';
import { useAuth } from './hooks/useAuth';
import Layout from './components/layout/Layout';

// Pages
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Scrape from './pages/Scrape';
import Messaging from './pages/Messaging';
import Groups from './pages/Groups';
import Lists from './pages/Lists';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import AccountSettings from './pages/AccountSettings';

function ProtectedRoute({ children, title }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Layout title={title}>{children}</Layout>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastContainer />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<ProtectedRoute title="Dashboard"><Dashboard /></ProtectedRoute>} />
          <Route path="/sessions" element={<ProtectedRoute title="Sessions"><Sessions /></ProtectedRoute>} />
          <Route path="/scrape" element={<ProtectedRoute title="Scrape"><Scrape /></ProtectedRoute>} />
          <Route path="/messaging" element={<ProtectedRoute title="Messaging"><Messaging /></ProtectedRoute>} />
          <Route path="/groups" element={<ProtectedRoute title="Groups"><Groups /></ProtectedRoute>} />
          <Route path="/lists" element={<ProtectedRoute title="Lists"><Lists /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute title="Reports"><Reports /></ProtectedRoute>} />
          <Route path="/account-settings" element={<ProtectedRoute title="Account Settings"><AccountSettings /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute title="Settings"><Settings /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
