import React from 'react';
import ReactDOM from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import AppWithAuth from './AppWithAuth';
import Miniplayer from './Miniplayer';
import { SpotifyHelperPage, SpotifySendWindow } from './SpotifyHelper';

// mini window opens this same bundle w/ ?view=miniplayer so it gets the
// tiny remote control instead of the whole app
const view = new URLSearchParams(window.location.search).get('view');
const isMiniplayer = view === 'miniplayer';
// the screens of the spotify helper (see SpotifyHelper.js) are opened in a browser, not in the app window
const helperView = view === 'spotify-helper' ? <SpotifyHelperPage /> : view === 'spotify-send' ? <SpotifySendWindow /> : null;

// go
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {helperView || (isMiniplayer ? <Miniplayer /> : <AppWithAuth />)}
  </React.StrictMode>
);

// service worker = installable + works offline-ish. not in dev (messes with
// hot reload) and not for the miniplayer, doesnt need it
if (!isMiniplayer && !helperView && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('service worker registration failed:', err);
    });
  });
}
