import React, { useState, useEffect, useCallback } from 'react';
import OriginalApp from './App';
import { socialFetch } from './socialApi';

// auth + settings api calls
const api = {
  getSession: async () => {
    const res = await socialFetch('/api/auth/session');
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return null;
    }
    const data = await res.json();
    return data.user;
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

  const applyUserSettings = useCallback(async (nextUser) => {
    if (!nextUser) {
      setThemeColor(readGuestThemeColor());
      setDebugMode(readGuestDebugMode());
      return;
    }

    try {
      const settings = await api.getSettings();
      if (settings) {
        setThemeColor({
          r: settings.theme_color_r || 255,
          g: settings.theme_color_g || 89,
          b: settings.theme_color_b || 0
        });
        setDebugMode(settings.debug_mode || false);
        return;
      }
    } catch (settingsErr) {
      console.warn('Failed to load user settings:', settingsErr);
    }

    setThemeColor({ r: 255, g: 89, b: 0 });
    setDebugMode(false);
  }, []);

  // check if ur logged in on load, pull settings if so
  useEffect(() => {
    const initAuth = async () => {
      try {
        const sessionUser = await api.getSession();
        setUser(sessionUser || null);
        await applyUserSettings(sessionUser || null);
      } catch (err) {
        console.error('Auth init error:', err);
        setUser(null);
        setThemeColor(readGuestThemeColor());
        setDebugMode(readGuestDebugMode());
      }
      setLoading(false);
    };

    initAuth();
  }, [applyUserSettings]);

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
          debug_mode: debugMode
        });
      } catch (err) {
        console.error('Failed to save theme to account:', err);
      }
      return;
    }

    localStorage.setItem(LOCAL_KEYS.guestThemeColor, `${newColor.r},${newColor.g},${newColor.b}`);
  }, [debugMode, user]);

  const handleDebugModeToggle = useCallback(async (enabled) => {
    setDebugMode(enabled);

    if (user) {
      try {
        await api.saveSettings({
          theme_color_r: themeColor.r,
          theme_color_g: themeColor.g,
          theme_color_b: themeColor.b,
          debug_mode: enabled
        });
      } catch (err) {
        console.error('Failed to save debug mode to account:', err);
      }
      return;
    }

    localStorage.setItem(LOCAL_KEYS.guestDebugMode, String(enabled));
  }, [themeColor.b, themeColor.g, themeColor.r, user]);

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
        onLogin={handleLogin}
        onLogout={handleLogout}
      />
    </>
  );
}
