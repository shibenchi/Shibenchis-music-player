import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Container, Form, Button, Card, ListGroup, Modal, Dropdown } from 'react-bootstrap';
import AuthForm from './AuthForm';
import { getSocialWsUrl, isSocialEndpoint, socialUrl } from './socialApi';
import { isTauriApp, sendNowPlaying, sendVisualizerFrame, onMiniplayerControl, onMiniplayerReady, saveFileWithDialog, getDefaultDownloadsDir, chooseDownloadsFolder, saveFileToFolder, applyShortcutPrefs, frontendLog } from './tauriApi';
import {
  buildSharedPlayerUpdate,
  getSharedResumeTime,
  isConversationVisible,
  markConversationPreviewEntriesRead,
  upsertConversationPreviewEntries
} from './realtimeUtils';

// keep the noisy resizeobserver warning out of the console
const originalConsoleError = console.error;
console.error = (...args) => {
  if (args[0] && typeof args[0] === 'string' && args[0].includes('ResizeObserver loop completed with undelivered notifications')) {
    return; // skip just this one
  }
  originalConsoleError.apply(console, args);
};

// catch real render crashes, but ignore the resizeobserver spam
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    // ignore resizeobserver noise
    if (error.message && error.message.includes('ResizeObserver loop completed with undelivered notifications')) {
      return { hasError: false }; // no need to show ui for this
    }
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // log the real stuff, skip the resizeobserver noise
    if (!(error.message && error.message.includes('ResizeObserver loop completed with undelivered notifications'))) {
      console.error('Error caught by boundary:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return <div>Something went wrong.</div>;
    }

    return this.props.children;
  }
}


const SVGIcons = {
  trash: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
    </svg>
  ),
  download: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  ),
  play: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  pause: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  ),
  previous: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="19 20 9 12 19 4 19 20" />
      <line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  next: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  shuffle: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  ),
  repeat: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  repeatOne: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      <text x="12" y="14" textAnchor="middle" fontSize="8" fill="currentColor" stroke="none">1</text>
    </svg>
  ),
  volume: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  ),
  mute: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  ),
  playNext: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  plus: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  list: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  folder: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  hamburger: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  ),
  close: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  drag: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  ),
  silhouette: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20c1.6-3.6 4.1-5.4 7-5.4S17.4 16.4 19 20" />
    </svg>
  ),
  collabPlaylist: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="6.5" r="3.5" />
      <circle cx="15" cy="6.5" r="3.5" opacity="0.4" />
      <path d="M2.5 21c1.2-3 3.5-5 6.5-5s5.3 2 6.5 5" />
      <path d="M15 16c3 0 5.3 2 6.5 5" opacity="0.4" />
    </svg>
  ),
  dots: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  ),
  arrowDown: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  ),
  settings: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  rainbow: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 0 1 9 9" />
      <path d="M12 5a7 7 0 0 1 7 7" />
      <path d="M12 7a5 5 0 0 1 5 5" />
      <path d="M5 12a7 7 0 0 1 7-7" />
      <path d="M7 12a5 5 0 0 1 5-5" />
    </svg>
  ),
  miniplayer: (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
};


function extractYouTubeId(url) {
  if (!url) return '';
  const trimmed = url.trim();
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([\w-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([\w-]+)/,
    /(?:https?:\/\/)?youtu\.be\/([\w-]+)/
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) return match[1];
  }

  if (/^[\w-]{10,}$/.test(trimmed)) return trimmed;
  return '';
}


function extractYouTubePlaylistId(url) {
  if (!url) return '';
  try {
    const normalized = url.trim();
    const parsed = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
    const list = parsed.searchParams.get('list');
    if (list) return list;
  } catch {
    
  }

  const match = url.match(/list=([\w-]+)/);
  return match?.[1] || '';
}


const SEARCH_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const APP_WS_PATH = '/ws';
const LOCAL_HELPER_FALLBACK_URL = 'http://127.0.0.1:3002';
const MEDIA_ENDPOINTS = ['/api/stream', '/api/prefetch', '/api/download', '/api/info', '/api/playlist', '/api/search'];

function normalizeOrigin(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function getLocalHelperUrl() {
  if (typeof window !== 'undefined') {
    const runtimeUrl = normalizeOrigin(window.__MUSIC_LOCAL_HELPER_URL__);
    if (runtimeUrl) return runtimeUrl;

    try {
      const storedUrl = normalizeOrigin(window.localStorage.getItem('music_local_helper_url'));
      if (storedUrl) return storedUrl;
    } catch {
      // ignore localStorage access errors
    }
  }

  return normalizeOrigin(process.env.REACT_APP_LOCAL_HELPER_URL) || LOCAL_HELPER_FALLBACK_URL;
}

function readLocalJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full/unavailable — not fatal, just skip persisting this once
  }
}

function getCached(key) {
  const item = SEARCH_CACHE.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  SEARCH_CACHE.delete(key);
  return null;
}

function setCached(key, data) {
  SEARCH_CACHE.set(key, { data, timestamp: Date.now() });
  if (SEARCH_CACHE.size > 50) {
    const firstKey = SEARCH_CACHE.keys().next().value;
    SEARCH_CACHE.delete(firstKey);
  }
}


const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 2, 4, 6, 8, 8, 8],
  vocal: [0, 0, 2, 4, 6, 6, 4, 2, 0, 0],
  dance: [6, 4, 2, 0, 0, 2, 4, 6, 8, 6],
  jazz: [4, 3, 2, 1, 2, 3, 4, 5, 6, 7],
  rock: [5, 4, 3, 2, 1, 2, 3, 4, 5, 6],
  pop: [3, 4, 5, 4, 3, 2, 3, 4, 5, 4],
  classical: [6, 5, 4, 3, 2, 2, 3, 4, 5, 6],
  electronic: [7, 5, 3, 2, 1, 3, 5, 7, 8, 7]
};

const VISUALIZER_PRESETS = [
  { key: 'none', label: 'background', description: 'no animation, just the plain background' },
  { key: 'particles', label: 'particles', description: 'floating glow orbs that pulse with volume, bottom glow pulses with bass' },
  { key: 'bars', label: 'bars', description: 'classic frequency bar equalizer' },
  { key: 'wave', label: 'wave', description: 'smooth oscilloscope-style waveform' },
  { key: 'radial', label: 'radial', description: 'spinning circular equalizer' },
  { key: 'ripple', label: 'ripple', description: 'rings that ripple out on every bass hit' },
  { key: 'starfield', label: 'starfield', description: 'warp-speed stars that react to volume' },
  { key: 'pulseGrid', label: 'pulse grid', description: 'a grid that lights up with the spectrum' },
  { key: 'network', label: 'network', description: 'drifting nodes connected by lines' },
  { key: 'mirrorSpectrum', label: 'mirror spectrum', description: 'bars mirrored above and below center' },
  { key: 'orbit', label: 'orbit', description: 'dots orbiting the center, pulsing with bass' },
  { key: 'flowField', label: 'flow field', description: 'smooth flowing wavy bands' },
  { key: 'minimalPulse', label: 'minimal pulse', description: 'a single clean pulsing ring' }
];

const REPEAT_MODES = {
  off: { icon: SVGIcons.repeat, label: 'repeat off' },
  all: { icon: SVGIcons.repeat, label: 'repeat all' },
  one: { icon: SVGIcons.repeatOne, label: 'repeat one' }
};


function getCategoryColor(category, themeColor) {
  const colors = {
    click: '#00ff00',
    hover: '#ffff00',
    input: '#00ffff',
    keyboard: '#ff00ff',
    scroll: '#ff8800',
    focus: '#88ff00',
    playback: '#ff6600',
    download: '#00ff88',
    playlist: '#8800ff',
    ui: '#0088ff',
    system: '#ffffff',
    error: '#ff0000',
    warn: '#ff8800'
  };
  
  const tc = themeColor || { r: 255, g: 89, b: 0 };
  return colors[category] || `rgb(${tc.r}, ${tc.g}, ${tc.b})`;
}


const generateId = () => Math.random().toString(36).substr(2, 9);

function getTrackKey(track) {
  if (!track) return '';
  return track.videoId || track.video_id || track.id || track.title || '';
}

function getTrackThumbnail(track) {
  if (!track) return '';
  if (track.thumbnail) return track.thumbnail;
  if (track.videoId) {
    return `https://img.youtube.com/vi/${track.videoId}/hqdefault.jpg`;
  }
  return '';
}

// getTrackThumbnail's own url can still fail to actually load (expired cdn
// url, a resolution youtube never generated for that video, random network
// blip) — so this walks down a chain of progressively safer fallbacks
// instead of just leaving a busted image icon sitting there
function TrackThumbnail({ track, className, alt }) {
  const [tier, setTier] = useState(0);
  const videoId = track?.videoId;
  const sources = [
    getTrackThumbnail(track),
    videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null,
    videoId ? `https://img.youtube.com/vi/${videoId}/default.jpg` : null
  ].filter(Boolean);

  useEffect(() => {
    setTier(0);
  }, [track?.videoId, track?.thumbnail]);

  if (!track || tier >= sources.length) return null;

  return (
    <img
      className={className}
      src={sources[tier]}
      alt={alt}
      onError={() => setTier((t) => t + 1)}
    />
  );
}

// icon buttons using the exact same rgb for both border and icon made the
// border basically disappear against the icon — annoying. this dims and
// desaturates it instead of just reusing the raw theme color, so the
// button outline actually reads as its own frame instead of blending in
function dimBorderColor(c, mix = 0.55, darken = 0.75) {
  const gray = (c.r + c.g + c.b) / 3;
  const r = Math.round((c.r * (1 - mix) + gray * mix) * darken);
  const g = Math.round((c.g * (1 - mix) + gray * mix) * darken);
  const b = Math.round((c.b * (1 - mix) + gray * mix) * darken);
  return `rgb(${r}, ${g}, ${b})`;
}

// shared by the disabled-feature/donate popup's hover and click triggers —
// flips to the opposite side of the cursor when the default side wouldve
// run it off-screen, instead of just clamping it awkwardly against the edge
function computeDisabledNoticePos(clientX, clientY) {
  const offset = 14;
  const margin = 16;
  const popupWidth = 230;
  const popupHeightEstimate = 110;

  let x = clientX + offset;
  if (x + popupWidth + margin > window.innerWidth) {
    x = clientX - offset - popupWidth;
  }
  x = Math.max(margin, x);

  let y = clientY + offset;
  if (y + popupHeightEstimate + margin > window.innerHeight) {
    y = clientY - offset - popupHeightEstimate;
  }
  y = Math.max(margin, y);

  return { x, y };
}

function normalizeTrack(track) {
  const source = String(track?.source || track?.provider || 'youtube').trim().toLowerCase() || 'youtube';
  const videoId = track?.videoId || track?.video_id || track?.id || '';
  return {
    ...track,
    source,
    provider: source,
    videoId,
    title: track?.title || '',
    author: track?.author || track?.artist || '',
    format: track?.format || 'mp3',
    thumbnail: track?.thumbnail || (videoId ? getTrackThumbnail({ ...track, videoId }) : ''),
    externalUrl: track?.externalUrl || track?.external_url || '',
    durationMs: Number(track?.durationMs || track?.duration_ms || 0) || 0
  };
}

function normalizeListeningActivity(listening) {
  if (!listening || typeof listening !== 'object') return null;

  const title = String(listening.title || '').trim();
  const author = String(listening.author || '').trim();
  const source = String(listening.source || 'personal').trim().toLowerCase() || 'personal';
  const serverId = String(listening.server_id || listening.serverId || '').trim() || null;

  if (!title) return null;

  return {
    title,
    author,
    source,
    server_id: serverId,
    is_playing: listening.is_playing !== false
  };
}

function formatListeningActivity(listening) {
  if (!listening?.title) return '';
  return listening.author ? `${listening.title} - ${listening.author}` : listening.title;
}

function normalizeSocialUsers(users) {
  const seen = new Set();
  return (Array.isArray(users) ? users : [])
    .map((entry) => {
      if (typeof entry === 'string') {
        const username = entry.trim();
        return username
          ? { id: username, username, is_online: true, current_server_id: null, listening_to: null }
          : null;
      }

      if (entry && typeof entry === 'object') {
        const username = String(entry.username || entry.name || entry.id || '').trim();
        const id = String(entry.id || entry.user_id || username).trim();
        if (!username || !id) return null;
        return {
          ...entry,
          id,
          username,
          is_online: entry.is_online === true,
          current_server_id: entry.current_server_id || null,
          listening_to: normalizeListeningActivity(entry.listening_to),
          last_seen: entry.last_seen ? Number(entry.last_seen) : null,
          created_at: entry.created_at ? Number(entry.created_at) : null
        };
      }

      return null;
    })
    .filter((entry) => {
      if (!entry?.id) return false;
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => a.username.localeCompare(b.username));
}

function formatMessageTimestamp(timestamp) {
  if (!timestamp) return '';

  let numericTimestamp;
  if (typeof timestamp === 'string' && timestamp.includes('T')) {
    // ISO string
    numericTimestamp = Date.parse(timestamp);
  } else {
    numericTimestamp = Number(timestamp);
  }

  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return '';
  }

  const date = new Date(numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatLastActive(timestamp, isOnline = false) {
  if (isOnline) return 'online now';
  if (!timestamp) return 'never seen';

  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp));
  if (deltaSeconds < 60) return 'active just now';
  if (deltaSeconds < 3600) return `active ${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `active ${Math.floor(deltaSeconds / 3600)}h ago`;
  if (deltaSeconds < 604800) return `active ${Math.floor(deltaSeconds / 86400)}d ago`;

  const date = new Date(Number(timestamp) * 1000);
  return `active ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function toIsoTimestamp(value) {
  const numericTimestamp = Number(value);
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return new Date().toISOString();
  }

  const timestampMs = numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp;
  return new Date(timestampMs).toISOString();
}

function normalizeDirectMessageRecord(message) {
  if (!message || typeof message !== 'object') return null;

  const senderId = String(message.sender_id || message.fromUserId || message.from || '').trim();
  const receiverId = String(message.receiver_id || message.toUserId || message.to || '').trim();
  const text = String(message.message || message.text || '').trim();

  if (!senderId || !receiverId || !text) return null;

  return {
    id: String(message.id || '').trim() || `temp-${Date.now()}`,
    sender_id: senderId,
    receiver_id: receiverId,
    message: text,
    created_at: toIsoTimestamp(message.created_at || message.timestamp || Date.now()),
    sender_username: String(message.sender_username || message.fromUsername || message.from || '').trim(),
    receiver_username: String(message.receiver_username || message.toUsername || message.to || '').trim(),
    client_message_id: String(message.client_message_id || message.clientMessageId || '').trim(),
    sender_theme_color: message.sender_theme_color || null
  };
}

function normalizeChannelPlayerState(state, fallbackUpdatedAtMs = Date.now()) {
  if (!state || typeof state !== 'object') return null;

  const currentTime = Number(state.current_time ?? 0);
  const volume = Number(state.volume ?? 1);
  const explicitSyncMs = Number(state.sync_updated_at_ms || 0);
  const updatedAtMs = explicitSyncMs > 0
    ? explicitSyncMs
    : (Number(state.updated_at || 0) > 0 ? Number(state.updated_at || 0) * 1000 : fallbackUpdatedAtMs);
  // calculate elapsed time since the last server update — only when playing
  // and we've got a valid timestamp to work with
  const elapsedSeconds = (state.is_playing === true || state.is_playing === 1) && updatedAtMs > 0
    ? Math.max(0, (fallbackUpdatedAtMs - updatedAtMs) / 1000)
    : 0;
  const effectiveCurrentTime = Number.isFinite(currentTime) ? currentTime + elapsedSeconds : 0;

  return {
    ...state,
    current_track_id: state.current_track_id || null,
    is_playing: state.is_playing === true || state.is_playing === 1,
    current_time: effectiveCurrentTime,
    volume: Number.isFinite(volume) ? volume : 1,
    sync_updated_at_ms: updatedAtMs || fallbackUpdatedAtMs,
    revision: String(state.revision || [
      state.current_track_id || 'none',
      state.is_playing ? 1 : 0,
      effectiveCurrentTime.toFixed(3),
      Number.isFinite(volume) ? volume.toFixed(3) : '1.000',
      updatedAtMs || fallbackUpdatedAtMs
    ].join(':'))
  };
}

// used by the debug console's click/hover logging — a bare tag+class isnt
// enough to tell apart two elements sharing a class, and hover often lands
// on a decorative child (an svg or one of its paths/lines) that carries no
// identifying info of its own at all. pulls in aria-label/title/name —
// whichever actually distinguishes it — and climbs to the nearest
// identifiable ancestor when the direct target doesnt have any of its own
function describeInteractionTarget(target) {
  const identify = (el) => {
    if (!el || !el.getAttribute) return null;
    const ariaLabel = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const name = el.getAttribute('name');
    const className = el.getAttribute('class');
    if (!ariaLabel && !title && !name && !className && !el.id) return null;
    return {
      tag: el.tagName,
      id: el.id || null,
      className: className || null,
      ariaLabel: ariaLabel || null,
      title: title || null,
      name: name || null
    };
  };

  const own = identify(target);
  if (own && (own.ariaLabel || own.title || own.name || own.id)) {
    return own;
  }

  // walk up looking for the nearest actually-labeled interactive ancestor
  let el = target.parentElement;
  for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
    const found = identify(el);
    if (found && (found.ariaLabel || found.title || found.name || found.id)) {
      return { tag: target.tagName, className: own?.className || null, in: found };
    }
  }

  return own || { tag: target.tagName, className: null };
}

function formatDebugDetails(details) {
  if (details === null || details === undefined) return '';
  try {
    return JSON.stringify(details);
  } catch {
    return '[unserializable details]';
  }
}

// local helper detection: auto-discovers yt-dlp helper running on the user's PC
const LOCAL_HELPER_URL = getLocalHelperUrl();
const LOCAL_HELPER_PROBE_TTL_MS = 15000;
let _localHelperAvailable = null; // null = not checked yet, true/false after probe
let _localHelperProbe = null;   // in-flight promise
let _localHelperLastProbeAt = 0;

function isMediaEndpoint(url) {
  return MEDIA_ENDPOINTS.some((endpoint) => String(url || '').startsWith(endpoint));
}

