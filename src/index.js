import React from 'react';
import ReactDOM from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import AppWithAuth from './AppWithAuth';
import Miniplayer from './Miniplayer';

// mini window opens this same bundle w/ ?view=miniplayer so it gets the
// tiny remote control instead of the whole app
const isMiniplayer = new URLSearchParams(window.location.search).get('view') === 'miniplayer';

// go
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {isMiniplayer ? <Miniplayer /> : <AppWithAuth />}
  </React.StrictMode>
);

// service worker = installable + works offline-ish. not in dev (messes with
// hot reload) and not for the miniplayer, doesnt need it
if (!isMiniplayer && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('service worker registration failed:', err);
    });
  });
}
