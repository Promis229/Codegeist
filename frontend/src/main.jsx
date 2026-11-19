import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { I18nProvider } from './i18n/index.jsx';
import { ToastProvider } from './components/ui.jsx';
import { reloadOnce } from './lib/lazy.js';
import { registerSW } from './lib/pwa.js';

// Vite signale ici l'échec du préchargement d'un fichier de page (version périmée après un déploiement) : on recharge, une seule fois.
// (sans preventDefault : l'erreur doit remonter jusqu'au filet de sécurité si le rechargement a déjà eu lieu.)
window.addEventListener('vite:preloadError', () => { reloadOnce(); });
registerSW();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
