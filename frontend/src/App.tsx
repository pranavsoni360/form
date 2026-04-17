import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { FullPageLoader } from './components/Loader'
import { Layout } from './components/Layout'
import LoginPage from './pages/Login'
import AdminDashboard from './pages/admin/Dashboard'
import BanksList from './pages/admin/BanksList'
import BankDetail from './pages/admin/BankDetail'
import VendorsList from './pages/admin/VendorsList'
import VendorDetail from './pages/admin/VendorDetail'
import AdminApplicationsList from './pages/admin/ApplicationsList'
import AdminApplicationDetail from './pages/admin/ApplicationDetail'
import AdminCalls from './pages/admin/Calls'
import AdminCallDetail from './pages/admin/CallDetail'
import PortalDashboard from './pages/portal/Dashboard'
import PortalApplications from './pages/portal/Applications'
import PortalApplicationDetail from './pages/portal/ApplicationDetail'
import PortalVendors from './pages/portal/Vendors'
import PortalCalls from './pages/portal/Calls'
import PortalCallNew from './pages/portal/CallNew'
import PortalCallDetail from './pages/portal/CallDetail'

function RequireAuth({ role, children }: { role: 'admin' | 'portal'; children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullPageLoader />
  if (!user) return <Navigate to={role === 'admin' ? '/admin/login' : '/login'} replace state={{ from: location }} />
  if (role === 'admin' && user.role !== 'admin') return <Navigate to="/portal" replace />
  if (role === 'portal' && !(user.role === 'bank_user' || user.role === 'vendor_user')) return <Navigate to="/admin" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage mode="portal" />} />
      <Route path="/admin/login" element={<LoginPage mode="admin" />} />

      {/* Admin */}
      <Route path="/admin" element={<RequireAuth role="admin"><Layout /></RequireAuth>}>
        <Route index element={<AdminDashboard />} />
        <Route path="banks" element={<BanksList />} />
        <Route path="banks/:id" element={<BankDetail />} />
        <Route path="vendors" element={<VendorsList />} />
        <Route path="vendors/:id" element={<VendorDetail />} />
        <Route path="applications" element={<AdminApplicationsList />} />
        <Route path="applications/:id" element={<AdminApplicationDetail />} />
        <Route path="calls" element={<AdminCalls />} />
        <Route path="calls/:id" element={<AdminCallDetail />} />
      </Route>

      {/* Portal (bank + vendor) */}
      <Route path="/portal" element={<RequireAuth role="portal"><Layout /></RequireAuth>}>
        <Route index element={<PortalDashboard />} />
        <Route path="applications" element={<PortalApplications />} />
        <Route path="applications/:id" element={<PortalApplicationDetail />} />
        <Route path="vendors" element={<PortalVendors />} />
        <Route path="calls" element={<PortalCalls />} />
        <Route path="calls/new" element={<PortalCallNew />} />
        <Route path="calls/:id" element={<PortalCallDetail />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