async function probeLocalHelper() {
  if (
    _localHelperAvailable !== null
    && (_localHelperAvailable === true || (Date.now() - _localHelperLastProbeAt) < LOCAL_HELPER_PROBE_TTL_MS)
  ) {
    return _localHelperAvailable;
  }
  if (_localHelperProbe) return _localHelperProbe;

  _localHelperProbe = (async () => {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${LOCAL_HELPER_URL}/api/version`, { signal: ctrl.signal });
      const data = await res.json();
      _localHelperAvailable = data.mode === 'helper';
      return _localHelperAvailable;
    } catch {
      _localHelperAvailable = false;
      return false;
    } finally {
      _localHelperLastProbeAt = Date.now();
      if (timer) {
        clearTimeout(timer);
      }
      _localHelperProbe = null;
    }
  })();

  return _localHelperProbe;
}

async function resolveApiTarget(url) {
  if (isMediaEndpoint(url) && await probeLocalHelper()) {
    return {
      url: `${LOCAL_HELPER_URL}${url}`,
      usingLocalHelper: true
    };
  }

  // social endpoints (auth/friends/dms/servers/collab) get credentials/auth
  // token handling. socialUrl() resolves to the same local server unless
  // REACT_APP_SOCIAL_API_BASE_URL is set
  if (isSocialEndpoint(url)) {
    return {
      url: socialUrl(url),
      usingLocalHelper: false,
      isSocial: true
    };
  }

  return {
    url,
    usingLocalHelper: false
  };
}

async function resolveMediaUrl(url) {
  const target = await resolveApiTarget(url);
  // when running from a remote host (vps), media endpoints need the local
  // helper. dont silently fall back to the vps — yt-dlp is blocked there
  if (isMediaEndpoint(url) && !target.usingLocalHelper) {
    const h = window.location.hostname;
    const isRemote = h !== 'localhost' && h !== '127.0.0.1' && h !== '0.0.0.0';
    if (isRemote) {
      throw new Error('local helper not running — start the app on your device to stream audio');
    }
  }
  return target.url;
}

async function readJsonResponse(response) {
  const raw = await response.text();
  let data = {};
  if (raw) { try { data = JSON.parse(raw); } catch { data = {}; } }
  if (!response.ok) {
    const error = new Error(data?.error || data?.details || raw || `request failed (${response.status})`);
    error.status = response.status;
    error.statusText = response.statusText;
    error.url = response.url;
    error.responseBody = raw;
    error.responseData = data;
    throw error;
  }
  return data;
}

// smart fetch: routes media endpoints to the local helper (if available), everything else to the local backend
async function fetchJson(url, options = {}) {
  const target = await resolveApiTarget(url);

  const fetchOptions = { ...options };
  if (target.isSocial) {
    fetchOptions.credentials = 'include';
    const authToken = typeof window !== 'undefined' ? window.localStorage.getItem('music_auth_token') : null;
    if (authToken) {
      fetchOptions.headers = {
        ...(fetchOptions.headers || {}),
        'X-Auth-Token': authToken
      };
    }
  }

  try {
    const response = await fetch(target.url, fetchOptions);
    return await readJsonResponse(response);
  } catch (error) {
    if (error && typeof error === 'object' && !error.requestUrl) {
      error.requestUrl = target.url;
    }
    if (target.usingLocalHelper) {
      _localHelperAvailable = false;
      const response = await fetch(url, options);
      return readJsonResponse(response);
    }
    throw error;
  }
}

function readSnapLayout(storageKey, fallback) {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;

    return Object.keys(fallback).reduce((next, key) => {
      next[key] = parsed[key] === 'right' ? 'right' : fallback[key];
      return next;
    }, {});
  } catch {
    return fallback;
  }
}

function readStoredJson(storageKey, fallback) {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const SOCIAL_LAYOUT_DEFAULTS = {
  friends: 'left',
  messages: 'right',
  requests: 'left'
};

const COLLAB_LAYOUT_DEFAULTS = {
  setup: 'left',
  queue: 'right',
  chat: 'left',
  player: 'right'
};

// memoized queue list component — isolated from parent re-renders
// (trackProgress ticks etc), otherwise this thing re-renders nonstop
const QueueList = React.memo(function QueueList({
  queue,
  currentIndex,
  themeColor,
  onPlayTrack,
  onRemoveTrack,
  onAddToPlaylist,
  onDownloadSingle,
  isDownloading,
  isQueueRunning,
  onProcessQueue,
  onAddAllToPlaylist,
  onClearQueue
}) {
  return (
    <>
      <ListGroup variant="flush" style={{ maxHeight: '240px', overflowY: 'auto' }}>
        {queue.map((item, idx) => (
          <ListGroup.Item
            key={`${item.videoId || idx}-${idx}`}
            active={idx === currentIndex}
            className="track-item border-0 d-flex justify-content-between align-items-start"
            onClick={() => onPlayTrack(idx)}
          >
            <div style={{ flex: 1 }}>
              <div className="fw-bold" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{item.title}</div>
              <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{item.author}</div>
            </div>

            <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px' }}>
              <Button
                variant="outline-light"
                size="sm"
                type="button"
                className="trash-btn btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveTrack(idx);
                }}
                style={{
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  background: 'transparent',
                  transition: 'all 0.2s ease',
                  transform: 'scale(1)',
                  padding: '4px 8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'scale(1.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {SVGIcons.trash}
              </Button>
              <Button
                variant="outline-light"
                size="sm"
                type="button"
                className="btn"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onAddToPlaylist(item);
                }}
                style={{
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  background: 'transparent',
                  transition: 'all 0.2s ease',
                  transform: 'scale(1)',
                  padding: '4px 8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'scale(1.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {SVGIcons.arrowDown}
              </Button>
              <Button
                variant="outline-light"
                size="sm"
                type="button"
                className="btn"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onDownloadSingle(item);
                }}
                style={{
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  background: 'transparent',
                  transition: 'all 0.2s ease',
                  transform: 'scale(1)',
                  padding: '4px 8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'scale(1.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {SVGIcons.download}
              </Button>
            </div>
          </ListGroup.Item>
        ))}
      </ListGroup>
      <div className="d-flex gap-2 mt-2">
        <Button
          variant="outline-light"
          size="sm"
          onClick={onProcessQueue}
          disabled={isDownloading || isQueueRunning}
          className="download-all-btn"
          style={{
            borderRadius: '6px',
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            border: `1px solid ${dimBorderColor(themeColor)}`,
            background: 'transparent',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
            e.currentTarget.style.color = '#000';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
          }}
        >
          download all
        </Button>
        <Button
          variant="outline-light"
          size="sm"
          // what the fuck — onClick={onAddAllToPlaylist} was passing the
          // click event straight through as the playlist id. the default
          // param only kicks in when NO argument is passed at all, so this
          // was silently searching for a playlist matching a click event,
          // finding nothing, and reporting "success" while adding literally
          // nothing to the playlist. fixed now
          onClick={() => onAddAllToPlaylist()}
          className="add-all-to-playlist-btn"
          style={{
            borderRadius: '6px',
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            border: `1px solid ${dimBorderColor(themeColor)}`,
            background: 'transparent',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
            e.currentTarget.style.color = '#000';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
          }}
        >
          save all to playlist
        </Button>
        <Button
          variant="outline-light"
          size="sm"
          onClick={onClearQueue}
          style={{
            borderRadius: '6px',
            color: '#ff4444',
            border: '1px solid #ff4444',
            background: 'transparent',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#ff4444';
            e.currentTarget.style.color = '#000';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#ff4444';
          }}
        >
          clear queue
        </Button>
      </div>
    </>
  );
});

export default function App({
  user = null,
  themeColor: parentThemeColor,
  debugMode: parentDebugMode,
  onThemeColorChange,
  onDebugModeToggle,
  onLogin,
  onLogout
}) {
  const guestPlaylistsStorageKey = 'music_playlists_guest';
  const socialLayoutStorageKey = user?.id ? `music_social_layout:${user.id}` : 'music_social_layout:guest';
  const collabLayoutStorageKey = user?.id ? `music_collab_layout:${user.id}` : 'music_collab_layout:guest';

  // session id for cross-origin websocket auth
  const [wsSessionId, setWsSessionId] = useState(null);

  const [localThemeColor, setLocalThemeColor] = useState({ r: 255, g: 89, b: 0 });
  const themeColor = parentThemeColor || localThemeColor;

  const debugMode = parentDebugMode !== undefined ? parentDebugMode : false;
  const eventListenersAttached = useRef(false);

  
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('mp3');
  const [status, setStatus] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [videoInfo, setVideoInfo] = useState(null);
  const [queue, setQueue] = useState(() => readLocalJSON(`music_queue_state:${user?.id || 'guest'}`, {}).queue || []);

  const [currentIndex, setCurrentIndex] = useState(-1);

  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [downloadedTracks, setDownloadedTracks] = useState(() => {
    try {
      const saved = localStorage.getItem('music_downloaded');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const prefetchAudioRef = useRef(null);


  const [playIndex, setPlayIndex] = useState(() => readLocalJSON(`music_queue_state:${user?.id || 'guest'}`, {}).playIndex ?? -1);
  const playIndexRef = useRef(playIndex);
  const queueRef = useRef(queue);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(() => readLocalJSON(`music_player_prefs:${user?.id || 'guest'}`, {}).shuffle ?? false);
  const [repeatMode, setRepeatMode] = useState(() => readLocalJSON(`music_player_prefs:${user?.id || 'guest'}`, {}).repeatMode ?? 'off');
  const [volume, setVolume] = useState(() => readLocalJSON(`music_player_prefs:${user?.id || 'guest'}`, {}).volume ?? 1);
  const [trackProgress, setTrackProgress] = useState({ current: 0, duration: 0 });
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isMuted, setIsMuted] = useState(() => readLocalJSON(`music_player_prefs:${user?.id || 'guest'}`, {}).isMuted ?? false);

  
  const audioContextRef = useRef(null);

  
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  // social/collab/login are network features that depended on a shared
  // remote backend thats no longer running (see the popup copy below) —
  // this just tracks which one to show the explanation next to, not
  // whether the feature is actually reachable
  const [disabledFeatureNotice, setDisabledFeatureNotice] = useState(null);
  const [disabledNoticePos, setDisabledNoticePos] = useState({ x: 0, y: 0 });
  const disabledNoticeTimerRef = useRef(null);

  const showDisabledNotice = useCallback((key, autoHide, event) => {
    if (disabledNoticeTimerRef.current) clearTimeout(disabledNoticeTimerRef.current);
    if (event) {
      setDisabledNoticePos(computeDisabledNoticePos(event.clientX, event.clientY));
    }
    setDisabledFeatureNotice(key);
    if (autoHide) {
      disabledNoticeTimerRef.current = setTimeout(() => setDisabledFeatureNotice(null), 4500);
    }
  }, []);

  // called on every mousemove while hovering a trigger — the popup used to
  // just freeze wherever the cursor happened to be on entry instead of
  // actually tracking it, annoying
  const updateDisabledNoticePos = useCallback((event) => {
    setDisabledNoticePos(computeDisabledNoticePos(event.clientX, event.clientY));
  }, []);

  const hideDisabledNotice = useCallback((key) => {
    if (disabledNoticeTimerRef.current) clearTimeout(disabledNoticeTimerRef.current);
    setDisabledFeatureNotice((current) => (current === key ? null : current));
  }, []);

  // appears right where the cursor triggered it instead of sliding in from
  // a fixed spot anchored to the element — position: fixed at the captured
  // cursor coordinates, no transition, just shows/hides instantly
  //
  // portaled straight to document.body instead of rendered in place: the
  // login trigger sits inside the settings modal, whose .modal-content has
  // backdrop-filter: blur(...) — which, just like transform, creates a NEW
  // containing block for position: fixed descendants. that was silently
  // repositioning this popup relative to the modal box instead of the
  // viewport, which is what was actually causing the "way off to the side"
  // offset — the coordinates being computed were correct the whole time!!
  // drove me insane for a bit. a portal sidesteps the problem entirely
  // regardless of whatevers in the ancestor chain, here or anywhere else
  // this ever gets used from later
  const renderDisabledNotice = useCallback((key) => {
    if (disabledFeatureNotice !== key) return null;
    return createPortal(
      <div
        style={{
          position: 'fixed',
          left: disabledNoticePos.x,
          top: disabledNoticePos.y,
          background: '#101010',
          border: `1px solid ${dimBorderColor(themeColor)}`,
          borderRadius: '8px',
          padding: '12px 14px',
          fontSize: '12px',
          lineHeight: 1.5,
          color: '#f5f5f5',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
          zIndex: 3000,
          width: '230px',
          pointerEvents: 'none'
        }}
      >
        sorry, due to server costs i had to disable these features for now. you're welcome to{' '}
        <a
          href="https://ko-fi.com/shibenchi"
          target="_blank"
          rel="noreferrer"
          style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontWeight: 'bold', pointerEvents: 'auto' }}
        >
          donate
        </a>{' '}
        to contribute to server costs. stay tuned as I may bring these features back in the future!
      </div>,
      document.body
    );
  }, [disabledFeatureNotice, disabledNoticePos, themeColor]);
  
  
  
  const handleThemeColorChange = useCallback((newColor) => {
    if (onThemeColorChange) {
      onThemeColorChange(newColor);
    } else {
      setLocalThemeColor(newColor);
      localStorage.setItem('music_theme_color_guest', `${newColor.r},${newColor.g},${newColor.b}`);
    }
  }, [onThemeColorChange]);

  
  const [playlists, setPlaylists] = useState(() => {
    return user ? [] : readStoredJson(guestPlaylistsStorageKey, []);
  });
  const [currentPlaylistId, setCurrentPlaylistId] = useState(() => {
    const localPlaylists = user ? [] : readStoredJson(guestPlaylistsStorageKey, []);
    return localPlaylists.length > 0 ? localPlaylists[0].id : '';
  });
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [editingPlaylistId, setEditingPlaylistId] = useState(null);

  
  const [suggestions, setSuggestions] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(true);

  
  const [showEQ, setShowEQ] = useState(false);
  const [eqEnabled, setEqEnabled] = useState(() => readLocalJSON(`music_eq:${user?.id || 'guest'}`, {}).eqEnabled ?? false);
  const [eqValues, setEqValues] = useState(() => readLocalJSON(`music_eq:${user?.id || 'guest'}`, {}).eqValues ?? EQ_PRESETS.flat);
  const [selectedPreset, setSelectedPreset] = useState(() => readLocalJSON(`music_eq:${user?.id || 'guest'}`, {}).selectedPreset ?? 'flat');
  const [visualizerPreset, setVisualizerPreset] = useState(() => localStorage.getItem(`music_visualizer_preset:${user?.id || 'guest'}`) || 'wave');

  
  const [showToast, setShowToast] = useState(null);
  const [draggedTrack, setDraggedTrack] = useState(null);
  const [playNextQueue, setPlayNextQueue] = useState([]);
  const [debugEntries, setDebugEntries] = useState(() => {
    const stored = readStoredJson('music_frontend_debug_logs', []);
    return Array.isArray(stored) ? stored : [];
  });
  const [backendDebugSnapshot, setBackendDebugSnapshot] = useState('');
  const [backendDebugError, setBackendDebugError] = useState('');
  const [backendDebugLoading, setBackendDebugLoading] = useState(false);
  const [backendDebugLoadedAt, setBackendDebugLoadedAt] = useState('');

  // first-run welcome dialog — shown once, only on a genuinely fresh
  // install (no registered users yet AND never dismissed before)
  const [showWelcomeModal, setShowWelcomeModal] = useState(false);
  const [welcomeDesktopShortcut, setWelcomeDesktopShortcut] = useState(true);
  const [welcomeTaskbarPin, setWelcomeTaskbarPin] = useState(true);
  useEffect(() => {
    if (localStorage.getItem('shibenchi_welcome_dismissed')) return;
    fetchJson('/api/first-run-status')
      .then((data) => {
        if (data?.isFreshInstall) setShowWelcomeModal(true);
      })
      .catch(() => {});
  }, []);
  const dismissWelcomeModal = () => {
    localStorage.setItem('shibenchi_welcome_dismissed', '1');
    setShowWelcomeModal(false);
    if (isTauriDesktop) applyShortcutPrefs(welcomeDesktopShortcut, welcomeTaskbarPin);
  };

  // version check stuff — still used for the "new version available" banner
  const [currentVersion, setCurrentVersion] = useState('1.0.0');
  const [versionMismatch, setVersionMismatch] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');

  const [activeTab, setActiveTab] = useState('main');
  const [allUsers, setAllUsers] = useState([]);
  const [friendsList, setFriendsList] = useState([]);
  const [pendingFriendRequests, setPendingFriendRequests] = useState([]);
  const [friendRequestActionIds, setFriendRequestActionIds] = useState([]);
  const [conversationList, setConversationList] = useState(() => {
    const stored = localStorage.getItem(`music_conversation_list:${user?.id || 'guest'}`);
    try {
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [playbackSource, setPlaybackSource] = useState('personal');
  const [friendSearch, setFriendSearch] = useState('');
  const [pendingFriendTargetIds, setPendingFriendTargetIds] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(() => {
    const stored = localStorage.getItem(`music_selected_conversation:${user?.id || 'guest'}`);
    return stored || '';
  });
  const [dmMessages, setDmMessages] = useState(() => {
    const stored = localStorage.getItem(`music_dm_messages:${user?.id || 'guest'}`);
    try {
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [dmText, setDmText] = useState('');
  const [channels, setChannels] = useState([]);
  const [currentChannel, setCurrentChannel] = useState(null);
  const [currentChannelId, setCurrentChannelId] = useState('');
  const [channelMembers, setChannelMembers] = useState([]);
  const [channelMessages, setChannelMessages] = useState([]);
  const [channelMessageText, setChannelMessageText] = useState('');
  const [chatUserPopup, setChatUserPopup] = useState(null); // { userId, username, x, y }
  const [channelQueue, setChannelQueue] = useState([]);
  const [channelPlayerState, setChannelPlayerState] = useState(null);
  const [sharedRepeatMode, setSharedRepeatMode] = useState('off');
  const [currentCollabPlaylistId, setCurrentCollabPlaylistId] = useState('');
  const [showCollabPlaylistModal, setShowCollabPlaylistModal] = useState(false);
  const [newCollabPlaylistName, setNewCollabPlaylistName] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDescription, setNewChannelDescription] = useState('');
  const [channelDraftName, setChannelDraftName] = useState('');
  const [channelDraftDescription, setChannelDraftDescription] = useState('');
  const [socialPanelSides, setSocialPanelSides] = useState(() => readSnapLayout(socialLayoutStorageKey, SOCIAL_LAYOUT_DEFAULTS));
  const [collabPanelSides, setCollabPanelSides] = useState(() => readSnapLayout(collabLayoutStorageKey, COLLAB_LAYOUT_DEFAULTS));
  const [draggingPanel, setDraggingPanel] = useState(null);
  const [activeDropColumn, setActiveDropColumn] = useState('');
  const [deleteUserConfirm, setDeleteUserConfirm] = useState(null); // { userId, username }
  const [unreadDmCount, setUnreadDmCount] = useState(0);
  const [unreadChannelCount, setUnreadChannelCount] = useState(0);

  // track last-viewed timestamps to calculate unread counts
  const lastViewedConversations = useRef({}); // { userId: timestamp }
  const lastViewedChannels = useRef({}); // { channelId: timestamp }

  const wsRef = useRef(null);
  const conversationListRef = useRef([]);
  const dmScrollRef = useRef(null);
  const channelScrollRef = useRef(null);
  const notifAudioRef = useRef(null);
  const notifAudio2Ref = useRef(null);
  const debugEntriesRef = useRef([]);
  const nativeConsoleRef = useRef({
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  });
  const lastListeningStateSentRef = useRef('');
  const selectedConversationRef = useRef('');
  const activeTabRef = useRef(activeTab);
  const currentChannelRef = useRef('');
  const channelsRef = useRef([]);
  const appWsUrl = getSocialWsUrl(wsSessionId);
  const currentUserId = user?.id || '';
  const currentUsername = user?.username || '';

  const getComparableTimestamp = useCallback((value) => {
    if (!value) return 0;
    if (typeof value === 'string' && value.includes('T')) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }, []);

  const normalizeConversationList = useCallback((incomingEntries, previousEntries = conversationListRef.current) => {
    const previousByUserId = new Map(
      (Array.isArray(previousEntries) ? previousEntries : []).map((entry) => [entry.user_id, entry])
    );

    return (Array.isArray(incomingEntries) ? incomingEntries : [])
      .map((entry) => {
        const previousEntry = previousByUserId.get(entry.user_id);
        const incomingTime = getComparableTimestamp(entry.last_message_at);
        const previousTime = getComparableTimestamp(previousEntry?.last_message_at);
        const baseEntry = previousEntry && previousTime > incomingTime
          ? { ...entry, ...previousEntry }
          : { ...previousEntry, ...entry };
        const lastViewedAtMs = (lastViewedConversations.current[baseEntry.user_id] || 0) * 1000;
        const hasUnread = Boolean(
          baseEntry.last_sender_id
          && baseEntry.last_sender_id !== currentUserId
          && getComparableTimestamp(baseEntry.last_message_at) > lastViewedAtMs
        );

        return {
          ...baseEntry,
          unread_count: hasUnread ? Math.max(Number(previousEntry?.unread_count || 0), 1) : 0
        };
      })
      .sort((a, b) => (
        getComparableTimestamp(b.last_message_at) - getComparableTimestamp(a.last_message_at)
        || a.username.localeCompare(b.username)
      ));
  }, [currentUserId, getComparableTimestamp]);

  // unread message calculation (depends on currentUserId, conversationList, channels, channelMessages)
  const calculateUnreadDmCount = useCallback(() => {
    let count = 0;
    conversationList.forEach((conv) => {
      const lastMsgAt = conv.last_message_at || 0;
      const lastViewedAt = lastViewedConversations.current[conv.user_id] || 0;
      if (lastMsgAt > lastViewedAt && conv.last_sender_id !== currentUserId) {
        count++;
      }
    });
    return count;
  }, [conversationList, currentUserId]);

  const calculateUnreadChannelCount = useCallback(() => {
    let count = 0;
    channels.forEach((ch) => {
      const lastMsg = channelMessages.find((m) => m.server_id === ch.id);
      if (!lastMsg) return;
      const lastMsgAt = lastMsg.created_at || 0;
      const lastViewedAt = lastViewedChannels.current[ch.id] || 0;
      if (lastMsgAt > lastViewedAt && lastMsg.user_id !== currentUserId) {
        count++;
      }
    });
    return count;
  }, [channels, channelMessages, currentUserId]);

  const markConversationRead = useCallback((userId) => {
    lastViewedConversations.current[userId] = Math.floor(Date.now() / 1000);
    
    // refresh conversation preview with the latest message data and mark it read
    setDmMessages((prev) => {
      const messages = prev[userId];
      const hasUnread = Array.isArray(messages) && messages.some((message) => message.unread);
      
      if (!hasUnread) {
        return prev;
      }

      const updatedMessages = messages.map((message) => ({ ...message, unread: false }));
      
      // also update the conversation preview w/ the latest message
      if (Array.isArray(messages) && messages.length > 0) {
        const latestMsg = messages[messages.length - 1];
        setConversationList((prevList) => {
          const updatedList = markConversationPreviewEntriesRead(prevList, userId);
          return updatedList.map((entry) => {
            if (entry.user_id === userId) {
              return {
                ...entry,
                last_message: latestMsg.message,
                last_message_at: latestMsg.created_at,
                last_sender_id: latestMsg.sender_id,
                last_sender_username: latestMsg.sender_username,
                unread_count: 0
              };
            }
            return entry;
          });
        });
      }

      return {
        ...prev,
        [userId]: updatedMessages
      };
    });
    setUnreadDmCount(calculateUnreadDmCount());
  }, [calculateUnreadDmCount]);

  const markChannelRead = useCallback((channelId) => {
    lastViewedChannels.current[channelId] = Math.floor(Date.now() / 1000);
    setUnreadChannelCount(calculateUnreadChannelCount());
  }, [calculateUnreadChannelCount]);

  const particleCanvasRef = useRef(null);
  const fadeTransitionRef = useRef({ active: false, progress: 0, target: 0 });

  const queueRunningRef = useRef(false);
  const abortControllerRef = useRef(null);
  const suggestionTimer = useRef(null);
  const latestSearchId = useRef(0);
  const audioRef = useRef(null);
  const personalProgressBarRef = useRef(null);
  const sharedProgressBarRef = useRef(null);
  const scrubbingRef = useRef(false);
  const handleNextRef = useRef(() => {});
  const eqFiltersRef = useRef([]);
  const analyserRef = useRef(null);
  const playbackSourceRef = useRef('personal');
  const playbackQueueRef = useRef([]);
  const channelQueueRef = useRef(channelQueue);
  const channelPlayerStateRef = useRef(channelPlayerState);
  const playRequestSerialRef = useRef(0);
  const autoplayRef = useRef(true);
  const lastSharedRevisionRef = useRef('');
  const sharedRecoveryTimeoutRef = useRef(null);
  const socialLayoutHydratedRef = useRef(true);
  const collabLayoutHydratedRef = useRef(true);
  const youtubeSyncReadyRef = useRef(false);
  const queueSyncReadyRef = useRef(false);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const MAX_STREAM_RETRIES = 3;
  // tracks whether the local client recently errored — used to prevent cascading skips from shared sync
  const localStreamErrorRef = useRef(false);
  const localStreamErrorTimerRef = useRef(null);
  // tracks the previous shared player is_playing state — used to detect pause→resume transitions
  const prevSharedPlayingRef = useRef(false);
  // personal player state persistence — saves the last paused position for resume
  const personalPlayerStateRef = useRef({ videoId: null, currentTime: 0, duration: 0 });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // notification sounds
  const playNotifSound = useCallback(() => {
    try {
      if (!notifAudioRef.current) {
        notifAudioRef.current = new Audio('/SMP notif.wav');
      } else {
        notifAudioRef.current.currentTime = 0;
      }
      notifAudioRef.current.play().catch(() => {});
    } catch {}
  }, []);

  const playNotifSound2 = useCallback(() => {
    try {
      if (!notifAudio2Ref.current) {
        notifAudio2Ref.current = new Audio('/SMP notif 2.wav');
      } else {
        notifAudio2Ref.current.currentTime = 0;
      }
      notifAudio2Ref.current.play().catch(() => {});
    } catch {}
  }, []);


  const appendDebugEntry = useCallback((entry) => {
    setDebugEntries((prev) => {
      const next = [...prev, entry].slice(-400);
      debugEntriesRef.current = next;
      return next;
    });
  }, []);

  const addDebugLog = useCallback((category, message, details = null, important = false) => {
    if (!debugMode && !important) return;

    let normalizedDetails = details;
    if (normalizedDetails !== null && normalizedDetails !== undefined) {
      try {
        normalizedDetails = JSON.parse(JSON.stringify(normalizedDetails));
      } catch {
        normalizedDetails = { note: 'details could not be serialized' };
      }
    }

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      category: String(category || 'system'),
      message: String(message || ''),
      details: normalizedDetails,
      important: important === true
    };

    appendDebugEntry(entry);

    const consoleMethod = entry.category === 'error' ? 'error' : entry.category === 'warn' ? 'warn' : 'log';
    nativeConsoleRef.current[consoleMethod](`[frontend:${entry.category}] ${entry.message}`, entry.details || '');
  }, [appendDebugEntry, debugMode]);

  const logClient = useCallback((message, details = null, important = false) => {
    addDebugLog('client', message, details, important);
  }, [addDebugLog]);

  // shared by the "copy all logs" and "save logs to file" debug console
  // buttons — both just need the same combined text, one to the
  // clipboard and one to disk.
  const buildAllDebugLogsText = useCallback(() => {
    const frontendLogs = debugEntries.map((e) =>
      `${e.ts} [${e.category}] ${e.message}${e.details ? '\n' + formatDebugDetails(e.details) : ''}`
    ).join('\n\n');
    return `=== FRONTEND LOGS (${debugEntries.length} entries) ===\n\n${frontendLogs}\n\n=== BACKEND LOGS ===\n\n${backendDebugSnapshot || '(not loaded)'}\n`;
  }, [debugEntries, backendDebugSnapshot]);

  // debug console window chrome — draggable by its title bar, resizable via
  // native css resize (see the panel's own style). null position just means
  // "still at the default bottom-right anchor, hasnt been dragged yet"
  const [debugConsolePos, setDebugConsolePos] = useState(null);
  const debugConsoleRef = useRef(null);
  const handleDebugConsoleDragStart = useCallback((e) => {
    const el = debugConsoleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const handleMove = (moveEvent) => {
      setDebugConsolePos({
        x: startLeft + (moveEvent.clientX - startX),
        y: startTop + (moveEvent.clientY - startY)
      });
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, []);
  const debugConsoleButtonStyle = {
    background: '#000',
    color: '#c0c0c0',
    border: '1px solid #808080',
    borderRadius: 0,
    padding: '4px 8px',
    fontSize: '10px',
    fontFamily: 'inherit',
    cursor: 'pointer'
  };

  const showNotification = useCallback((message, variant = 'info') => {
    setShowToast({ message, variant });
    setTimeout(() => setShowToast(null), 3000);
    addDebugLog('ui', `toast: ${variant}`, { message }, variant === 'error');
  }, [addDebugLog]);

  const upsertConversationPreview = useCallback((message) => {
    if (!message?.sender_id || !message?.receiver_id) return;

    const countAsUnread = message.sender_id !== currentUserId && message.unread === true;
    setConversationList((prev) => upsertConversationPreviewEntries(prev, message, currentUserId, countAsUnread));
  }, [currentUserId]);

  const refreshBackendDebugLogs = useCallback(async () => {
    if (!currentUserId) return;

    setBackendDebugLoading(true);
    setBackendDebugError('');
    addDebugLog('api', 'loading backend debug logs', { lines: 200 }, true);

    try {
      const data = await fetchJson('/api/debug/logs?lines=200');
      const serverLines = Array.isArray(data.server_lines) ? data.server_lines : [];
      const errorLines = Array.isArray(data.error_lines) ? data.error_lines : [];
      const snapshot = [
        'server log',
        ...serverLines,
        '',
        'error log',
        ...errorLines
      ].join('\n');

      setBackendDebugSnapshot(snapshot.trim());
      setBackendDebugLoadedAt(new Date().toISOString());
    } catch (error) {
      setBackendDebugError(error.message || 'failed to load backend logs');
      addDebugLog('error', 'failed to load backend debug logs', { error: error.message || String(error) }, true);
    } finally {
      setBackendDebugLoading(false);
    }
  }, [addDebugLog, currentUserId]);

  const sendWsMessage = useCallback((payload) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addDebugLog('ws', 'send skipped because socket is not open', {
        readyState: wsRef.current?.readyState ?? null,
        payload
      }, true);
      return false;
    }

    addDebugLog('ws', `send ${payload?.type || 'unknown'}`, payload, true);
    wsRef.current.send(JSON.stringify(payload));
    return true;
  }, [addDebugLog]);

  const pushDirectMessage = useCallback((rawMessage, options = {}) => {
    const message = normalizeDirectMessageRecord(rawMessage);
    if (!message) return null;

    const conversationId = message.sender_id === currentUserId ? message.receiver_id : message.sender_id;
    const isVisible = isConversationVisible(activeTabRef.current, selectedConversationRef.current, conversationId);
    message.unread = !isVisible && message.sender_id !== currentUserId;

    upsertConversationPreview(message);

    setDmMessages((prev) => {
      const existing = prev[conversationId] || [];
      // always strip temp/optimistic messages so the server response replaces them
      const filtered = existing.filter((entry) => !entry.id.startsWith('temp-'));

      if (filtered.some((entry) => entry.id === message.id)) {
        return prev;
      }

      return {
        ...prev,
        [conversationId]: [...filtered, message]
      };
    });

    return { message, conversationId };
  }, [currentUserId, upsertConversationPreview]);

  const refreshUsers = useCallback(async () => {
    if (!currentUserId) {
      return;
    }

    setLoadingUsers(true);
    try {
      const data = await fetchJson('/api/users');
      const next = normalizeSocialUsers(data.users);
      if (Array.isArray(data?.users)) {
        setAllUsers(next);
      }
    } catch (error) {
      // silent fail — polling hits localhost without auth cookies during dev
    } finally {
      setLoadingUsers(false);
    }
  }, [currentUserId]);

  const refreshFriends = useCallback(async () => {
    if (!currentUserId) return;
    try {
      const data = await fetchJson('/api/friends');
      const next = Array.isArray(data.friends) ? data.friends : [];
      if (next.length > 0 || data.friends) setFriendsList(next);
    } catch (error) {
      // silent fail
    }
  }, [currentUserId]);

  const refreshPendingFriendRequests = useCallback(async () => {
    if (!currentUserId) return;
    try {
      const data = await fetchJson('/api/friends/requests');
      const next = Array.isArray(data.requests) ? data.requests : [];
      if (next.length > 0 || data.requests) setPendingFriendRequests(next);
    } catch (error) {
      // silent fail
    }
  }, [currentUserId]);

  const beginFriendRequestAction = useCallback((requestId) => {
    let started = false;
    setFriendRequestActionIds((prev) => {
      if (prev.includes(requestId)) {
        return prev;
      }
      started = true;
      return [...prev, requestId];
    });
    return started;
  }, []);

  const finishFriendRequestAction = useCallback((requestId) => {
    setFriendRequestActionIds((prev) => prev.filter((id) => id !== requestId));
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!currentUserId) {
      return;
    }

    try {
      const data = await fetchJson('/api/messages/conversations');
      const next = Array.isArray(data?.conversations) ? data.conversations : [];
      setConversationList((prev) => normalizeConversationList(next, prev));
    } catch (error) {
      // silent fail — polling hits localhost without auth cookies during dev
      // conversation list is maintained by upsertConversationPreview instead
    }
  }, [currentUserId, normalizeConversationList]);

  const refreshChannels = useCallback(async () => {
    if (!currentUserId) {
      setChannels([]);
      return;
    }

    try {
      const data = await fetchJson('/api/servers');
      const nextChannels = Array.isArray(data.servers) ? data.servers : [];
      setChannels(nextChannels);
      setCurrentChannel((prev) => {
        if (!currentChannelRef.current) return null;
        return nextChannels.find((entry) => entry.id === currentChannelRef.current) || prev;
      });
    } catch (error) {
      console.warn('Channel list load error:', error);
      setChannels([]);
    }
  }, [currentUserId]);

  const loadConversationMessages = useCallback(async (targetUserId) => {
    if (!currentUserId || !targetUserId) return;

    try {
      addDebugLog('api', 'loading conversation messages', { targetUserId }, true);
      const data = await fetchJson(`/api/messages/${encodeURIComponent(targetUserId)}`);
      const nextMessages = (Array.isArray(data?.messages) ? data.messages : [])
        .map(normalizeDirectMessageRecord)
        .filter(Boolean);

      setDmMessages((prev) => {
        const existing = prev[targetUserId] || [];
        if (existing.length === nextMessages.length && existing.every((message, index) => message.id === nextMessages[index]?.id)) {
          return prev;
        }
        return { ...prev, [targetUserId]: nextMessages };
      });
    } catch (error) {
      addDebugLog('error', 'conversation load failed', { targetUserId, error: error.message || String(error) }, true);
      console.warn('Conversation load error:', error);
    }
  }, [addDebugLog, currentUserId]);

  const loadChannelState = useCallback(async (channelId) => {
    if (!currentUserId || !channelId) {
      setChannelMessages([]);
      setChannelQueue([]);
      setChannelPlayerState(null);
      setChannelMembers([]);
      return;
    }

    try {
      addDebugLog('api', 'loading channel state', { channelId }, true);
      const [messagesData, queueData, playerData, membersData] = await Promise.all([
        fetchJson(`/api/server/${encodeURIComponent(channelId)}/messages`),
        fetchJson(`/api/server/${encodeURIComponent(channelId)}/queue`),
        fetchJson(`/api/server/${encodeURIComponent(channelId)}/player`),
        fetchJson(`/api/servers/${encodeURIComponent(channelId)}/members`)
      ]);

      setChannelMessages(Array.isArray(messagesData.messages) ? messagesData.messages : []);
      setChannelQueue(Array.isArray(queueData.queue) ? queueData.queue : []);
      setChannelPlayerState(normalizeChannelPlayerState(playerData.state, playerData.server_now_ms));
      setChannelMembers(Array.isArray(membersData.members) ? membersData.members : []);

      try {
        const collabPlaylistsData = await fetchJson(`/api/servers/${encodeURIComponent(channelId)}/collab-playlists`);

        // load collab playlists from server without letting playlist errors blank the room
        const serverCollabPlaylists = Array.isArray(collabPlaylistsData?.playlists)
          ? collabPlaylistsData.playlists.map((pl) => ({
              ...pl,
              type: 'collab',
              allowedMemberIds: Array.isArray(membersData.members) ? membersData.members.map((m) => m.user_id) : [],
              tracks: Array.isArray(pl.tracks) ? pl.tracks.map((t) => normalizeTrack(t)) : []
            }))
          : [];

        setPlaylists((prev) => {
          const nonCollab = prev.filter((p) => p.type !== 'collab');
          return [...nonCollab, ...serverCollabPlaylists];
        });
        setCurrentCollabPlaylistId((prev) => {
          if (serverCollabPlaylists.length === 0) return '';
          if (prev && serverCollabPlaylists.some((playlist) => playlist.id === prev)) {
            return prev;
          }
          return serverCollabPlaylists[0].id;
        });
      } catch (playlistError) {
        addDebugLog('warn', 'channel collab playlists load failed', {
          channelId,
          error: playlistError.message || String(playlistError)
        }, true);
      }

      setCurrentChannel((prev) => channelsRef.current.find((entry) => entry.id === channelId) || prev);
    } catch (error) {
      addDebugLog('error', 'channel state load failed', { channelId, error: error.message || String(error) }, true);
      console.warn('Channel state load error:', error);
      setChannelMessages([]);
      setChannelQueue([]);
      setChannelPlayerState(null);
      setChannelMembers([]);
    }
  }, [addDebugLog, currentUserId]);

  const openConversation = useCallback(async (targetUser, options = {}) => {
    const targetUserId = typeof targetUser === 'string'
      ? targetUser
      : targetUser?.user_id || targetUser?.friend_id || targetUser?.id;
    const targetUsername = typeof targetUser === 'string'
      ? ''
      : (targetUser?.username || targetUser?.sender_username || '');

    if (!targetUserId) return;

    setSelectedConversationId(targetUserId);
    setDmText('');
    if (targetUsername) {
      setConversationList((prev) => {
        if (prev.some((entry) => entry.user_id === targetUserId)) return prev;
        return [{ user_id: targetUserId, username: targetUsername }, ...prev];
      });
    }
    await loadConversationMessages(targetUserId, options);
  }, [loadConversationMessages]);

  const openUserProfileCard = useCallback((event, targetUser) => {
    const targetUserId = typeof targetUser === 'string'
      ? targetUser
      : targetUser?.user_id || targetUser?.friend_id || targetUser?.id;
    const targetUsername = typeof targetUser === 'string'
      ? targetUser
      : (targetUser?.username || targetUser?.sender_username || targetUser?.name || '');

    if (!targetUserId || !targetUsername) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const popupWidth = 240;
    const viewportWidth = window.innerWidth || 0;

    setChatUserPopup({
      userId: targetUserId,
      username: targetUsername,
      x: Math.max(12, Math.min(rect.left, Math.max(12, viewportWidth - popupWidth - 12))),
      y: rect.bottom + 6
    });
  }, []);

  const deleteUser = useCallback(async (userId) => {
    if (!userId) return;
    try {
      await fetchJson(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
      setDeleteUserConfirm(null);
      await refreshUsers();
      showNotification('user deleted', 'success');
    } catch (error) {
      showNotification(error.message || 'failed to delete user', 'warning');
    }
  }, [refreshUsers, showNotification]);

  const sendFriendRequest = useCallback(async (targetUserId, targetUsername = '') => {
    if (!targetUserId) return;

    addDebugLog('social', 'sending friend request over http', { targetUserId, targetUsername }, true);

    try {
      await fetchJson('/api/friends/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ receiverId: targetUserId })
      });

      setPendingFriendTargetIds((prev) => (prev.includes(targetUserId) ? prev : [...prev, targetUserId]));
      await refreshPendingFriendRequests();
      showNotification(`friend request sent to ${targetUsername || 'user'}`, 'success');
    } catch (error) {
      console.error('[friends] send request failed', {
        targetUserId,
        targetUsername,
        message: error?.message || String(error),
        status: error?.status,
        requestUrl: error?.requestUrl || error?.url,
        responseData: error?.responseData,
        responseBody: error?.responseBody
      });
      addDebugLog('error', 'friend request failed', { targetUserId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to send friend request', 'warning');
      await refreshPendingFriendRequests();
      await refreshFriends();
    }
  }, [addDebugLog, refreshFriends, refreshPendingFriendRequests, showNotification]);

  const acceptFriendRequest = useCallback(async (requestId, senderUsername = '') => {
    if (!requestId) return;
    if (!beginFriendRequestAction(requestId)) return;

    addDebugLog('social', 'accepting friend request over http', { requestId, senderUsername }, true);

    try {
      await fetchJson(`/api/friends/requests/${encodeURIComponent(requestId)}/accept`, {
        method: 'POST'
      });
      setPendingFriendRequests((prev) => prev.filter((request) => request.id !== requestId));
      await refreshFriends();
      await refreshPendingFriendRequests();
      await refreshUsers();
      showNotification(`you are now friends with ${senderUsername || 'user'}`, 'success');
    } catch (error) {
      console.error('[friends] accept request failed', {
        requestId,
        senderUsername,
        message: error?.message || String(error),
        status: error?.status,
        requestUrl: error?.requestUrl || error?.url,
        responseData: error?.responseData,
        responseBody: error?.responseBody
      });
      addDebugLog('error', 'accept friend request failed', { requestId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to accept request', 'warning');
      await refreshPendingFriendRequests();
    } finally {
      finishFriendRequestAction(requestId);
    }
  }, [addDebugLog, beginFriendRequestAction, finishFriendRequestAction, refreshFriends, refreshPendingFriendRequests, refreshUsers, showNotification]);

  const declineFriendRequest = useCallback(async (requestId) => {
    if (!requestId) return;
    if (!beginFriendRequestAction(requestId)) return;

    addDebugLog('social', 'declining friend request over http', { requestId }, true);

    try {
      await fetchJson(`/api/friends/requests/${encodeURIComponent(requestId)}/decline`, {
        method: 'POST'
      });
      setPendingFriendRequests((prev) => prev.filter((request) => request.id !== requestId));
      await refreshPendingFriendRequests();
      showNotification('friend request declined', 'info');
    } catch (error) {
      console.error('[friends] decline request failed', {
        requestId,
        message: error?.message || String(error),
        status: error?.status,
        requestUrl: error?.requestUrl || error?.url,
        responseData: error?.responseData,
        responseBody: error?.responseBody
      });
      addDebugLog('error', 'decline friend request failed', { requestId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to decline request', 'warning');
      await refreshPendingFriendRequests();
    } finally {
      finishFriendRequestAction(requestId);
    }
  }, [addDebugLog, beginFriendRequestAction, finishFriendRequestAction, refreshPendingFriendRequests, showNotification]);

  const sendDmMessage = useCallback(async () => {
    const text = dmText.trim();
    if (!selectedConversationId || !text) return;
    if (!currentUserId) {
      showNotification('sign in first', 'warning');
      return;
    }

    const targetEntry = conversationListRef.current.find((entry) => entry.user_id === selectedConversationId);
    const targetUsername = targetEntry?.username || '';

    if (!targetUsername) {
      showNotification('could not find user', 'warning');
      return;
    }

    const clientMessageId = `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = normalizeDirectMessageRecord({
      id: `temp-${clientMessageId}`,
      sender_id: currentUserId,
      receiver_id: selectedConversationId,
      message: text,
      created_at: Date.now(),
      sender_username: currentUsername,
      receiver_username: targetUsername,
      client_message_id: clientMessageId,
      sender_theme_color: { r: themeColor.r, g: themeColor.g, b: themeColor.b }
    });

    if (optimisticMessage) {
      setDmMessages((prev) => ({
        ...prev,
        [selectedConversationId]: [...(prev[selectedConversationId] || []), optimisticMessage]
      }));
      upsertConversationPreview(optimisticMessage);
    }

    addDebugLog('social', 'sending dm over http', {
      conversationId: selectedConversationId,
      targetUsername,
      clientMessageId,
      text
    }, true);

    try {
      const data = await fetchJson(`/api/messages/${encodeURIComponent(selectedConversationId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text, sender_theme_color: { r: themeColor.r, g: themeColor.g, b: themeColor.b } })
      });
      const deliveredMessage = normalizeDirectMessageRecord(data.message);
      if (deliveredMessage) {
        pushDirectMessage(deliveredMessage, { clientMessageId });
      }
      setDmText('');
    } catch (error) {
      addDebugLog('error', 'dm send failed', { conversationId: selectedConversationId, error: error.message || String(error) }, true);
      if (optimisticMessage) {
        setDmMessages((prev) => ({
          ...prev,
          [selectedConversationId]: (prev[selectedConversationId] || []).filter((entry) => entry.id !== optimisticMessage.id)
        }));
      }
      showNotification(error.message || 'failed to send message', 'warning');
    }
  }, [addDebugLog, currentUserId, currentUsername, dmText, pushDirectMessage, selectedConversationId, showNotification, upsertConversationPreview]);

  const joinChannel = useCallback(async (channel) => {
    const targetChannel = typeof channel === 'string'
      ? channels.find((entry) => entry.id === channel)
      : channel;

    if (!targetChannel?.id) return;

    const alreadyJoined = Array.isArray(targetChannel.members)
      && targetChannel.members.some((member) => member.user_id === currentUserId);

    try {
      let channelPayload = targetChannel;

      if (!alreadyJoined) {
        const data = await fetchJson(`/api/servers/${encodeURIComponent(targetChannel.id)}/join`, {
          method: 'POST'
        });
        channelPayload = data.server || targetChannel;
        showNotification(`joined ${channelPayload.name}`, 'success');
      }

      setCurrentChannelId(targetChannel.id);
      setCurrentChannel(channelPayload);
      setChannelDraftName(channelPayload.name || '');
      setChannelDraftDescription(channelPayload.description || '');
      // mark channel as read when joining/opening
      markChannelRead(targetChannel.id);

      const joinedViaSocket = sendWsMessage({
        type: 'join_server',
        serverId: targetChannel.id
      });

      if (!joinedViaSocket) {
        await loadChannelState(targetChannel.id);
      }

      await refreshChannels();
      await refreshUsers();
    } catch (error) {
      showNotification(error.message || 'failed to join channel', 'warning');
    }
  }, [channels, currentUserId, loadChannelState, markChannelRead, refreshChannels, refreshUsers, sendWsMessage, showNotification]);

  const leaveChannel = useCallback(async (channelId = currentChannelId) => {
    if (!channelId) return;

    try {
      await fetchJson(`/api/servers/${encodeURIComponent(channelId)}/leave`, {
        method: 'POST'
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'leave_server',
          serverId: channelId
        }));
      }

      if (currentChannelRef.current === channelId) {
        setCurrentChannel(null);
        setCurrentChannelId('');
        setChannelMembers([]);
        setChannelMessages([]);
        setChannelQueue([]);
        setChannelPlayerState(null);
        setCurrentCollabPlaylistId('');
        // remove collab playlists from state when leaving
        setPlaylists((prev) => prev.filter((p) => p.type !== 'collab'));
      }

      await refreshChannels();
      await refreshUsers();
      showNotification('left channel', 'info');
    } catch (error) {
      showNotification(error.message || 'failed to leave channel', 'warning');
    }
  }, [currentChannelId, refreshChannels, refreshUsers, showNotification]);

  const createChannel = useCallback(async () => {
    const name = newChannelName.trim();
    if (!name) return;

    try {
      const data = await fetchJson('/api/servers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name
        })
      });

      setNewChannelName('');
      setNewChannelDescription('');
      await refreshChannels();
      if (data.server) {
        await joinChannel(data.server);
      }
    } catch (error) {
      showNotification(error.message || 'failed to create channel', 'warning');
    }
  }, [joinChannel, newChannelName, refreshChannels, showNotification]);

  const saveCurrentChannel = useCallback(async () => {
    if (!currentChannelId) return;

    try {
      const data = await fetchJson(`/api/servers/${encodeURIComponent(currentChannelId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: channelDraftName.trim()
        })
      });

      setCurrentChannel(data.server || null);
      await refreshChannels();
      showNotification('channel updated', 'success');
    } catch (error) {
      showNotification(error.message || 'failed to update channel', 'warning');
    }
  }, [channelDraftName, currentChannelId, refreshChannels, showNotification]);

  const deleteChannel = useCallback(async (channelId) => {
    if (!channelId) return;

    try {
      await fetchJson(`/api/servers/${encodeURIComponent(channelId)}`, {
        method: 'DELETE'
      });

      if (currentChannelRef.current === channelId) {
        setCurrentChannel(null);
        setCurrentChannelId('');
        setChannelMembers([]);
        setChannelMessages([]);
        setChannelQueue([]);
        setChannelPlayerState(null);
      }

      await refreshChannels();
      await refreshUsers();
      showNotification('channel deleted', 'info');
    } catch (error) {
      showNotification(error.message || 'failed to delete channel', 'warning');
    }
  }, [refreshChannels, refreshUsers, showNotification]);

  const updateChannelAdmin = useCallback(async (member, isAdmin) => {
    if (!currentChannelId || !member?.user_id) return;

    try {
      await fetchJson(`/api/servers/${encodeURIComponent(currentChannelId)}/admins/${encodeURIComponent(member.user_id)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isAdmin })
      });

      await loadChannelState(currentChannelId);
      await refreshChannels();
      showNotification(isAdmin ? 'member promoted' : 'member demoted', 'success');
    } catch (error) {
      showNotification(error.message || 'failed to update admin', 'warning');
    }
  }, [currentChannelId, loadChannelState, refreshChannels, showNotification]);

  const kickChannelMember = useCallback(async (member) => {
    if (!currentChannelId || !member?.user_id) return;

    try {
      await fetchJson(`/api/servers/${encodeURIComponent(currentChannelId)}/kick/${encodeURIComponent(member.user_id)}`, {
        method: 'POST'
      });

      await loadChannelState(currentChannelId);
      await refreshChannels();
      await refreshUsers();
      showNotification(`${member.username} removed`, 'info');
    } catch (error) {
      showNotification(error.message || 'failed to remove member', 'warning');
    }
  }, [currentChannelId, loadChannelState, refreshChannels, refreshUsers, showNotification]);

  const sendChannelMessage = useCallback(async () => {
    const text = channelMessageText.trim();
    if (!currentChannelId || !text) return;

    addDebugLog('collab', 'sending channel message over http', { channelId: currentChannelId, text }, true);

    try {
      const data = await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text })
      });

      if (data.message) {
        setChannelMessages((prev) => (
          prev.some((entry) => entry.id === data.message.id) ? prev : [...prev, data.message]
        ));
      }
      setChannelMessageText('');
    } catch (error) {
      addDebugLog('error', 'channel message send failed', { channelId: currentChannelId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to send channel message', 'warning');
    }
  }, [addDebugLog, channelMessageText, currentChannelId, showNotification]);

  const addTrackToCurrentChannel = useCallback(async (track) => {
    if (!currentChannelId) {
      showNotification('join a channel first', 'warning');
      return;
    }

    const normalizedTrack = normalizeTrack(track);
    if (!normalizedTrack.videoId || !normalizedTrack.title) {
      showNotification('pick a valid track first', 'warning');
      return;
    }

    addDebugLog('collab', 'adding track to shared queue over http', {
      channelId: currentChannelId,
      videoId: normalizedTrack.videoId,
      title: normalizedTrack.title
    }, true);

    try {
      await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          videoId: normalizedTrack.videoId,
          title: normalizedTrack.title,
          author: normalizedTrack.author,
          format: normalizedTrack.format,
          source: normalizedTrack.source,
          thumbnail: normalizedTrack.thumbnail,
          externalUrl: normalizedTrack.externalUrl,
          durationMs: normalizedTrack.durationMs
        })
      });

      await loadChannelState(currentChannelId);
      showNotification('track added to shared queue', 'success');
    } catch (error) {
      addDebugLog('error', 'shared queue add failed', { channelId: currentChannelId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to add track', 'warning');
    }
  }, [addDebugLog, currentChannelId, loadChannelState, showNotification]);

  const removeTrackFromCurrentChannel = useCallback(async (trackId) => {
    if (!currentChannelId || !trackId) return;

    addDebugLog('collab', 'removing track from shared queue over http', { channelId: currentChannelId, trackId }, true);

    try {
      await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/queue/${encodeURIComponent(trackId)}`, {
        method: 'DELETE'
      });
      await loadChannelState(currentChannelId);
    } catch (error) {
      addDebugLog('error', 'shared queue remove failed', { channelId: currentChannelId, trackId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to remove track', 'warning');
    }
  }, [addDebugLog, currentChannelId, loadChannelState, showNotification]);

  const clearCurrentChannelQueue = useCallback(async () => {
    if (!currentChannelId) return;

    addDebugLog('collab', 'clearing shared queue over http', { channelId: currentChannelId }, true);

    try {
      await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/queue`, {
        method: 'DELETE'
      });
      await loadChannelState(currentChannelId);
      showNotification('shared queue cleared', 'info');
    } catch (error) {
      addDebugLog('error', 'shared queue clear failed', { channelId: currentChannelId, error: error.message || String(error) }, true);
      showNotification(error.message || 'failed to clear queue', 'warning');
    }
  }, [addDebugLog, currentChannelId, loadChannelState, showNotification]);

  const updateCurrentChannelPlayer = useCallback(async (nextState) => {
    if (!currentChannelId) return;

    const optimisticUpdatedAtMs = Date.now();
    const optimisticState = normalizeChannelPlayerState({
      ...(channelPlayerState || {}),
      ...nextState,
      current_track_id: nextState.current_track_id ?? channelPlayerState?.current_track_id ?? null,
      is_playing: nextState.is_playing === true,
      current_time: nextState.current_time ?? channelPlayerState?.current_time ?? 0,
      volume: nextState.volume ?? channelPlayerState?.volume ?? 1,
      sync_updated_at_ms: optimisticUpdatedAtMs,
      revision: `local:${optimisticUpdatedAtMs}:${Math.random().toString(36).slice(2, 8)}`
    }, optimisticUpdatedAtMs);

    setChannelPlayerState(optimisticState);

    addDebugLog('collab', 'sending shared player update over http', {
      channelId: currentChannelId,
      nextState
    }, true);

    try {
      await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/player`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(nextState)
      });
    } catch (error) {
      addDebugLog('error', 'shared player update failed', { channelId: currentChannelId, error: error.message || String(error), nextState }, true);
      await loadChannelState(currentChannelId);
      showNotification(error.message || 'failed to update player', 'warning');
    }
  }, [addDebugLog, channelPlayerState, currentChannelId, loadChannelState, showNotification]);

  // grab the auth token for cross-origin auth
  useEffect(() => {
    if (!user) {
      setWsSessionId(null);
      return;
    }
    let cancelled = false;
    // read the auth token from localStorage (set during login/register)
    const authToken = typeof window !== 'undefined' ? window.localStorage.getItem('music_auth_token') : null;
    if (!cancelled) setWsSessionId(authToken);
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (!user) {
      youtubeSyncReadyRef.current = false;
      queueSyncReadyRef.current = false;
      stopAndResetPlayback();
      const guestPlaylists = readStoredJson(guestPlaylistsStorageKey, []);
      setPlaylists(Array.isArray(guestPlaylists) ? guestPlaylists : []);
      setCurrentPlaylistId(Array.isArray(guestPlaylists) && guestPlaylists.length > 0 ? guestPlaylists[0].id : '');
      setQueue([]);
      setPendingFriendTargetIds([]);
      return;
    }

    let ignore = false;

    const loadAccountPlaylists = async () => {
      try {
        const data = await fetchJson('/api/user/playlists');
        if (ignore) return;

        const nextPlaylists = Array.isArray(data.playlists)
          ? data.playlists.map((playlist) => ({
              ...playlist,
              tracks: Array.isArray(playlist.tracks)
                ? playlist.tracks.map((track) => normalizeTrack(track)).filter((track) => track.videoId)
                : []
            }))
          : [];

        setPlaylists(nextPlaylists);
        setCurrentPlaylistId((prev) => nextPlaylists.find((playlist) => playlist.id === prev)?.id || nextPlaylists[0]?.id || '');
      } catch (error) {
        console.warn('Playlist sync load error:', error);
      } finally {
        if (!ignore) {
          youtubeSyncReadyRef.current = true;
        }
      }
    };

    loadAccountPlaylists();
    return () => {
      ignore = true;
    };
  }, [guestPlaylistsStorageKey, user]);

  useEffect(() => {
    const friendIds = new Set(friendsList.map((friend) => friend.friend_id));
    setPendingFriendTargetIds((prev) => prev.filter((id) => !friendIds.has(id)));
  }, [friendsList]);

  useEffect(() => {
    if (!user || !youtubeSyncReadyRef.current) return;

    const syncTimer = setTimeout(async () => {
      try {
        await fetchJson('/api/user/playlists-sync', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            playlists: playlists.map((playlist) => ({
              ...playlist,
              tracks: Array.isArray(playlist.tracks)
                ? playlist.tracks.map((track) => normalizeTrack(track)).filter((track) => track.videoId)
                : []
            }))
          })
        });
      } catch (error) {
        console.warn('Playlist sync save error:', error);
      }
    }, 300);

    return () => clearTimeout(syncTimer);
  }, [user, playlists]);

  useEffect(() => {
    if (!user) return;

    let ignore = false;
    queueSyncReadyRef.current = false;

    const loadAccountQueue = async () => {
      try {
        const data = await fetchJson('/api/user/queue');
        if (ignore) return;

        const nextQueue = Array.isArray(data.queue)
          ? data.queue.map((track) => normalizeTrack(track)).filter((track) => track.videoId)
          : [];

        setQueue(nextQueue);
      } catch (error) {
        console.warn('Queue sync load error:', error);
        if (!ignore) {
          setQueue([]);
        }
      } finally {
        if (!ignore) {
          queueSyncReadyRef.current = true;
        }
      }
    };

    loadAccountQueue();
    return () => {
      ignore = true;
      queueSyncReadyRef.current = false;
    };
  }, [user]);

  const syncPersonalQueueNow = useCallback(async (reason = 'manual') => {
    if (!user || !queueSyncReadyRef.current) {
      return false;
    }

    const normalizedQueue = queue.map((track) => normalizeTrack(track)).filter((track) => track.videoId);

    try {
      await fetchJson('/api/user/queue', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          queue: normalizedQueue
        })
      });
      return true;
    } catch (error) {
      console.warn('Queue sync save error:', error);
      addDebugLog('warn', 'personal queue save failed', {
        reason,
        error: error.message || String(error),
        queueLength: normalizedQueue.length
      }, true);
      return false;
    }
  }, [addDebugLog, queue, user]);

  useEffect(() => {
    if (!user || !queueSyncReadyRef.current) return;

    const syncTimer = setTimeout(() => {
      syncPersonalQueueNow('queue change');
    }, 300);

    return () => clearTimeout(syncTimer);
  }, [queue, syncPersonalQueueNow, user]);

  useEffect(() => {
    playbackSourceRef.current = playbackSource;
    playbackQueueRef.current = playbackSource === 'shared' ? channelQueue : queue;
  }, [channelQueue, playbackSource, queue]);

  useEffect(() => {
    channelQueueRef.current = channelQueue;
  }, [channelQueue]);

  useEffect(() => {
    channelPlayerStateRef.current = channelPlayerState;
  }, [channelPlayerState]);

  useEffect(() => () => {
    if (sharedRecoveryTimeoutRef.current) {
      clearTimeout(sharedRecoveryTimeoutRef.current);
      sharedRecoveryTimeoutRef.current = null;
    }
  }, []);


  useEffect(() => {
    document.title = "Shibenchi's music player";
  }, []);

  // check version and load changelog
  useEffect(() => {
    const checkVersion = async () => {
      try {
        // get current version
        const versionResponse = await fetch('/package.json');
        const versionContentType = versionResponse.headers.get('content-type');
        if (!versionContentType || !versionContentType.includes('application/json')) {
          console.log('Version response invalid');
          return;
        }
        const packageJson = await versionResponse.json();
        const currentVer = packageJson.version;
        setCurrentVersion(currentVer);

        // check for updates every 30 seconds
        const checkUpdate = async () => {
          try {
            const response = await fetch('/api/version');
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
              return;
            }
            const data = await response.json();
            setLatestVersion(data.version);

            if (data.version !== currentVer) {
              setVersionMismatch(true);
            }
          } catch (err) {
            console.log('Version check error:', err);
          }
        };

        checkUpdate();
        const interval = setInterval(checkUpdate, 30000);

        return () => clearInterval(interval);
      } catch (err) {
        console.log('Version loading error:', err);
      }
    };

    checkVersion();
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem('music_currentIndex');
      localStorage.removeItem('music_playIndex');
      localStorage.removeItem('music_source');
      localStorage.removeItem('music_youtube_queue');
      setCurrentIndex(-1);
      setPlayIndex(-1);
      playIndexRef.current = -1;
      setCurrentTrack(null);
    } catch (err) {
      console.error('Failed to load from localStorage:', err);
    }
  }, []);

  useEffect(() => {
    conversationListRef.current = conversationList;
  }, [conversationList]);

  useEffect(() => {
    debugEntriesRef.current = debugEntries;
    localStorage.setItem('music_frontend_debug_logs', JSON.stringify(debugEntries));
  }, [debugEntries]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    currentChannelRef.current = currentChannelId;
  }, [currentChannelId]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    socialLayoutHydratedRef.current = false;
    setSocialPanelSides(readSnapLayout(socialLayoutStorageKey, SOCIAL_LAYOUT_DEFAULTS));
  }, [socialLayoutStorageKey]);

  useEffect(() => {
    collabLayoutHydratedRef.current = false;
    setCollabPanelSides(readSnapLayout(collabLayoutStorageKey, COLLAB_LAYOUT_DEFAULTS));
  }, [collabLayoutStorageKey]);

  useEffect(() => {
    if (!socialLayoutHydratedRef.current) {
      socialLayoutHydratedRef.current = true;
      return;
    }
    localStorage.setItem(socialLayoutStorageKey, JSON.stringify(socialPanelSides));
  }, [socialLayoutStorageKey, socialPanelSides]);

  useEffect(() => {
    if (!collabLayoutHydratedRef.current) {
      collabLayoutHydratedRef.current = true;
      return;
    }
    localStorage.setItem(collabLayoutStorageKey, JSON.stringify(collabPanelSides));
  }, [collabLayoutStorageKey, collabPanelSides]);

  useEffect(() => {
    if (!currentUserId) {
      setIsConnected(false);
      setAllUsers([]);
      setFriendsList([]);
      setPendingFriendRequests([]);
      setConversationList([]);
      setSelectedConversationId('');
      setDmMessages({});
      setDmText('');
      setChannels([]);
      setCurrentChannel(null);
      setCurrentChannelId('');
      setChannelMembers([]);
      setChannelMessages([]);
      setChannelMessageText('');
      setChannelQueue([]);
      setChannelPlayerState(null);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      return;
    }

    // auto-detect local helper for yt-dlp (streaming/downloads)
    probeLocalHelper();

    refreshUsers();
    // always refresh core social data on connect, regardless of active tab
    // so conversations/messages are ready when user switches to social tab
    refreshFriends();
    refreshPendingFriendRequests();
    refreshConversations();
    if (selectedConversationRef.current) {
      loadConversationMessages(selectedConversationRef.current);
    }
    if (activeTab === 'collab') {
      refreshChannels();
      if (currentChannelRef.current) {
        loadChannelState(currentChannelRef.current);
      }
    }
  }, [
    activeTab,
    currentUserId,
    loadChannelState,
    loadConversationMessages,
    refreshChannels,
    refreshConversations,
    refreshFriends,
    refreshPendingFriendRequests,
    refreshUsers
  ]);

  useEffect(() => {
    if (!currentUserId) return;
    // re-read localStorage with the correct user key (initial render mightve used 'guest')
    try {
      const storedConvList = localStorage.getItem(`music_conversation_list:${currentUserId}`);
      const convList = storedConvList ? JSON.parse(storedConvList) : null;
      if (convList && convList.length > 0) {
        setConversationList(normalizeConversationList(convList, convList));
      }
    } catch {}
    try {
      const storedSelected = localStorage.getItem(`music_selected_conversation:${currentUserId}`);
      if (storedSelected) {
        setSelectedConversationId(storedSelected);
      }
    } catch {}
    try {
      const storedDm = localStorage.getItem(`music_dm_messages:${currentUserId}`);
      const dm = storedDm ? JSON.parse(storedDm) : null;
      if (dm) {
        setDmMessages(dm);
      }
    } catch {}
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    // on reload, if theres a stored selected conversation, always refresh
    // the list so conversation cards show up immediately in the UI
    if (selectedConversationId) {
      refreshConversations();
    }
  }, [currentUserId, normalizeConversationList, selectedConversationId, refreshConversations]);

  useEffect(() => {
    if (!currentUserId || selectedConversationId) return;
    if (conversationList.length > 0) {
      setSelectedConversationId(conversationList[0].user_id);
    }
  }, [conversationList, currentUserId, selectedConversationId]);

  useEffect(() => {
    if (!currentUserId || !selectedConversationId || activeTab !== 'social') return;
    // always load messages for the visible conversation
    loadConversationMessages(selectedConversationId);
    // mark messages as read only after the thread is actually visible for a moment
    const timer = setTimeout(() => {
      markConversationRead(selectedConversationId);
    }, 500);
    return () => clearTimeout(timer);
  }, [activeTab, currentUserId, loadConversationMessages, markConversationRead, selectedConversationId]);

  // persist selected conversation to localStorage
  useEffect(() => {
    if (selectedConversationId) {
      localStorage.setItem(`music_selected_conversation:${user?.id || 'guest'}`, selectedConversationId);
    }
  }, [selectedConversationId, user?.id]);

  // persist dm messages to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(`music_dm_messages:${user?.id || 'guest'}`, JSON.stringify(dmMessages));
    } catch {}
  }, [dmMessages, user?.id]);

  // persist conversation list to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(`music_conversation_list:${user?.id || 'guest'}`, JSON.stringify(conversationList));
    } catch {}
  }, [conversationList, user?.id]);

  // recalculate unread counts when switching tabs
  useEffect(() => {
    if (activeTab === 'social') {
      setUnreadDmCount(calculateUnreadDmCount());
    }
    if (activeTab === 'collab' && currentChannelId) {
      markChannelRead(currentChannelId);
    }
    // recalculate channel count whenever tab changes
    if (activeTab !== 'collab') {
      setUnreadChannelCount(calculateUnreadChannelCount());
    }
  }, [activeTab, calculateUnreadDmCount, calculateUnreadChannelCount, currentChannelId, markChannelRead]);

  // auto-scroll dm chat when new messages arrive in the current conversation
  const currentDmMessages = dmMessages[selectedConversationId] || [];
  const currentDmCount = currentDmMessages.length;
  
  useEffect(() => {
    if (dmScrollRef.current && currentDmCount > 0) {
      // setTimeout so the dom's actually updated before we scroll
      const timer = setTimeout(() => {
        if (dmScrollRef.current) {
          dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight;
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [currentDmCount, selectedConversationId]);

  // auto-scroll channel chat when new messages arrive
  const currentChannelMsgCount = channelMessages.length;
  
  useEffect(() => {
    if (channelScrollRef.current && currentChannelMsgCount > 0) {
      // setTimeout so the dom's actually updated before we scroll
      const timer = setTimeout(() => {
        if (channelScrollRef.current) {
          channelScrollRef.current.scrollTop = channelScrollRef.current.scrollHeight;
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [currentChannelMsgCount]);

  useEffect(() => {
    if (!currentUserId || !wsSessionId) return;

    let cancelled = false;
    let reconnectTimer = null;
    let socket = null;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      if (cancelled) return;
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
        return;
      }

      addDebugLog('ws', 'opening websocket connection', { appWsUrl, currentUsername, currentChannelId: currentChannelRef.current || null }, true);
      const ws = new WebSocket(appWsUrl);
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }
        addDebugLog('ws', 'websocket open', { appWsUrl, currentUsername }, true);
        setIsConnected(true);
        clearReconnect();
        ws.send(JSON.stringify({ type: 'set_username', username: currentUsername }));
        if (currentChannelRef.current) {
          addDebugLog('ws', 'joining current channel after socket open', { serverId: currentChannelRef.current }, true);
          ws.send(JSON.stringify({
            type: 'join_server',
            serverId: currentChannelRef.current
          }));
        } else {
          ws.send(JSON.stringify({ type: 'request_state' }));
        }
      };

      ws.onclose = () => {
        addDebugLog('ws', 'websocket closed', { appWsUrl, currentUsername }, true);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        setIsConnected(false);
        if (cancelled) return;
        clearReconnect();
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (event) => {
        addDebugLog('error', 'websocket error', { event: String(event?.message || event || 'unknown') }, true);
        if (!cancelled) {
          setIsConnected(false);
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) return;

        try {
          const data = JSON.parse(event.data);
          addDebugLog('ws', `received ${data.type || 'unknown'}`, data, data.type === 'error');

          switch (data.type) {
            case 'connected':
              setIsConnected(true);
              if (data.current_server_id) {
                setCurrentChannelId((prev) => prev || data.current_server_id);
              }
              refreshUsers();
              refreshChannels();
              break;

            case 'presence_update':
              refreshUsers();
              break;

            case 'user_joined':
            case 'user_left':
              refreshUsers();
              break;

            case 'direct_message': {
              const delivered = pushDirectMessage(data.message);
              if (
                delivered
                && delivered.message.sender_id !== currentUserId
                && delivered.message.unread
              ) {
                showNotification(`new DM from ${delivered.message.sender_username}`, 'info');
                playNotifSound();
                // bump the unread dm count
                setUnreadDmCount((prev) => prev + 1);
              }
              break;
            }

            case 'direct_message_ack':
              pushDirectMessage(data.message, { clientMessageId: data.clientMessageId });
              break;

            case 'server_created':
            case 'server_updated':
              refreshChannels();
              break;

            case 'server_deleted':
              if (currentChannelRef.current === data.serverId) {
                setCurrentChannel(null);
                setCurrentChannelId('');
                setChannelMembers([]);
                setChannelMessages([]);
                setChannelQueue([]);
                setChannelPlayerState(null);
              }
              refreshChannels();
              refreshUsers();
              break;

            case 'joined_server':
              if (data.serverId) {
                setCurrentChannelId(data.serverId);
              }
              refreshUsers();
              break;

            case 'left_server':
              if (currentChannelRef.current === data.serverId) {
                setCurrentChannel(null);
                setCurrentChannelId('');
                setChannelMembers([]);
                setChannelMessages([]);
                setChannelQueue([]);
                setChannelPlayerState(null);
              }
              refreshUsers();
              break;

            case 'initial_state':
              if (data.users) {
                refreshUsers();
              }
              if (data.serverId) {
                setCurrentChannelId(data.serverId);
                setCurrentChannel(data.server || null);
                setChannelDraftName(data.server?.name || '');
                setChannelDraftDescription(data.server?.description || '');
                setChannelMessages(Array.isArray(data.messages) ? data.messages : []);
                setChannelQueue(Array.isArray(data.queue) ? data.queue : []);
                setChannelPlayerState(normalizeChannelPlayerState(data.player, data.server_now_ms));
                setChannelMembers(Array.isArray(data.members) ? data.members : []);
              }
              break;

            case 'server_members_updated':
              if (data.serverId === currentChannelRef.current) {
                setChannelMembers(Array.isArray(data.members) ? data.members : []);
              }
              refreshChannels();
              refreshUsers();
              break;

            case 'server_queue_updated':
              if (data.serverId === currentChannelRef.current) {
                setChannelQueue(Array.isArray(data.queue) ? data.queue : []);
              }
              break;

            case 'server_player_updated':
              if (data.serverId === currentChannelRef.current) {
                setChannelPlayerState(normalizeChannelPlayerState(data.state, data.server_now_ms));
              }
              break;

            case 'chat_message':
              if (data.serverId === currentChannelRef.current && data.message) {
                setChannelMessages((prev) => (
                  prev.some((entry) => entry.id === data.message.id) ? prev : [...prev, data.message]
                ));
                if (data.message.user_id !== currentUserId) {
                  playNotifSound2();
                  if (activeTabRef.current !== 'collab') {
                    const activeChannelName = channelsRef.current.find((entry) => entry.id === data.serverId)?.name || data.serverId || 'channel';
                    showNotification(`message from ${data.message.username} in #${activeChannelName}`, 'info');
                  }
                }
              } else if (data.serverId !== currentChannelRef.current && data.message && data.message.user_id !== currentUserId) {
                // message in a channel the user isnt currently viewing — bump unread
                const otherChannelName = channelsRef.current.find((entry) => entry.id === data.serverId)?.name || data.serverId || 'channel';
                showNotification(`message from ${data.message.username} in #${otherChannelName}`, 'info');
                playNotifSound2();
                setUnreadChannelCount((prev) => prev + 1);
              }
              break;

            case 'collab_playlist_created':
              if (data.serverId === currentChannelRef.current && data.playlist) {
                const playlistWithMembers = {
                  ...data.playlist,
                  type: 'collab',
                  allowedMemberIds: currentChannelMembers.map((m) => m.user_id)
                };
                setPlaylists((prev) => {
                  if (prev.some((p) => p.id === data.playlist.id)) return prev;
                  return [...prev, playlistWithMembers];
                });
                if (!currentCollabPlaylistId) {
                  setCurrentCollabPlaylistId(data.playlist.id);
                }
              }
              break;

            case 'collab_playlist_deleted':
              if (data.serverId === currentChannelRef.current && data.playlistId) {
                setPlaylists((prev) => {
                  const filtered = prev.filter((p) => p.id !== data.playlistId);
                  if (currentCollabPlaylistId === data.playlistId && filtered.length > 0) {
                    setCurrentCollabPlaylistId(filtered[0].id);
                  }
                  return filtered;
                });
              }
              break;

            case 'collab_playlist_renamed':
              if (data.serverId === currentChannelRef.current && data.playlistId) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId ? { ...p, name: data.name } : p
                ));
              }
              break;

            case 'collab_playlist_track_added':
              if (data.serverId === currentChannelRef.current && data.playlistId && data.track) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId
                    ? { ...p, tracks: [...p.tracks, { ...data.track, addedAt: Date.now() }] }
                    : p
                ));
              }
              break;

            case 'collab_playlist_track_removed':
              if (data.serverId === currentChannelRef.current && data.playlistId && data.trackIndex !== undefined) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId
                    ? { ...p, tracks: p.tracks.filter((_, i) => i !== data.trackIndex) }
                    : p
                ));
              }
              break;

            case 'collab_playlist_cleared':
              if (data.serverId === currentChannelRef.current && data.playlistId) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId ? { ...p, tracks: [] } : p
                ));
              }
              break;

            case 'collab_playlist_reordered':
              if (data.serverId === currentChannelRef.current && data.playlistId && data.tracks) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId ? { ...p, tracks: data.tracks } : p
                ));
              }
              break;

            case 'collab_playlist_add_all':
              if (data.serverId === currentChannelRef.current && data.playlistId && data.tracks) {
                setPlaylists((prev) => prev.map((p) =>
                  p.id === data.playlistId
                    ? { ...p, tracks: [...p.tracks, ...data.tracks.map((t) => ({ ...t, addedAt: Date.now() }))] }
                    : p
                ));
              }
              break;

            case 'user_kicked':
              if (data.userId === currentUserId && data.serverId === currentChannelRef.current) {
                setCurrentChannel(null);
                setCurrentChannelId('');
                setChannelMembers([]);
                setChannelMessages([]);
                setChannelQueue([]);
                setChannelPlayerState(null);
                showNotification('you were removed from the channel', 'warning');
              }
              refreshChannels();
              refreshUsers();
              break;

            case 'error':
              showNotification(data.error || data.message || 'server error', 'warning');
              break;

            case 'friend_request_sent':
              // friend request went through, already handled optimistically
              break;

            case 'friend_request_error':
              if (data.error === 'already sent') {
                showNotification(`friend request already sent`, 'info');
              } else if (data.error === 'already friends') {
                showNotification(`already friends`, 'info');
                refreshFriends();
              } else {
                showNotification(data.error || 'failed to send friend request', 'warning');
              }
              // remove from pending if it got added optimistically
              if (data.error) {
                setPendingFriendTargetIds((prev) => prev.filter(id => id !== data.receiverId));
              }
              break;

            case 'friend_request_received':
              // new friend request came in
              showNotification(`friend request from ${data.from}`, 'info');
              refreshPendingFriendRequests();
              break;

            case 'friend_request_response':
              if (data.action === 'accept' && data.success) {
                showNotification('friend request accepted', 'success');
                refreshFriends();
                refreshPendingFriendRequests();
                refreshUsers();
              } else if (data.action === 'decline' && data.success) {
                refreshPendingFriendRequests();
              } else if (data.error) {
                showNotification(`failed to ${data.action} friend request: ${data.error}`, 'warning');
                refreshFriends();
                refreshPendingFriendRequests();
              }
              break;

            case 'friend_accepted':
              showNotification(`${data.from} accepted your friend request`, 'success');
              refreshFriends();
              refreshUsers();
              break;

            case 'friend_declined':
              showNotification(`${data.from} declined your friend request`, 'info');
              break;

            default:
              break;
          }
        } catch (error) {
          console.warn('Websocket message parse error:', error);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearReconnect();
      if (socket) {
        const isConnecting = socket.readyState === WebSocket.CONNECTING;
        socket.onerror = null;
        socket.onmessage = null;

        if (isConnecting) {
          socket.onclose = null;
          socket.onopen = () => {
            try {
              socket.close();
            } catch {
              // ignore
            }
          };
        } else {
          socket.onopen = null;
          socket.onclose = null;
          try {
            socket.close();
          } catch {
            // ignore
          }
        }
      }
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
    };
  }, [
    appWsUrl,
    currentUserId,
    currentUsername,
    pushDirectMessage,
    refreshChannels,
    refreshConversations,
    refreshFriends,
    refreshPendingFriendRequests,
    refreshUsers,
    showNotification,
    playNotifSound,
    playNotifSound2,
    wsSessionId
  ]);

  useEffect(() => {
    const root = document.documentElement;
    
    root.style.setProperty('--theme-primary', `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`);
    root.style.setProperty('--theme-primary-rgb', `${themeColor.r}, ${themeColor.g}, ${themeColor.b}`);
    root.style.setProperty('--theme-primary-rgba', `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.25)`);
    root.style.setProperty('--theme-primary-dark', `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.15)`);
    root.style.setProperty('--theme-glow', `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.5)`);
    root.style.setProperty('--theme-shadow', `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.3)`);
    root.style.setProperty('--theme-neon-glow', `0 0 20px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.6)`);
  }, [themeColor]);

  
  useEffect(() => {
    if (user) return;
    localStorage.setItem(guestPlaylistsStorageKey, JSON.stringify(playlists));
  }, [guestPlaylistsStorageKey, playlists, user]);

  // re-read everything under the correct per-user key once the real user id
  // resolves — initial state above mightve read the 'guest' key if this
  // mounted before login finished, same pattern as the dms/conversations one
  useEffect(() => {
    const uid = user?.id || 'guest';
    const queueState = readLocalJSON(`music_queue_state:${uid}`, null);
    if (queueState) {
      if (Array.isArray(queueState.queue)) setQueue(queueState.queue);
      if (typeof queueState.playIndex === 'number') setPlayIndex(queueState.playIndex);
    }
    const prefs = readLocalJSON(`music_player_prefs:${uid}`, null);
    if (prefs) {
      if (typeof prefs.volume === 'number') setVolume(prefs.volume);
      if (typeof prefs.shuffle === 'boolean') setShuffle(prefs.shuffle);
      if (typeof prefs.repeatMode === 'string') setRepeatMode(prefs.repeatMode);
      if (typeof prefs.isMuted === 'boolean') setIsMuted(prefs.isMuted);
    }
    const eq = readLocalJSON(`music_eq:${uid}`, null);
    if (eq) {
      if (typeof eq.eqEnabled === 'boolean') setEqEnabled(eq.eqEnabled);
      if (Array.isArray(eq.eqValues)) setEqValues(eq.eqValues);
      if (typeof eq.selectedPreset === 'string') setSelectedPreset(eq.selectedPreset);
    }
    const savedVisualizerPreset = localStorage.getItem(`music_visualizer_preset:${uid}`);
    if (savedVisualizerPreset) setVisualizerPreset(savedVisualizerPreset);
  }, [user?.id]);

  // persist the personal queue + where playback is in it — this is what
  // makes the queue survive closing and reopening the app.
  useEffect(() => {
    writeLocalJSON(`music_queue_state:${user?.id || 'guest'}`, { queue, playIndex });
  }, [queue, playIndex, user?.id]);

  // persist volume/shuffle/repeat/mute together since they're small and
  // always change as a set
  useEffect(() => {
    writeLocalJSON(`music_player_prefs:${user?.id || 'guest'}`, { volume, shuffle, repeatMode, isMuted });
  }, [volume, shuffle, repeatMode, isMuted, user?.id]);

  // persist EQ on/off, band values, and the last preset picked
  useEffect(() => {
    writeLocalJSON(`music_eq:${user?.id || 'guest'}`, { eqEnabled, eqValues, selectedPreset });
  }, [eqEnabled, eqValues, selectedPreset, user?.id]);

  // persist the chosen visualizer animation preset
  useEffect(() => {
    localStorage.setItem(`music_visualizer_preset:${user?.id || 'guest'}`, visualizerPreset);
  }, [visualizerPreset, user?.id]);

  useEffect(() => {
    if (queue.length === 0 && typeof stopAndResetPlayback === 'function') {
      stopAndResetPlayback();
    }
  }, [queue]);

  useEffect(() => {
    playIndexRef.current = playIndex;
  }, [playIndex]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (playIndex < 0) {
      setCurrentTrack(null);
      return;
    }

    const activeList = playbackSource === 'shared' ? channelQueue : queue;
    const queuedTrack = activeList[playIndex];
    if (!queuedTrack) return;

    if ((!currentTrack || getTrackKey(queuedTrack) === getTrackKey(currentTrack)) && currentTrack !== queuedTrack) {
      setCurrentTrack(queuedTrack);
    }
  }, [channelQueue, currentTrack, playIndex, playbackSource, queue]);

  
  useEffect(() => {
    localStorage.setItem('music_downloaded', JSON.stringify(downloadedTracks));
  }, [downloadedTracks]);

  
  useEffect(() => {
    if (user || onDebugModeToggle) return;
    localStorage.setItem('music_debug_mode_guest', String(debugMode));
  }, [debugMode, onDebugModeToggle, user]);

  
  useEffect(() => {
    if (!debugMode) return;

    
    const handleError = (message, source, lineno, colno, error) => {
      addDebugLog('error', `global error: ${message}`, {
        source,
        line: lineno,
        column: colno,
        error: error?.message || null,
        stack: error?.stack || null
      }, true);
      return false;
    };

    
    const handleUnhandledRejection = (event) => {
      const reason = event.reason;
      addDebugLog('error', `unhandled promise rejection: ${reason?.message || String(reason)}`, {
        reason: reason?.stack || String(reason),
        promise: event.promise
      }, true);
    };

    
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    
    console.error = (...args) => {
      addDebugLog('error', `console.error: ${args.join(' ')}`, { args }, true);
      originalConsoleError.apply(console, args);
    };
    
    console.warn = (...args) => {
      addDebugLog('warn', `console.warn: ${args.join(' ')}`, { args });
      originalConsoleWarn.apply(console, args);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    addDebugLog('system', 'global error handlers attached');

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
      addDebugLog('system', 'global error handlers detached');
    };
  }, [debugMode, addDebugLog]);

  useEffect(() => {
    if (!debugMode || !currentUserId) return;
    refreshBackendDebugLogs();
  }, [currentUserId, debugMode, refreshBackendDebugLogs]);

  
  useEffect(() => {
    if (!debugMode || eventListenersAttached.current) return;

    eventListenersAttached.current = true;

    
    const handleClick = (e) => {
      const target = e.target;
      const elementInfo = {
        ...describeInteractionTarget(target),
        text: target.textContent?.slice(0, 50)?.trim() || null,
        x: e.clientX,
        y: e.clientY
      };
      addDebugLog('click', `clicked: ${target.tagName.toLowerCase()}`, elementInfo);
    };


    let lastHoverTime = 0;
    const handleMouseOver = (e) => {
      const now = Date.now();
      if (now - lastHoverTime < 100) return;
      lastHoverTime = now;

      const target = e.target;
      const elementInfo = {
        ...describeInteractionTarget(target),
        x: e.clientX,
        y: e.clientY
      };
      addDebugLog('hover', `hover: ${target.tagName.toLowerCase()}`, elementInfo);
    };

    
    const handleKeyDown = (e) => {
      addDebugLog('keyboard', `key pressed: ${e.code}`, {
        key: e.key,
        code: e.code,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey
      });
    };

    
    let lastScrollTime = 0;
    const handleScroll = (e) => {
      const now = Date.now();
      if (now - lastScrollTime < 200) return;
      lastScrollTime = now;

      addDebugLog('scroll', 'page scrolled', {
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });
    };

    
    const handleInput = (e) => {
      const target = e.target;
      addDebugLog('input', `input changed: ${target.tagName.toLowerCase()}`, {
        tag: target.tagName,
        type: target.type || null,
        value: target.value?.slice(0, 100) || null
      });
    };

    
    const handleFocus = (e) => {
      const target = e.target;
      addDebugLog('focus', `focused: ${target.tagName.toLowerCase()}`, {
        tag: target.tagName,
        type: target.type || null
      });
    };

    const handleBlur = (e) => {
      const target = e.target;
      addDebugLog('focus', `blurred: ${target.tagName.toLowerCase()}`, {
        tag: target.tagName,
        type: target.type || null
      });
    };

    
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('focus', handleFocus, true);
    document.addEventListener('blur', handleBlur, true);

    addDebugLog('system', 'global debug event listeners attached');

    return () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('focus', handleFocus, true);
      document.removeEventListener('blur', handleBlur, true);
      eventListenersAttached.current = false;
      addDebugLog('system', 'global debug event listeners detached');
    };
  }, [debugMode, addDebugLog]);

  const initAudioContext = () => {
    const audio = audioRef.current;
    if (!audio) return;

    
    if (audioContextRef.current) return;

    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaElementSource(audio);

      
      const analyser = audioContext.createAnalyser();
      // 256 gave only 128 total bins across the full 0-24khz range, so the
      // ENTIRE bass region (20-250hz) collapsed into basically a single
      // bin — thats what made every bass-end bar/spoke look identical and
      // blocky af. 4096 gives 2048 bins (~20x finer than before), spreading
      // real detail across the low end instead of just mid/treble — still
      // under 100ms per analysis window so its not noticeable, cant even tell
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const gainNode = audioContext.createGain();

      const filters = [];
      const frequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

      frequencies.forEach((freq, index) => {
        const filter = audioContext.createBiquadFilter();
        filter.type = index === 0 ? 'lowshelf' : index === frequencies.length - 1 ? 'highshelf' : 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1;
        filter.gain.value = eqValues[index];
        filters.push(filter);
      });

      
      source.connect(analyser);
      analyser.connect(filters[0]);

      let lastNode = filters[0];
      for (let i = 1; i < filters.length; i++) {
        lastNode.connect(filters[i]);
        lastNode = filters[i];
      }
      lastNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      eqFiltersRef.current = filters;
    } catch (e) {
      console.warn('Web Audio API not fully supported:', e);
    }
  };

  useEffect(() => {
    const unlockAudio = () => {
      initAudioContext();
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };

    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);

    return () => {
      window.removeEventListener('pointerdown', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    };
  }, []);

  
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      eqFiltersRef.current = [];
    };
  }, []);

  
  useEffect(() => {
    eqFiltersRef.current.forEach((filter, index) => {
      filter.gain.value = eqEnabled ? eqValues[index] : 0;
    });
  }, [eqValues, eqEnabled]);

  const playTrackAtIndex = useCallback(async (index, trackList = null, options = {}) => {
    console.log('[PLAYTRACK] playTrackAtIndex called', { index, trackList: !!trackList, options });
    const nextSource = options.source || (trackList === channelQueue ? 'shared' : 'personal');
    const shouldAutoplay = options.autoplay !== false;
    const shouldNotify = options.notify !== false;
    const shouldRestoreSavedPosition = options.restoreSavedPosition === true;
    const startTime = typeof options.startTime === 'number' && Number.isFinite(options.startTime)
      ? Math.max(0, options.startTime)
      : 0;
    const list = (trackList || (nextSource === 'shared' ? channelQueue : queue)).map((track) => normalizeTrack(track));
    if (!list || !list.length) {
      addDebugLog('playback', 'playTrackAtIndex: no tracks available', { index, listLength: list?.length }, true);
      setPlayIndex(-1);
      setIsPlaying(false);
      return;
    }

    const safeIndex = Math.max(0, Math.min(index, list.length - 1));
    index = safeIndex;
    playbackQueueRef.current = list;
    autoplayRef.current = shouldAutoplay;
    // if were hopping from personal to shared, keep the solo spot around
    if (nextSource === 'shared' && playbackSourceRef.current !== 'shared' && audioRef.current?.src && Number.isFinite(audioRef.current.currentTime)) {
      personalPlayerStateRef.current = {
        videoId: currentTrack?.videoId || null,
        currentTime: audioRef.current.currentTime,
        duration: audioRef.current.duration || 0
      };
    }
    playbackSourceRef.current = nextSource;
    setPlaybackSource(nextSource);
    setPlayIndex(index);
    setCurrentIndex(index);
    playIndexRef.current = index;

    const rawItem = list[index];
    const track = normalizeTrack(rawItem);
    const rawVideoId = rawItem?.videoId || rawItem?.video_id || rawItem?.id || '(none)';
    
    const audio = audioRef.current;
    
    const savedState = personalPlayerStateRef.current;
    const shouldRestorePosition = shouldRestoreSavedPosition
      && nextSource !== 'shared'
      && savedState.videoId === track.videoId
      && savedState.currentTime > 0;
    const pendingStartTime = startTime > 0
      ? startTime
      : (shouldRestorePosition ? savedState.currentTime : 0);
    
    console.log('[PLAYTRACK] Track analysis', {
      currentVideoId: currentTrack?.videoId,
      newVideoId: track.videoId,
      audioSrc: audio?.src,
      savedState,
      shouldRestorePosition,
      shouldRestoreSavedPosition,
      pendingStartTime,
      startTime,
      nextSource
    });

    setCurrentTrack(track);
    addDebugLog('playback', `playTrackAtIndex: ${index}`, {
      index,
      source: nextSource,
      startTime,
      pendingStartTime,
      autoplay: shouldAutoplay,
      videoId: track.videoId,
      rawVideoId,
      title: track.title,
      listLength: list.length,
      listVideoIds: list.slice(0, 3).map(t => t?.videoId || '(none)')
    }, true);
    logClient('playTrackAtIndex', { index, videoId: track.videoId, title: track.title });

    if (!audio) {
      addDebugLog('error', 'playTrackAtIndex: audio element not found', { index }, true);
      return;
    }
    console.log('[PLAYTRACK] Audio element found', { src: audio.src, currentTime: audio.currentTime, duration: audio.duration });

    if (nextSource === 'shared') {
      audio.dataset.requestedSharedTrackId = String(track.id || rawItem?.id || '');
    } else {
      delete audio.dataset.requestedSharedTrackId;
    }

    setIsBuffering(true);
    addDebugLog('playback', `loading stream: ${track.videoId}`, { videoId: track.videoId }, true);
    const requestSerial = ++playRequestSerialRef.current;

    // hang on to the solo spot before we reset the element
    if (nextSource !== 'shared' && audio.src && Number.isFinite(audio.currentTime)) {
      console.log('[PLAYTRACK] Saving personal player state before reset', { currentTime: audio.currentTime, videoId: currentTrack?.videoId });
      personalPlayerStateRef.current = {
        videoId: currentTrack?.videoId || null,
        currentTime: audio.currentTime,
        duration: audio.duration || 0
      };
    }

    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load();


    if (audio._loadTimeout) {
      clearTimeout(audio._loadTimeout);
      audio._loadTimeout = null;
    }

    // new load, fresh retry counter
    audio._streamRetryCount = 0;

    
    
    const streamPath = `/api/stream?videoId=${encodeURIComponent(track.videoId)}`;
    addDebugLog('api', `stream request: ${streamPath}`, { videoId: track.videoId, startTime }, true);
    let streamUrl = streamPath;
    try {
      streamUrl = await resolveMediaUrl(streamPath);
    } catch (error) {
      if (requestSerial !== playRequestSerialRef.current) {
        return;
      }
      addDebugLog('error', `stream url resolve failed: ${error.message}`, { videoId: track.videoId }, true);
      showNotification(`failed to load: ${track.title}`, 'error');
      setIsPlaying(false);
      setIsBuffering(false);
      return;
    }

    if (requestSerial !== playRequestSerialRef.current) {
      return;
    }

    audio._pendingStartTime = pendingStartTime > 0 ? pendingStartTime : null;
    audio.src = streamUrl;
    audio.dataset.lastSrc = streamUrl;
    audio.load();
    audio.volume = isMutedRef.current ? 0 : volumeRef.current;



    audio._loadTimeout = setTimeout(() => {
      if (requestSerial !== playRequestSerialRef.current) {
        return;
      }
      if (audio.readyState === 0) {
        const retryCount = audio._streamRetryCount || 0;
        if (retryCount < MAX_STREAM_RETRIES) {
          // try loading it again instead of skipping right away
          audio._streamRetryCount = retryCount + 1;
          const delayMs = Math.min(1000 * Math.pow(2, retryCount), 4000);
          addDebugLog('error', `stream timeout: retry ${audio._streamRetryCount}/${MAX_STREAM_RETRIES} for ${track.title}`, { videoId: track.videoId, readyState: audio.readyState }, true);
          audio._loadTimeout = setTimeout(() => {
            if (requestSerial !== playRequestSerialRef.current) return;
            audio.src = streamUrl;
            audio.dataset.lastSrc = streamUrl;
            audio.load();
          }, delayMs);
        } else {
          addDebugLog('error', `stream timeout: failed to load ${track.title} after ${MAX_STREAM_RETRIES} retries`, { videoId: track.videoId, readyState: audio.readyState }, true);
          showNotification(`failed to load: ${track.title}`, 'error');
          setIsPlaying(false);
          setIsBuffering(false);

          setTimeout(() => handleNextRef.current(), 1000);
        }
      }
    }, 15000);

    const resumeAudioContext = async () => {
      initAudioContext();
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
          addDebugLog('playback', 'AudioContext resumed', null, true);
        } catch (e) {
          addDebugLog('error', `AudioContext resume failed: ${e.message}`, { error: e }, true);
        }
      }
    };

    resumeAudioContext().then(() => {
      if (requestSerial !== playRequestSerialRef.current) {
        return;
      }
      if (!shouldAutoplay) {
        setIsPlaying(false);
        return;
      }

      audio.play().then(() => {
        if (requestSerial !== playRequestSerialRef.current) {
          return;
        }
        if (audio._loadTimeout) {
          clearTimeout(audio._loadTimeout);
          audio._loadTimeout = null;
        }
        setIsPlaying(true);
        if (shouldNotify) {
          showNotification(`playing: ${track.title}`, 'info');
        }
      }).catch((err) => {
        if (requestSerial !== playRequestSerialRef.current) {
          return;
        }
        console.warn('Audio play blocked:', err?.message || err);
        if (shouldNotify) {
          showNotification(`playback failed: ${track.title}`, 'error');
        }
        setIsPlaying(false);
        setIsBuffering(false);
        if (audio._loadTimeout) {
          clearTimeout(audio._loadTimeout);
          audio._loadTimeout = null;
        }
      });
    });
  }, [channelQueue, queue, showNotification]);

  const syncSharedPlayerFromAudio = useCallback((overrides = {}) => {
    if (playbackSourceRef.current !== 'shared' || !currentChannelId || !channelPlayerState?.current_track_id) {
      return;
    }

    const audio = audioRef.current;
    const nextState = buildSharedPlayerUpdate({
      currentTrackId: overrides.current_track_id ?? channelPlayerState.current_track_id,
      audioCurrentTime: audio?.currentTime,
      audioVolume: audio?.volume,
      isAudioPaused: overrides.is_playing !== undefined ? !overrides.is_playing : audio?.paused,
      fallbackCurrentTime: overrides.current_time ?? channelPlayerState.current_time ?? 0,
      fallbackVolume: overrides.volume ?? channelPlayerState.volume ?? volume
    });

    if (!nextState) {
      return;
    }

    updateCurrentChannelPlayer({
      ...nextState,
      ...overrides
    });
  }, [channelPlayerState, currentChannelId, updateCurrentChannelPlayer, volume]);

  const scheduleSharedPlaybackRecovery = useCallback((reason, delayMs = 1200) => {
    if (sharedRecoveryTimeoutRef.current) {
      clearTimeout(sharedRecoveryTimeoutRef.current);
    }

    sharedRecoveryTimeoutRef.current = setTimeout(() => {
      sharedRecoveryTimeoutRef.current = null;

      if (playbackSourceRef.current !== 'shared') {
        return;
      }

      const sharedState = channelPlayerStateRef.current;
      const sharedQueue = channelQueueRef.current;
      const serverId = currentChannelRef.current;
      if (!serverId || !sharedState?.current_track_id || !Array.isArray(sharedQueue) || !sharedQueue.length) {
        return;
      }

      const sharedIndex = sharedQueue.findIndex((track) => track.id === sharedState.current_track_id);
      if (sharedIndex < 0) {
        return;
      }

      addDebugLog('playback', `recovering local shared stream after ${reason}`, {
        channelId: serverId,
        trackId: sharedState.current_track_id,
        currentTime: sharedState.current_time
      }, true);

      if (localStreamErrorTimerRef.current) {
        clearTimeout(localStreamErrorTimerRef.current);
        localStreamErrorTimerRef.current = null;
      }
      localStreamErrorRef.current = false;

      playTrackAtIndex(sharedIndex, sharedQueue, {
        source: 'shared',
        autoplay: sharedState.is_playing === true,
        notify: false,
        startTime: sharedState.current_time || 0
      });
    }, delayMs);
  }, [addDebugLog, playTrackAtIndex]);

  
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // throttle progress updates so time ticks dont rerender the whole app nonstop
    let lastProgressMs = 0;
    const PROGRESS_THROTTLE_MS = 250;

    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastProgressMs < PROGRESS_THROTTLE_MS) return;
      lastProgressMs = now;
      // a stray timeupdate CAN still fire right after an error handler tears
      // the element down (removeAttribute('src') + .load()), and at that
      // point audio.duration is NaN — used to write that straight into
      // trackProgress as duration: 0, which made the whole progress bar
      // silently render nothing (see the ternary below) even though a real
      // track was still "current." this is what made the entire play bar
      // just vanish after a failed stream instead of showing SOMETHING.
      // just skip the update entirely when theres no real duration to
      // report instead of clobbering the last known-good value
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      setTrackProgress({ current: audio.currentTime, duration: audio.duration });
    };

    const onPlaying = () => {
      setIsPlaying(true);
      setIsBuffering(false);
      // defensive sync — loadedmetadata is SUPPOSED to fire before playing
      // and already set a real duration by now, but on a reload/retry
      // (same src re-assigned, not a fresh url) some browsers skip firing
      // it again even though duration IS actually available on the element.
      // when that happens trackProgress.duration stays stuck at whatever it
      // was (often 0 right after a retry), which is exactly what pins the
      // player on the "0:00 / ?" fallback display forever instead of ever
      // showing the real seek bar once its actually playing fine
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setTrackProgress((prev) => (prev.duration > 0 ? prev : { current: audio.currentTime, duration: audio.duration }));
      }
    };

    const onPause = () => {
      // save the solo spot on pause no matter what caused it
      if (audio.currentTime > 0 && !audio.ended && Number.isFinite(audio.currentTime)) {
        personalPlayerStateRef.current = {
          videoId: currentTrack?.videoId || null,
          currentTime: audio.currentTime,
          duration: audio.duration || 0
        };
      }
      if (audio.currentTime > 0 && !audio.ended) {
        setIsPlaying(false);
      }
    };

    const onEnded = () => {
      // clear the saved solo spot when a track really finishes
      personalPlayerStateRef.current = { videoId: null, currentTime: 0, duration: 0 };
      setIsPlaying(false);
      setIsBuffering(false);
      if (repeatMode === 'one') {
        audio.currentTime = 0;
        audio.play();
        setIsPlaying(true);
      } else {
        handleNext();
      }
    };

    // retry state for stream errors — prevents immediate skips on transient failures
    audio._streamRetryCount = audio._streamRetryCount || 0;

    const onError = () => {

      if (audio._loadTimeout) {
        clearTimeout(audio._loadTimeout);
        audio._loadTimeout = null;
      }

      const error = audio.error;
      const errorCode = error ? error.code : 0;
      const errorMessage = error ? error.message : 'Unknown error';

      // retry network errors (2), aborted (1), unknown (0), AND decode
      // errors (3). decode errors from youtube's cdn are often transient —
      // just a corrupted segment on a specific edge server. only
      // src-not-supported (4) is truly permanent, everything else gets a shot
      const isRetryable = errorCode === 1 || errorCode === 2 || errorCode === 3 || errorCode === 0;

      if (isRetryable && audio._streamRetryCount < MAX_STREAM_RETRIES) {
        audio._streamRetryCount++;
        const delayMs = Math.min(1000 * Math.pow(2, audio._streamRetryCount - 1), 4000);
        const resumeAt = audio.currentTime;
        addDebugLog('error', `stream error (retryable, attempt ${audio._streamRetryCount}/${MAX_STREAM_RETRIES}): ${errorCode}`, { videoId: currentTrack?.videoId, code: errorCode, msg: errorMessage, resumeAt }, true);

        // retry: reload the same src after a backoff delay. without
        // capturing the position first, reloading drops it back to 0 —
        // which is what made a retried stream look like it "restarted"
        // instead of just quietly recovering in place. sneaky bug
        audio._pendingStartTime = resumeAt > 0 ? resumeAt : null;
        const retrySerial = playRequestSerialRef.current;
        setTimeout(() => {
          if (retrySerial !== playRequestSerialRef.current) return;
          audio.pause();
          audio.removeAttribute('src');
          audio.src = audio.dataset.lastSrc || audio.src;
          audio.load();
          audio.play().catch(() => {});
        }, delayMs);
        return;
      }

      // out of retries — recover locally for shared playback, skip for personal playback
      const message = error ? `Playback error (${error.code}): ${error.message}` : 'Playback failed';
      if (audio._streamRetryCount >= MAX_STREAM_RETRIES) {
        showNotification(`stream failed after ${MAX_STREAM_RETRIES} retries: ${currentTrack?.title || 'track'}`, 'error');
        addDebugLog('error', `stream failed after ${MAX_STREAM_RETRIES} retries: ${currentTrack?.title}`, {
          videoId: currentTrack?.videoId,
          shared: playbackSourceRef.current === 'shared'
        }, true);
      } else {
        showNotification(message, 'error');
      }
      console.error('Audio element error (final):', error);
      setIsPlaying(false);
      setIsBuffering(false);
      audio._streamRetryCount = 0;
      // mark local stream error so it doesnt cause cascading skips on other clients
      localStreamErrorRef.current = true;
      if (localStreamErrorTimerRef.current) clearTimeout(localStreamErrorTimerRef.current);
      localStreamErrorTimerRef.current = setTimeout(() => {
        localStreamErrorRef.current = false;
      }, 10000);

      audio.pause();
      audio.removeAttribute('src');
      delete audio.dataset.requestedSharedTrackId;
      audio.load();

      // track consecutive stream failures to prevent infinite skip loops
      audio._consecutiveFailures = (audio._consecutiveFailures || 0) + 1;
      if (audio._consecutiveFailures >= 3) {
        addDebugLog('error', `${audio._consecutiveFailures} tracks failed in a row, stopping playback`, null, true);
        showNotification('multiple tracks failed — check if local helper is running', 'error');
        audio._consecutiveFailures = 0;
        return;
      }

      if (playbackSourceRef.current === 'shared') {
        scheduleSharedPlaybackRecovery('stream error');
        return;
      }

      // personal mode — skip to next track after a short delay
      setTimeout(() => handleNextRef.current(), 1000);
    };

    const onLoadedMetadata = () => {
      let pendingStartTime = 0;
      if (typeof audio._pendingStartTime === 'number' && Number.isFinite(audio._pendingStartTime)) {
        const nextTime = audio.duration
          ? Math.min(audio._pendingStartTime, audio.duration)
          : audio._pendingStartTime;
        if (nextTime > 0) {
          audio.currentTime = nextTime;
          pendingStartTime = nextTime;
        }
      }
      audio._pendingStartTime = null;

      
      if (audio._loadTimeout) {
        clearTimeout(audio._loadTimeout);
        audio._loadTimeout = null;
      }
      delete audio.dataset.requestedSharedTrackId;
      setTrackProgress({ current: pendingStartTime, duration: audio.duration || 0 });
    };

    const onLoadStart = () => {
      setIsBuffering(true);
    };

    const onWaiting = () => {
      setIsBuffering(true);
    };

    const onCanPlay = () => {
      setIsBuffering(false);
      // once it can play again, clear stall tracking
      audio._stallCount = 0;
      // same deal for failure tracking
      audio._consecutiveFailures = 0;

      if (autoplayRef.current && audio.paused) {
        const ctx = audioContextRef.current;
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        audio.play().catch(() => {});
        setIsPlaying(true);
      } else if (!autoplayRef.current) {
        setIsPlaying(false);
      }
    };

    const onStalled = () => {
      // chromium (and therefore this webview) fires `stalled` fairly often
      // during completely ordinary buffering pauses on a locally-proxied
      // stream — not just on genuinely dead connections, false alarms
      // basically. if theres already buffered-ahead data (readyState >=
      // HAVE_FUTURE_DATA) its almost certainly noise, not a real stall, so
      // it doesnt count. isolated stalls also decay after a quiet stretch
      // instead of stacking up across an entire listening session, so three
      // unrelated hiccups spread minutes apart cant add up to a false
      // trigger the way they used to
      if (audio.readyState >= 3) return;

      const now = Date.now();
      if (audio._lastStallAt && now - audio._lastStallAt > 8000) {
        audio._stallCount = 0;
      }
      audio._lastStallAt = now;
      audio._stallCount = (audio._stallCount || 0) + 1;
      addDebugLog('playback', `stream stalled (count: ${audio._stallCount})`, { videoId: currentTrack?.videoId, readyState: audio.readyState }, true);

      if (audio._stallCount >= 3) {
        // after a few stalls, treat it like a retryable failure
        audio._stallCount = 0;
        const retryCount = audio._streamRetryCount || 0;
        if (retryCount < MAX_STREAM_RETRIES) {
          audio._streamRetryCount = retryCount + 1;
          const delayMs = Math.min(1000 * Math.pow(2, retryCount), 4000);
          const resumeAt = audio.currentTime;
          addDebugLog('error', `stream stalled 3 times, retrying (${audio._streamRetryCount}/${MAX_STREAM_RETRIES})`, { videoId: currentTrack?.videoId, resumeAt }, true);
          // same position-preservation trick as the error-retry path above
          // — reloading without this drops playback back to 0, which made
          // a stall recovery look like a random restart. same bug, same fix
          audio._pendingStartTime = resumeAt > 0 ? resumeAt : null;
          setTimeout(() => {
            audio.src = audio.dataset.lastSrc || audio.src;
            audio.load();
          }, delayMs);
        } else {
          addDebugLog('error', `stream stalled and retries exhausted: ${currentTrack?.title}`, {
            videoId: currentTrack?.videoId,
            shared: playbackSourceRef.current === 'shared'
          }, true);
          showNotification(`stream stalled: ${currentTrack?.title}`, 'error');
          delete audio.dataset.requestedSharedTrackId;
          if (playbackSourceRef.current === 'shared') {
            scheduleSharedPlaybackRecovery('stream stall');
          } else {
            setTimeout(() => handleNextRef.current(), 1000);
          }
        }
      }
    };

    const onPointerMove = (event) => {
      if (!scrubbingRef.current) return;
      const container = playbackSourceRef.current !== 'shared' ? personalProgressBarRef.current : sharedProgressBarRef.current;
      // only seek when the bar and duration are both real
      const audio = audioRef.current;
      if (!container || !audio || !audio.duration) return;
      seekToClientX(event.clientX, container);
    };

    const onPointerUp = () => {
      if (scrubbingRef.current) {
        scrubbingRef.current = false;
        syncSharedPlayerFromAudio();
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('loadstart', onLoadStart);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('stalled', onStalled);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('loadstart', onLoadStart);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('stalled', onStalled);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      if (audio._loadTimeout) {
        clearTimeout(audio._loadTimeout);
      }
      if (localStreamErrorTimerRef.current) {
        clearTimeout(localStreamErrorTimerRef.current);
      }
    };
  }, [currentTrack, playIndex, repeatMode, scheduleSharedPlaybackRecovery, showNotification, syncSharedPlayerFromAudio]);

  useEffect(() => {
    const canvas = particleCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let animationFrameId;

    const rgbToHue = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0;
      if (max !== min) {
        const d = max - min;
        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
          case g: h = ((b - r) / d + 2) / 6; break;
          case b: h = ((r - g) / d + 4) / 6; break;
        }
      }
      return h * 360;
    };

    const baseHue = rgbToHue(themeColor.r, themeColor.g, themeColor.b);

    // fft bins are linearly spaced in hz, but pitch/octaves (and where
    // music actually puts its energy) are logarithmic — sampling bins
    // linearly across the bar count crams the entire audible low/mid range
    // into a handful of bars on the left and leaves most of the display
    // showing near-silent 5-20khz content. this maps bar position to a
    // log-spaced point between 20hz and 20khz (audible range, not the full
    // nyquist range up to sampleRate/2) and converts that to the matching
    // bin, so a log sweep — or just normal music — actually uses the whole
    // width instead of sitting frozen at the left edge like before
    const FREQ_MIN = 20;
    const FREQ_MAX = 20000;
    const hzToBin = (hz, dataArray) => {
      const sampleRate = audioContextRef.current?.sampleRate || 44100;
      const nyquist = sampleRate / 2;
      const bin = Math.round((hz / nyquist) * dataArray.length);
      return Math.min(dataArray.length - 1, Math.max(0, bin));
    };
    // returns the PEAK amplitude (0-1) across every bin between this bar's
    // own frequency and the next bar's — NOT the average of that span. bar
    // width in hz grows with frequency (thats the whole point of the log
    // scale), so a high bar can span hundreds of bins while a low one spans
    // only one or two. averaging that span meant a single sine tone sitting
    // in a wide high-frequency bar got diluted by all the silent bins
    // around it — a full-scale 15khz tone would show up as barely a
    // flicker while the same tone at 200hz lit its (much narrower) bar up
    // completely, purely because of how many mostly-empty neighbors it got
    // averaged against. so dumb once i figured out why the highs always
    // looked dead. peak instead of mean means a bar reflects whatevers
    // actually loud inside its range, regardless of how wide that range is
    const ampForBarRange = (barIndex, barCount, dataArray) => {
      if (!dataArray) return 0;
      const tStart = barIndex / barCount;
      const tEnd = (barIndex + 1) / barCount;
      const hzStart = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, tStart);
      const hzEnd = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, tEnd);
      const binStart = hzToBin(hzStart, dataArray);
      const binEnd = Math.max(binStart, hzToBin(hzEnd, dataArray));
      let peak = 0;
      for (let b = binStart; b <= binEnd; b++) {
        if (dataArray[b] > peak) peak = dataArray[b];
      }
      return peak / 255;
    };

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const updateFadeTransition = () => {
      const fade = fadeTransitionRef.current;
      if (fade.active) {
        const fadeSpeed = fade.target === 0 ? 0.08 : 0.02;
        fade.progress += (fade.target - fade.progress) * fadeSpeed;
        if (Math.abs(fade.progress - fade.target) < 0.01) {
          fade.progress = fade.target;
          if (fade.target === 0) fade.active = false;
        }
      }
    };

    // scratch state for whichever preset is active — reset fresh every time
    // this effect (re)runs, i.e. every preset switch. each renderer below
    // lazily fills in whatever arrays it needs on its own first frame.
    const state = {};

    const makeFloatParticles = (count) => {
      const list = [];
      for (let i = 0; i < count; i++) {
        list.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          baseRadius: Math.random() * 5 + 4,
          radius: Math.random() * 5 + 4,
          hueOffset: Math.random() * 60 - 30,
          alpha: 0,
          targetAlpha: Math.random() * 0.8 + 0.5
        });
      }
      return list;
    };

    // --- preset renderers ----------------------------------------------
    // each takes the same per-frame audio snapshot (f) and draws onto the
    // full-screen canvas however it likes. f.baseHue ties every preset's
    // palette back to the user's theme color, so switching color re-tints
    // whichever animation is active.

    const renderParticles = (f) => {
      if (!state.particles) state.particles = makeFloatParticles(60);
      // splitting particles into a bass zone and a treble zone caused a
      // visible "wall" right at the halfway line — a particle rising from
      // the bass half into the treble half would abruptly switch which
      // level drives it, and since treble is usually way quieter than bass,
      // itd suddenly lose speed and shrink right at that boundary. looked
      // so weird. one straightforward pulse/rise for every particle now —
      // no per-particle branching, so no discontinuity — but folds in bass
      // alongside volume so the particles visibly swell and speed up
      // together with the bottom glow instead of moving on an unrelated signal
      const pulseFactor = f.isPlaying ? (0.3 + f.volumeLevel * 2 + f.bassLevel * 2) : 1;

      state.particles.forEach((particle) => {
        const volumeRise = f.isPlaying ? (f.volumeLevel * 1.3 + f.bassLevel * 1.5) : 0;
        particle.x += particle.vx;
        particle.y += particle.vy - volumeRise;

        if (particle.x < -50) particle.x = canvas.width + 50;
        if (particle.x > canvas.width + 50) particle.x = -50;
        if (particle.y < -50) particle.y = canvas.height + 50;
        if (particle.y > canvas.height + 50) particle.y = -50;

        const targetAlpha = f.isPlaying ? particle.targetAlpha * f.fadeProgress : 0;
        const fadeSpeed = f.fadeProgress > 0.5 ? 0.05 : 0.08;
        particle.alpha += (targetAlpha - particle.alpha) * fadeSpeed;

        const targetRadius = particle.baseRadius * pulseFactor;
        particle.radius += (targetRadius - particle.radius) * 0.28;

        if (particle.alpha > 0.01) {
          // mostly theme-tinted now (not the old random ±30° per-particle
          // spread that made this look like a rainbow puked everywhere),
          // but a small ±12° drift per particle keeps it from feeling like
          // one flat color — plus a saturation/lightness bump so it reads
          // as brighter and more alive against the dark background
          const hue = (f.baseHue + particle.hueOffset * 0.2 + 360) % 360;
          const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.radius * 0.8);
          gradient.addColorStop(0, `hsla(${hue}, 100%, 70%, ${particle.alpha})`);
          gradient.addColorStop(0.6, `hsla(${hue}, 95%, 60%, ${particle.alpha * 0.4})`);
          gradient.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.radius * 0.8, 0, Math.PI * 2);
          ctx.fillStyle = gradient;
          ctx.fill();
        }
      });

      if (f.isPlaying) {
        // height itself pulses with bass too, not just opacity — makes the
        // bottom glow visibly swell on hits instead of just brightening.
        const glowHeight = canvas.height * (0.3 + f.bassLevel * 0.18);
        const glowGradient = ctx.createLinearGradient(0, canvas.height - glowHeight, 0, canvas.height);
        const glowIntensity = Math.min(1, f.bassLevel * 0.65 + f.volumeLevel * 0.08);
        glowGradient.addColorStop(0, `hsla(${f.baseHue}, 70%, 50%, 0)`);
        glowGradient.addColorStop(0.3, `hsla(${f.baseHue}, 70%, 50%, ${glowIntensity * 0.3})`);
        glowGradient.addColorStop(0.6, `hsla(${f.baseHue}, 75%, 45%, ${glowIntensity * 0.5})`);
        glowGradient.addColorStop(1, `hsla(${f.baseHue}, 80%, 40%, ${glowIntensity * 0.7})`);
        ctx.fillStyle = glowGradient;
        ctx.fillRect(0, canvas.height - glowHeight, canvas.width, glowHeight);
      }
    };

    const renderBars = (f) => {
      const barCount = 48;
      const gap = 3;
      const barWidth = canvas.width / barCount - gap;
      for (let i = 0; i < barCount; i++) {
        const raw = ampForBarRange(i, barCount, f.dataArray);
        const height = f.isPlaying ? Math.max(4, raw * canvas.height * 0.5) : 4;
        const x = i * (barWidth + gap);
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - height);
        gradient.addColorStop(0, `hsla(${f.baseHue}, 85%, 55%, 0.85)`);
        gradient.addColorStop(1, `hsla(${f.baseHue}, 90%, 65%, 0.15)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, canvas.height - height, barWidth, height);
      }
    };

    const renderWave = (f) => {
      if (!f.timeData) return;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `hsla(${f.baseHue}, 85%, 60%, 0.9)`;
      ctx.shadowColor = `hsla(${f.baseHue}, 85%, 60%, 0.6)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      const midY = canvas.height / 2;
      const sliceWidth = canvas.width / f.timeData.length;
      let x = 0;
      for (let i = 0; i < f.timeData.length; i++) {
        const v = (f.timeData[i] - 128) / 128;
        const y = midY + v * midY * 0.8 * (f.isPlaying ? 1 : 0.05);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const renderRadial = (f) => {
      // nothing playing -> nothing drawn, instead of the old static
      // pinwheel just sitting there at rest length looking like its "on"
      // when it isnt
      if (!f.isPlaying) return;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const baseRadius = Math.min(canvas.width, canvas.height) * 0.15;
      const spokes = 64;
      if (state.radialAngle === undefined) state.radialAngle = 0;
      state.radialAngle += 0.002;
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2 + state.radialAngle;
        const raw = ampForBarRange(i, spokes, f.dataArray);
        const len = baseRadius * 0.3 + raw * baseRadius * 1.4;
        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + len);
        const y2 = cy + Math.sin(angle) * (baseRadius + len);
        // same hue all the way around, but lightness drifts smoothly with
        // angle so it doesn't read as one flat blob — no hard color jumps
        // to fade, just a soft brightness wave.
        const lightness = 55 + Math.sin(angle * 3) * 15;
        ctx.strokeStyle = `hsla(${f.baseHue}, 85%, ${lightness}%, 0.8)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    };

    const renderRipple = (f) => {
      if (!state.rings) state.rings = [];
      if (!state.cooldown) state.cooldown = 0;
      state.cooldown -= 1;
      if (f.isPlaying && f.bassLevel > 0.55 && state.cooldown <= 0) {
        state.rings.push({ radius: 10, alpha: 0.8 });
        state.cooldown = 10;
      }
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      state.rings.forEach((ring) => {
        ring.radius += 4 + f.volumeLevel * 6;
        ring.alpha *= 0.965;
        ctx.strokeStyle = `hsla(${f.baseHue}, 85%, 60%, ${ring.alpha})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2);
        ctx.stroke();
      });
      state.rings = state.rings.filter((ring) => ring.alpha > 0.02 && ring.radius < Math.max(canvas.width, canvas.height));
    };

    const renderStarfield = (f) => {
      if (!state.stars) {
        state.stars = Array.from({ length: 120 }, () => ({
          x: (Math.random() - 0.5) * canvas.width,
          y: (Math.random() - 0.5) * canvas.height,
          z: Math.random() * canvas.width
        }));
      }
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const speed = f.isPlaying ? 2 + f.volumeLevel * 14 : 1;
      state.stars.forEach((star) => {
        star.z -= speed;
        if (star.z <= 1) {
          star.x = (Math.random() - 0.5) * canvas.width;
          star.y = (Math.random() - 0.5) * canvas.height;
          star.z = canvas.width;
        }
        const k = 128 / star.z;
        const sx = star.x * k + cx;
        const sy = star.y * k + cy;
        if (sx < 0 || sx > canvas.width || sy < 0 || sy > canvas.height) return;
        const size = Math.max(0.5, (1 - star.z / canvas.width) * 3);
        const hue = (f.baseHue + (star.z % 40)) % 360;
        ctx.fillStyle = `hsla(${hue}, 80%, 70%, ${Math.min(1, (1 - star.z / canvas.width) * 1.2)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    const renderPulseGrid = (f) => {
      const cols = 20;
      const rows = 12;
      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;
      const colAmps = Array.from({ length: cols }, (_, col) => ampForBarRange(col, cols, f.dataArray));
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const raw = colAmps[col];
          const rowFalloff = 1 - Math.abs(row - rows / 2) / (rows / 2);
          const intensity = f.isPlaying ? raw * rowFalloff : rowFalloff * 0.05;
          if (intensity < 0.03) continue;
          ctx.fillStyle = `hsla(${f.baseHue}, 80%, 60%, ${intensity * 0.8})`;
          const pad = 2;
          ctx.fillRect(col * cellW + pad, row * cellH + pad, cellW - pad * 2, cellH - pad * 2);
        }
      }
    };

    const renderNetwork = (f) => {
      if (!state.nodes) state.nodes = makeFloatParticles(80);
      const pulseFactor = f.isPlaying ? (0.4 + f.bassLevel * 1.5) : 0.4;
      // drift speed itself now tracks the music (used to be a constant
      // crawl no matter what was playing, boring) — nodes visibly quicken
      // on louder/bassier moments instead of only flickering in place
      const speedMul = f.isPlaying ? 1 + f.volumeLevel * 3 + f.bassLevel * 2 : 1;
      state.nodes.forEach((node) => {
        node.x += node.vx * speedMul;
        node.y += node.vy * speedMul;
        if (node.x < 0) node.x = canvas.width;
        if (node.x > canvas.width) node.x = 0;
        if (node.y < 0) node.y = canvas.height;
        if (node.y > canvas.height) node.y = 0;
      });
      const maxDist = 120 + f.bassLevel * 60;
      for (let i = 0; i < state.nodes.length; i++) {
        for (let j = i + 1; j < state.nodes.length; j++) {
          const a = state.nodes[i];
          const b = state.nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * 0.5 * pulseFactor;
            ctx.strokeStyle = `hsla(${f.baseHue}, 80%, 65%, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      state.nodes.forEach((node) => {
        ctx.fillStyle = `hsla(${f.baseHue}, 85%, 65%, 0.9)`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 2 * pulseFactor + 1, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    const renderMirrorSpectrum = (f) => {
      const barCount = 64;
      const gap = 2;
      const barWidth = canvas.width / barCount - gap;
      const midY = canvas.height / 2;
      for (let i = 0; i < barCount; i++) {
        const raw = ampForBarRange(i, barCount, f.dataArray);
        const height = f.isPlaying ? Math.max(2, raw * canvas.height * 0.4) : 2;
        const x = i * (barWidth + gap);
        ctx.fillStyle = `hsla(${f.baseHue}, 85%, 60%, 0.75)`;
        ctx.fillRect(x, midY - height, barWidth, height);
        ctx.fillStyle = `hsla(${f.baseHue}, 85%, 60%, 0.4)`;
        ctx.fillRect(x, midY, barWidth, height);
      }
    };

    const renderOrbit = (f) => {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const orbiters = 8;
      if (state.orbitAngle === undefined) state.orbitAngle = 0;
      // old deltas (0.01 base, +0.02*volume) were so close together that
      // the audio-driven part was basically invisible — spin is now mostly
      // volume-driven instead of a near-constant idle crawl with a tiny
      // bonus tacked on
      const spinDelta = f.isPlaying ? 0.004 + f.volumeLevel * 0.09 : 0.004;
      state.orbitAngle += spinDelta;
      for (let i = 0; i < orbiters; i++) {
        // bass swing was capped at +40% radius, barely readable against
        // orbiters already 1.5-8.5x apart in base radius — +140% makes a
        // bass hit visibly punch the whole ring outward.
        const radius = (Math.min(canvas.width, canvas.height) * 0.08) * (i + 1.5) * (1 + f.bassLevel * 1.4);
        const angle = state.orbitAngle * (i % 2 === 0 ? 1 : -1) + i;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 0.6;
        // mostly theme-tinted, small ±10° drift per orbiter plus a
        // lightness stagger so they're visually distinct from each other
        // instead of one flat color, with brighter/more saturated tones
        // than before.
        const hue = (f.baseHue + (i - orbiters / 2) * 2.5 + 360) % 360;
        const lightness = 58 + (i % 4) * 8;
        const size = f.isPlaying ? 4 + f.volumeLevel * 16 + f.bassLevel * 6 : 4;
        ctx.fillStyle = `hsla(${hue}, 95%, ${lightness}%, 0.9)`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const renderFlowField = (f) => {
      if (state.flowTime === undefined) state.flowTime = 0;
      state.flowTime += 0.02 + f.volumeLevel * 0.03;
      const bands = 5;
      for (let b = 0; b < bands; b++) {
        const amplitude = (20 + f.volumeLevel * 60) * (1 - (b / bands) * 0.5);
        const yOffset = canvas.height * ((b + 1) / (bands + 1));
        const hue = (f.baseHue + b * 25) % 360;
        ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${0.5 - b * 0.06})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x <= canvas.width; x += 8) {
          const y = yOffset + Math.sin(x * 0.01 + state.flowTime + b) * amplitude;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };

    const renderMinimalPulse = (f) => {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const baseRadius = Math.min(canvas.width, canvas.height) * 0.08;
      const pulse = f.isPlaying ? baseRadius * (1 + f.bassLevel * 1.2) : baseRadius;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulse * 2);
      gradient.addColorStop(0, `hsla(${f.baseHue}, 85%, 60%, 0.5)`);
      gradient.addColorStop(1, `hsla(${f.baseHue}, 85%, 60%, 0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, pulse * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `hsla(${f.baseHue}, 90%, 65%, 0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, pulse, 0, Math.PI * 2);
      ctx.stroke();
    };

    const RENDERERS = {
      none: () => {},
      particles: renderParticles,
      bars: renderBars,
      wave: renderWave,
      radial: renderRadial,
      ripple: renderRipple,
      starfield: renderStarfield,
      pulseGrid: renderPulseGrid,
      network: renderNetwork,
      mirrorSpectrum: renderMirrorSpectrum,
      orbit: renderOrbit,
      flowField: renderFlowField,
      minimalPulse: renderMinimalPulse
    };

    const animate = () => {
      updateFadeTransition();
      const fadeProgress = fadeTransitionRef.current.progress;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const analyser = analyserRef.current;
      let dataArray = null;
      let timeData = null;
      let bassLevel = 0;
      let volumeLevel = 0;

      if (analyser && isPlaying) {
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        timeData = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(timeData);

        const bassLength = Math.floor(dataArray.length * 0.1);
        let bassSum = 0;
        for (let i = 0; i < bassLength; i++) bassSum += dataArray[i];
        bassLevel = bassSum / bassLength / 255;

        let volumeSum = 0;
        for (let i = 0; i < dataArray.length; i++) volumeSum += dataArray[i];
        volumeLevel = volumeSum / dataArray.length / 255;
      }

      const renderer = RENDERERS[visualizerPreset] || renderParticles;
      renderer({ baseHue, isPlaying, fadeProgress, bassLevel, volumeLevel, dataArray, timeData });

      // downsampled copy for the miniplayer's own background visualizer —
      // it has no audio context of its own (nothing plays there), so this
      // is literally the only way it can be reactive at all. throttled to
      // ~20fps and 24 points since its a 300x118 window, not worth full
      // resolution or a 60fps ipc call. no-ops cheaply when the miniplayer
      // isnt open. mirrors whichever preset is actually selected: same
      // log-scale frequency mapping the real bar-style renderers use
      // (linear bin sampling was clustering almost all the energy into the
      // first couple of points, since most of a track's energy sits in the
      // low end of a linear spectrum), or the raw waveform for "wave"
      state.vizFrameCounter = (state.vizFrameCounter || 0) + 1;
      if (state.vizFrameCounter % 3 === 0) {
        let bins = null;
        let wave = null;
        if (dataArray) {
          bins = new Array(24);
          for (let i = 0; i < 24; i++) bins[i] = Math.round(ampForBarRange(i, 24, dataArray) * 255);
        }
        if (timeData) {
          wave = new Array(24);
          const step = Math.floor(timeData.length / 24) || 1;
          for (let i = 0; i < 24; i++) wave[i] = timeData[i * step];
        }
        sendVisualizerFrame({ baseHue, isPlaying, preset: visualizerPreset, bins, wave });
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, themeColor, visualizerPreset]);

  
  useEffect(() => {
    const fade = fadeTransitionRef.current;
    if (isPlaying) {
      
      fade.target = 1;
      fade.active = true;
      fade.progress = 0;
    } else {
      
      fade.target = 0;
      fade.active = true;
      fade.progress = 1;
    }
  }, [isPlaying]);

  
  useEffect(() => {
    const handleKeyDown = (e) => {
      
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleNext();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handlePrevious();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume((v) => Math.min(1, v + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume((v) => Math.max(0, v - 0.1));
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
        case 'KeyS':
          e.preventDefault();
          setShuffle((s) => !s);
          break;
        case 'KeyR':
          e.preventDefault();
          cycleRepeatMode();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, playIndex, queue.length]);

  
  const activePlaylists = playlists;
  const currentPlaylist = activePlaylists.find((playlist) => playlist.id === currentPlaylistId) || activePlaylists[0];
  const currentTracks = useMemo(() => currentPlaylist?.tracks || [], [currentPlaylist]);

  
  const downloadFile = async (videoId, title, signal, format = 'mp3') => {
    console.log('[downloadFile] Starting with:', { videoId, title, format, hasSignal: !!signal });
    
    

    const downloadPath = `/api/download?videoId=${encodeURIComponent(videoId)}&title=${encodeURIComponent(title)}&format=${encodeURIComponent(format)}`;
    console.log('[downloadFile] URL:', downloadPath);
    
    const maxRetries = 2;
    let attempt = 0;

    addDebugLog('download', `starting download: ${title}`, { videoId, format }, true);

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        console.log(`[downloadFile] Attempt ${attempt}/${maxRetries + 1}`);
        const downloadUrl = await resolveMediaUrl(downloadPath);
        addDebugLog('api', `fetch attempt ${attempt}/${maxRetries + 1}`, { url: downloadUrl }, true);
        
        console.log('[downloadFile] Calling fetch...');
        const res = await fetch(downloadUrl, { signal });
        console.log('[downloadFile] Fetch returned:', res.status, res.statusText);

        
        let headersObj = {};
        try {
          for (const [key, value] of res.headers.entries()) {
            headersObj[key] = value;
          }
        } catch (hErr) {
          console.warn('[downloadFile] Could not read headers:', hErr);
          headersObj = { error: 'Could not read headers' };
        }

        addDebugLog('api', `download response: ${res.status}`, {
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type'),
          contentLength: res.headers.get('content-length')
        }, true);

        if (!res.ok) {
          let err = {};
          try {
            err = await res.json();
          } catch (jErr) {
            console.warn('[downloadFile] Could not parse error JSON:', jErr);
            err = { error: `HTTP ${res.status}` };
          }
          console.error('[downloadFile] Server returned error:', err);
          addDebugLog('error', `download failed: ${res.status}`, { error: err }, true);
          throw new Error(err.error || `Download request failed (${res.status})`);
        }

        const total = parseInt(res.headers.get('content-length') || '0', 10);
        console.log('[downloadFile] Total bytes:', total);
        addDebugLog('download', `download started: ${total || 'unknown'} bytes expected`, { total }, true);
        setProgress({ loaded: 0, total });

        const reader = res.body.getReader();
        console.log('[downloadFile] Got reader, starting to read...');
        const chunks = [];
        let loaded = 0;
        let lastProgressLog = 0;
        let lastProgressLogTime = Date.now();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log('[downloadFile] Read complete');
            break;
          }
          chunks.push(value);
          loaded += value.length;
          setProgress({ loaded, total });

          
          if (total > 0) {
            const percent = Math.round((loaded / total) * 100);
            const now = Date.now();
            if (percent % 25 === 0 && percent > lastProgressLog && now - lastProgressLogTime > 500) {
              console.log(`[downloadFile] Progress: ${percent}%`);
              addDebugLog('download', `progress: ${percent}%`, { loaded, total });
              lastProgressLog = percent;
              lastProgressLogTime = now;
            }
          }
        }

        console.log('[downloadFile] Assembling', chunks.length, 'chunks');
        const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const suggestedName = `${title}.${format}`;

        // writes straight into the configured downloads folder on the
        // desktop app — no per-download "save as" prompt anymore (thank
        // god), that folder gets set once in settings instead. falls back
        // to the save dialog only if the direct write actually fails (e.g a
        // custom folder outside Downloads whose access grant didnt survive
        // an app restart) so a download never just silently goes nowhere
        if (await isTauriApp()) {
          try {
            const targetFolder = downloadsFolder || await getDefaultDownloadsDir();
            const savedPath = await saveFileToFolder(targetFolder, suggestedName, combined);
            addDebugLog('download', `file saved: ${savedPath}`, null, true);
            console.log('[downloadFile] Download complete! Saved to', savedPath);
            return;
          } catch (directSaveError) {
            console.warn('[downloadFile] direct save failed, falling back to save dialog:', directSaveError);
            addDebugLog('warn', `direct save failed, falling back to save dialog: ${directSaveError?.message}`, null, true);
            const savedPath = await saveFileWithDialog(suggestedName, combined);
            if (!savedPath) {
              console.log('[downloadFile] Save dialog cancelled by user');
              addDebugLog('download', 'save cancelled by user', null, true);
              return;
            }
            addDebugLog('download', `file saved: ${savedPath}`, null, true);
            console.log('[downloadFile] Download complete! Saved to', savedPath);
            return;
          }
        }

        const mime = format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : format === 'flac' ? 'audio/flac' : 'audio/mpeg';
        const blob = new Blob([combined], { type: mime });
        console.log('[downloadFile] Blob size:', blob.size);
        addDebugLog('download', `download complete: ${blob.size} bytes`, { blobSize: blob.size }, true);

        console.log('[downloadFile] Creating download link...');
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = suggestedName;
        document.body.appendChild(a);
        console.log('[downloadFile] Triggering download click...');
        a.click();
        console.log('[downloadFile] Removing download link...');
        a.remove();
        URL.revokeObjectURL(objectUrl);
        console.log('[downloadFile] Revoked object URL');

        addDebugLog('download', `file saved: ${suggestedName}`, null, true);
        console.log('[downloadFile] Download complete!');
        return;
      } catch (error) {
        console.error(`[downloadFile] Attempt ${attempt} failed:`, error);
        addDebugLog('error', `download attempt ${attempt} failed: ${error.message}`, {
          error: error.message,
          videoId,
          title
        }, true);
        if (signal?.aborted) {
          console.log('[downloadFile] Download was aborted');
          addDebugLog('download', 'download aborted by user', { videoId }, true);
          throw new Error('Download cancelled');
        }
        if (attempt > maxRetries) {
          console.error('[downloadFile] All attempts failed');
          addDebugLog('error', `download failed after ${maxRetries + 1} attempts`, { videoId }, true);
          throw error;
        }
        console.log(`[downloadFile] Retrying in ${1000 * attempt}ms...`);
        addDebugLog('download', `retrying in ${1000 * attempt}ms...`, { attempt }, true);
        await sleep(1000 * attempt);
      }
    }
  };

  
  const prefetchNextTrack = (index, trackList) => {
    const list = trackList || queue;
    const nextIndex = index + 1;
    if (!list || nextIndex >= list.length) return;

    const track = list[nextIndex];
    const prefetchAudio = prefetchAudioRef.current;
    if (!prefetchAudio) return;

    addDebugLog('playback', `prefetching next track: ${track.title || track.videoId}`, { index: nextIndex, videoId: track.videoId }, true);

    const streamPath = `/api/stream?videoId=${encodeURIComponent(track.videoId)}`;
    resolveMediaUrl(streamPath)
      .then((streamUrl) => {
        if (prefetchAudioRef.current !== prefetchAudio) return;
        prefetchAudio.src = streamUrl;
        prefetchAudio.load();
      })
      .catch((error) => {
        addDebugLog('warn', `prefetch skipped: ${error.message}`, { videoId: track.videoId }, true);
      });
  };


  const playSharedTrack = useCallback(async (trackOrId, options = {}) => {
    if (!currentChannelId) return;

    const trackId = typeof trackOrId === 'string' ? trackOrId : trackOrId?.id;
    const sharedIndex = channelQueue.findIndex((entry) => entry.id === trackId);
    if (sharedIndex < 0) {
      showNotification('shared track not found', 'warning');
      return;
    }

    const nextTrack = normalizeTrack(channelQueue[sharedIndex]);
    const nextTime = getSharedResumeTime({
      audioCurrentTime: undefined,
      requestedTime: options.currentTime,
      fallbackCurrentTime: 0
    });
    const audio = audioRef.current;
    const nextVolume = audio?.volume ?? channelPlayerState?.volume ?? volume;
    const isSameSharedTrack = playbackSourceRef.current === 'shared'
      && currentTrack?.videoId
      && currentTrack.videoId === nextTrack.videoId
      && audio?.src;

    if (isSameSharedTrack) {
      autoplayRef.current = options.autoplay !== false;
      if (audio && nextTime >= 0 && Math.abs((audio.currentTime || 0) - nextTime) > 0.1) {
        audio.currentTime = nextTime;
      }
      if (audio && options.autoplay !== false) {
        audio.play().catch(() => {});
        setIsPlaying(true);
      }
    } else {
      playTrackAtIndex(sharedIndex, channelQueue, {
        source: 'shared',
        autoplay: options.autoplay !== false,
        notify: false,
        startTime: nextTime
      });
    }

    await updateCurrentChannelPlayer({
      current_track_id: nextTrack.id,
      is_playing: options.isPlaying !== false,
      current_time: nextTime,
      volume: nextVolume
    });
  }, [channelPlayerState, channelQueue, currentChannelId, currentTrack, playTrackAtIndex, showNotification, updateCurrentChannelPlayer, volume]);

  const pauseSharedPlayback = useCallback(async (resetTime = false) => {
    if (!currentChannelId || !channelPlayerState?.current_track_id) return;

    const audio = audioRef.current;
    autoplayRef.current = false;

    // grab the current time BEFORE pausing so we have the right position
    const capturedTime = getSharedResumeTime({
      audioCurrentTime: audio && audio.readyState >= 2 ? audio.currentTime : undefined,
      requestedTime: channelPlayerState.current_time,
      fallbackCurrentTime: channelPlayerState.current_time || 0
    });

    if (audio) {
      if (resetTime) {
        audio.currentTime = 0;
      }
      audio.pause();
    }

    setIsPlaying(false);

    await updateCurrentChannelPlayer({
      current_track_id: channelPlayerState.current_track_id,
      is_playing: false,
      current_time: resetTime ? 0 : capturedTime,
      volume: audio?.volume ?? channelPlayerState.volume ?? volume
    });
  }, [channelPlayerState, currentChannelId, updateCurrentChannelPlayer, volume]);

  const stepSharedPlayback = useCallback(async (direction) => {
    if (!currentChannelId || !channelQueue.length) return;

    const currentIndex = channelQueue.findIndex((track) => track.id === channelPlayerState?.current_track_id);
    let nextIndex = currentIndex >= 0 ? currentIndex + direction : 0;

    if (nextIndex < 0) {
      nextIndex = channelQueue.length - 1;
    }

    if (nextIndex >= channelQueue.length) {
      nextIndex = 0;
    }

    await playSharedTrack(channelQueue[nextIndex], {
      autoplay: true,
      isPlaying: true,
      currentTime: 0
    });
  }, [channelPlayerState, channelQueue, currentChannelId, playSharedTrack]);

  const toggleSharedPlayback = useCallback(async () => {
    if (!currentChannelId) return;

    const targetTrack = channelQueue.find((track) => track.id === channelPlayerState?.current_track_id)
      || channelQueue[0]
      || null;

    if (!targetTrack) {
      showNotification('add a track to the shared queue first', 'warning');
      return;
    }

    if (channelPlayerState?.is_playing) {
      await pauseSharedPlayback(false);
      return;
    }

    const normalizedTargetTrack = normalizeTrack(targetTrack);
    const canUseLocalSharedTime = playbackSourceRef.current === 'shared'
      && currentTrack?.videoId
      && currentTrack.videoId === normalizedTargetTrack.videoId
      && audioRef.current?.src;
    const requestedResumeTime = getSharedResumeTime({
      audioCurrentTime: canUseLocalSharedTime && audioRef.current?.readyState >= 2 ? audioRef.current.currentTime : undefined,
      requestedTime: channelPlayerState?.current_time,
      fallbackCurrentTime: 0,
      allowAudioOverride: canUseLocalSharedTime
    });

    addDebugLog('playback', 'shared resume requested', {
      playbackSource: playbackSourceRef.current,
      currentVideoId: currentTrack?.videoId || null,
      targetVideoId: normalizedTargetTrack.videoId,
      audioCurrentTime: audioRef.current?.currentTime,
      requestedTime: channelPlayerState?.current_time,
      allowAudioOverride: canUseLocalSharedTime,
      chosenTime: requestedResumeTime
    }, true);

    await playSharedTrack(targetTrack, {
      autoplay: true,
      isPlaying: true,
      currentTime: requestedResumeTime
    });
  }, [addDebugLog, channelPlayerState, channelQueue, currentChannelId, currentTrack, pauseSharedPlayback, playSharedTrack, showNotification]);

  // === shared player sync — kicks in once the client's switched to shared playback ===
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // while still in personal mode, keep the shared revision and
    // pause/play history warm so an automatic handoff into shared playback
    // can resume cleanly
    if (playbackSourceRef.current !== 'shared') {
      prevSharedPlayingRef.current = Boolean(channelPlayerState?.is_playing);
      // still update the revision so when the user switches back to shared were in sync
      if (channelPlayerState?.current_track_id) {
        lastSharedRevisionRef.current = String(channelPlayerState.revision || [
          currentChannelId,
          channelPlayerState.current_track_id,
          channelPlayerState.is_playing ? 1 : 0,
          Number(channelPlayerState.current_time || 0).toFixed(3),
          Number(channelPlayerState.volume ?? 1).toFixed(3),
          Number(channelPlayerState.sync_updated_at_ms || 0)
        ].join(':'));
      }
      return;
    }

    if (!currentChannelId || !channelPlayerState?.current_track_id) {
      lastSharedRevisionRef.current = '';
      autoplayRef.current = false;
      audio.pause();
      setIsPlaying(false);
      setPlaybackSource('personal');
      playbackSourceRef.current = 'personal';
      playbackQueueRef.current = queue;
      return;
    }

    const nextIndex = channelQueue.findIndex((track) => track.id === channelPlayerState.current_track_id);
    if (nextIndex < 0) return;

    const nextTrack = normalizeTrack(channelQueue[nextIndex]);
    const currentVideoId = currentTrack?.videoId || '';
    // in shared mode, only load a new track if the track id actually
    // changed and were not mid-way through handling a stream error
    const trackIdChanged = currentVideoId !== nextTrack.videoId;
    const hasLoadedSource = Boolean(audio.currentSrc || audio.getAttribute('src'));
    const requestedSharedTrackId = String(audio.dataset.requestedSharedTrackId || '');
    const isSharedTrackAlreadyRequested = requestedSharedTrackId !== '' && requestedSharedTrackId === String(channelPlayerState.current_track_id || '');
    const isLoadingOrError = audio._streamRetryCount > 0 || (hasLoadedSource && audio.readyState === 0);
    const shouldLoadTrack = (trackIdChanged || !hasLoadedSource)
      && !isSharedTrackAlreadyRequested
      && !isLoadingOrError
      && !localStreamErrorRef.current;
    const nextRevision = String(channelPlayerState.revision || [
      currentChannelId,
      channelPlayerState.current_track_id,
      channelPlayerState.is_playing ? 1 : 0,
      Number(channelPlayerState.current_time || 0).toFixed(3),
      Number(channelPlayerState.volume ?? 1).toFixed(3),
      Number(channelPlayerState.sync_updated_at_ms || 0)
    ].join(':'));
    const isFreshSharedUpdate = lastSharedRevisionRef.current !== nextRevision;

    audio.volume = isMuted ? 0 : (channelPlayerState.volume ?? volume);

    if (shouldLoadTrack) {
      playTrackAtIndex(nextIndex, channelQueue, {
        source: 'shared',
        autoplay: channelPlayerState.is_playing,
        notify: false,
        startTime: channelPlayerState.current_time || 0
      });
      lastSharedRevisionRef.current = nextRevision;
      return;
    }

    const wasPlaying = prevSharedPlayingRef.current;
    const isNowPlaying = channelPlayerState.is_playing;
    const isResumeTransition = !wasPlaying && isNowPlaying;

    if (
      isFreshSharedUpdate
      && typeof channelPlayerState.current_time === 'number'
      && Number.isFinite(channelPlayerState.current_time)
    ) {
      const drift = Math.abs((audio.currentTime || 0) - channelPlayerState.current_time);
      // on resume transitions, always sync time (very low threshold)
      // on normal playing state updates, only sync if drift is significant
      const driftThreshold = isResumeTransition ? 0.05 : (isNowPlaying ? 0.4 : 0.1);
      if (drift > driftThreshold) {
        addDebugLog('playback', `shared player time sync (drift: ${drift.toFixed(2)}s, threshold: ${driftThreshold}, resume: ${isResumeTransition})`, {
          audioTime: audio.currentTime,
          serverTime: channelPlayerState.current_time,
          drift,
          isResumeTransition
        }, true);
        audio.currentTime = channelPlayerState.current_time;
      }
    }

    if (isNowPlaying) {
      autoplayRef.current = true;
      // on resume transitions, explicitly seek to the correct position before playing
      if (isResumeTransition && typeof channelPlayerState.current_time === 'number' && Number.isFinite(channelPlayerState.current_time)) {
        audio.currentTime = channelPlayerState.current_time;
      }
      if (audio.paused) {
        audio.play().catch(() => {});
      }
      setIsPlaying(true);
    } else {
      autoplayRef.current = false;
      if (!audio.paused) {
        audio.pause();
      }
      setIsPlaying(false);
    }

    prevSharedPlayingRef.current = isNowPlaying;
    lastSharedRevisionRef.current = nextRevision;
  }, [channelPlayerState, channelQueue, currentChannelId, currentTrack, isMuted, playTrackAtIndex, playbackSource, queue, volume]);

  const handleNext = useCallback(() => {
    const currentIndex = playIndexRef.current;
    const activeList = playbackSourceRef.current === 'shared' ? channelQueue : queue;
    logClient('handleNext', { currentIndex, queueLength: activeList.length, playNextQueueLength: playNextQueue.length });

    if (playbackSourceRef.current === 'shared' && currentChannelId) {
      if (!activeList.length) return;

      let nextIndex = currentIndex + 1;
      if (nextIndex >= activeList.length) {
        nextIndex = 0;
      }

      const nextTrack = activeList[nextIndex];
      if (!nextTrack) return;

      updateCurrentChannelPlayer({
        current_track_id: nextTrack.id,
        is_playing: true,
        current_time: 0,
        volume: channelPlayerState?.volume ?? volume
      });
      return;
    }

    
    if (playNextQueue.length > 0) {
      const nextTrack = playNextQueue[0];
      const remainingQueue = playNextQueue.slice(1);
      setPlayNextQueue(remainingQueue);

      
      const currentList = queue;
      const insertIndex = currentIndex + 1;

      
      const tempQueue = [...currentList.slice(0, insertIndex), nextTrack, ...currentList.slice(insertIndex)];
      playTrackAtIndex(insertIndex, tempQueue, { source: 'personal' });
      return;
    }

    if (!activeList.length) return;

    const list = activeList;
    let nextIndex = currentIndex + 1;

    if (shuffle) {
      nextIndex = Math.floor(Math.random() * list.length);
    } else {
      if (nextIndex >= list.length) {
        if (repeatMode === 'all') {
          nextIndex = 0;
        } else {
          setIsPlaying(false);
          return;
        }
      }
    }
    playTrackAtIndex(nextIndex, list, { source: 'personal' });
  }, [channelPlayerState, channelQueue, currentChannelId, playNextQueue, playTrackAtIndex, queue, repeatMode, shuffle, updateCurrentChannelPlayer, volume]);

  
  useEffect(() => {
    handleNextRef.current = handleNext;
  }, [handleNext]);

  const stopPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setIsPlaying(false);
    setTrackProgress({ current: 0, duration: 0 });
    showNotification('playback stopped', 'info');
  };

  const handlePrevious = useCallback(() => {
    const audio = audioRef.current;
    logClient('handlePrevious', { currentIndex: playIndexRef.current });

    if (audio && !audio.ended && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }

    const list = playbackSourceRef.current === 'shared' ? channelQueue : queue;
    if (!list.length) return;

    const currentIndex = playIndexRef.current;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : list.length - 1;
    if (playbackSourceRef.current === 'shared' && currentChannelId) {
      const previousTrack = list[prevIndex];
      if (!previousTrack) return;

      updateCurrentChannelPlayer({
        current_track_id: previousTrack.id,
        is_playing: true,
        current_time: 0,
        volume: channelPlayerState?.volume ?? volume
      });
      return;
    }

    playTrackAtIndex(prevIndex, list, { source: 'personal' });
  }, [channelPlayerState, channelQueue, currentChannelId, playTrackAtIndex, queue, updateCurrentChannelPlayer, volume]);

  const togglePlayPause = () => {
    const audio = audioRef.current;
    logClient('togglePlayPause', { isPlaying, playIndex: playIndexRef.current });
    addDebugLog('playback', `toggle play/pause - was ${isPlaying ? 'playing' : 'paused'}`);

    if (!audio) return;

    if (playbackSourceRef.current === 'shared' && currentChannelId && channelPlayerState?.current_track_id) {
      autoplayRef.current = !channelPlayerState.is_playing;
      const currentTime = getSharedResumeTime({
        audioCurrentTime: audio.readyState >= 2 ? audio.currentTime : undefined,
        requestedTime: channelPlayerState.current_time,
        fallbackCurrentTime: channelPlayerState.current_time || 0
      });
      updateCurrentChannelPlayer({
        current_track_id: channelPlayerState.current_track_id,
        is_playing: !channelPlayerState.is_playing,
        current_time: currentTime,
        volume: audio.volume ?? channelPlayerState.volume ?? volume
      });
      return;
    }

    if (isPlaying) {
      autoplayRef.current = false;
      // save personal player state before pausing
      if (audio.src && Number.isFinite(audio.currentTime)) {
        personalPlayerStateRef.current = {
          videoId: currentTrack?.videoId || null,
          currentTime: audio.currentTime,
          duration: audio.duration || 0
        };
      }
      audio.pause();
      setIsPlaying(false);
      showNotification('paused', 'info');
    } else {
      if (!audio.src) {
        autoplayRef.current = true;
        const startIndex = playIndex >= 0 ? playIndex : 0;
        const list = currentTracks.length > 0 ? currentTracks : queue;
        playTrackAtIndex(startIndex, list, { source: 'personal' });
      } else {
        // restore saved position for personal mode
        const saved = personalPlayerStateRef.current;
        if (audio.ended) {
          audio.currentTime = 0;
        }
        if (saved.currentTime > 0 && Number.isFinite(saved.currentTime) && saved.currentTime < (audio.duration || Infinity)) {
          audio.currentTime = saved.currentTime;
        }
        autoplayRef.current = true;
        audio.play().catch((err) => {
          console.warn('Audio play blocked:', err?.message || err);
        });
        setIsPlaying(true);
        showNotification('playing', 'info');
      }
    }
  };

  // media session — lock-screen/notification playback controls and metadata,
  // needed for background/behind-lock-screen playback on mobile (PWA) and desktop
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    if (!currentTrack) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: currentTrack.title || 'unknown track',
      artist: currentTrack.author || '',
      artwork: currentTrack.thumbnail
        ? [96, 256, 512].map((size) => ({ src: currentTrack.thumbnail, sizes: `${size}x${size}`, type: 'image/jpeg' }))
        : []
    });
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [currentTrack, isPlaying]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevious());
    navigator.mediaSession.setActionHandler('nexttrack', () => handleNext());
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        const audio = audioRef.current;
        if (!audio || !Number.isFinite(details.seekTime)) return;
        audio.currentTime = details.seekTime;
        setTrackProgress((prev) => ({ ...prev, current: details.seekTime }));
      });
    } catch {
      // seekto not supported in this browser
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('seekto', null);
      } catch {
        // ignore
      }
    };
  }, [togglePlayPause, handleNext, handlePrevious]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!trackProgress.duration || !Number.isFinite(trackProgress.duration)) return;

    try {
      navigator.mediaSession.setPositionState({
        duration: trackProgress.duration,
        position: Math.min(trackProgress.current, trackProgress.duration),
        playbackRate: audioRef.current?.playbackRate || 1
      });
    } catch {
      // throws if position briefly exceeds duration mid track-change; harmless
    }
  }, [trackProgress.current, trackProgress.duration]);

  // tauri miniplayer bridge — no-ops entirely outside tauri (browser/pwa),
  // see src/tauriApi.js
  const [isTauriDesktop, setIsTauriDesktop] = useState(false);
  useEffect(() => {
    isTauriApp().then((v) => {
      frontendLog('main', `isTauriApp() resolved: ${v}`);
      setIsTauriDesktop(v);
    });
  }, []);

  // desktop shortcut / taskbar pin are a windows-only concept (see
  // apply_shortcut_prefs in src-tauri/src/lib.rs, its a no-op everywhere
  // else) — mac installs by dragging into /Applications and pins to the
  // dock by hand, theres no matching checkbox to show there. cheap ua
  // sniff instead of pulling in @tauri-apps/plugin-os for one boolean
  const isWindowsDesktop = useMemo(() => /win/i.test(navigator.userAgent || navigator.platform || ''), []);

  // where downloads land — no more per-download "save as" dialog (finally).
  // defaults to the os Downloads folder + a subfolder the first time this
  // runs on the desktop app, so theres always somewhere sensible to write
  // to without ever showing a dialog; settings page lets you point it
  // anywhere else
  const [downloadsFolder, setDownloadsFolder] = useState(() => {
    try {
      return localStorage.getItem('music_downloads_folder') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!isTauriDesktop || downloadsFolder) return;
    getDefaultDownloadsDir().then((dir) => {
      if (!dir) return;
      setDownloadsFolder(dir);
      try {
        localStorage.setItem('music_downloads_folder', dir);
      } catch {}
    });
  }, [isTauriDesktop, downloadsFolder]);

  const handleChangeDownloadsFolder = useCallback(async () => {
    const picked = await chooseDownloadsFolder(downloadsFolder);
    if (!picked) return;
    setDownloadsFolder(picked);
    try {
      localStorage.setItem('music_downloads_folder', picked);
    } catch {}
    showNotification('downloads folder updated', 'success');
  }, [downloadsFolder, showNotification]);

  // mirrored into refs so buildNowPlayingPayload can read the latest values
  // without needing to be recreated (and without needing the
  // miniplayer-ready listener below to be torn down and rebuilt) every time
  // any of them changes — trackProgress.current alone ticks several times a
  // sec during playback. the ready-listener used to live inside the same
  // effect as these values, so it was getting unsubscribed and resubscribed
  // constantly during playback, and — worse — could simply not exist yet at
  // the EXACT moment the miniplayer's very first "ready" announcement
  // arrived (most likely right after a fresh install, when both windows are
  // cold-starting webview2 for the first time and timing is least
  // predictable). took forever to figure out why it kept opening blank on
  // first launch. that's what left it stuck on "nothing playing" and the
  // default color despite a track actually being loaded — pausing meant
  // nothing was left ticking to ever naturally retrigger a resend and fix it
  const currentTrackRef = useRef(currentTrack);
  const isPlayingRef = useRef(isPlaying);
  const trackProgressRef = useRef(trackProgress);
  const themeColorRef = useRef(themeColor);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { trackProgressRef.current = trackProgress; }, [trackProgress]);
  useEffect(() => { themeColorRef.current = themeColor; }, [themeColor]);

  const buildNowPlayingPayload = useCallback(() => {
    const track = currentTrackRef.current;
    return track
      ? {
          title: track.title || '',
          author: track.author || '',
          thumbnail: getTrackThumbnail(track),
          videoId: track.videoId || '',
          isPlaying: isPlayingRef.current,
          currentTime: trackProgressRef.current.current,
          duration: trackProgressRef.current.duration,
          themeColor: themeColorRef.current
        }
      : { themeColor: themeColorRef.current };
  }, []);

  useEffect(() => {
    sendNowPlaying(buildNowPlayingPayload());
  }, [currentTrack, isPlaying, trackProgress.current, trackProgress.duration, themeColor, buildNowPlayingPayload]);

  // registered once and never torn down — the miniplayer can open at any
  // moment (auto-shows on blur/minimize), independent of any state above
  // changing, and needs to resend the current snapshot the instant it
  // announces itself instead of leaving it on the placeholder until the
  // next incidental update (which, if paused, might never come at all)
  useEffect(() => {
    return onMiniplayerReady(() => sendNowPlaying(buildNowPlayingPayload()));
  }, [buildNowPlayingPayload]);

  useEffect(() => {
    return onMiniplayerControl((action) => {
      if (action === 'toggle') togglePlayPause();
      else if (action === 'next') handleNext();
      else if (action === 'previous') handlePrevious();
      else if (action && typeof action === 'object' && action.type === 'seek') {
        const audio = audioRef.current;
        if (!audio || !audio.duration) return;
        const newTime = Math.max(0, Math.min(1, action.percent)) * audio.duration;
        audio._stallCount = 0;
        audio._streamRetryCount = 0;
        audio.currentTime = newTime;
        setTrackProgress({ current: newTime, duration: audio.duration || 0 });
      }
    });
  }, [togglePlayPause, handleNext, handlePrevious]);

  // resolving a track's direct stream url is what actually makes clicking
  // play feel slow (youtube-side extraction, not something payload tweaking
  // fixes) — since listening is normally sequential through a queue, warm
  // that resolve for whatevers coming up next while the current track is
  // still playing, so by the time playback actually gets there its already
  // cached server-side instead of resolving cold. skipped under shuffle
  // (genuinely unpredictable — picked at random when next fires) and
  // shared-channel playback (server dictates the queue, not us)
  useEffect(() => {
    if (!currentTrack || shuffle || currentChannelId) return;
    const upcoming = playNextQueue.length > 0
      ? playNextQueue[0]
      : (playIndex + 1 < queue.length ? queue[playIndex + 1] : (repeatMode === 'all' ? queue[0] : null));
    if (!upcoming?.videoId || upcoming.videoId === currentTrack.videoId) return;
    resolveMediaUrl(`/api/prefetch?videoId=${encodeURIComponent(upcoming.videoId)}`)
      .then((url) => fetch(url))
      .catch(() => {
        // best-effort — /api/stream just resolves cold when actually played
      });
  }, [currentTrack, queue, playIndex, shuffle, currentChannelId, playNextQueue, repeatMode]);

  const stopAndResetPlayback = () => {
    logClient('stopAndResetPlayback', { playIndex: playIndexRef.current });
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    setIsPlaying(false);
    setIsBuffering(false);
    setPlaybackSource('personal');
    playbackSourceRef.current = 'personal';
    playbackQueueRef.current = queue;
    autoplayRef.current = false;
    setTrackProgress({ current: 0, duration: 0 });
    setPlayIndex(-1);
    setCurrentIndex(-1);
    setCurrentTrack(null);
    playIndexRef.current = -1;
    setPlayNextQueue([]);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    addDebugLog('playback', `toggle mute - will be ${!isMuted ? 'muted' : 'unmuted'}`);
    if (audio) {
      audio.muted = !isMuted;
      setIsMuted(!isMuted);
      showNotification(isMuted ? 'unmuted' : 'muted', 'info');
    }
  };

  const setPlayVolume = (value) => {
    addDebugLog('playback', `volume changed to ${Math.round(value * 100)}%`);
    setVolume(value);
    const audio = audioRef.current;
    if (audio) audio.volume = value;
    if (value > 0 && isMuted) setIsMuted(false);
    if (playbackSourceRef.current === 'shared' && currentChannelId && channelPlayerState?.current_track_id) {
      const sharedTime = getSharedResumeTime({
        audioCurrentTime: audio && audio.readyState >= 2 ? audio.currentTime : undefined,
        requestedTime: channelPlayerState.current_time,
        fallbackCurrentTime: channelPlayerState.current_time || 0
      });
      updateCurrentChannelPlayer({
        current_track_id: channelPlayerState.current_track_id,
        is_playing: !audio?.paused,
        current_time: sharedTime,
        volume: value
      });
    }
  };

  const seekToClientX = (clickX, container) => {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;

    const relativeX = clickX - rect.left;
    const percent = Math.max(0, Math.min(1, relativeX / rect.width));
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;

    const newTime = percent * audio.duration;
    console.log('[SEEK] Seeking track', { newTime, percent, duration: audio.duration });

    audio._stallCount = 0;
    audio._streamRetryCount = 0;
    audio.currentTime = newTime;
    setTrackProgress({ current: newTime, duration: audio.duration || 0 });

    if (playbackSourceRef.current !== 'shared') {
      // keep the solo resume spot in sync with the slider
      personalPlayerStateRef.current = {
        videoId: currentTrack?.videoId || null,
        currentTime: newTime,
        duration: audio.duration || 0
      };
    }
  };

  const getCurrentTrack = useCallback(() => {
    return currentTrack;
  }, [currentTrack]);

  const addCurrentToQueue = () => {
    const currentTrack = getCurrentTrack();
    if (!currentTrack) {
      showNotification('no track playing', 'warning');
      return;
    }
    setQueue((prev) => [...prev, currentTrack]);
    showNotification('added to queue', 'info');
    logClient('addCurrentToQueue', { videoId: currentTrack.videoId, title: currentTrack.title });
  };

  const addAllToPlaylist = (playlistId = currentPlaylistId) => {
    if (!queue.length) {
      showNotification('queue is empty', 'warning');
      return;
    }
    const playlist = activePlaylists.find((item) => item.id === playlistId);
    if (!playlist) {
      // used to fall through to here silently and still report "success"
      // with an undefined name lol — no playlist selected/created yet is a
      // real, common case (e.g. a fresh install), not something to paper
      // over with a false-positive toast
      showNotification('pick or create a playlist first', 'warning');
      return;
    }

    addDebugLog('playlist', `add all to "${playlist.name}": ${queue.length} tracks`);
    setPlaylists(playlists.map((p) =>
      p.id === playlistId
        ? { ...p, tracks: [...p.tracks, ...queue.map((track) => ({ ...normalizeTrack(track), addedAt: Date.now() }))] }
        : p
    ));
    showNotification(`added ${queue.length} tracks to "${playlist.name}"`, 'success');
  };

  const loadPlaylistToQueue = () => {
    if (!currentTracks.length) {
      showNotification('playlist is empty', 'warning');
      return;
    }
    const playlist = activePlaylists.find((item) => item.id === currentPlaylistId);
    addDebugLog('playlist', `load "${playlist?.name}" to queue: ${currentTracks.length} tracks`);
    stopAndResetPlayback();
    setQueue(currentTracks.map((track) => normalizeTrack(track)));
    showNotification(`loaded "${playlist?.name}" to queue`, 'success');
  };

  const cycleRepeatMode = () => {
    const modes = Object.keys(REPEAT_MODES);
    const currentIndex = modes.indexOf(repeatMode);
    const nextMode = modes[(currentIndex + 1) % modes.length];
    addDebugLog('playback', `cycle repeat mode: ${repeatMode} -> ${nextMode}`);
    setRepeatMode(nextMode);
    showNotification(`repeat: ${REPEAT_MODES[nextMode].label}`, 'info');
  };

  
  const createPlaylist = async () => {
    if (!newPlaylistName.trim()) return;

    const newPlaylist = {
      id: generateId(),
      name: newPlaylistName.trim().toLowerCase(),
      tracks: []
    };
    setPlaylists([...playlists, newPlaylist]);
    setCurrentPlaylistId(newPlaylist.id);
    setNewPlaylistName('');
    setShowPlaylistModal(false);
    showNotification(`playlist "${newPlaylist.name}" created`, 'success');
  };

  const deletePlaylist = async (id) => {
    if (playlists.length <= 1) {
      showNotification('cannot delete the last playlist', 'error');
      return;
    }
    const newPlaylists = playlists.filter((p) => p.id !== id);
    setPlaylists(newPlaylists);
    if (currentPlaylistId === id) {
      setCurrentPlaylistId(newPlaylists[0].id);
    }
    showNotification('playlist deleted', 'success');
  };

  const renamePlaylist = async (id, newName) => {
    setPlaylists(playlists.map((p) =>
      p.id === id ? { ...p, name: newName } : p
    ));
    showNotification('playlist renamed', 'success');
  };

  const addTrackToPlaylist = async (track, playlistId = currentPlaylistId) => {
    const playlist = activePlaylists.find((item) => item.id === playlistId);
    const normalizedTrack = normalizeTrack(track);

    addDebugLog('playlist', `add to "${playlist?.name}": ${track.title || track.videoId}`);
    setPlaylists(playlists.map((p) =>
      p.id === playlistId
        ? { ...p, tracks: [...p.tracks, { ...normalizedTrack, addedAt: Date.now() }] }
        : p
    ));
    showNotification(`added to "${playlist?.name}"`, 'success');
  };

  const removeTrackFromPlaylist = async (index) => {
    const track = currentTracks[index];

    addDebugLog('playlist', `remove from "${currentPlaylistId}": ${track?.title || index}`);
    setPlaylists(playlists.map((p) =>
      p.id === currentPlaylistId
        ? { ...p, tracks: p.tracks.filter((_, i) => i !== index) }
        : p
    ));
    showNotification('track removed from playlist', 'info');
  };

  const clearPlaylist = async () => {
    const playlist = activePlaylists.find((item) => item.id === currentPlaylistId);

    addDebugLog('playlist', `clear "${playlist?.name}" (${currentTracks.length} tracks)`);
    setPlaylists(playlists.map((p) =>
      p.id === currentPlaylistId ? { ...p, tracks: [] } : p
    ));
    showNotification('playlist cleared', 'info');
  };

  
  const handleDragStart = (e, index) => {
    setDraggedTrack(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedTrack === null || draggedTrack === dropIndex) return;

    const newTracks = [...currentTracks];
    const [draggedItem] = newTracks.splice(draggedTrack, 1);
    newTracks.splice(dropIndex, 0, draggedItem);

    setPlaylists(playlists.map((p) =>
      p.id === currentPlaylistId ? { ...p, tracks: newTracks } : p
    ));
    setDraggedTrack(null);
    showNotification('track reordered', 'success');
  };

  // collab playlist functions (uses unified playlists state with type field)
  const currentCollabPlaylist = playlists.find((p) => p.id === currentCollabPlaylistId) || playlists.find((p) => p.type === 'collab');
  const currentCollabTracks = currentCollabPlaylist?.tracks || [];
  const canEditCollabPlaylist = (playlist) => {
    if (!playlist || playlist.type !== 'collab') return false;
    // check if current user is a member of the current channel
    if (!currentChannelMembers || !currentChannelMembers.length) return false;
    return currentChannelMembers.some((m) => m.user_id === currentUserId);
  };

  const createCollabPlaylist = async () => {
    if (!newCollabPlaylistName.trim() || !currentChannel) return;
    const memberIds = currentChannelMembers.map((m) => m.user_id);
    const newPlaylist = {
      id: generateId(),
      name: newCollabPlaylistName.trim().toLowerCase(),
      tracks: [],
      type: 'collab',
      allowedMemberIds: memberIds,
      createdBy: currentUserId,
      createdAt: Date.now()
    };
    try {
      await fetchJson(`/api/servers/${currentChannelId}/collab-playlists`, {
        method: 'POST',
        body: JSON.stringify({ id: newPlaylist.id, name: newPlaylist.name, createdBy: currentUserId })
      });
    } catch (err) {
      showNotification('failed to save collab playlist to server', 'error');
      console.error('Collab playlist create error:', err);
    }
    setPlaylists((prev) => [...prev, newPlaylist]);
    setCurrentCollabPlaylistId(newPlaylist.id);
    setNewCollabPlaylistName('');
    setShowCollabPlaylistModal(false);
    showNotification(`collab playlist "${newPlaylist.name}" created`, 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_created',
        serverId: currentChannelId,
        playlist: newPlaylist
      }));
    } catch {}
  };

  const deleteCollabPlaylist = async (id) => {
    const collabPlaylists = playlists.filter((p) => p.type === 'collab');
    if (collabPlaylists.length <= 1) {
      showNotification('cannot delete the last collab playlist', 'error');
      return;
    }
    try {
      await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${id}`, {
        method: 'DELETE'
      });
    } catch (err) {
      showNotification('failed to delete collab playlist from server', 'error');
      console.error('Collab playlist delete error:', err);
    }
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    if (currentCollabPlaylistId === id) {
      const remaining = playlists.filter((p) => p.type === 'collab' && p.id !== id);
      setCurrentCollabPlaylistId(remaining[0]?.id || '');
    }
    showNotification('collab playlist deleted', 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_deleted',
        serverId: currentChannelId,
        playlistId: id
      }));
    } catch {}
  };

  const renameCollabPlaylist = async (id, newName) => {
    setPlaylists((prev) => prev.map((p) =>
      p.id === id ? { ...p, name: newName } : p
    ));
    try {
      await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: newName })
      });
    } catch (err) {
      showNotification('failed to rename collab playlist on server', 'error');
      console.error('Collab playlist rename error:', err);
    }
    showNotification('collab playlist renamed', 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_renamed',
        serverId: currentChannelId,
        playlistId: id,
        name: newName
      }));
    } catch {}
  };

  const addTrackToCollabPlaylist = async (track, playlistId = currentCollabPlaylistId) => {
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!canEditCollabPlaylist(playlist)) {
      showNotification('you cannot edit this playlist', 'warning');
      return;
    }
    const normalizedTrack = normalizeTrack(track);
    try {
      const result = await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${playlistId}/tracks`, {
        method: 'POST',
        body: JSON.stringify(normalizedTrack)
      });
      const savedTrack = result.track;
      setPlaylists((prev) => prev.map((p) =>
        p.id === playlistId
          ? { ...p, tracks: [...p.tracks, { ...savedTrack, addedAt: Date.now() }] }
          : p
      ));
    } catch (err) {
      showNotification('failed to save track to collab playlist on server', 'error');
      console.error('Collab playlist add track error:', err);
      return;
    }
    showNotification(`added to "${playlist?.name}"`, 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_track_added',
        serverId: currentChannelId,
        playlistId,
        track: normalizedTrack
      }));
    } catch {}
  };

  const removeTrackFromCollabPlaylist = async (index, playlistId = currentCollabPlaylistId) => {
    const playlist = playlists.find((p) => p.id === playlistId);
    if (!canEditCollabPlaylist(playlist)) {
      showNotification('you cannot edit this playlist', 'warning');
      return;
    }
    const trackId = playlist.tracks[index]?.id;
    setPlaylists((prev) => prev.map((p) =>
      p.id === playlistId
        ? { ...p, tracks: p.tracks.filter((_, i) => i !== index) }
        : p
    ));
    try {
      if (trackId) {
        await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${playlistId}/tracks/${trackId}`, {
          method: 'DELETE'
        });
      }
    } catch (err) {
      showNotification('failed to remove track from collab playlist on server', 'error');
      console.error('Collab playlist remove track error:', err);
    }
    showNotification('track removed', 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_track_removed',
        serverId: currentChannelId,
        playlistId,
        trackIndex: index
      }));
    } catch {}
  };

  const clearCollabPlaylist = async () => {
    const playlist = playlists.find((p) => p.id === currentCollabPlaylistId);
    if (!canEditCollabPlaylist(playlist)) {
      showNotification('you cannot edit this playlist', 'warning');
      return;
    }
    setPlaylists((prev) => prev.map((p) =>
      p.id === currentCollabPlaylistId ? { ...p, tracks: [] } : p
    ));
    try {
      await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${currentCollabPlaylistId}/tracks`, {
        method: 'DELETE'
      });
    } catch (err) {
      showNotification('failed to clear collab playlist on server', 'error');
      console.error('Collab playlist clear error:', err);
    }
    showNotification('collab playlist cleared', 'info');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_cleared',
        serverId: currentChannelId,
        playlistId: currentCollabPlaylistId
      }));
    } catch {}
  };

  const loadCollabPlaylistToQueue = () => {
    if (!currentCollabTracks.length) {
      showNotification('collab playlist is empty', 'warning');
      return;
    }
    const playlist = playlists.find((p) => p.id === currentCollabPlaylistId);
    addDebugLog('collab_playlist', `load "${playlist?.name}" to shared queue: ${currentCollabTracks.length} tracks`);
    setChannelQueue((prev) => [...prev, ...currentCollabTracks.map((t) => normalizeTrack(t))]);
    showNotification(`loaded "${playlist?.name}" to shared queue`, 'success');
  };

  const handleCollabPlaylistDragStart = (e, index) => {
    setDraggedTrack(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleCollabPlaylistDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedTrack === null || draggedTrack === dropIndex) return;
    const playlist = playlists.find((p) => p.id === currentCollabPlaylistId);
    if (!canEditCollabPlaylist(playlist)) {
      showNotification('you cannot edit this playlist', 'warning');
      setDraggedTrack(null);
      return;
    }
    const newTracks = [...currentCollabTracks];
    const [draggedItem] = newTracks.splice(draggedTrack, 1);
    newTracks.splice(dropIndex, 0, draggedItem);
    setPlaylists((prev) => prev.map((p) =>
      p.id === currentCollabPlaylistId ? { ...p, tracks: newTracks } : p
    ));
    setDraggedTrack(null);
    showNotification('track reordered', 'success');
    try {
      wsRef.current?.send(JSON.stringify({
        type: 'collab_playlist_reordered',
        serverId: currentChannelId,
        playlistId: currentCollabPlaylistId,
        tracks: newTracks
      }));
    } catch {}
  };


  const addToPlayNext = (track) => {
    setPlayNextQueue([...playNextQueue, track]);
    showNotification(`"${track.title}" will play next`, 'info');
  };

  
  const cancelDownload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    queueRunningRef.current = false;
    setIsDownloading(false);
    setIsQueueRunning(false);
    setCurrentIndex(-1);
    showNotification('download cancelled', 'warning');
  };

  const removeFromQueue = (index) => {
    logClient('removeFromQueue', { index, currentPlayIndex: playIndexRef.current });
    const removingCurrentTrack = playbackSourceRef.current !== 'shared'
      && index === playIndexRef.current
      && (isPlaying || (audioRef.current && !audioRef.current.paused));

    setQueue((prev) => {
      const next = [...prev];
      next.splice(index, 1);

      if (!next.length) {
        stopAndResetPlayback();
        return [];
      }

      if (removingCurrentTrack) {
        return next;
      }

      setPlayIndex((current) => {
        if (index < current) return Math.max(0, current - 1);
        if (index === current) return Math.min(current, next.length - 1);
        return current;
      });

      return next;
    });

    if (removingCurrentTrack) {
      stopAndResetPlayback();
      showNotification('current track removed from queue', 'info');
      return;
    }

    showNotification('removed from queue', 'info');
  };

  const clearQueue = () => {
    setQueue([]);
    stopAndResetPlayback();
    showNotification('queue cleared', 'info');
  };

  const fetchVideoInfo = async (videoId) => {
    addDebugLog('api', `fetching video info: ${videoId}`, null, true);
    try {
      const infoUrl = `/api/info?videoId=${encodeURIComponent(videoId)}`;
      const info = await fetchJson(infoUrl);
      addDebugLog('api', 'video info response: ok', { videoId }, true);
      return info;
    } catch (err) {
      addDebugLog('error', `video info fetch error: ${err.message}`, { videoId, error: err }, true);
      return null;
    }
  };

  const searchTracks = async (q) => {
    if (!q) return [];
    addDebugLog('api', `searching youtube: ${q}`, null, true);

    const cacheKey = `youtube:${q}`;
    const cached = getCached(cacheKey);
    if (cached) {
      addDebugLog('api', `search cache hit: ${cacheKey}`, null, true);
      return cached;
    }

    try {
      const data = await fetchJson(`/api/search?q=${encodeURIComponent(q)}`);
      const results = Array.isArray(data.results)
        ? data.results.map((result) => normalizeTrack(result))
        : [];

      addDebugLog('api', `search results: ${results.length} found`, { count: results.length, query: q, source: 'youtube' }, true);
      setCached(cacheKey, results);
      if (!results.length) {
        setSuggestionError('no results found');
      }
      // most people click one of the first couple results shortly after
      // searching — warm those in the background so the resolve is already
      // done (or well underway) by the time they actually hit play.
      results.slice(0, 3).forEach((track) => {
        if (!track?.videoId) return;
        resolveMediaUrl(`/api/prefetch?videoId=${encodeURIComponent(track.videoId)}`)
          .then((url) => fetch(url))
          .catch(() => {});
      });
      return results;
    } catch (e) {
      addDebugLog('error', `search failed: ${e.message}`, { query: q, error: e }, true);
      setSuggestionError(e.message);
      return [];
    }
  };

  const handleQueryChange = (value) => {
    setQuery(value);
    setSuggestionError(null);

    const videoId = extractYouTubeId(value);
    const playlistId = extractYouTubePlaylistId(value);

    if (videoId) {
      setIsSuggesting(true);
      setSuggestions([]);
      fetchVideoInfo(videoId)
        .then((info) => {
          if (!info) return;
          setSuggestions([
            {
              videoId,
              title: info.title || videoId,
              author: info.author || 'unknown author'
            }
          ]);
          setVideoInfo({ title: info.title, author: info.author, videoId });
        })
        .finally(() => setIsSuggesting(false));
      return;
    }

    if (playlistId) {
      setIsSuggesting(false);
      setSuggestions([
        {
          playlistId,
          title: `playlist: ${playlistId}`,
          author: ''
        }
      ]);
      setVideoInfo(null);
      return;
    }

    if (suggestionTimer.current) {
      clearTimeout(suggestionTimer.current);
    }

    if (!value.trim()) {
      setSuggestions([]);
      setVideoInfo(null);
      return;
    }

    suggestionTimer.current = setTimeout(async () => {
      setIsSuggesting(true);
      const searchId = ++latestSearchId.current;
      const results = await searchTracks(value);

      if (searchId !== latestSearchId.current) return;

      setSuggestions(results);
      setIsSuggesting(false);
      setVideoInfo(null);
    }, 150);
  };

  const handleAddToQueue = () => {
    if (!query.trim() && suggestions.length === 0) {
      showNotification('please enter a youtube link/id or search query', 'warning');
      return;
    }

    const playlistId = extractYouTubePlaylistId(query);
    if (playlistId) {
      enqueuePlaylist(playlistId);
      return;
    }

    const videoId = extractYouTubeId(query);
    if (videoId) {
      enqueue();
      return;
    }

    if (suggestions.length > 0) {
      enqueue(suggestions[0]);
      return;
    }

    showNotification('no valid video selected', 'warning');
  };

  const enqueue = async (item) => {
    const normalizedItem = item ? normalizeTrack(item) : null;

    const videoId = normalizedItem?.videoId || extractYouTubeId(query);
    if (!videoId) {
      showNotification('please enter a valid youtube url or id', 'warning');
      return;
    }
    addDebugLog('queue', `enqueue: ${videoId}`, { videoId, title: normalizedItem?.title || 'loading...', author: item?.author || '...' }, true);

    const placeholderItem = {
      videoId,
      title: normalizedItem?.title || 'loading...',
      author: item?.author || '...',
      format: normalizedItem?.format || format,
      thumbnail: normalizedItem?.thumbnail || '',
      source: 'youtube'
    };

    setQueue((prev) => {
      const next = [...prev, placeholderItem];
      addDebugLog('queue', `setQueue callback: adding ${videoId} at index ${next.length - 1}, queue size: ${next.length}`, { videoId, queueSize: next.length }, true);
      return next;
    });
    showNotification('fetching video info...', 'info');
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);

    const info = await fetchVideoInfo(videoId);
    if (!info) {
      showNotification('unable to load info; added with placeholder title', 'warning');
      return;
    }

    setQueue((prev) =>
      prev.map((q) =>
        q.videoId === videoId && q.title === 'loading...'
          ? { ...q, title: info.title || videoId, author: info.author || 'unknown author' }
          : q
      )
    );

    showNotification('added to queue', 'success');
  };

  const enqueuePlaylist = async (playlistId) => {
    if (!playlistId) {
      showNotification('please enter a valid playlist link or id', 'warning');
      return;
    }

    showNotification('fetching playlist content...', 'info');

    try {
      const data = await fetchJson(`/api/playlist?list=${encodeURIComponent(playlistId)}`);

      const tracks = Array.isArray(data.items) ? data.items : [];
      if (!tracks.length) {
        showNotification('playlist returned no tracks', 'warning');
        return;
      }

      setQueue((prev) => {
        const next = [...prev, ...tracks.map((t) => ({ ...t, format }))];
        return next;
      });

      showNotification(`added ${tracks.length} tracks from playlist`, 'success');
      setQuery('');
      setSuggestions([]);
    } catch (error) {
      showNotification(`playlist loading failed: ${error.message}`, 'error');
    }
  };

  const downloadSingle = async (item) => {
    console.log('[downloadSingle] Called with item:', item);
    
    if (!item) {
      console.error('[downloadSingle] No item provided');
      addDebugLog('error', 'downloadSingle called with no item', null, true);
      return;
    }

    try {
      console.log('[downloadSingle] Starting download for:', item.videoId);
      logClient('downloadSingle', { videoId: item.videoId, title: item.title });
      addDebugLog('download', `download single: ${item.title || item.videoId}`, { videoId: item.videoId }, true);

      const ctl = new AbortController();
      console.log('[downloadSingle] AbortController created');
      showNotification('download started', 'success');

      // isDownloading was only ever set by the "download all" queue flow —
      // a single-track download never flipped it on, so the progress bar
      // (which renders on isDownloading || isQueueRunning) just never
      // showed up for the WAY more common case of downloading one track.
      // fixed now
      setProgress({ loaded: 0, total: 0 });
      setIsDownloading(true);

      try {
        console.log('[downloadSingle] Calling downloadFile with:', {
          videoId: item.videoId,
          title: item.title,
          format: item.format
        });

        await downloadFile(item.videoId, item.title, ctl.signal, item.format);
        console.log('[downloadSingle] downloadFile completed successfully');

        setDownloadedTracks((prev) => {
          const exists = prev.some((t) => t.videoId === item.videoId);
          if (exists) return prev;
          return [...prev, { ...item, downloadedAt: Date.now() }];
        });
        showNotification('download finished', 'success');
      } catch (error) {
        console.error('[downloadSingle] downloadFile error:', error);
        addDebugLog('error', `downloadSingle error: ${error.message}`, { videoId: item.videoId, error }, true);
        if (error.message === 'Download cancelled') {
          showNotification('download cancelled', 'warning');
        } else {
          showNotification(`download failed: ${error.message}`, 'error');
        }
      } finally {
        setIsDownloading(false);
      }
    } catch (err) {
      console.error('[downloadSingle] CRASHED:', err);
      addDebugLog('error', `downloadSingle crashed: ${err.message}`, { error: err, stack: err.stack }, true);
      showNotification('download error occurred', 'error');
    }
  };

  const processQueue = async () => {
    if (!queue.length) {
      showNotification('queue is empty', 'info');
      return;
    }
    addDebugLog('download', `process queue: ${queue.length} tracks`);

    setIsQueueRunning(true);
    setIsDownloading(true);
    queueRunningRef.current = true;
    showNotification('starting queue...', 'info');

    for (let i = 0; i < queue.length; i += 1) {
      if (!queueRunningRef.current) break;
      setCurrentIndex(i);
      const item = queue[i];

      setVideoInfo({ title: item.title, author: item.author, videoId: item.videoId });
      showNotification(`downloading (${i + 1}/${queue.length})`, 'success');

      abortControllerRef.current = new AbortController();

      try {
        await downloadFile(item.videoId, item.title, abortControllerRef.current.signal, item.format);
        showNotification(`downloaded: ${item.title}`, 'success');
      } catch (error) {
        showNotification(`failed: ${item.title} - ${error.message}`, 'error');
        if (error.message === 'Download cancelled') break;
      }

      await sleep(300);
    }

    queueRunningRef.current = false;
    setIsQueueRunning(false);
    setIsDownloading(false);
    setCurrentIndex(-1);
    abortControllerRef.current = null;
  };

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  
  const EQSlider = ({ index, value }) => (
    <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      <input
        type="range"
        min="-12"
        max="12"
        value={value}
        onChange={(e) => {
          const newValues = [...eqValues];
          newValues[index] = Number(e.target.value);
          setEqValues(newValues);
          setSelectedPreset('custom');
        }}
        disabled={!eqEnabled}
        style={{
          writingMode: 'vertical-lr',
          direction: 'rtl',
          height: '130px',
          appearance: 'slider-vertical',
          width: '24px'
        }}
      />
      <span style={{ fontSize: '11px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
        {index === 0 ? '32' : index === 9 ? '16k' : `${index * 1000 / 1000}k`}
      </span>
    </div>
  );

  const selectedConversation = selectedConversationId
    ? (
        conversationList.find((entry) => entry.user_id === selectedConversationId)
        || friendsList.find((entry) => entry.friend_id === selectedConversationId)
        || allUsers.find((entry) => entry.id === selectedConversationId)
      )
    : null;

  const searchedUsers = allUsers
    .filter((entry) => entry.username !== currentUsername)
    .filter((entry) => entry.username.toLowerCase().includes(friendSearch.trim().toLowerCase()))
    .slice(0, 8);

  const friendsWithStatus = friendsList
    .map((friend) => {
      const match = allUsers.find((entry) => entry.id === friend.friend_id);
      return {
        ...friend,
        is_online: match?.is_online === true,
        current_server_id: match?.current_server_id || null
      };
    })
    .sort((a, b) => Number(b.is_online) - Number(a.is_online) || a.username.localeCompare(b.username));
  const pendingFriendTargetSet = new Set(pendingFriendTargetIds);

  const currentChannelMembers = channelMembers
    .map((member) => {
      const match = allUsers.find((entry) => entry.id === member.user_id);
      return {
        ...member,
        is_online: member.user_id === currentUserId ? isConnected : match?.is_online === true,
        listening_to: match?.listening_to || null,
        current_server_id: member.user_id === currentUserId
          ? currentChannelId || null
          : (match?.current_server_id || null)
      };
    })
    .sort((a, b) => Number(b.is_online) - Number(a.is_online) || Number(b.is_admin) - Number(a.is_admin) || a.username.localeCompare(b.username));

  const activeSharedTrack = channelQueue.find((track) => track.id === channelPlayerState?.current_track_id) || null;
  const sharedTrackProgress = playbackSource === 'shared'
    ? trackProgress
    : {
        current: channelPlayerState?.current_time || 0,
        duration: activeSharedTrack?.durationMs ? activeSharedTrack.durationMs / 1000 : 0
      };
  const onlineSharedMembers = currentChannelMembers.filter((member) => member.is_online);
  const otherOnlineSharedMembers = onlineSharedMembers.filter((member) => member.user_id !== currentUserId);
  const sharedAudioStatus = (() => {
    if (!currentChannel) {
      return { label: 'join a channel to use the shared player', tone: '#9ca3af' };
    }

    if (!channelQueue.length) {
      return {
        label: otherOnlineSharedMembers.length > 0
          ? `waiting on a client to queue audio for ${otherOnlineSharedMembers.length} other client(s)`
          : 'waiting on you to queue audio',
        tone: '#9ca3af'
      };
    }

    if (!activeSharedTrack) {
      return {
        label: otherOnlineSharedMembers.length > 0
          ? 'waiting on another client to start the shared player'
          : 'waiting on you to start the shared player',
        tone: '#9ca3af'
      };
    }

    if (channelPlayerState?.is_playing && playbackSource !== 'shared') {
      return {
        label: 'shared audio is live; syncing this client',
        tone: '#facc15'
      };
    }

    if (channelPlayerState?.is_playing && isBuffering) {
      return {
        label: otherOnlineSharedMembers.length > 0
          ? `waiting on this client to buffer for ${otherOnlineSharedMembers.length} other client(s)`
          : 'waiting on this client to buffer',
        tone: '#facc15'
      };
    }

    if (channelPlayerState?.is_playing) {
      return {
        label: otherOnlineSharedMembers.length > 0
          ? `playing with ${otherOnlineSharedMembers.length} other client(s)`
          : 'playing for you',
        tone: '#22c55e'
      };
    }

    if ((channelPlayerState?.current_time || 0) > 0) {
      return {
        label: otherOnlineSharedMembers.length > 0
          ? `paused at ${formatTime(channelPlayerState.current_time)}; waiting on another client to resume`
          : `paused at ${formatTime(channelPlayerState.current_time)}; waiting on you to resume`,
        tone: '#9ca3af'
      };
    }

    return {
      label: otherOnlineSharedMembers.length > 0
        ? 'ready to play; waiting on another client'
        : 'ready to play; waiting on you',
      tone: '#9ca3af'
    };
  })();
  const recentDebugEntries = debugEntries.slice(-120).reverse();
  const canManageCurrentChannel = currentChannel
    ? Boolean(
      user?.is_admin
      || currentChannel.host_id === currentUserId
      || currentChannelMembers.some((member) => member.user_id === currentUserId && member.is_admin)
    )
    : Boolean(user?.is_admin);
  const joinedChannelIds = new Set(
    channels
      .filter((channel) => Array.isArray(channel.members) && channel.members.some((member) => member.user_id === currentUserId))
      .map((channel) => channel.id)
  );
  const onlineMembers = allUsers.filter((entry) => entry.is_online);
  const panelStyle = {
    border: `1px solid ${dimBorderColor(themeColor)}`,
    borderRadius: '0',
    background: 'transparent',
    boxShadow: 'none',
    padding: '16px'
  };
  const inputStyle = {
    width: '100%',
    background: 'rgba(0,0,0,0.45)',
    border: `1px solid ${dimBorderColor(themeColor)}`,
    borderRadius: '6px',
    padding: '10px 12px',
    color: '#fff',
    fontSize: '12px',
    outline: 'none'
  };
  const primaryButtonStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: 'none',
    background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    color: '#000',
    fontWeight: 'bold',
    fontSize: '11px',
    cursor: 'pointer'
  };
  const outlineButtonStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: `1px solid ${dimBorderColor(themeColor)}`,
    background: 'transparent',
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    fontSize: '11px',
    cursor: 'pointer'
  };
  const dangerButtonStyle = {
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid #ef4444',
    background: 'transparent',
    color: '#ef4444',
    fontSize: '11px',
    cursor: 'pointer'
  };
  const itemShellStyle = {
    padding: '10px 12px',
    borderRadius: '6px',
    background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.05)`,
    border: `1px solid ${dimBorderColor(themeColor)}`
  };
  const wirePanelStyle = {
    border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.7)`,
    borderRadius: '6px',
    background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.08)`,
    boxShadow: 'none',
    padding: '14px 16px',
    overflow: 'visible',
    transition: 'background 0.2s ease, border-color 0.2s ease'
  };
  const wireHeaderStyle = {
    padding: '0 0 10px 0',
    borderBottom: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.18)`,
    background: 'transparent'
  };
  const wireBodyStyle = {
    padding: 0
  };
  const wireSectionTitleStyle = {
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    fontWeight: 'bold',
    fontSize: '13px',
    textTransform: 'lowercase',
    letterSpacing: '0.04em'
  };
  const wireSectionMetaStyle = {
    color: '#9ca3af',
    fontSize: '10px',
    marginTop: '4px',
    textTransform: 'lowercase',
    letterSpacing: '0.05em'
  };
  const sectionChipStyle = (active = false) => ({
    padding: '7px 10px',
    borderRadius: '4px',
    border: `1px solid ${dimBorderColor(themeColor)}`,
    background: active
      ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
      : `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.08)`,
    color: active ? '#000' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    fontSize: '10px',
    fontWeight: 'bold',
    letterSpacing: '0.08em',
    textTransform: 'uppercase'
  });
  const wireRowStyle = (active = false) => ({
    ...itemShellStyle,
    background: active
      ? `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.18)`
      : `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.04)`
  });
  const wireEmptyStyle = {
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: '12px',
    padding: '28px 12px'
  };
  const panelCardBodyStyle = {
    padding: '14px 16px',
    overflow: 'visible'
  };
  const messageGuideFrameStyle = {
    margin: '0 auto',
    width: '100%',
    maxWidth: '260px',
    padding: '16px 14px',
    borderRadius: '6px',
    border: `1px dashed rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.38)`,
    background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.04)`,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  };
  const messageGuideLineStyle = (width = '100%') => ({
    width,
    height: '1px',
    borderRadius: '999px',
    background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.28)`
  });
  const chatBubbleStyle = (isOwnMessage) => ({
    alignSelf: isOwnMessage ? 'flex-end' : 'flex-start',
    maxWidth: '78%',
    borderRadius: '6px',
    padding: '12px 14px',
    border: `1px solid ${isOwnMessage ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'rgba(255,255,255,0.12)'}`,
    background: isOwnMessage
      ? `linear-gradient(135deg, rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.95), rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.72))`
      : 'rgba(255,255,255,0.05)',
    color: isOwnMessage ? '#000' : '#fff',
    boxShadow: isOwnMessage ? `0 0 12px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.18)` : 'none'
  });
  const friendLookupUsers = (friendSearch.trim() ? searchedUsers.filter((entry) => entry.is_online) : onlineMembers)
    .filter((entry) => entry.username !== currentUsername)
    .slice(0, 8);
  const allUsersByLastActive = allUsers
    .filter((entry) => entry.username !== currentUsername)
    .slice()
    .sort((a, b) => {
      const timeA = Number(a.last_seen || a.created_at || 0);
      const timeB = Number(b.last_seen || b.created_at || 0);
      return Number(b.is_online) - Number(a.is_online) || timeB - timeA || a.username.localeCompare(b.username);
    });

  // build userId -> themeColor map for message username colors
  const userThemeColorMap = {};
  allUsers.forEach((u) => {
    if (u.theme_color) {
      userThemeColorMap[u.id] = u.theme_color;
    }
  });
  // also include current user's theme color
  userThemeColorMap[currentUserId] = { r: themeColor.r, g: themeColor.g, b: themeColor.b };

  const onlineDirectoryUsers = allUsersByLastActive.filter((entry) => (
    !friendSearch.trim() || entry.username.toLowerCase().includes(friendSearch.trim().toLowerCase())
  ));
  const currentShareCandidate = currentTrack || queue[playIndex] || queue[0] || null;
  const currentListeningActivity = useMemo(() => {
    if (!currentTrack) {
      return null;
    }

    const isActivelyListening = Boolean(
      isPlaying || (playbackSource === 'shared' && channelPlayerState?.is_playing)
    );

    if (!isActivelyListening) {
      return null;
    }

    return {
      title: currentTrack.title || '',
      author: currentTrack.author || '',
      source: playbackSource === 'shared' ? 'shared' : 'personal',
      server_id: playbackSource === 'shared' ? currentChannelId || null : null,
      is_playing: true
    };
  }, [
    channelPlayerState?.is_playing,
    currentChannelId,
    currentTrack,
    isPlaying,
    playbackSource
  ]);

  useEffect(() => {
    if (!isConnected) {
      lastListeningStateSentRef.current = '';
    }
  }, [currentUserId, isConnected]);

  useEffect(() => {
    if (!currentUserId || !isConnected) return;

    const serializedListeningState = JSON.stringify(currentListeningActivity || null);
    if (lastListeningStateSentRef.current === serializedListeningState) {
      return;
    }

    lastListeningStateSentRef.current = serializedListeningState;
    sendWsMessage({
      type: 'set_listening_state',
      listening: currentListeningActivity
    });
  }, [currentListeningActivity, currentUserId, isConnected, sendWsMessage]);

  const snapLayoutStyle = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.7fr) minmax(0, 1.3fr)',
    gap: '22px',
    alignItems: 'start'
  };
  const snapColumnStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    minWidth: 0,
    width: '100%',
    maxWidth: '100%'
  };
  const panelHandleStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    borderRadius: '6px',
    border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.5)`,
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.08)`,
    cursor: 'grab',
    marginLeft: 'auto'
  };
  const panelDropZoneStyle = (active = false) => ({
    minHeight: '52px',
    borderRadius: '6px',
    border: `1px dashed ${active ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.28)`}`,
    background: active
      ? `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.12)`
      : 'rgba(255,255,255,0.02)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: active ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'rgba(156,163,175,0.9)',
    transition: 'all 0.16s ease'
  });
  const panelSplitStyle = {
    display: 'grid',
    gridTemplateColumns: '260px minmax(0, 1fr)',
    gap: '16px',
    alignItems: 'start'
  };
  const subsectionLabelStyle = {
    color: '#9ca3af',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginTop: '4px'
  };
  const sectionStackStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px'
  };
  const setPanelSide = (scope, panelId, side) => {
    if (scope === 'social') {
      setSocialPanelSides((prev) => ({ ...prev, [panelId]: side }));
      return;
    }

    setCollabPanelSides((prev) => ({ ...prev, [panelId]: side }));
  };
  const readDraggedPanel = (event) => {
    const raw = event.dataTransfer?.getData('text/plain');
    if (!raw) return draggingPanel;

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.scope && parsed?.panelId) {
        return parsed;
      }
    } catch {
      return draggingPanel;
    }

    return draggingPanel;
  };
  const renderPanelHandle = (scope, panelId, label = '') => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
      {label ? <div style={wireSectionTitleStyle}>{label}</div> : <div />}
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={`move ${panelId}`}
        onDragStart={(event) => {
          const nextPanel = { scope, panelId };
          setDraggingPanel(nextPanel);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', JSON.stringify(nextPanel));
        }}
        onDragEnd={() => {
          setDraggingPanel(null);
          setActiveDropColumn('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            setPanelSide(scope, panelId, 'left');
          }
          if (event.key === 'ArrowRight') {
            setPanelSide(scope, panelId, 'right');
          }
        }}
        style={panelHandleStyle}
      >
        {SVGIcons.silhouette}
      </div>
    </div>
  );
  const renderPanelCard = (scope, panelId, label, content) => (
    <Card key={`${scope}-${panelId}`} className="glass card-hover shadow-sm border-0">
      <Card.Body className="card-body snap-panel-body" style={panelCardBodyStyle}>
        {renderPanelHandle(scope, panelId, label)}
        {content}
      </Card.Body>
    </Card>
  );
  const renderMessageGuide = (scope, title, detail) => (
    <div style={wireEmptyStyle}>
      {scope === 'social' && (
        <div style={messageGuideFrameStyle}>
          <div style={messageGuideLineStyle('72%')} />
          <div style={messageGuideLineStyle('100%')} />
          <div style={messageGuideLineStyle('88%')} />
        </div>
      )}
      <div style={{ color: '#fff', fontSize: '12px', marginTop: '14px' }}>{title}</div>
      {detail ? <div style={{ color: '#9ca3af', fontSize: '11px', marginTop: '6px' }}>{detail}</div> : null}
    </div>
  );
  const renderPanelColumn = (scope, side, panelIds, panels) => {
    const isActiveDrop = draggingPanel?.scope === scope && activeDropColumn === `${scope}:${side}`;
    const showDropZone = draggingPanel?.scope === scope;

    return (
      <div
        style={snapColumnStyle}
        onDragOver={(event) => {
          const draggedPanel = readDraggedPanel(event);
          if (!draggedPanel || draggedPanel.scope !== scope) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setActiveDropColumn(`${scope}:${side}`);
        }}
        onDrop={(event) => {
          const draggedPanel = readDraggedPanel(event);
          if (!draggedPanel || draggedPanel.scope !== scope) return;
          event.preventDefault();
          setPanelSide(scope, draggedPanel.panelId, side);
          setDraggingPanel(null);
          setActiveDropColumn('');
        }}
      >
        {showDropZone && (
          <div style={panelDropZoneStyle(isActiveDrop)}>
            {SVGIcons.silhouette}
          </div>
        )}
        {panelIds.map((panelId) => panels[panelId])}
      </div>
    );
  };
  const socialPanels = {
    online: renderPanelCard('social', 'online', 'online', (
        <div style={sectionStackStyle}>
          <div style={{ ...sectionStackStyle, maxHeight: '220px', overflowY: 'auto' }}>
            {onlineMembers.length === 0 ? (
              <div style={wireEmptyStyle}>nobody else is online</div>
            ) : onlineMembers.map((entry) => (
              <div key={entry.id} style={wireRowStyle(false)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>{entry.username}</div>
                    <div style={{ color: '#22c55e', fontSize: '10px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {entry.listening_to
                        ? (entry.listening_to.is_playing === false ? 'paused on: ' : 'listening to: ') + formatListeningActivity(entry.listening_to)
                        : (entry.current_server_id ? 'inside a channel' : 'online')}
                    </div>
                  </div>
                  <button onClick={() => openConversation(entry, { notify: true })} style={outlineButtonStyle}>message</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )),
    messages: renderPanelCard('social', 'messages', 'messages', (
        <div style={panelSplitStyle}>
          <div style={{ ...sectionStackStyle, minWidth: 0 }}>
            <div style={{ ...sectionStackStyle, maxHeight: '540px', overflowY: 'auto' }}>
              {conversationList.length === 0 ? (
                renderMessageGuide('social', 'no conversations yet', 'choose someone from online to start a chat')
              ) : conversationList.map((entry) => {
                const hasUnread = entry.unread_count > 0;
                const isActive = selectedConversationId === entry.user_id;
                return (
                  <button
                    key={entry.user_id}
                    onClick={() => openConversation(entry, { notify: true })}
                    style={{
                      ...wireRowStyle(isActive),
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      background: isActive ? `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.12)` : hasUnread ? 'rgba(255,255,255,0.03)' : 'transparent',
                      borderLeft: isActive ? `3px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : '3px solid transparent',
                      boxShadow: isActive ? `0 0 12px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.25), inset 0 0 8px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.06)` : 'none',
                      borderRadius: isActive ? '4px' : '0'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {isActive && (
                            <span style={{
                              display: 'inline-block',
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                              boxShadow: `0 0 6px rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                            }} />
                          )}
                          <div style={{ color: '#fff', fontSize: '12px', fontWeight: isActive ? '700' : hasUnread ? '700' : 'bold' }}>{entry.username}</div>
                        </div>
                        <div style={{ color: '#9ca3af', fontSize: '11px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isActive ? '600' : hasUnread ? '600' : '400' }}>
                          {(() => {
                            // always prioritize the latest message from dmMessages for dynamic updates
                            const liveMessages = dmMessages[entry.user_id] || [];
                            const latestMsg = liveMessages[liveMessages.length - 1];
                            const senderId = latestMsg?.sender_id || entry.last_sender_id;
                            const senderName = senderId === currentUserId
                              ? 'you'
                              : (latestMsg?.sender_username || entry.last_sender_username || entry.username);
                            const msg = latestMsg?.message || entry.last_message;
                            return msg ? `${senderName}: ${msg}` : 'open chat';
                          })()}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        {hasUnread && (
                          <span style={{
                            background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                            color: '#000',
                            fontSize: '9px',
                            fontWeight: '700',
                            borderRadius: '10px',
                            padding: '1px 6px',
                            minWidth: '16px',
                            textAlign: 'center'
                          }}>{entry.unread_count}</span>
                        )}
                        <span style={{ color: '#9ca3af', fontSize: '10px', whiteSpace: 'nowrap' }}>
                          {(() => {
                            const liveMessages = dmMessages[entry.user_id] || [];
                            const latestMsg = liveMessages[liveMessages.length - 1];
                            const latestTime = latestMsg?.created_at || entry.last_message_at;
                            return formatMessageTimestamp(latestTime);
                          })()}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ ...sectionStackStyle, minWidth: 0, borderLeft: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.16)`, paddingLeft: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', paddingBottom: '8px', borderBottom: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.16)` }}>
              <div style={{ color: '#fff', fontSize: '16px', fontWeight: 'bold' }}>
                {selectedConversation?.username || 'pick a conversation'}
              </div>
            </div>
            <div ref={dmScrollRef} style={{ ...sectionStackStyle, minHeight: '460px', maxHeight: '460px', overflowY: 'auto' }}>
              {!selectedConversation ? (
                renderMessageGuide('social', 'choose a conversation from the left', 'online users show on the left and the active chat opens here')
              ) : (dmMessages[selectedConversationId] || []).length === 0 ? (
                renderMessageGuide('social', `start the conversation with ${selectedConversation.username}`, 'messages will stack here once the chat begins')
              ) : (dmMessages[selectedConversationId] || []).map((message, idx) => {
                const senderColor = userThemeColorMap[message.sender_id]
                  ? `rgb(${userThemeColorMap[message.sender_id].r}, ${userThemeColorMap[message.sender_id].g}, ${userThemeColorMap[message.sender_id].b})`
                  : '#fff';
                const isUnread = message.unread === true;
                const msgs = dmMessages[selectedConversationId] || [];
                const prevMsg = idx > 0 ? msgs[idx - 1] : null;
                const msgTime = message.created_at ? (Number(message.created_at) < 1e12 ? Number(message.created_at) * 1000 : Number(message.created_at)) : 0;
                const prevTime = prevMsg?.created_at ? (Number(prevMsg.created_at) < 1e12 ? Number(prevMsg.created_at) * 1000 : Number(prevMsg.created_at)) : 0;
                const timeGap = msgTime - prevTime;
                const showTimeBreak = prevTime > 0 && timeGap > 30 * 60 * 1000;
                return (
                  <div key={message.id}>
                    {showTimeBreak && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        margin: '12px 0',
                        color: '#6b7280',
                        fontSize: '10px'
                      }}>
                        <div style={{ flex: 1, height: '1px', background: 'rgba(107,114,128,0.3)' }} />
                        <span>{(() => {
                          const d = new Date(prevTime);
                          const now = new Date();
                          const isToday = d.toDateString() === now.toDateString();
                          const opts = isToday ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
                          return d.toLocaleString([], opts);
                        })()}</span>
                        <div style={{ flex: 1, height: '1px', background: 'rgba(107,114,128,0.3)' }} />
                      </div>
                    )}
                    <div style={wireRowStyle(message.sender_id === currentUserId)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                        <span
                          style={{ color: senderColor, fontWeight: 'bold', fontSize: '11px' }}
                        >{message.sender_username}</span>
                        <span style={{ color: '#9ca3af', fontSize: '10px' }}>{formatMessageTimestamp(message.created_at)}</span>
                      </div>
                      <div style={{ color: '#fff', fontSize: '13px', marginTop: '6px' }}>{message.message}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                value={dmText}
                onChange={(e) => setDmText(e.target.value)}
                placeholder={selectedConversation ? `message ${selectedConversation.username}...` : 'pick a conversation first'}
                disabled={!selectedConversation}
                style={{ ...inputStyle, flex: 1, opacity: selectedConversation ? 1 : 0.6 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    sendDmMessage();
                  }
                }}
              />
              <button
                onClick={sendDmMessage}
                disabled={!selectedConversation || !dmText.trim()}
                style={{
                  ...primaryButtonStyle,
                  opacity: selectedConversation && dmText.trim() ? 1 : 0.5,
                  cursor: selectedConversation && dmText.trim() ? 'pointer' : 'not-allowed'
                }}
              >
                send
              </button>
            </div>
          </div>
        </div>
      )),
    allUsers: (
      <div key="social-all-users" className="wire-panel" style={wirePanelStyle}>
        {renderPanelHandle('social', 'allUsers')}
        <div style={{ ...sectionStackStyle, maxHeight: '620px', overflowY: 'auto' }}>
          {allUsersByLastActive.length === 0 ? (
            <div style={wireEmptyStyle}>no other accounts yet</div>
          ) : allUsersByLastActive.map((entry) => {
            const isFriend = friendsList.some((friend) => friend.friend_id === entry.id);
            const hasPendingRequest = pendingFriendTargetSet.has(entry.id);

            return (
              <div key={entry.id} style={wireRowStyle(false)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <button
                      type="button"
                      onClick={(event) => openUserProfileCard(event, entry)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#fff',
                        fontSize: '12px',
                        fontWeight: 'bold',
                        padding: 0,
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                    >
                      {entry.username}
                    </button>
                    <div style={{ color: entry.is_online ? '#22c55e' : '#9ca3af', fontSize: '10px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {entry.is_online
                        ? (entry.listening_to
                          ? (entry.listening_to.is_playing === false ? 'paused on: ' : 'listening to: ') + formatListeningActivity(entry.listening_to)
                          : (entry.current_server_id ? 'online in a channel' : 'online'))
                        : formatLastActive(entry.last_seen || entry.created_at, entry.is_online)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button onClick={() => openConversation(entry, { notify: true })} style={outlineButtonStyle}>message</button>
                    {!isFriend && !hasPendingRequest && (
                      <button
                        onClick={() => sendFriendRequest(entry.id, entry.username)}
                        style={primaryButtonStyle}
                      >
                        add
                      </button>
                    )}
                    {isFriend && (
                      <div style={{ ...outlineButtonStyle, cursor: 'default', opacity: 0.75 }}>friend</div>
                    )}
                    {hasPendingRequest && (
                      <div style={{ ...outlineButtonStyle, cursor: 'default', opacity: 0.75 }}>pending</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ),
    requests: renderPanelCard('social', 'requests', 'requests', (
        <div style={{ ...sectionStackStyle, maxHeight: '320px', overflowY: 'auto' }}>
          {pendingFriendRequests.length === 0 ? (
            <div style={wireEmptyStyle}>no pending requests</div>
          ) : pendingFriendRequests.map((request) => (
            <div key={request.id} style={{ ...wireRowStyle(false), background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.24)' }}>
              <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>{request.sender_username}</div>
              <div style={{ color: '#9ca3af', fontSize: '10px', marginTop: '4px' }}>sent you a request</div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => acceptFriendRequest(request.id, request.sender_username)}
                  disabled={friendRequestActionIds.includes(request.id)}
                  style={{
                    ...primaryButtonStyle,
                    background: '#22c55e',
                    opacity: friendRequestActionIds.includes(request.id) ? 0.65 : 1,
                    cursor: friendRequestActionIds.includes(request.id) ? 'wait' : 'pointer'
                  }}
                >
                  {friendRequestActionIds.includes(request.id) ? 'working...' : 'accept'}
                </button>
                <button
                  onClick={() => declineFriendRequest(request.id)}
                  disabled={friendRequestActionIds.includes(request.id)}
                  style={{
                    ...dangerButtonStyle,
                    opacity: friendRequestActionIds.includes(request.id) ? 0.65 : 1,
                    cursor: friendRequestActionIds.includes(request.id) ? 'wait' : 'pointer'
                  }}
                >
                  {friendRequestActionIds.includes(request.id) ? 'working...' : 'decline'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))
  };
  const socialPanelOrder = ['online', 'messages', 'requests'];
  const socialLeftPanelIds = socialPanelOrder.filter((panelId) => socialPanelSides[panelId] !== 'right');
  const socialRightPanelIds = socialPanelOrder.filter((panelId) => socialPanelSides[panelId] === 'right');
  const socialView = (
    <div style={snapLayoutStyle}>
      {renderPanelColumn('social', 'left', socialLeftPanelIds, socialPanels)}
      {renderPanelColumn('social', 'right', socialRightPanelIds, socialPanels)}
    </div>
  );
  const collabPanels = {
    setup: renderPanelCard('collab', 'setup', '',
      currentChannel ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <Card className="glass-dark p-3" style={{ maxHeight: '220px', overflow: 'hidden' }}>
            <div className="fw-bold mb-2" style={{ color: '#fff', fontSize: '12px' }}>server</div>
            <div style={{ fontSize: '11px', color: '#ccc' }}>
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>name:</span> {currentChannel.name}</div>
              {currentChannel.description && (
                <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>desc:</span> {currentChannel.description}</div>
              )}
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>host:</span> {currentChannel.host_username}</div>
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>members:</span> {currentChannelMembers.length}</div>
              {currentChannel.host_id === currentUserId ? (
                <button
                  onClick={() => deleteChannel(currentChannel.id)}
                  style={{
                    ...dangerButtonStyle,
                    padding: '6px 12px',
                    fontSize: '10px',
                    marginTop: '6px',
                    width: '100%',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#ff4444';
                    e.currentTarget.style.color = '#000';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = '#ff4444';
                  }}
                >
                  delete server
                </button>
              ) : (
                <button
                  onClick={() => leaveChannel(currentChannel.id)}
                  style={{
                    ...dangerButtonStyle,
                    padding: '6px 12px',
                    fontSize: '10px',
                    marginTop: '6px',
                    width: '100%',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#ff4444';
                    e.currentTarget.style.color = '#000';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = '#ff4444';
                  }}
                >
                  leave server
                </button>
              )}
            </div>
          </Card>
          <Card className="glass-dark p-3" style={{ maxHeight: '220px', overflowY: 'auto' }}>
            <div className="fw-bold mb-2" style={{ color: '#fff', fontSize: '12px' }}>members</div>
            {currentChannelMembers.map((member) => (
              <div key={member.id} style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '6px',
                alignItems: 'center',
                padding: '6px 2px',
                borderBottom: '1px solid rgba(255,255,255,0.06)'
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#fff', fontSize: '11px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {member.username} {member.user_id === currentUserId ? '(you)' : ''}
                  </div>
                  <div style={{ color: member.is_online ? '#22c55e' : '#9ca3af', fontSize: '9px', marginTop: '2px' }}>
                    {member.is_online ? 'online' : 'offline'} {member.is_admin ? '| admin' : ''}
                  </div>
                </div>
                {canManageCurrentChannel && member.user_id !== currentUserId && (
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button
                      onClick={() => updateChannelAdmin(member, !member.is_admin)}
                      style={{
                        ...outlineButtonStyle,
                        padding: '4px 6px',
                        fontSize: '9px',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                        e.currentTarget.style.color = '#000';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                      }}
                    >{member.is_admin ? 'unadmin' : 'admin'}</button>
                    <button
                      onClick={() => kickChannelMember(member)}
                      style={{
                        ...dangerButtonStyle,
                        padding: '4px 6px',
                        fontSize: '9px',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#ff4444';
                        e.currentTarget.style.color = '#000';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = '#ff4444';
                      }}
                    >remove</button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </div>
      ) : (
        <div style={sectionStackStyle}>
          <input value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} placeholder="channel name" style={inputStyle} />
          <button
            onClick={createChannel}
            disabled={!newChannelName.trim()}
            style={{ ...primaryButtonStyle, opacity: newChannelName.trim() ? 1 : 0.5, cursor: newChannelName.trim() ? 'pointer' : 'not-allowed' }}
          >
            create channel
          </button>
          <div style={{ ...sectionStackStyle, maxHeight: '260px', overflowY: 'auto' }}>
            {channels.length === 0 ? (
              <div style={wireEmptyStyle}>no channels yet</div>
            ) : channels.map((channel) => {
              const joined = joinedChannelIds.has(channel.id);
              const active = currentChannelId === channel.id;

              return (
                <div key={channel.id} style={wireRowStyle(active)}>
                  <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>{channel.name}</div>
                  <div style={{ color: '#9ca3af', fontSize: '10px', marginTop: '4px' }}>host: {channel.host_username} | {(channel.members || []).length} members</div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                    <button onClick={() => joinChannel(channel)} style={{ ...primaryButtonStyle, flex: 1 }}>{active ? 'open' : joined ? 'rejoin' : 'join'}</button>
                    {joined && <button onClick={() => leaveChannel(channel.id)} style={dangerButtonStyle}>leave</button>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ ...sectionStackStyle, maxHeight: '220px', overflowY: 'auto' }}>
            {onlineMembers.length === 0 ? (
              <div style={wireEmptyStyle}>nobody else is online</div>
            ) : onlineMembers.map((entry) => (
              <div key={entry.id} style={wireRowStyle(false)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>{entry.username}</div>
                    <div style={{ color: '#22c55e', fontSize: '10px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {entry.listening_to
                        ? (entry.listening_to.is_playing === false ? 'paused on: ' : 'listening to: ') + formatListeningActivity(entry.listening_to)
                        : (entry.current_server_id ? 'inside a channel' : 'online')}
                    </div>
                  </div>
                  <button onClick={() => openConversation(entry, { notify: true })} style={outlineButtonStyle}>message</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    ),
    queue: renderPanelCard('collab', 'queue', '', (
      !currentChannel ? (
        renderMessageGuide('collab', 'join or create a channel', 'shared queue items will show up here')
      ) : (
        <>
          <hr style={{ border: 'none', borderTop: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, margin: '20px 0' }} />
          <ListGroup variant="flush" style={{ maxHeight: '240px', overflowY: 'auto' }}>
            {channelQueue.map((track) => (
              <ListGroup.Item
                key={track.id}
                active={track.id === channelPlayerState?.current_track_id}
                className="track-item border-0 d-flex justify-content-between align-items-start"
                onClick={() => playSharedTrack(track, { autoplay: true, isPlaying: true, currentTime: 0 })}
                onMouseEnter={(e) => {
                  const btns = e.currentTarget.querySelectorAll('.btn svg');
                  btns.forEach(svg => {
                    svg.style.setProperty('color', '#000', 'important');
                    svg.style.setProperty('fill', '#000', 'important');
                  });
                }}
                onMouseLeave={(e) => {
                  const btns = e.currentTarget.querySelectorAll('.btn svg');
                  btns.forEach(svg => {
                    svg.style.setProperty('color', `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`);
                    svg.style.setProperty('fill', '');
                  });
                }}
              >
                <div style={{ flex: 1 }}>
                  <div className="fw-bold" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.title}</div>
                  <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.author || 'unknown artist'}</div>
                </div>

                <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px' }}>
                  <Button
                    variant="outline-light"
                    size="sm"
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      addTrackToCollabPlaylist(track);
                    }}
                    style={{
                      borderRadius: '6px',
                      color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                      border: `1px solid ${dimBorderColor(themeColor)}`,
                      background: 'transparent',
                      transition: 'all 0.2s ease',
                      transform: 'scale(1)',
                      padding: '4px 8px'
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.transform = 'scale(1.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.transform = 'scale(1)';
                    }}
                  >
                    {SVGIcons.arrowDown}
                  </Button>
                  {canManageCurrentChannel && (
                    <Button
                      variant="outline-light"
                      size="sm"
                      className="trash-btn btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTrackFromCurrentChannel(track.id);
                      }}
                      style={{
                        borderRadius: '6px',
                        color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        border: `1px solid ${dimBorderColor(themeColor)}`,
                        background: 'transparent',
                        transition: 'all 0.2s ease',
                        transform: 'scale(1)',
                        padding: '4px 8px'
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.transform = 'scale(1.15)';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.transform = 'scale(1)';
                      }}
                    >
                      {SVGIcons.trash}
                    </Button>
                  )}
                </div>
              </ListGroup.Item>
            ))}
          </ListGroup>
          {channelQueue.length > 0 && (
            <div className="d-flex gap-2 mt-2">
              <Button
                size="sm"
                onClick={() => addTrackToCurrentChannel(currentShareCandidate)}
                disabled={!currentShareCandidate}
                style={{
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  background: 'transparent',
                  transition: 'all 0.2s ease',
                  opacity: currentShareCandidate ? 1 : 0.5,
                  cursor: currentShareCandidate ? 'pointer' : 'not-allowed'
                }}
                onMouseEnter={(e) => {
                  e.target.style.setProperty('color', '#000', 'important');
                  e.target.style.setProperty('background', `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, 'important');
                }}
                onMouseLeave={(e) => {
                  e.target.style.setProperty('color', `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`);
                  e.target.style.setProperty('background', 'transparent');
                }}
              >
                add current track
              </Button>
              {canManageCurrentChannel && (
                <Button
                  size="sm"
                  onClick={clearCurrentChannelQueue}
                  style={{
                    borderRadius: '6px',
                    color: '#ff4444',
                    border: '1px solid #ff4444',
                    background: 'transparent',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.color = '#000';
                    e.target.style.background = '#ff4444';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.color = '#ff4444';
                    e.target.style.background = 'transparent';
                  }}
                >
                  clear queue
                </Button>
              )}
            </div>
          )}
          <div style={{ borderTop: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.16)`, paddingTop: '12px', marginTop: '12px' }}>
            <div style={{ color: '#9ca3af', fontSize: '11px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              add from your queue
            </div>
            <ListGroup variant="flush" style={{ maxHeight: '180px', overflowY: 'auto' }}>
              {queue.length === 0 ? (
                <div style={wireEmptyStyle}>your queue is empty</div>
              ) : queue.slice(0, 10).map((track, index) => (
                <ListGroup.Item
                  key={`${track.videoId}-${index}`}
                  className="track-item border-0 d-flex justify-content-between align-items-start"
                  onClick={() => addTrackToCurrentChannel(track)}
                  onMouseEnter={(e) => {
                    const btns = e.currentTarget.querySelectorAll('.btn svg');
                    btns.forEach((svg) => {
                      svg.style.setProperty('color', '#000', 'important');
                      svg.style.setProperty('fill', '#000', 'important');
                    });
                  }}
                  onMouseLeave={(e) => {
                    const btns = e.currentTarget.querySelectorAll('.btn svg');
                    btns.forEach((svg) => {
                      svg.style.setProperty('color', `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`);
                      svg.style.setProperty('fill', '');
                    });
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div className="fw-bold" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.title}</div>
                    <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.author || 'unknown artist'}</div>
                  </div>
                  <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px' }}>
                    <Button
                      variant="outline-light"
                      size="sm"
                      className="btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        addTrackToCurrentChannel(track);
                      }}
                      style={{
                        borderRadius: '6px',
                        color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        border: `1px solid ${dimBorderColor(themeColor)}`,
                        background: 'transparent',
                        transition: 'all 0.2s ease',
                        transform: 'scale(1)',
                        padding: '4px 8px'
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.transform = 'scale(1.15)';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.transform = 'scale(1)';
                      }}
                    >
                      {SVGIcons.plus}
                    </Button>
                  </div>
                </ListGroup.Item>
              ))}
            </ListGroup>
          </div>
        </>
      )
    )),
    chat: renderPanelCard('collab', 'chat', '', (
      !currentChannel ? (
        renderMessageGuide('collab', 'join a channel to start chatting', 'room messages will appear here for everyone in the server')
      ) : (
          <div style={sectionStackStyle}>
            <div ref={channelScrollRef} style={{ ...sectionStackStyle, minHeight: '420px', maxHeight: '420px', overflowY: 'auto' }}>
              {channelMessages.length === 0 ? (
                <div style={wireEmptyStyle}>no channel messages yet</div>
              ) : channelMessages.map((message) => {
                const tc = message.sender_theme_color;
                const senderColor = tc
                  ? `rgb(${tc.r}, ${tc.g}, ${tc.b})`
                  : (userThemeColorMap[message.user_id]
                    ? `rgb(${userThemeColorMap[message.user_id].r}, ${userThemeColorMap[message.user_id].g}, ${userThemeColorMap[message.user_id].b})`
                    : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`);
                return (
                  <div key={message.id} style={wireRowStyle(message.user_id === currentUserId)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <span
                        style={{ color: senderColor, fontWeight: 'bold', fontSize: '11px', cursor: 'pointer' }}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setChatUserPopup({
                            userId: message.user_id,
                            username: message.username,
                            x: rect.left,
                            y: rect.bottom + 4
                          });
                        }}
                      >{message.username}</span>
                      <span style={{ color: '#9ca3af', fontSize: '10px' }}>{formatMessageTimestamp(message.created_at)}</span>
                    </div>
                    <div style={{ color: '#fff', fontSize: '13px', marginTop: '6px' }}>{message.message}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                value={channelMessageText}
                onChange={(e) => setChannelMessageText(e.target.value)}
                placeholder={currentChannel ? `message #${currentChannel.name}` : 'join a channel first'}
                style={{ ...inputStyle, flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    sendChannelMessage();
                  }
                }}
              />
              <button
                onClick={sendChannelMessage}
                disabled={!channelMessageText.trim()}
                style={{ ...primaryButtonStyle, opacity: channelMessageText.trim() ? 1 : 0.5, cursor: channelMessageText.trim() ? 'pointer' : 'not-allowed' }}
              >
                send
              </button>
            </div>
          </div>
        )
      )),
    player: renderPanelCard('collab', 'player', '',
      !currentChannel ? (
        renderMessageGuide('collab', 'join a channel to use the shared player', 'everyone in the server follows the same shared playback state')
      ) : (
        <>
          <div className="d-flex justify-content-center mb-3">
            <div className={`vinyl-record ${(channelPlayerState?.is_playing && activeSharedTrack) ? '' : 'paused'}`}>
              {activeSharedTrack && (
                <TrackThumbnail track={activeSharedTrack} className="record-thumb" alt="shared track thumbnail" />
              )}
            </div>
          </div>

          {activeSharedTrack && (
            <div className="text-center mb-3">
              <div className="fw-bold text-truncate" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{activeSharedTrack.title}</div>
              <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{activeSharedTrack.author || 'unknown artist'}</div>
            </div>
          )}

          <div
            className="text-center mb-3"
            style={{
              color: sharedAudioStatus.tone,
              fontSize: '11px',
              padding: '8px 10px',
              borderRadius: '6px',
              border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.18)`,
              background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.06)`
            }}
          >
            {sharedAudioStatus.label}
          </div>

          {sharedTrackProgress.duration > 0 ? (
            <div className="mb-3">
              <div
                ref={sharedProgressBarRef}
                className="position-relative"
                onPointerDown={(e) => {
                  e.preventDefault();
                  scrubbingRef.current = true;
                  seekToClientX(e.clientX, sharedProgressBarRef.current);
                }}
                style={{
                  height: '8px',
                  background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                <div
                  className="position-absolute"
                  style={{
                    height: '100%',
                    width: `${(sharedTrackProgress.current / sharedTrackProgress.duration) * 100}%`,
                    borderRadius: '6px',
                    transition: 'width 0.1s linear',
                    background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                  }}
                />
                <div
                  className="position-absolute"
                  style={{
                    top: '50%',
                    left: `${(sharedTrackProgress.current / sharedTrackProgress.duration) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    width: '52px',
                    height: '52px',
                    borderRadius: '50%',
                    backgroundImage: 'url(/download.png)',
                    backgroundSize: 'contain',
                    backgroundRepeat: 'no-repeat',
                    cursor: 'grab',
                    pointerEvents: 'none'
                  }}
                />
              </div>
              <div className="d-flex justify-content-between mt-1">
                <span className="text-muted small" style={{ fontSize: '11px' }}>
                  {formatTime(sharedTrackProgress.current)}
                </span>
                <span className="text-muted small" style={{ fontSize: '11px' }}>
                  {formatTime(sharedTrackProgress.duration)}
                </span>
              </div>
            </div>
          ) : channelPlayerState?.is_playing ? (
            <div className="mb-3">
              <div
                className="position-relative"
                style={{
                  height: '8px',
                  background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
                  borderRadius: '6px'
                }}
              >
                <div
                  className="position-absolute"
                  style={{
                    height: '100%',
                    width: `${((sharedTrackProgress.current % 10) / 10) * 100}%`,
                    borderRadius: '6px',
                    transition: 'width 0.15s linear',
                    background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                  }}
                />
              </div>
              <div className="d-flex justify-content-between mt-1">
                <span className="text-muted small" style={{ fontSize: '11px' }}>
                  {formatTime(sharedTrackProgress.current)}
                </span>
                <span className="text-muted small" style={{ fontSize: '11px' }}>
                  ?
                </span>
              </div>
            </div>
          ) : activeSharedTrack ? (
            <div className="text-muted small text-center mb-3">ready to play</div>
          ) : (
            <div className="text-muted small text-center mb-3">pick a track from the shared queue</div>
          )}

          <div className="d-flex justify-content-center align-items-center gap-2 mb-3">
            <Button
              variant="outline-light"
              size="sm"
              disabled
              style={{
                borderRadius: '6px',
                width: '36px',
                height: '36px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title="shared shuffle is not available"
            >
              {SVGIcons.shuffle}
            </Button>
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => stepSharedPlayback(-1)}
              disabled={!channelQueue.length}
              style={{
                borderRadius: '6px',
                width: '36px',
                height: '36px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title="previous"
            >
              {SVGIcons.previous}
            </Button>
            <Button
              variant="outline-light"
              size="sm"
              onClick={toggleSharedPlayback}
              disabled={!channelQueue.length}
              style={{
                borderRadius: '6px',
                width: '45px',
                height: '45px',
                padding: 0,
                color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                border: `1px solid ${dimBorderColor(themeColor)}`,
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title="play/pause (Space)"
            >
              {channelPlayerState?.is_playing ? SVGIcons.pause : SVGIcons.play}
            </Button>
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => stepSharedPlayback(1)}
              disabled={!channelQueue.length}
              style={{
                borderRadius: '6px',
                width: '36px',
                height: '36px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title="next"
            >
              {SVGIcons.next}
            </Button>
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => {
                setSharedRepeatMode((prev) => {
                  if (prev === 'off') return 'all';
                  if (prev === 'all') return 'one';
                  return 'off';
                });
              }}
              active={sharedRepeatMode !== 'off'}
              style={{
                borderRadius: '6px',
                width: '36px',
                height: '36px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              title={`repeat: ${sharedRepeatMode === 'off' ? 'off' : sharedRepeatMode === 'all' ? 'all' : 'one'}`}
            >
              {sharedRepeatMode === 'one' ? SVGIcons.repeatOne : SVGIcons.repeat}
            </Button>
          </div>

          <div className="d-flex align-items-center gap-2 mb-3">
            <Button
              variant="outline-light"
              size="sm"
              onClick={toggleMute}
              active={isMuted}
              style={{ borderRadius: '6px', minWidth: '48px', padding: '0 8px' }}
              title="mute (M)"
            >
              {isMuted || volume === 0 ? SVGIcons.mute : SVGIcons.volume}
            </Button>
            <input
              type="range"
              className="volume-slider"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={(e) => setPlayVolume(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="text-muted small" style={{ minWidth: '40px', textAlign: 'right' }}>
              {Math.round((isMuted ? 0 : volume) * 100)}%
            </span>
          </div>
        </>
      )
    ),
    collabplaylists: renderPanelCard('collab', 'collabplaylists', '',
      !currentChannel ? (
        renderMessageGuide('collab', 'join a channel to use collab playlists', 'shared playlists will show up here')
      ) : (
        <>
          <div className="d-flex justify-content-end mb-3">
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => setShowCollabPlaylistModal(true)}
              style={{
                borderRadius: '6px',
                color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                border: `1px solid ${dimBorderColor(themeColor)}`,
                background: 'transparent',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.target.style.color = '#000';
                e.target.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
              }}
              onMouseLeave={(e) => {
                e.target.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                e.target.style.background = 'transparent';
              }}
            >
              {SVGIcons.plus} new
            </Button>
          </div>

          <div className="d-flex gap-2 mb-3 flex-wrap">
            {playlists.map((playlist) => {
              const isCollabType = playlist.type === 'collab';
              const canEdit = isCollabType ? canEditCollabPlaylist(playlist) : true;
              return (
                <div
                  key={playlist.id}
                  className={`playlist-tab ${currentCollabPlaylistId === playlist.id ? 'active' : ''}`}
                  onClick={() => setCurrentCollabPlaylistId(playlist.id)}
                  style={{
                    padding: '8px 16px',
                    background: currentCollabPlaylistId === playlist.id ? `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)` : 'transparent',
                    border: `1px solid ${dimBorderColor(themeColor)}`,
                    borderRadius: '6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: currentCollabPlaylistId === playlist.id ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : '#ccc',
                    transition: 'all 0.2s ease'
                  }}
                >
                  {isCollabType ? SVGIcons.collabPlaylist : SVGIcons.folder}
                  {playlist.name}
                  {isCollabType && !canEdit && (
                    <span style={{ fontSize: '9px', color: '#9ca3af' }}>(read-only)</span>
                  )}
                  {isCollabType && canEdit && (
                    <Dropdown align="end" className="d-inline ms-1">
                      <Dropdown.Toggle as="span" className="border-0 bg-transparent p-0" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer', transition: 'color 0.2s ease' }} onMouseEnter={(e) => {
                        e.target.style.color = '#000';
                      }} onMouseLeave={(e) => {
                        e.target.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                      }}>
                        {SVGIcons.dots}
                      </Dropdown.Toggle>
                      <Dropdown.Menu className="glass-dark">
                        <Dropdown.Item onClick={() => {
                          const newName = prompt('rename playlist:', playlist.name);
                          if (newName) renameCollabPlaylist(playlist.id, newName);
                        }}>
                          rename
                        </Dropdown.Item>
                        <Dropdown.Item
                          onClick={() => deleteCollabPlaylist(playlist.id)}
                          className="text-danger"
                        >
                          delete
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown>
                  )}
                </div>
              );
            })}
          </div>

          {currentCollabTracks.length > 0 ? (
            <ListGroup variant="flush" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {currentCollabTracks.map((track, idx) => {
                const isCollabType = currentCollabPlaylist?.type === 'collab';
                const canEdit = isCollabType ? canEditCollabPlaylist(currentCollabPlaylist) : true;
                return (
                  <ListGroup.Item
                    key={`${getTrackKey(track)}-${idx}`}
                    className="track-item border-0 d-flex justify-content-between align-items-start"
                    draggable={canEdit}
                    onDragStart={(e) => handleCollabPlaylistDragStart(e, idx)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(e) => handleCollabPlaylistDrop(e, idx)}
                  >
                    <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px', marginRight: '12px', display: 'flex', flexShrink: 0 }}>
                      {canEdit && (
                        <Button
                          variant="outline-light"
                          size="sm"
                          className="trash-btn btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTrackFromCollabPlaylist(idx);
                          }}
                          style={{
                            borderRadius: '6px',
                            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                            border: `1px solid ${dimBorderColor(themeColor)}`,
                            background: 'transparent',
                            transition: 'all 0.2s ease',
                            transform: 'scale(1)',
                            padding: '4px 8px'
                          }}
                          onMouseEnter={(e) => {
                            e.target.style.transform = 'scale(1.15)';
                          }}
                          onMouseLeave={(e) => {
                            e.target.style.transform = 'scale(1)';
                          }}
                        >
                          {SVGIcons.trash}
                        </Button>
                      )}
                    </div>
                    <div className="d-flex align-items-center gap-2" style={{ flex: 1 }}>
                      {canEdit && (
                        <span className="drag-handle tooltip" data-tooltip="drag to reorder" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'grab' }}>
                          {SVGIcons.drag}
                        </span>
                      )}
                      <div style={{ flex: 1 }}>
                        <div className="fw-bold text-truncate" style={{ maxWidth: '200px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
                          {track.title}
                        </div>
                        <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.author}</div>
                      </div>
                    </div>
                  </ListGroup.Item>
                );
              })}
            </ListGroup>
          ) : (
            <div className="text-center text-muted py-4">
              <div className="small">this playlist is empty</div>
            </div>
          )}

          {currentCollabTracks.length > 0 && (
            <div className="d-flex justify-content-between align-items-center mt-3">
              <span className="text-muted small">{currentCollabTracks.length} tracks</span>
              <div className="d-flex gap-2">
                {(() => {
                  const isCollabType = currentCollabPlaylist?.type === 'collab';
                  const canEdit = isCollabType ? canEditCollabPlaylist(currentCollabPlaylist) : true;
                  return canEdit ? (
                    <>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => {
                          if (!channelQueue.length) {
                            showNotification('shared queue is empty', 'warning');
                            return;
                          }
                          const playlist = playlists.find((p) => p.id === currentCollabPlaylistId);
                          setPlaylists((prev) => prev.map((p) =>
                            p.id === currentCollabPlaylistId
                              ? { ...p, tracks: [...p.tracks, ...channelQueue.map((t) => ({ ...normalizeTrack(t), addedAt: Date.now() }))] }
                              : p
                          ));
                          showNotification(`added ${channelQueue.length} tracks to "${playlist?.name}"`, 'success');
                          if (isCollabType) {
                            try {
                              wsRef.current?.send(JSON.stringify({
                                type: 'collab_playlist_add_all',
                                serverId: currentChannelId,
                                playlistId: currentCollabPlaylistId,
                                tracks: channelQueue.map((t) => normalizeTrack(t))
                              }));
                            } catch {}
                          }
                        }}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        add all from queue
                      </Button>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={loadCollabPlaylistToQueue}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        load to queue
                      </Button>
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={clearCollabPlaylist}
                        style={{ borderRadius: '6px' }}
                      >
                        clear playlist
                      </Button>
                    </>
                  ) : null;
                })()}
              </div>
            </div>
          )}
        </>
      )
    )
  };
  const collabPanelOrder = ['setup', 'queue', 'chat', 'player', 'collabplaylists'];
  const collabLeftPanelIds = collabPanelOrder.filter((panelId) => collabPanelSides[panelId] !== 'right');
  const collabRightPanelIds = collabPanelOrder.filter((panelId) => collabPanelSides[panelId] === 'right');
  const collabLayoutStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '22px',
    alignItems: 'start',
    width: '100%',
    maxWidth: '100%',
    margin: 0
  };
  const collabView = (
    <div style={collabLayoutStyle}>
      {renderPanelColumn('collab', 'left', collabLeftPanelIds, collabPanels)}
      {renderPanelColumn('collab', 'right', collabRightPanelIds, collabPanels)}
    </div>
  );

  // chat username popup data
  const chatPopupUserData = (() => {
    if (!chatUserPopup?.userId) return null;
    const member = currentChannelMembers.find((m) => m.user_id === chatUserPopup.userId);
    const allUser = allUsers.find((u) => u.id === chatUserPopup.userId);
    const joinedTimestamp = member?.joined_at || allUser?.created_at || 0;
    const joinedAt = joinedTimestamp ? new Date(joinedTimestamp * 1000).toLocaleString() : 'unknown';
    const isOnline = member?.is_online || allUser?.is_online || false;
    const currentServerId = member?.current_server_id || allUser?.current_server_id || null;
    const listeningActivity = member?.listening_to || allUser?.listening_to || null;
    let status = 'offline';
    if (isOnline) {
      if (listeningActivity) {
        status = (listeningActivity.is_playing === false ? 'paused on: ' : 'listening to: ') + formatListeningActivity(listeningActivity);
      } else {
        status = currentServerId ? 'online in a channel' : 'online';
      }
    }
    return {
      username: chatUserPopup.username,
      joinedAt,
      status,
      listeningTo: listeningActivity
        ? {
            label: formatListeningActivity(listeningActivity),
            prefix: listeningActivity.is_playing === false ? 'paused on' : 'listening to'
          }
        : null
    };
  })();

  return (
    <ErrorBoundary>
      <Container className="py-4" style={{ maxWidth: '1200px' }} onClick={() => setChatUserPopup(null)}>
      {/* version mismatch notification */}
      {versionMismatch && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(680px, calc(100% - 32px))',
            background: 'rgba(0, 0, 0, 0.94)',
            border: `1px solid ${dimBorderColor(themeColor)}`,
            borderRadius: '12px',
            boxShadow: `0 0 20px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.18)`,
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            padding: '12px 16px',
            zIndex: 2000,
            fontSize: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            backdropFilter: 'blur(6px)'
          }}
        >
          <span style={{ fontWeight: 'bold', letterSpacing: '0.2px' }}>new version {latestVersion} available</span>
          <button
            onClick={() => {
              window.location.reload();
            }}
            style={{
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              borderRadius: '6px',
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 'bold',
              padding: '6px 12px',
              transition: 'all 0.2s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
              e.currentTarget.style.color = '#000';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
            }}
          >
            refresh now
          </button>
          <button
            onClick={() => setVersionMismatch(false)}
            style={{
              background: 'transparent',
              border: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.35)`,
              borderRadius: '6px',
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              cursor: 'pointer',
              fontSize: '0px',
              fontWeight: 'bold',
              lineHeight: 1,
              padding: '6px 10px',
              transition: 'all 0.2s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
              e.currentTarget.style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.35)`;
              e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
            }}
          >
            <span style={{ fontSize: '14px' }}>x</span>

          </button>
        </div>
      )}

      {}
      <canvas
        ref={particleCanvasRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0
        }}
      />

      {}
      <div
        className="top-nav-bar"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '60px',
          background: '#000000',
          borderBottom: `2px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: '20px',
          boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)'
        }}
      >
        {}
        <button
          className="settings-menu-btn"
          style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}
          onClick={() => setShowSettingsModal(true)}
          aria-label="open settings"
        >
          {SVGIcons.hamburger}
        </button>

        {}
        <span style={{
          color: user ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.6)`,
          fontSize: '13px',
          fontWeight: user ? 'bold' : 'normal'
        }}>
          {user ? user.username : 'not signed in'}
        </span>

        {}
        <div style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center'
        }}>
          <span style={{
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            fontSize: '14px',
            fontWeight: 'bold',
            letterSpacing: '0.5px'
          }}>
            Shibenchi's music player
          </span>
        </div>

        {}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {['main', 'social', 'collab'].map((tab) => {
            const badgeCount = tab === 'social' ? unreadDmCount : tab === 'collab' ? unreadChannelCount : 0;
            const isDisabledFeature = tab === 'social' || tab === 'collab';
            return (
              <div key={tab} style={{ position: 'relative' }}>
                <button
                  onClick={(event) => {
                    if (isDisabledFeature) {
                      showDisabledNotice(tab, true, event);
                      return;
                    }
                    setActiveTab(tab);
                  }}
                  onMouseMove={isDisabledFeature ? updateDisabledNoticePos : undefined}
                  style={{
                    padding: '6px 10px',
                    border: '1px solid',
                    borderColor: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    borderRadius: '6px',
                    background: activeTab === tab ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                    color: activeTab === tab ? '#000' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    cursor: 'pointer',
                    fontSize: '12px',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  {tab === 'main' ? 'home' : tab}
                  {badgeCount > 0 && (
                    <span style={{
                      background: '#ef4444',
                      color: '#fff',
                      fontSize: '9px',
                      fontWeight: 'bold',
                      borderRadius: '10px',
                      padding: '1px 5px',
                      lineHeight: '1',
                      minWidth: '16px',
                      textAlign: 'center'
                    }}>
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </button>
                {isDisabledFeature && renderDisabledNotice(tab)}
              </div>
            );
          })}
        </div>

        {}
        <div style={{ minWidth: '100px' }} />
      </div>

      {}
      <div style={{ height: '60px' }} />

      {}
      <Modal
        show={showSettingsModal}
        onHide={() => setShowSettingsModal(false)}
        centered
        className="settings-modal"
        dialogClassName="settings-modal-dialog"
        animation={false}
      >
        <Modal.Header closeButton style={{ borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)` }}>
          <Modal.Title style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '18px' }}>settings</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, color: '#fff', padding: '24px' }}>
          {}
          <div
            style={{ marginBottom: '30px', position: 'relative' }}
            onMouseEnter={(event) => showDisabledNotice('login', false, event)}
            onMouseMove={updateDisabledNoticePos}
            onMouseLeave={() => hideDisabledNotice('login')}
          >
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>account</h4>
            <AuthForm
              user={user}
              onAuthSuccess={onLogin}
              onLogout={onLogout}
              themeColor={themeColor}
            />
            {renderDisabledNotice('login')}
          </div>

          {}
          <div style={{ marginBottom: '30px' }}>
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>theme color</h4>

            {}
            <div
              style={{
                width: '100%',
                height: '60px',
                background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 'bold',
                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
                fontSize: '12px'
              }}
            >
              rgb({themeColor.r}, {themeColor.g}, {themeColor.b})
            </div>

            {}
            <div style={{ marginTop: '15px' }}>
              <input
                type="range"
                min="0"
                max="360"
                value={(() => {
                  const r = themeColor.r / 255;
                  const g = themeColor.g / 255;
                  const b = themeColor.b / 255;
                  const max = Math.max(r, g, b);
                  const min = Math.min(r, g, b);
                  let h = 0;
                  if (max !== min) {
                    const d = max - min;
                    switch (max) {
                      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                      case g: h = ((b - r) / d + 2) / 6; break;
                      case b: h = ((r - g) / d + 4) / 6; break;
                    }
                  }
                  return Math.round(h * 360);
                })()}
                onChange={(e) => {
                  const hue = parseInt(e.target.value);
                  
                  const s = 1;
                  const l = 0.5;
                  const c = (1 - Math.abs(2 * l - 1)) * s;
                  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
                  const m = l - c / 2;
                  let r, g, b;
                  if (hue < 60) { r = c; g = x; b = 0; }
                  else if (hue < 120) { r = x; g = c; b = 0; }
                  else if (hue < 180) { r = 0; g = c; b = x; }
                  else if (hue < 240) { r = 0; g = x; b = c; }
                  else if (hue < 300) { r = x; g = 0; b = c; }
                  else { r = c; g = 0; b = x; }
                  handleThemeColorChange({
                    r: Math.round((r + m) * 255),
                    g: Math.round((g + m) * 255),
                    b: Math.round((b + m) * 255)
                  });
                }}
                style={{
                  width: '100%',
                  height: '24px',
                  borderRadius: '6px',
                  background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
                  outline: 'none',
                  cursor: 'pointer',
                  WebkitAppearance: 'none',
                  appearance: 'none'
                }}
              />
              <style>{`
                input[type="range"]::-webkit-slider-thumb {
                  -webkit-appearance: none;
                  appearance: none;
                  width: 28px;
                  height: 28px;
                  border-radius: 50%;
                  background: #fff;
                  border: 3px solid #000;
                  cursor: pointer;
                  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
                }
                input[type="range"]::-moz-range-thumb {
                  width: 28px;
                  height: 28px;
                  border-radius: 50%;
                  background: #fff;
                  border: 3px solid #000;
                  cursor: pointer;
                  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
                }
              `}</style>
            </div>

            {}
            <button
              onClick={async () => {
                await handleThemeColorChange(themeColor);
                await syncPersonalQueueNow('theme save');
                showNotification('theme color saved to account!', 'success');
              }}
              style={{
                width: '100%',
                padding: '10px',
                marginTop: '15px',
                background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                border: 'none',
                borderRadius: '6px',
                color: '#000',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 'bold',
                boxShadow: `0 10px 24px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.28)`,
                transform: 'translateY(0)',
                transition: 'transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#000';
                e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = `0 14px 30px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.4)`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                e.currentTarget.style.color = '#000';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = `0 10px 24px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.28)`;
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'translateY(1px) scale(0.985)';
                e.currentTarget.style.boxShadow = `0 6px 16px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.22)`;
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = `0 14px 30px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.4)`;
              }}
            >
              save theme
            </button>
          </div>

          {}
          <button
            onClick={() => handleThemeColorChange({ r: 255, g: 89, b: 0 })}
            style={{
              width: '100%',
              padding: '12px',
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              borderRadius: '6px',
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              cursor: 'pointer',
              fontSize: '14px',
              marginBottom: '15px'
            }}
          >
            reset to default
          </button>

          {}
          <div style={{ marginBottom: '30px' }}>
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>background animation</h4>
            <Dropdown>
              <Dropdown.Toggle
                as="button"
                type="button"
                className="w-100 border-0"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  background: `linear-gradient(135deg, rgb(${themeColor.r}, ${Math.max(0, themeColor.g - 50)}, ${Math.max(0, themeColor.b - 50)}), rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b}))`,
                  color: '#000',
                  fontWeight: 'bold',
                  fontSize: '14px'
                }}
              >
                <span>{VISUALIZER_PRESETS.find((p) => p.key === visualizerPreset)?.label || visualizerPreset}</span>
              </Dropdown.Toggle>
              <Dropdown.Menu
                style={{
                  width: '100%',
                  maxHeight: '320px',
                  overflowY: 'auto',
                  background: '#0a0a0a',
                  border: `1px solid ${dimBorderColor(themeColor)}`
                }}
              >
                {VISUALIZER_PRESETS.map((preset) => (
                  <Dropdown.Item
                    key={preset.key}
                    active={visualizerPreset === preset.key}
                    onClick={() => setVisualizerPreset(preset.key)}
                    title={preset.description}
                    style={{
                      fontWeight: 'bold',
                      color: visualizerPreset === preset.key ? '#000' : '#fff',
                      background: visualizerPreset === preset.key ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent'
                    }}
                  >
                    {preset.label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          </div>

          {isTauriDesktop && (
            <div style={{ marginBottom: '30px' }}>
              <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>downloads folder</h4>
              <div
                title={downloadsFolder}
                style={{
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  background: 'rgba(0, 0, 0, 0.3)',
                  color: '#fff',
                  fontSize: '12px',
                  marginBottom: '10px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {downloadsFolder || 'not set yet'}
              </div>
              <button
                onClick={handleChangeDownloadsFolder}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: 'transparent',
                  border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  cursor: 'pointer',
                  fontSize: '13px',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                  e.currentTarget.style.color = '#000';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                }}
              >
                change folder
              </button>
            </div>
          )}

          {}
          <div style={{ marginBottom: '15px' }}>
            <button
              onClick={() => {
                const newMode = !debugMode;
                if (onDebugModeToggle) {
                  onDebugModeToggle(newMode);
                }
                addDebugLog('settings', `debug mode ${newMode ? 'enabled' : 'disabled'}`, { nextMode: newMode }, true);
              }}
              style={{
                width: '100%',
                padding: '12px',
                background: debugMode ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                border: `1px solid ${dimBorderColor(themeColor)}`,
                borderRadius: '6px',
                color: debugMode ? '#000000' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: debugMode ? 'bold' : 'normal'
              }}
            >
              debug logs: {debugMode ? 'ON' : 'OFF'}
            </button>
          </div>
        </Modal.Body>
      </Modal>

      {debugMode && (
        <div
          ref={debugConsoleRef}
          style={{
            position: 'fixed',
            ...(debugConsolePos
              ? { left: debugConsolePos.x, top: debugConsolePos.y }
              : { right: 18, bottom: 18 }),
            width: '820px',
            height: '380px',
            minWidth: '360px',
            minHeight: '200px',
            resize: 'both',
            overflow: 'auto',
            zIndex: 1200,
            border: '1px solid #808080',
            background: '#000000',
            borderRadius: 0,
            fontFamily: '"Courier New", Courier, monospace',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <div
            onMouseDown={handleDebugConsoleDragStart}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '4px 8px',
              borderBottom: '1px solid #808080',
              background: dimBorderColor(themeColor, 0.35, 0.9),
              alignItems: 'center',
              flexWrap: 'wrap',
              flexShrink: 0,
              cursor: 'move',
              userSelect: 'none'
            }}
          >
            <div>
              <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>debug console</div>
              <div style={{ color: '#c0c0c0', fontSize: '10px', marginTop: '2px' }}>
                socket: {isConnected ? 'connected' : 'disconnected'} | frontend logs: {debugEntries.length} | backend logs: {backendDebugLoadedAt ? `loaded ${new Date(backendDebugLoadedAt).toLocaleTimeString()}` : 'not loaded'}
              </div>
            </div>
            <div onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={refreshBackendDebugLogs}
                disabled={backendDebugLoading}
                style={{ ...debugConsoleButtonStyle, opacity: backendDebugLoading ? 0.6 : 1 }}
              >
                {backendDebugLoading ? 'loading backend...' : 'refresh backend logs'}
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(buildAllDebugLogsText()).then(() => {
                    showNotification('debug logs copied to clipboard', 'success');
                  }).catch(() => {
                    showNotification('failed to copy debug logs', 'error');
                  });
                }}
                style={debugConsoleButtonStyle}
              >
                copy all logs
              </button>
              <button
                onClick={async () => {
                  const text = buildAllDebugLogsText();
                  const filename = `shibenchi-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
                  try {
                    if (isTauriDesktop) {
                      const saved = await saveFileWithDialog(filename, new TextEncoder().encode(text));
                      if (saved) showNotification('debug logs saved', 'success');
                    } else {
                      const blob = new Blob([text], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = filename;
                      a.click();
                      URL.revokeObjectURL(url);
                      showNotification('debug logs saved', 'success');
                    }
                  } catch {
                    showNotification('failed to save debug logs', 'error');
                  }
                }}
                style={debugConsoleButtonStyle}
              >
                save logs to file
              </button>
              <button
                onClick={() => {
                  setDebugEntries([]);
                  localStorage.removeItem('music_frontend_debug_logs');
                }}
                style={{ ...debugConsoleButtonStyle, color: '#ff5555', borderColor: '#ff5555' }}
              >
                clear frontend logs
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0',
              flex: 1,
              minHeight: 0
            }}
          >
            <div style={{ borderRight: '1px solid #808080', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '4px 8px', color: '#000', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#808080', flexShrink: 0 }}>
                frontend
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
                {recentDebugEntries.length === 0 ? (
                  <div style={{ color: '#808080', fontSize: '11px' }}>no frontend logs yet</div>
                ) : recentDebugEntries.map((entry) => (
                  <div key={entry.id} style={{ padding: '4px 0', borderBottom: '1px dotted #333' }}>
                    <div style={{ color: entry.category === 'error' ? '#ff5555' : '#00ff41', fontSize: '10px' }}>
                      {entry.ts} [{entry.category}]
                    </div>
                    <div style={{ color: '#c0c0c0', fontSize: '11px', marginTop: '2px', wordBreak: 'break-word' }}>{entry.message}</div>
                    {entry.details ? (
                      <div style={{ color: '#808080', fontSize: '10px', marginTop: '2px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {formatDebugDetails(entry.details)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '4px 8px', color: '#000', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#808080', flexShrink: 0 }}>
                backend
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
                {backendDebugError ? (
                  <div style={{ color: '#ff5555', fontSize: '11px', whiteSpace: 'pre-wrap' }}>{backendDebugError}</div>
                ) : backendDebugSnapshot ? (
                  <pre style={{ margin: 0, color: '#c0c0c0', fontSize: '10px', fontFamily: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {backendDebugSnapshot}
                  </pre>
                ) : (
                  <div style={{ color: '#808080', fontSize: '11px' }}>no backend logs loaded yet</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ height: '60px' }} />

      <div style={{ marginBottom: '8px', display: 'none' }}>
        {/* Tabs are now in top header bar */}
      </div>

      {activeTab === 'main' && (
        <div className="main-content">
          <div className="row g-4">
            <div className="col-lg-6">
            {}
            <Card className="glass card-hover shadow-sm border-0">
              <Card.Body>
                {}
                <Form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAddToQueue();
                  }}
                >

                  <Form.Group className="mb-3">
                    <Form.Control
                      value={query}
                      onChange={(e) => {
                        handleQueryChange(e.target.value);
                        setShowSuggestions(true);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      placeholder="search song title or just paste a link (playlist links supported)"
                      style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}
                      disabled={isDownloading || isQueueRunning}
                      autoComplete="off"
                      className="modern-input"
                    />
                  </Form.Group>

                  {isSuggesting && (
                    <div className="text-muted small mb-2 animate-pulse">
                      <span className="equalizer me-2">
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className="equalizer-bar" />
                        ))}
                      </span>
                      searching...
                    </div>
                  )}

                  {suggestions.length > 0 && showSuggestions && (
                    <ListGroup className="mb-3 glass-dark" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                      {suggestions.map((result) => (
                        <ListGroup.Item
                          key={result.videoId || result.playlistId}
                          className="search-result-item border-0"
                          onClick={() => {
                            if (result.playlistId) {
                              enqueuePlaylist(result.playlistId);
                            } else {
                              enqueue(result);
                            }
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <div className="fw-semibold text-truncate" style={{ maxWidth: '250px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
                              {result.title}
                            </div>
                            <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{result.author}</div>
                          </div>
                          <div className="btn-group">
                            {result.playlistId ? (
                              <Button
                                variant="outline-light"
                                size="sm"
                                type="button"
                                className="tooltip"
                                data-tooltip="add playlist to queue"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  enqueuePlaylist(result.playlistId);
                                }}
                                style={{ borderRadius: '6px' }}
                              >
                                {SVGIcons.folder}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="outline-light"
                                  size="sm"
                                  type="button"
                                  className="tooltip"
                                  data-tooltip="add to queue"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    enqueue(result);
                                  }}
                                  style={{ borderRadius: '6px' }}
                                >
                                  {SVGIcons.list}
                                </Button>
                                <Button
                                  variant="outline-light"
                                  size="sm"
                                  type="button"
                                  className="tooltip"
                                  data-tooltip="download"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    downloadSingle(result);
                                  }}
                                  style={{ borderRadius: '6px' }}
                                >
                                  {SVGIcons.download}
                                </Button>
                                <Button
                                  variant="outline-light"
                                  size="sm"
                                  type="button"
                                  className="tooltip"
                                  data-tooltip="add to playlist"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    addTrackToPlaylist(result);
                                  }}
                                  style={{ borderRadius: '6px' }}
                                >
                                  {SVGIcons.arrowDown}
                                </Button>
                              </>
                            )}
                          </div>
                        </ListGroup.Item>
                      ))}
                    </ListGroup>
                  )}

                  {}
                </Form>

                {(isDownloading || isQueueRunning) && (
                  <div
                    className="mt-3"
                    style={{
                      padding: '12px 14px',
                      borderRadius: 'var(--border-radius-md)',
                      border: `1px solid ${dimBorderColor(themeColor)}`,
                      background: 'rgba(0, 0, 0, 0.3)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                      <span style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '12px', fontWeight: 'bold' }}>
                        downloading{progress.total ? ` — ${Math.round((progress.loaded / progress.total) * 100)}%` : '...'}
                      </span>
                      <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                        {progress.total
                          ? `${Math.round(progress.loaded / 1024)} kb / ${Math.round(progress.total / 1024)} kb`
                          : `${Math.round(progress.loaded / 1024)} kb downloaded`}
                      </span>
                    </div>
                    <div style={{ height: '10px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.08)', overflow: 'hidden', position: 'relative' }}>
                      {progress.total ? (
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.min(100, (progress.loaded / progress.total) * 100)}%`,
                            background: `linear-gradient(90deg, rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b}), rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.6))`,
                            borderRadius: '6px',
                            transition: 'width 0.3s ease'
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            height: '100%',
                            width: '40%',
                            background: `linear-gradient(90deg, rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b}), rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.6))`,
                            borderRadius: '6px',
                            animation: 'download-progress-indeterminate 1.4s ease-in-out infinite'
                          }}
                        />
                      )}
                    </div>
                  </div>
                )}

                {}
                {queue.length > 0 && (
                  <>
                    <hr style={{ border: 'none', borderTop: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, margin: '20px 0' }} />
                    <QueueList
                      queue={queue}
                      currentIndex={currentIndex}
                      themeColor={themeColor}
                      onPlayTrack={(idx) => playTrackAtIndex(idx, queue, { source: 'personal' })}
                      onRemoveTrack={removeFromQueue}
                      onAddToPlaylist={addTrackToPlaylist}
                      onDownloadSingle={downloadSingle}
                      isDownloading={isDownloading}
                      isQueueRunning={isQueueRunning}
                      onProcessQueue={processQueue}
                      onAddAllToPlaylist={addAllToPlaylist}
                      onClearQueue={clearQueue}
                    />
                  </>
                )}
              </Card.Body>
            </Card>
          </div>

          {}
          <div className="col-lg-6">
            {}
            <Card className="glass card-hover shadow-sm border-0 mb-4">
              <Card.Body>
                {}
                  <div className="d-flex justify-content-center mb-3">
                    <div className={`vinyl-record ${isPlaying ? '' : 'paused'}`}>
                      {getCurrentTrack() && (
                        <TrackThumbnail track={getCurrentTrack()} className="record-thumb" alt="thumbnail" />
                      )}
                    </div>
                </div>

                {}
                {getCurrentTrack() && (
                  <div className="text-center mb-3">
                    <div className="fw-bold text-truncate" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{getCurrentTrack().title}</div>
                    <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{getCurrentTrack().author}</div>
                  </div>
                )}

                {}
                {trackProgress.duration > 0 ? (
                  <div className="mb-3">
                    <div
                      ref={personalProgressBarRef}
                      className="position-relative"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        scrubbingRef.current = true;
                        seekToClientX(e.clientX, personalProgressBarRef.current);
                      }}
                      style={{
                        height: '8px',
                        background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
                        borderRadius: '6px',
                        cursor: 'pointer'
                      }}
                    >
                      <div
                        className="position-absolute"
                        style={{
                          height: '100%',
                          width: `${(trackProgress.current / trackProgress.duration) * 100}%`,
                          borderRadius: '6px',
                          transition: 'width 0.1s linear',
                          background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                        }}
                      />
                      <div
                        className="position-absolute"
                        style={{
                          top: '50%',
                          left: `${(trackProgress.current / trackProgress.duration) * 100}%`,
                          transform: 'translate(-50%, -50%)',
                          width: '52px',
                          height: '52px',
                          borderRadius: '50%',
                          backgroundImage: 'url(/download.png)',
                          backgroundSize: 'contain',
                          backgroundRepeat: 'no-repeat',
                          cursor: 'grab',
                          pointerEvents: 'none'
                        }}
                      />
                    </div>
                    <div className="d-flex justify-content-between mt-1">
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        {formatTime(trackProgress.current)}
                      </span>
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        {formatTime(trackProgress.duration)}
                      </span>
                    </div>
                  </div>
                ) : isPlaying ? (
                  <div className="mb-3">
                    <div
                      className="position-relative"
                      style={{
                        height: '8px',
                        background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
                        borderRadius: '6px'
                      }}
                    >
                      <div
                        className="position-absolute"
                        style={{
                          height: '100%',
                          width: `${((trackProgress.current % 10) / 10) * 100}%`,
                          borderRadius: '6px',
                          transition: 'width 0.15s linear',
                          background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                        }}
                      />
                    </div>
                    <div className="d-flex justify-content-between mt-1">
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        {formatTime(trackProgress.current)}
                      </span>
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        ?
                      </span>
                    </div>
                  </div>
                ) : isBuffering ? (
                  <div className="text-muted small text-center mb-3">buffering...</div>
                ) : getCurrentTrack() ? (
                  // used to just render nothing here whenever duration/isPlaying/
                  // isBuffering all happened to be false at once (e.g. right after
                  // a failed stream) — that was the actual "entire play bar
                  // disappears" bug. theres still a real track selected in that
                  // state, so always show SOMETHING instead of silently vanishing
                  <div className="text-muted small text-center mb-3">playback stopped — hit play to retry</div>
                ) : null}

                {}
                <div className="d-flex justify-content-center align-items-center gap-2 mb-3">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={() => {
                      addDebugLog('playback', `shuffle ${!shuffle ? 'enabled' : 'disabled'}`);
                      setShuffle((s) => !s);
                    }}
                    active={shuffle}
                    style={{
                      borderRadius: '6px',
                      width: '36px',
                      height: '36px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="shuffle (S)"
                  >
                    {SVGIcons.shuffle}
                  </Button>
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={handlePrevious}
                    disabled={!queue.length}
                    style={{
                      borderRadius: '6px',
                      width: '36px',
                      height: '36px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="previous"
                  >
                    {SVGIcons.previous}
                  </Button>
                  {}
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={togglePlayPause}
                    disabled={!queue.length}
                    style={{
                      borderRadius: '6px',
                      width: '45px',
                      height: '45px',
                      padding: 0,
                      color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                      border: `1px solid ${dimBorderColor(themeColor)}`,
                      background: 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="play/pause (Space)"
                  >
                    {isPlaying ? SVGIcons.pause : SVGIcons.play}
                  </Button>
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={handleNext}
                    disabled={!queue.length}
                    style={{
                      borderRadius: '6px',
                      width: '36px',
                      height: '36px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="next"
                  >
                    {SVGIcons.next}
                  </Button>
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={cycleRepeatMode}
                    active={repeatMode !== 'off'}
                    style={{
                      borderRadius: '6px',
                      width: '36px',
                      height: '36px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title={`repeat: ${REPEAT_MODES[repeatMode].label} (R)`}
                  >
                    {repeatMode === 'one' ? SVGIcons.repeatOne : SVGIcons.repeat}
                  </Button>
                </div>

                {}
                <div className="d-flex align-items-center gap-2 mb-3">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={toggleMute}
                    active={isMuted}
                    style={{ borderRadius: '6px', minWidth: '48px', padding: '0 8px' }}
                    title="mute (M)"
                  >
                    {isMuted || volume === 0 ? SVGIcons.mute : SVGIcons.volume}
                  </Button>
                  <input
                    type="range"
                    className="volume-slider"
                    min="0"
                    max="1"
                    step="0.01"
                    value={isMuted ? 0 : volume}
                    onChange={(e) => setPlayVolume(Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span className="text-muted small" style={{ minWidth: '40px', textAlign: 'right' }}>
                    {Math.round((isMuted ? 0 : volume) * 100)}%
                  </span>
                </div>

                {}
                <div className="d-flex gap-2">
                  <Button
                    variant={eqEnabled ? 'success' : 'outline-light'}
                    size="sm"
                    onClick={() => {
                      setEqEnabled(!eqEnabled);
                      setShowEQ(!showEQ);
                    }}
                    style={{ borderRadius: '6px', flex: 1 }}
                  >
                    eq {eqEnabled ? 'on' : 'off'}
                  </Button>
                </div>

                {}
                {showEQ && (
                  <Card className="glass-dark mt-3 p-3">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <span className="fw-bold">equalizer</span>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => {
                          setEqValues(EQ_PRESETS.flat);
                          setSelectedPreset('flat');
                        }}
                        style={{ borderRadius: '6px' }}
                      >
                        reset
                      </Button>
                    </div>

                    {}
                    <div className="d-flex flex-wrap gap-2 mb-3">
                      {Object.keys(EQ_PRESETS).map((preset) => (
                        <Button
                          key={preset}
                          variant={selectedPreset === preset ? 'primary' : 'outline-light'}
                          size="sm"
                          onClick={() => {
                            setEqValues(EQ_PRESETS[preset]);
                            setSelectedPreset(preset);
                            setEqEnabled(true);
                          }}
                          className="eq-preset"
                          style={{
                            borderRadius: '6px',
                            background: selectedPreset === preset
                              ? `linear-gradient(135deg, rgb(${themeColor.r}, ${themeColor.g - 50}, ${themeColor.b - 50}), rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b}), rgb(${themeColor.r + 50}, ${themeColor.g + 50}, ${themeColor.b + 50}))`
                              : undefined,
                            border: selectedPreset === preset ? 'none' : `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                          }}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>

                    {}
                    <div className="d-flex justify-content-between px-2">
                      {eqValues.map((value, index) => (
                        <EQSlider key={index} index={index} value={value} />
                      ))}
                    </div>
                  </Card>
                )}

              </Card.Body>
            </Card>

            {}
            <Card className="glass card-hover shadow-sm border-0">
              <Card.Body>
                <div className="d-flex justify-content-end mb-3">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={() => setShowPlaylistModal(true)}
                    style={{
                      borderRadius: '6px',
                      color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                      border: `1px solid ${dimBorderColor(themeColor)}`,
                      background: 'transparent',
                      transition: 'all 0.2s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.color = '#000';
                      e.target.style.background = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                      e.target.style.background = 'transparent';
                    }}
                  >
                    {SVGIcons.plus} new
                  </Button>
                </div>

                {}
                <div className="d-flex gap-2 mb-3 flex-wrap">
                  {playlists.map((playlist) => (
                    <div
                      key={playlist.id}
                      className={`playlist-tab ${currentPlaylistId === playlist.id ? 'active' : ''}`}
                      onClick={() => setCurrentPlaylistId(playlist.id)}
                      style={{
                        padding: '8px 16px',
                        background: currentPlaylistId === playlist.id ? `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)` : 'transparent',
                        border: `1px solid ${dimBorderColor(themeColor)}`,
                        borderRadius: '6px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        color: currentPlaylistId === playlist.id ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : '#ccc',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      {playlist.type === 'collab' ? SVGIcons.collabPlaylist : SVGIcons.folder}
                      {playlist.name}
                      {playlist.type === 'collab' && (
                        <span style={{ fontSize: '9px', color: '#9ca3af' }}>(collab)</span>
                      )}
                      {playlist.type !== 'collab' && playlist.id !== 'default' && (
                        <Dropdown align="end" className="d-inline ms-1">
                          <Dropdown.Toggle as="span" className="border-0 bg-transparent p-0" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer', transition: 'color 0.2s ease' }} onMouseEnter={(e) => {
                            e.target.style.color = '#000';
                          }} onMouseLeave={(e) => {
                            e.target.style.color = `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`;
                          }}>
                            {SVGIcons.dots}
                          </Dropdown.Toggle>
                          <Dropdown.Menu className="glass-dark">
                            <Dropdown.Item onClick={() => {
                              const newName = prompt('rename playlist:', playlist.name);
                              if (newName) renamePlaylist(playlist.id, newName);
                            }}>
                              rename
                            </Dropdown.Item>
                            <Dropdown.Item
                              onClick={() => deletePlaylist(playlist.id)}
                              className="text-danger"
                            >
                              delete
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown>
                      )}
                    </div>
                  ))}
                </div>

                {}
                {currentTracks.length > 0 ? (
                  <ListGroup variant="flush" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    {(() => {
                      const activeTrackKey = getTrackKey(currentTrack);
                      return currentTracks.map((track, idx) => (
                        <ListGroup.Item
                          key={`${getTrackKey(track)}-${idx}`}
                          active={activeTrackKey === getTrackKey(track)}
                          className={`track-item border-0 d-flex justify-content-between align-items-start ${draggedTrack === idx ? 'opacity-50' : ''}`}
                          draggable
                          onDragStart={(e) => handleDragStart(e, idx)}
                          onDragOver={(e) => handleDragOver(e, idx)}
                          onDrop={(e) => handleDrop(e, idx)}
                        >
                        <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px', marginRight: '12px', display: 'flex', flexShrink: 0 }}>
                          <Button
                            variant="outline-light"
                            size="sm"
                            className="trash-btn btn"
                            data-tooltip="remove"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeTrackFromPlaylist(idx);
                            }}
                            style={{
                              borderRadius: '6px',
                              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                              border: `1px solid ${dimBorderColor(themeColor)}`,
                              background: 'transparent',
                              transition: 'all 0.2s ease',
                              transform: 'scale(1)',
                              padding: '4px 8px'
                            }}
                            onMouseEnter={(e) => {
                              e.target.style.transform = 'scale(1.15)';
                            }}
                            onMouseLeave={(e) => {
                              e.target.style.transform = 'scale(1)';
                            }}
                          >
                            {SVGIcons.trash}
                          </Button>
                        </div>
                        <div className="d-flex align-items-center gap-2" style={{ flex: 1 }}>
                          <span className="drag-handle tooltip" data-tooltip="drag to reorder" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'grab' }}>
                            {SVGIcons.drag}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div className="fw-bold text-truncate" style={{ maxWidth: '200px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
                              {track.title}
                            </div>
                            <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{track.author}</div>
                          </div>
                        </div>
                      </ListGroup.Item>
                    ));
                    })()}
                  </ListGroup>
                ) : (
                  <div className="text-center text-muted py-4">
                    <div className="small">this playlist is empty</div>
                  </div>
                )}

                {currentTracks.length > 0 && (
                  <div className="d-flex justify-content-between align-items-center mt-3">
                    <span className="text-muted small">{currentTracks.length} tracks</span>
                    <div className="d-flex gap-2">
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => loadPlaylistToQueue()}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        load to queue
                      </Button>
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={clearPlaylist}
                        style={{ borderRadius: '6px' }}
                      >
                        clear playlist
                      </Button>
                    </div>
                  </div>
                )}

                {}
                {playNextQueue.length > 0 && (
                  <Card className="glass-dark mt-3">
                    <Card.Body className="py-2">
                      <Card.Title className="small fw-bold mb-2">
                        play next ({playNextQueue.length})
                      </Card.Title>
                      <ListGroup variant="flush" style={{ maxHeight: '100px', overflowY: 'auto' }}>
                        {playNextQueue.map((track, idx) => (
                          <ListGroup.Item
                            key={`${track.videoId}-${idx}`}
                            className="border-0 py-1 small d-flex justify-content-between align-items-center"
                          >
                            <span className="text-truncate" style={{ maxWidth: '200px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
                              {track.title}
                            </span>
                            <Button
                              variant="outline-danger"
                              size="sm"
                              className="py-0 trash-btn"
                              onClick={() => {
                                setPlayNextQueue(playNextQueue.filter((_, i) => i !== idx));
                              }}
                              style={{ borderRadius: '6px', padding: '0 6px' }}
                            >
                              {SVGIcons.trash}
                            </Button>
                          </ListGroup.Item>
                        ))}
                      </ListGroup>
                    </Card.Body>
                  </Card>
                )}
              </Card.Body>
            </Card>
          </div>
        </div>
      </div>
      )}

      {activeTab === 'social' && socialView}

      {activeTab === 'collab' && collabView}

      {/* chat username popup */}
      {chatUserPopup && chatPopupUserData && (
        <div
          style={{
            position: 'fixed',
            left: `${chatUserPopup.x}px`,
            top: `${chatUserPopup.y}px`,
            background: 'rgba(0, 0, 0, 0.95)',
            border: `1px solid ${dimBorderColor(themeColor)}`,
            borderRadius: '10px',
            boxShadow: `0 0 20px rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
            padding: '12px 16px',
            zIndex: 3000,
            minWidth: '200px',
            backdropFilter: 'blur(8px)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold', marginBottom: '8px' }}>
            {chatPopupUserData.username}
          </div>
          <div style={{ fontSize: '11px', color: '#ccc', lineHeight: '1.6' }}>
            <div><span style={{ color: '#9ca3af' }}>status:</span> <span style={{ color: chatPopupUserData.status === 'offline' ? '#9ca3af' : '#22c55e' }}>{chatPopupUserData.status}</span></div>
            <div><span style={{ color: '#9ca3af' }}>joined:</span> {chatPopupUserData.joinedAt}</div>
            {chatPopupUserData.listeningTo && (
              <div><span style={{ color: '#9ca3af' }}>{chatPopupUserData.listeningTo.prefix}:</span> {chatPopupUserData.listeningTo.label}</div>
            )}
          </div>
        </div>
      )}

      <audio ref={audioRef} preload="auto" style={{ display: 'none' }} crossOrigin="anonymous" />
      <audio ref={prefetchAudioRef} preload="auto" style={{ display: 'none' }} crossOrigin="anonymous" />


      <Modal
        show={showPlaylistModal}
        onHide={() => setShowPlaylistModal(false)}
        centered
        className="settings-modal"
        dialogClassName="settings-modal-dialog"
        animation={false}
      >
        <Modal.Header closeButton style={{ borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)` }}>
          <Modal.Title style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '18px' }}>create new playlist</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '24px' }}>
          <Form.Group>
            <Form.Control
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="playlist name"
              style={{
                background: 'rgba(0, 0, 0, 0.4)',
                border: 'none',
                borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                borderRadius: '0',
                color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                fontSize: '13px',
                outline: 'none',
                padding: '10px 12px'
              }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') createPlaylist();
              }}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer style={{ borderTop: 'none', background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '16px 24px' }}>
          <Button
            onClick={() => setShowPlaylistModal(false)}
            style={{
              borderRadius: '6px',
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              padding: '10px 20px',
              cursor: 'pointer'
            }}
          >
            cancel
          </Button>
          <Button
            onClick={createPlaylist}
            disabled={!newPlaylistName.trim()}
            style={{
              borderRadius: '6px',
              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              border: 'none',
              color: '#000',
              padding: '10px 20px',
              fontWeight: 'bold',
              cursor: newPlaylistName.trim() ? 'pointer' : 'not-allowed',
              opacity: newPlaylistName.trim() ? 1 : 0.5
            }}
          >
            create
          </Button>
        </Modal.Footer>
      </Modal>

      {}
      <Modal
        show={showCollabPlaylistModal}
        onHide={() => setShowCollabPlaylistModal(false)}
        centered
        className="settings-modal"
        dialogClassName="settings-modal-dialog"
        animation={false}
      >
        <Modal.Header closeButton style={{ borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)` }}>
          <Modal.Title style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '18px' }}>create collab playlist</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '24px' }}>
          <Form.Group>
            <Form.Control
              value={newCollabPlaylistName}
              onChange={(e) => setNewCollabPlaylistName(e.target.value)}
              placeholder="playlist name"
              style={{
                background: 'rgba(0, 0, 0, 0.4)',
                border: 'none',
                borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                borderRadius: '0',
                color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                fontSize: '13px',
                outline: 'none',
                padding: '10px 12px'
              }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') createCollabPlaylist();
              }}
            />
          </Form.Group>
          <div style={{ color: '#9ca3af', fontSize: '11px', marginTop: '12px' }}>
            all current members ({currentChannelMembers.length}) will be able to edit this playlist
          </div>
        </Modal.Body>
        <Modal.Footer style={{ borderTop: 'none', background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '16px 24px' }}>
          <Button
            onClick={() => setShowCollabPlaylistModal(false)}
            style={{
              borderRadius: '6px',
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              padding: '10px 20px',
              cursor: 'pointer'
            }}
          >
            cancel
          </Button>
          <Button
            onClick={createCollabPlaylist}
            disabled={!newCollabPlaylistName.trim()}
            style={{
              borderRadius: '6px',
              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              border: 'none',
              color: '#000',
              padding: '10px 20px',
              fontWeight: 'bold',
              cursor: newCollabPlaylistName.trim() ? 'pointer' : 'not-allowed',
              opacity: newCollabPlaylistName.trim() ? 1 : 0.5
            }}
          >
            create
          </Button>
        </Modal.Footer>
      </Modal>

      {}
      <Modal
        show={deleteUserConfirm !== null}
        onHide={() => setDeleteUserConfirm(null)}
        centered
        className="settings-modal"
        dialogClassName="settings-modal-dialog"
        animation={false}
      >
        <Modal.Header closeButton style={{ borderBottom: `1px solid #ff4444`, background: `rgba(255, 68, 68, 0.1)` }}>
          <Modal.Title style={{ color: '#ff4444', fontSize: '18px' }}>delete user</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: `rgba(255, 68, 68, 0.05)`, padding: '24px' }}>
          <div style={{ color: '#fff', fontSize: '14px', marginBottom: '12px' }}>
            are you sure you want to permanently delete <strong style={{ color: '#ff4444' }}>{deleteUserConfirm?.username}</strong>?
          </div>
          <div style={{ color: '#9ca3af', fontSize: '12px' }}>
            this will remove all their data including messages, friends, playlists, and server memberships. this cannot be undone.
          </div>
        </Modal.Body>
        <Modal.Footer style={{ borderTop: 'none', background: `rgba(255, 68, 68, 0.05)`, padding: '16px 24px' }}>
          <Button
            onClick={() => setDeleteUserConfirm(null)}
            style={{
              borderRadius: '6px',
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              padding: '10px 20px',
              cursor: 'pointer'
            }}
          >
            cancel
          </Button>
          <Button
            onClick={() => deleteUser(deleteUserConfirm?.userId)}
            style={{
              borderRadius: '6px',
              background: '#ff4444',
              border: 'none',
              color: '#fff',
              padding: '10px 20px',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            delete user
          </Button>
        </Modal.Footer>
      </Modal>

      {/* first-run welcome dialog — fresh installs only, see the effect above */}
      <Modal
        show={showWelcomeModal}
        onHide={dismissWelcomeModal}
        centered
        className="settings-modal"
        dialogClassName="settings-modal-dialog"
        animation={false}
        size="lg"
      >
        <Modal.Header style={{ borderBottom: `2px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, background: '#000000' }}>
          <Modal.Title style={{ color: '#ffffff', fontSize: '18px' }}>hey, welcome</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '24px', maxHeight: '65vh', overflowY: 'auto', color: '#fff', fontSize: '14px', lineHeight: 1.6 }}>
          <p>
            hi, i'm shibenchi. i made this music player because i didn't want to end up paying for
            spotify or youtube premium, and other music players out there either got discontinued or
            got their good features axed. this is just a sort of private thing — i don't intend to
            mass-distribute it — but feel free to use it, no risk to you.
          </p>
          <p style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontWeight: 'bold', marginTop: '20px' }}>
            quick rundown of how everything works:
          </p>
          <ul style={{ paddingLeft: '20px' }}>
            <li style={{ marginBottom: '8px' }}><strong>search</strong> — type a song name up top, or paste a youtube link (single video or playlist) and it'll pull it straight in.</li>
            <li style={{ marginBottom: '8px' }}><strong>queue</strong> — click a search result to add it, drag to reorder, hit play. shuffle/repeat/prev/next all work like you'd expect.</li>
            <li style={{ marginBottom: '8px' }}><strong>playlists</strong> — save the current queue as a playlist, or build one from scratch, from the playlists tab.</li>
            <li style={{ marginBottom: '8px' }}><strong>downloads</strong> — the download button on any track saves it as an mp3 (highest quality, thumbnail embedded) to wherever you pick.</li>
            <li style={{ marginBottom: '8px' }}><strong>eq & theme color</strong> — in settings: a real equalizer, plus a theme color that tints basically the whole app.</li>
            <li style={{ marginBottom: '8px' }}><strong>background animation</strong> — also in settings: a bunch of audio-reactive visualizer styles, or none at all if you'd rather keep it plain.</li>
            <li style={{ marginBottom: '8px' }}><strong>miniplayer</strong> — pops up automatically when you minimize or click away from the main window, with basic playback controls. draggable, closable.</li>
            <li style={{ marginBottom: '0' }}><strong>accounts</strong> — optional. lets your queue/playlists sync if you ever use this on more than one device.</li>
          </ul>

          {isTauriDesktop && isWindowsDesktop && (
            <div style={{
              marginTop: '20px',
              paddingTop: '16px',
              borderTop: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.3)`
            }}>
              <p style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontWeight: 'bold', marginBottom: '10px' }}>
                easier access:
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={welcomeDesktopShortcut}
                  onChange={(e) => setWelcomeDesktopShortcut(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer' }}
                />
                add a desktop shortcut
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={welcomeTaskbarPin}
                  onChange={(e) => setWelcomeTaskbarPin(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer' }}
                />
                pin to taskbar
              </label>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer style={{ borderTop: 'none', background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`, padding: '16px 24px' }}>
          <Button
            onClick={dismissWelcomeModal}
            style={{
              borderRadius: 'var(--border-radius-md)',
              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              border: 'none',
              color: '#000',
              padding: '10px 20px',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            got it, let's go
          </Button>
        </Modal.Footer>
      </Modal>

      {showToast && (
        <div className={`toast ${showToast.variant}`}>
          <span>{showToast.message}</span>
        </div>
      )}
    </Container>
    </ErrorBoundary>
  );
}
