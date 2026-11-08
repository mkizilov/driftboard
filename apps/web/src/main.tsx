import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { pwaStatus } from './lib/pwa-status';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// In `vite dev` there is no service worker and this does nothing.
const updateServiceWorker = registerSW({
  onOfflineReady: () => {
    pwaStatus.markOfflineReady();
  },
  onNeedRefresh: () => {
    pwaStatus.markNeedRefresh();
  },
});
pwaStatus.setReload(() => {
  void updateServiceWorker(true);
});
