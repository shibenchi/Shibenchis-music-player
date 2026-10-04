import React, { useState, useEffect, useCallback } from 'react';
import OriginalApp from './App';
import { socialFetch } from './socialApi';
import { transferGuestDataToAccount } from './guestTransfer';

// auth + settings api calls
const api = {
  getSession: async () => {
    // the social server can be on another machine, and a server that is down
    // or unreachable must not leave the app stuck on its loading screen. after
    // 5 seconds it carries on as signed out
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await socialFetch('/api/auth/session', { signal: controller.signal });
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return null;
      }
      const data = await res.json();
      return data.user;
    } finally {
      clearTimeout(timer);
    }
  },

  logout: async () => {
    const res = await socialFetch('/api/auth/logout', { method: 'POST' });
    return res.ok;
  },

  getSettings: async () => {
    const res = await socialFetch('/api/user/settings');
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return null;
    }
    const data = await res.json();
    return data.settings;
  },

  saveSettings: async (settings) => {
    const res = await socialFetch('/api/user/settings', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
    return res.ok;
  }
};

// localstorage keys
const LOCAL_KEYS = {
  settings: 'music_settings',
  playlists: 'music_playlists',
  queue: 'music_queue',
  downloaded: 'music_downloaded',
  guestThemeColor: 'music_theme_color_guest',
  guestDebugMode: 'music_debug_mode_guest'
};

