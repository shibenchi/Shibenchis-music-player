import React from 'react';
import ReactDOM from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './index.css';
import AppWithAuth from './AppWithAuth';
import Miniplayer from './Miniplayer';
import Wallpaper from './Wallpaper';
import { SpotifyHelperPage, SpotifySendWindow } from './SpotifyHelper';
import { initUiScale } from './uiScale';

// mini window opens this same bundle w/ ?view=miniplayer so it gets the
// tiny remote control instead of the whole app. the live wallpaper window
// (?view=wallpaper) gets only the visualizer
const view = new URLSearchParams(window.location.search).get('view');
const isMiniplayer = view === 'miniplayer';
const isWallpaper = view === 'wallpaper';
// the screens of the spotify helper (see SpotifyHelper.js) are opened in a browser, not in the app window
const helperView = view === 'spotify-helper' ? <SpotifyHelperPage /> : view === 'spotify-send' ? <SpotifySendWindow /> : null;

// a file let go over the window would be opened by it, in place of the app. nothing here takes dropped files, so they are refused.
// (the desktop window used to take drops before the page saw them, which also kept this from happening)
const carriesFiles = (event) => Boolean(event.dataTransfer && event.dataTransfer.types && Array.from(event.dataTransfer.types).includes('Files'));
window.addEventListener('dragover', (event) => { if (carriesFiles(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (carriesFiles(event)) event.preventDefault(); });

// the size of the interface (ctrl and plus or minus on a computer, a setting on the phone). the mini player and the wallpaper keep their own
if (!isMiniplayer && !isWallpaper) initUiScale();

// go
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {helperView || (isMiniplayer ? <Miniplayer /> : isWallpaper ? <Wallpaper /> : <AppWithAuth />)}
  </React.StrictMode>
);

// service worker = installable + works offline-ish. not in dev (messes with
// hot reload) and not for the miniplayer, doesnt need it
if (!isMiniplayer && !isWallpaper && !helperView && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('service worker registration failed:', err);
    });
  });
}
