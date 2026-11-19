import { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { lazyPage } from './lib/lazy.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Layout from './components/Layout.jsx';
import { Mark } from './components/Logo.jsx';
import { DemoEntry, Forgot, Login, OAuthCallback, Register, Reset, Verify } from './pages/Auth.jsx';
const Landing = lazyPage(() => import('./pages/Landing.jsx'));
const Dashboard = lazyPage(() => import('./pages/Dashboard.jsx'));
const Tickets = lazyPage(() => import('./pages/Tickets.jsx'));
const TicketDetail = lazyPage(() => import('./pages/TicketDetail.jsx'));
const Copilot = lazyPage(() => import('./pages/Copilot.jsx'));
const Intelligence = lazyPage(() => import('./pages/Intelligence.jsx'));
const Knowledge = lazyPage(() => import('./pages/Knowledge.jsx'));
const Settings = lazyPage(() => import('./pages/Settings.jsx'));
const Messages = lazyPage(() => import('./pages/Messages.jsx'));
const Customers = lazyPage(() => import('./pages/Customers.jsx'));
const Team = lazyPage(() => import('./pages/Team.jsx'));
const Automation = lazyPage(() => import('./pages/Automation.jsx'));
const Integrations = lazyPage(() => import('./pages/Integrations.jsx'));

/** Ecran reserve a un role : un role insuffisant est renvoye a l'accueil (le serveur refuse de toute facon les appels). */
function Gate({ min, children }) {
  const { can } = useAuth();
  return can(min) ? children : <Navigate to="/" replace />;
}

function Splash() {
  return <div className="grid min-h-screen place-items-center"><div className="aura" /><Mark size={56} /></div>;
}

function Protected({ children }) {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Splash />;
  // Un visiteur qui arrive sur "/" voit la page de présentation ; ailleurs il est renvoyé vers la connexion.
  if (status === 'out') return loc.pathname === '/' ? <Navigate to="/welcome" replace /> : <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

function Public({ children, bare = false }) {
  const { status } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'in') return <Navigate to="/" replace />;
  return <>{!bare && <div className="aura" aria-hidden="true" />}{children}</>;
}

export default function App() {
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
    <Suspense fallback={<Splash />}>
    <Routes>
      <Route path="/welcome" element={<Public bare><Landing /></Public>} />
      <Route path="/demo" element={<Public><DemoEntry /></Public>} />
      <Route path="/login" element={<Public><Login /></Public>} />
      <Route path="/register" element={<Public><Register /></Public>} />
      <Route path="/verify" element={<Public><Verify /></Public>} />
      <Route path="/forgot" element={<Public><Forgot /></Public>} />
      <Route path="/reset" element={<Public><Reset /></Public>} />
      <Route path="/auth/callback" element={<><div className="aura" /><OAuthCallback /></>} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Dashboard />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="intelligence" element={<Intelligence />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="messages" element={<Messages />} />
        <Route path="messages/:id" element={<Messages />} />
        <Route path="customers" element={<Customers />} />
        <Route path="team" element={<Team />} />
        <Route path="automation" element={<Gate min="agent"><Automation /></Gate>} />
        <Route path="integrations" element={<Gate min="admin"><Integrations /></Gate>} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