function parseThemeColor(raw) {
  if (!raw) return null;

  const [r, g, b] = String(raw).split(',').map((value) => Number(value));
  if (![r, g, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
    return null;
  }

  return { r, g, b };
}

// the signed in user and their settings are kept on the device, so opening the
// app with no connection (or the account server down) still shows their own
// playlists and queue instead of dropping them to a guest
const CACHED_USER_KEY = 'music_cached_user';
function readCachedUser() {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    const user = raw ? JSON.parse(raw) : null;
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function readGuestThemeColor() {
  return parseThemeColor(localStorage.getItem(LOCAL_KEYS.guestThemeColor)) || { r: 255, g: 89, b: 0 };
}

function readGuestDebugMode() {
  return localStorage.getItem(LOCAL_KEYS.guestDebugMode) === 'true';
}

export default function AppWithAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // theme color, from storage or just default to the orange
  const [themeColor, setThemeColor] = useState(() => {
    return readGuestThemeColor();
  });

  // debug mode toggle
  const [debugMode, setDebugMode] = useState(() => {
    return readGuestDebugMode();
  });

  // keeps what the account is listening to from other people (kept on the account)
  const [hideListening, setHideListening] = useState(false);

  const applyUserSettings = useCallback(async (nextUser) => {
    if (!nextUser) {
      setThemeColor(readGuestThemeColor());
      setDebugMode(readGuestDebugMode());
      setHideListening(false);
      return;
    }

    const settingsKey = `music_cached_settings:${nextUser.id}`;
    try {
      let settings = null;
      try {
        settings = await api.getSettings();
        if (settings) localStorage.setItem(settingsKey, JSON.stringify(settings));
      } catch (networkErr) {
        // no connection: use the settings this device last saw
        try { settings = JSON.parse(localStorage.getItem(settingsKey) || 'null'); } catch { settings = null; }
        if (!settings) throw networkErr;
      }
      if (settings) {
        // a channel of 0 is a real value (pure blue has no red), only a missing one
        // falls back to the default orange
        const channel = (value, fallback) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value));
        setThemeColor({
          r: channel(settings.theme_color_r, 255),
          g: channel(settings.theme_color_g, 89),
          b: channel(settings.theme_color_b, 0)
        });
        setDebugMode(settings.debug_mode || false);
        setHideListening(Boolean(settings.hide_listening));
        return;
      }
    } catch (settingsErr) {
      console.warn('Failed to load user settings:', settingsErr);
    }

    setThemeColor({ r: 255, g: 89, b: 0 });
    setDebugMode(false);
  }, []);

  // theme color and debug mode from what this device saved last time, with no
  // waiting on the network. returns false when nothing was saved yet
  const applyCachedSettings = useCallback((cachedUser) => {
    try {
      const settings = JSON.parse(localStorage.getItem(`music_cached_settings:${cachedUser.id}`) || 'null');
      if (!settings) return false;
      const channel = (value, fallback) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value));
      setThemeColor({
        r: channel(settings.theme_color_r, 255),
        g: channel(settings.theme_color_g, 89),
        b: channel(settings.theme_color_b, 0)
      });
      setDebugMode(settings.debug_mode || false);
      setHideListening(Boolean(settings.hide_listening));
      return true;
    } catch {
      return false;
    }
  }, []);

  // another device changed the theme color or settings, pick up the new ones
  const handleAccountSettingsChanged = useCallback(() => {
    if (user) applyUserSettings(user);
  }, [applyUserSettings, user]);

  // check if ur logged in on load, pull settings if so
  useEffect(() => {
    const initAuth = async () => {
      // someone who was signed in last time opens straight into their own app
      // from what this device has saved, and the server is asked in the
      // background. waiting on it (up to 5 seconds when it cannot be reached,
      // as on a network that blocks it) left a blank loading screen at every launch
      const cachedUser = readCachedUser();
      if (cachedUser && localStorage.getItem('music_auth_token')) {
        setUser(cachedUser);
        applyCachedSettings(cachedUser);
        setLoading(false);
        try {
          const sessionUser = await api.getSession();
          if (sessionUser) {
            try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(sessionUser)); } catch {}
            // same person, keep the object the app already uses so nothing reloads
            setUser((prev) => (prev && prev.id === sessionUser.id ? prev : sessionUser));
            applyUserSettings(sessionUser);
          } else {
            // the server answered and says this sign in is over
            try { localStorage.removeItem(CACHED_USER_KEY); } catch {}
            localStorage.removeItem('music_auth_token');
            setUser(null);
            setThemeColor(readGuestThemeColor());
            setDebugMode(readGuestDebugMode());
          }
        } catch (err) {
          // no connection or the server is down: stay signed in on this device
          console.warn('Background session check failed:', err);
        }
        return;
      }

      try {
        const sessionUser = await api.getSession();
        // an account that is still empty picks up what was made as a guest.
        // done before the user is set so the app loads the moved data
        if (sessionUser) {
          await transferGuestDataToAccount(sessionUser).catch(() => {});
          try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(sessionUser)); } catch {}
        } else {
          // the server answered and says nobody is signed in
          try { localStorage.removeItem(CACHED_USER_KEY); } catch {}
        }
        setUser(sessionUser || null);
        await applyUserSettings(sessionUser || null);
      } catch (err) {
        console.error('Auth init error:', err);
        // the server could not be reached. someone who was signed in stays
        // signed in as far as this device goes, with the data it already has
        const cached = readCachedUser();
        if (cached && localStorage.getItem('music_auth_token')) {
          setUser(cached);
          await applyUserSettings(cached);
        } else {
          setUser(null);
          setThemeColor(readGuestThemeColor());
          setDebugMode(readGuestDebugMode());
        }
      }
      setLoading(false);
    };

    initAuth();
  }, [applyUserSettings, applyCachedSettings]);

  // guest only - save theme to localstorage when it changes
  useEffect(() => {
    if (loading || user) return; // dont clobber the real user's theme with guest storage
    localStorage.setItem(LOCAL_KEYS.guestThemeColor, `${themeColor.r},${themeColor.g},${themeColor.b}`);
  }, [themeColor, loading, user]);

  // same deal but for debug mode
  useEffect(() => {
    if (loading || user) return;
    localStorage.setItem(LOCAL_KEYS.guestDebugMode, String(debugMode));
  }, [debugMode, loading, user]);

  const handleLogin = useCallback(async (loggedInUser) => {
    if (loggedInUser) {
      // brand new or still empty accounts take the guest queue, playlists and
      // theme color along. it has to finish before setUser so the app then
      // loads the moved data instead of an empty account
      await transferGuestDataToAccount(loggedInUser).catch(() => {});
      setUser(loggedInUser);
      await applyUserSettings(loggedInUser);
    }
  }, [applyUserSettings]);

  const handleLogout = useCallback(async () => {
    if (user) {
      await api.logout();
    }
    // wipe the token, back to guest
    localStorage.removeItem('music_auth_token');
    try { localStorage.removeItem(CACHED_USER_KEY); } catch {}
    setUser(null);
    setThemeColor(readGuestThemeColor());
    setDebugMode(readGuestDebugMode());
  }, [user]);

  // theme color change - logged in users get it synced to the db, guests just get localstorage
  const handleThemeColorChange = useCallback(async (newColor) => {
    setThemeColor(newColor);

    if (user) {
      try {
        await api.saveSettings({
          theme_color_r: newColor.r,
          theme_color_g: newColor.g,
          theme_color_b: newColor.b,
          debug_mode: debugMode,
          hide_listening: hideListening
        });
      } catch (err) {
        console.error('Failed to save theme to account:', err);
      }
      return;
    }

    localStorage.setItem(LOCAL_KEYS.guestThemeColor, `${newColor.r},${newColor.g},${newColor.b}`);
  }, [debugMode, hideListening, user]);

  const handleDebugModeToggle = useCallback(async (enabled) => {
    setDebugMode(enabled);

    if (user) {
      try {
        await api.saveSettings({
          theme_color_r: themeColor.r,
          theme_color_g: themeColor.g,
          theme_color_b: themeColor.b,
          debug_mode: enabled,
          hide_listening: hideListening
        });
      } catch (err) {
        console.error('Failed to save debug mode to account:', err);
      }
      return;
    }

    localStorage.setItem(LOCAL_KEYS.guestDebugMode, String(enabled));
  }, [hideListening, themeColor.b, themeColor.g, themeColor.r, user]);

  const handleHideListeningToggle = useCallback(async (hidden) => {
    setHideListening(hidden);
    if (!user) return;
    try {
      await api.saveSettings({
        theme_color_r: themeColor.r,
        theme_color_g: themeColor.g,
        theme_color_b: themeColor.b,
        debug_mode: debugMode,
        hide_listening: hidden
      });
    } catch (err) {
      console.error('Failed to save the listening setting to account:', err);
      setHideListening(!hidden);
    }
  }, [debugMode, themeColor.b, themeColor.g, themeColor.r, user]);

  // just a loading screen, nothing crazy
  if (loading) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
        color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '24px', marginBottom: '20px' }}>Shibenchi's music player</div>
          <div style={{ fontSize: '14px', opacity: 0.7 }}>loading...</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {}
      <OriginalApp
        user={user || null}
        themeColor={themeColor}
        debugMode={debugMode}
        onThemeColorChange={handleThemeColorChange}
        onDebugModeToggle={handleDebugModeToggle}
        hideListening={hideListening}
        onHideListeningToggle={handleHideListeningToggle}
        onLogin={handleLogin}
        onLogout={handleLogout}
        onAccountSettingsChanged={handleAccountSettingsChanged}
      />
    </>
  );
}
