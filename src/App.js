import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { Container, Form, Button, Card, ListGroup, Modal, Dropdown } from 'react-bootstrap';
import AuthForm from './AuthForm';
import { CLIENT_ID, getSocialWsUrl, isSocialEndpoint, onSocialBaseChange, retargetSocialBase, socialUrl } from './socialApi';
import PipPlayer from './PipPlayer';
import Marquee from './Marquee';
import { applyAppIconColor } from './appIcon';
import { isAndroidApp, onPictureInPicture, isTauriApp, sendNowPlaying, sendVisualizerFrame, onMiniplayerControl, onMiniplayerReady, saveFileWithDialog, getDefaultDownloadsDir, chooseDownloadsFolder, saveFileToFolder, applyShortcutPrefs, frontendLog, openExternalUrl, pickTextFile, setMiniplayerEnabled } from './tauriApi';
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
const MEDIA_ENDPOINTS = ['/api/stream', '/api/prefetch', '/api/download', '/api/info', '/api/playlist', '/api/search', '/api/offline'];

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
    // storage full/unavailable - not fatal, just skip persisting this once
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
  { key: 'starfield', label: 'starfield', description: 'warp-speed stars that react to bass' },
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
// blip) - so this walks down a chain of progressively safer fallbacks
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
// border basically disappear against the icon - annoying. this dims and
// desaturates it instead of just reusing the raw theme color, so the
// button outline actually reads as its own frame instead of blending in
function dimBorderColor(c, mix = 0.55, darken = 0.75) {
  const gray = (c.r + c.g + c.b) / 3;
  const r = Math.round((c.r * (1 - mix) + gray * mix) * darken);
  const g = Math.round((c.g * (1 - mix) + gray * mix) * darken);
  const b = Math.round((c.b * (1 - mix) + gray * mix) * darken);
  return `rgb(${r}, ${g}, ${b})`;
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

// ---- playlist import/export --------------------------------------------
// two formats: a "shibenchi-playlist" JSON that round-trips exactly back
// into this app (every field normalizeTrack understands), and a plain CSV
// (Title/Artist/VideoId/URL/Duration columns) meant for spreadsheets and
// other playlist tools to read. a CSV from somewhere else usually wont
// carry a videoId at all, so importing one runs each title+artist through
// the same youtube search the search box uses, one row at a time, and
// reports back whatever it couldn't confidently match instead of quietly
// dropping it
const PLAYLIST_EXPORT_FORMAT = 'shibenchi-playlist';
const PLAYLIST_EXPORT_VERSION = 1;

function playlistToExportObject(playlist) {
  return {
    format: PLAYLIST_EXPORT_FORMAT,
    version: PLAYLIST_EXPORT_VERSION,
    name: playlist?.name || 'playlist',
    exportedAt: new Date().toISOString(),
    trackCount: playlist?.tracks?.length || 0,
    tracks: (playlist?.tracks || []).map((t) => {
      const track = normalizeTrack(t);
      return {
        title: track.title,
        author: track.author,
        videoId: track.videoId,
        source: track.source,
        durationMs: track.durationMs,
        thumbnail: track.thumbnail,
        externalUrl: track.externalUrl
      };
    })
  };
}

function csvEscapeField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function playlistToCsv(playlist) {
  const header = ['Title', 'Artist', 'VideoId', 'URL', 'Duration (sec)'];
  const rows = (playlist?.tracks || []).map((t) => {
    const track = normalizeTrack(t);
    const url = track.videoId ? `https://www.youtube.com/watch?v=${track.videoId}` : '';
    const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : '';
    return [track.title, track.author, track.videoId, url, durationSec];
  });
  return [header, ...rows].map((row) => row.map(csvEscapeField).join(',')).join('\r\n');
}

// minimal RFC4180-ish csv parser - handles quoted fields (escaped ""
// quotes, embedded commas/newlines), the part a naive text.split('\n')
// then split(',') always gets wrong on a real-world export
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { pushField(); continue; }
    if (char === '\r') continue;
    if (char === '\n') { pushRow(); continue; }
    field += char;
  }
  if (field.length || row.length) pushRow();

  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

const CSV_HEADER_ALIASES = {
  title: ['title', 'song', 'track', 'name', 'track name', 'song name'],
  author: ['artist', 'author', 'channel', 'artists'],
  videoId: ['videoid', 'video id', 'youtube id', 'youtubeid', 'id'],
  url: ['url', 'link', 'youtube url', 'youtube link'],
  durationMs: ['duration', 'duration (sec)', 'duration_sec', 'length', 'duration (ms)']
};

function matchCsvHeaderField(headerCell) {
  const normalized = headerCell.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

// turns parsed csv rows into "pending" track descriptors - resolved
// straight from a videoId/url when the row has one, otherwise flagged
// for a youtube search during import
function csvRowsToPendingTracks(rows) {
  if (!rows.length) return [];

  const headerMap = {};
  rows[0].forEach((cell, i) => { headerMap[i] = matchCsvHeaderField(cell); });
  const looksLikeHeader = Object.values(headerMap).some((f) => f !== null);

  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  // no recognizable header at all - fall back to positional columns so a
  // bare two/three-column csv from some other tool still works instead
  // of just being rejected
  const columns = looksLikeHeader ? headerMap : { 0: 'title', 1: 'author', 2: 'videoId' };

  return dataRows.map((row) => {
    const entry = { title: '', author: '', videoId: '', durationMs: 0 };
    row.forEach((cell, i) => {
      const field = columns[i];
      if (!field) return;
      const value = cell.trim();
      if (field === 'url') {
        if (!entry.videoId) entry.videoId = extractYouTubeId(value) || '';
      } else if (field === 'videoId') {
        entry.videoId = extractYouTubeId(value) || value;
      } else if (field === 'durationMs') {
        const num = Number(value.replace(/[^\d.]/g, ''));
        // guess seconds vs milliseconds by magnitude - a real track in ms
        // is almost always 5+ digits, seconds tops out in the low
        // thousands for anything reasonable
        if (Number.isFinite(num) && num > 0) entry.durationMs = num > 3600 ? num : num * 1000;
      } else {
        entry[field] = value;
      }
    });
    return entry;
  }).filter((entry) => entry.title || entry.videoId);
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

// where the shared track is right now. current_time on the player state is the
// spot at the moment that state arrived, so while it is playing the time since
// then has to be added. restarting from the bare current_time put a player
// that had to reload back at an old spot, again and again
function liveSharedPosition(state) {
  if (!state) return 0;
  const base = Number(state.current_time) || 0;
  if (!state.is_playing) return base;
  const sinceArrival = typeof performance !== 'undefined' && state.received_at_perf
    ? (performance.now() - state.received_at_perf) / 1000
    : 0;
  const waitBeforeStart = (Number(state.start_in_ms) || 0) / 1000;
  return Math.max(0, base + Math.max(0, sinceArrival - waitBeforeStart));
}

function normalizeChannelPlayerState(state, fallbackUpdatedAtMs = Date.now()) {
  if (!state || typeof state !== 'object') return null;

  const currentTime = Number(state.current_time ?? 0);
  const volume = Number(state.volume ?? 1);
  const explicitSyncMs = Number(state.sync_updated_at_ms || 0);
  const updatedAtMs = explicitSyncMs > 0
    ? explicitSyncMs
    : (Number(state.updated_at || 0) > 0 ? Number(state.updated_at || 0) * 1000 : fallbackUpdatedAtMs);
  // calculate elapsed time since the last server update - only when playing
  // and we've got a valid timestamp to work with
  const elapsedSeconds = (state.is_playing === true || state.is_playing === 1) && updatedAtMs > 0
    ? Math.max(0, (fallbackUpdatedAtMs - updatedAtMs) / 1000)
    : 0;
  const effectiveCurrentTime = Number.isFinite(currentTime) ? currentTime + elapsedSeconds : 0;

  // when a synced start is scheduled, how long from now it is. start_at_ms and
  // the fallback (the server's clock at send time) are both server time, so
  // this does not depend on this computer's clock being right
  const startAtMs = Number(state.start_at_ms || 0);
  const startInMs = startAtMs > 0 ? Math.max(0, startAtMs - fallbackUpdatedAtMs) : 0;

  return {
    ...state,
    current_track_id: state.current_track_id || null,
    is_playing: state.is_playing === true || state.is_playing === 1,
    start_in_ms: startInMs,
    received_at_perf: typeof performance !== 'undefined' ? performance.now() : 0,
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

// used by the debug console's click/hover logging - a bare tag+class isnt
// enough to tell apart two elements sharing a class, and hover often lands
// on a decorative child (an svg or one of its paths/lines) that carries no
// identifying info of its own at all. pulls in aria-label/title/name -
// whichever actually distinguishes it - and climbs to the nearest
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
// on a phone the helper is part of the app itself, so a "not there yet" at launch
// is forgotten after two seconds instead of fifteen
const LOCAL_HELPER_PROBE_TTL_MS = (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) ? 2000 : 15000;
let _localHelperAvailable = null; // null = not checked yet, true/false after probe
let _localHelperProbe = null;   // in-flight promise
let _localHelperLastProbeAt = 0;

function isMediaEndpoint(url) {
  return MEDIA_ENDPOINTS.some((endpoint) => String(url || '').startsWith(endpoint));
}

async function probeLocalHelper(force = false) {
  if (
    !force
    && _localHelperAvailable !== null
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
  // helper. dont silently fall back to the vps - yt-dlp is blocked there
  if (isMediaEndpoint(url) && !target.usingLocalHelper) {
    const h = window.location.hostname;
    const isRemote = h !== 'localhost' && h !== '127.0.0.1' && h !== '0.0.0.0';
    if (isRemote) {
      if (isAndroidApp()) throw new Error('the audio helper is still starting, give it a moment and try again');
      throw new Error('local helper not running - start the app on your device to stream audio');
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
  if (typeof fetchOptions.body === 'string') {
    const hasType = Object.keys(fetchOptions.headers || {}).some((name) => name.toLowerCase() === 'content-type');
    if (!hasType) fetchOptions.headers = { ...(fetchOptions.headers || {}), 'Content-Type': 'application/json' };
  }
  if (target.isSocial) {
    fetchOptions.credentials = 'include';
    fetchOptions.headers = { ...(fetchOptions.headers || {}), 'X-Client-Id': CLIENT_ID };
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
    // the social server has a second address for networks that cannot reach the
    // main one. a call that never connected is tried again on the other address,
    // but not a call the server answered (those have a status) or one the caller
    // cancelled
    if (target.isSocial && !error?.status && options.signal?.aborted !== true && await retargetSocialBase()) {
      const response = await fetch(socialUrl(url), fetchOptions);
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
  online: 'left',
  messages: 'right',
  requests: 'left'
};

// the home tab's panels and which column each starts in
const MAIN_LAYOUT_DEFAULTS = {
  search: 'left',
  queue: 'left',
  player: 'right',
  playlists: 'right'
};

// the order the panels come in. on a phone, where everything is one column,
// this is the order down the page
const DEFAULT_PANEL_ORDERS = {
  main: ['search', 'queue', 'player', 'playlists'],
  social: ['online', 'messages', 'requests'],
  collab: ['setup', 'queue', 'chat', 'player', 'collabplaylists']
};

// what a panel is called in the layout editor
const PANEL_LABELS = {
  main: {
    search: ['search', 'the search box and downloads'],
    queue: ['queue', 'the songs lined up to play'],
    player: ['player', 'the record, the controls and the seek bar'],
    playlists: ['playlists', 'your playlists and their songs']
  },
  social: {
    online: ['online', 'who is online'],
    messages: ['messages', 'your conversations'],
    requests: ['requests', 'friend requests']
  },
  collab: {
    setup: ['channels', 'create or join a channel, and its members'],
    queue: ['shared queue', 'what the room plays'],
    chat: ['chat', 'the room chat'],
    player: ['shared player', 'the room player'],
    collabplaylists: ['collab playlists', "the channel's playlists"]
  }
};

const COLLAB_LAYOUT_DEFAULTS = {
  setup: 'left',
  queue: 'right',
  chat: 'left',
  player: 'right',
  collabplaylists: 'left'
};

// the playlists and the queue as they are sent to the server, and what is
// compared to know whether anything actually changed since the last save
function serializePlaylistsForSync(playlists) {
  // a channel's collab playlists sit in the same list while the channel is open,
  // but they belong to the channel, not to this account. saving them here made
  // them show up as ordinary playlists of the account
  return (Array.isArray(playlists) ? playlists : []).filter((playlist) => playlist && playlist.type !== 'collab').map((playlist) => ({
    ...playlist,
    tracks: Array.isArray(playlist.tracks)
      ? playlist.tracks.map((track) => normalizeTrack(track)).filter((track) => track.videoId)
      : []
  }));
}

function serializeQueueForSync(queue) {
  return (Array.isArray(queue) ? queue : []).map((track) => normalizeTrack(track)).filter((track) => track.videoId);
}

// whole seconds since active turned true, 0 while it is false. lets a waiting
// message say how long it has been, so a slow step never looks like a frozen app
// the reason a start in the room is waiting, from the list the server keeps of
// who is not ready yet and why
function describeSyncWaiting(waiting, selfId, seconds) {
  const list = Array.isArray(waiting) ? waiting : [];
  const tail = seconds >= 8 ? ` ${seconds}s` : '';
  if (!list.length) return seconds < 8 ? '' : `starting the room's song...${tail}`;
  const who = (entry) => (entry.user_id === selfId ? 'you' : entry.username);
  if (list.length === 1) return `waiting for ${who(list[0])}: ${list[0].reason}${tail}`;
  return `waiting for ${list.map((entry) => `${who(entry)} (${entry.reason})`).join(', ')}${tail}`;
}

// why this player is not ready to start yet, in a few words, for the room to see
function syncReasonFor(el, hasSource, targetTime, stage) {
  if (el._streamRetryCount > 0) return 'the song would not load, trying again';
  switch (stage) {
    case 'helper': return 'waking up the audio helper';
    case 'source': return 'finding the song on youtube';
    case 'start': return 'loading the first part of the song';
    case 'buffering': return 'buffering the song';
    default: break;
  }
  if (!hasSource) return 'getting the song ready';
  if (el.readyState < 3) return 'loading the song';
  if (el.seeking || el._pendingStartTime != null || Math.abs((el.currentTime || 0) - targetTime) >= 1.5) return 'moving to the right spot';
  return 'getting ready';
}

// the phone says "offline" for a second or two when it hops between wifi and mobile data or
// passes a gap in coverage. only a loss that lasts counts, so the status text and the offline
// screens do not flip (and throw you out of the collab tab) for those moments
const OFFLINE_CONFIRM_MS = 6000;
let networkConfirmedDown = typeof navigator !== 'undefined' && navigator.onLine === false;

// the version of the screens that are running, put in by the build. a dev run has
// none and asks the server it was loaded from instead
const BUILT_VERSION = process.env.REACT_APP_VERSION || '';
// where the installers are, for an update that can not be done from inside the app
const RELEASES_URL = 'https://github.com/shibenchi/Shibenchis-music-player/releases/latest';

// is version a newer than version b ("1.4.11" against "1.4.10")
function isNewerVersion(a, b) {
  const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

// scrolls the list that holds the playing song until the song is in the middle of
// view (and the page to the list, if it is off screen). false when there is none
function jumpToPlayingRow(fromElement) {
  const card = fromElement && fromElement.closest ? fromElement.closest('[data-panel]') : null;
  const row = card && card.querySelector('.list-group-item.active');
  if (!row) return false;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

// returns a function that never changes identity but always calls the latest
// version of whatever it was given. handlers made inline in the big App
// component are new functions every render, and App renders several times a
// second (the progress bar), so passing them straight into a memoized list
// made the memo useless: all 150 rows redrew on every tick and the whole app
// got laggy with a big playlist loaded
function useStableCallback(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args) => ref.current(...args), []);
}

// a scrolling list with a handle under it: drag the handle down to make the
// list taller, up to make it shorter. the height is remembered per list
function ResizableListGroup({ storageKey, defaultHeight, minHeight = 120, children }) {
  const [height, setHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`music_list_height:${storageKey}`));
      return Number.isFinite(saved) && saved >= minHeight ? saved : defaultHeight;
    } catch {
      return defaultHeight;
    }
  });
  const listRef = useRef(null);

  const startDrag = (event) => {
    event.preventDefault();
    const startY = event.clientY;
    // start from the height it is showing now, not the stored max, so a short
    // list does not jump on the first move
    const startHeight = Math.max(minHeight, listRef.current ? listRef.current.getBoundingClientRect().height : height);
    let latest = startHeight;

    const onMove = (moveEvent) => {
      latest = Math.max(minHeight, Math.min(2400, startHeight + (moveEvent.clientY - startY)));
      setHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        localStorage.setItem(`music_list_height:${storageKey}`, String(Math.round(latest)));
      } catch {
        // not being able to remember it is fine
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <>
      <ListGroup ref={listRef} variant="flush" style={{ maxHeight: `${height}px`, overflowY: 'auto' }}>
        {children}
      </ListGroup>
      <div className="resize-handle" onPointerDown={startDrag} title="drag to change the list height" />
    </>
  );
}

// one queue row. memoized on its own so a single row changing (the highlight
// moving, a track getting removed) doesnt redraw every other row in the list
// the little "saved" tag next to a song that is stored on the phone
function SavedTag({ themeColor }) {
  return (
    <span
      title="saved on this phone, plays without internet"
      style={{
        marginLeft: '8px',
        padding: '0 6px',
        fontSize: '10px',
        border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
        color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
        borderRadius: '8px',
        whiteSpace: 'nowrap'
      }}
    >
      saved
    </span>
  );
}

const QueueRow = React.memo(function QueueRow({
  item,
  idx,
  active,
  themeColor,
  onPlayTrack,
  onRemoveTrack,
  onAddToPlaylist,
  onDownloadSingle,
  offlineMode = false,
  offline = false,
  dimmed = false
}) {
  return (
    <ListGroup.Item
      active={active}
      className="track-item border-0 d-flex justify-content-between align-items-start"
      style={dimmed ? { opacity: 0.4 } : undefined}
      title={dimmed ? 'not saved on this phone' : undefined}
      onClick={() => { if (!dimmed) onPlayTrack(idx); }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Marquee className="fw-bold" text={item.title} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
        <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
          {item.author}
          {offlineMode && offline && <SavedTag themeColor={themeColor} />}
        </div>
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
            transition: 'none',
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
            transition: 'none',
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
            transition: 'none',
            transform: 'scale(1)',
            padding: '4px 8px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.15)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          title={offlineMode ? (offline ? 'saved for offline, tap to remove' : 'save for offline') : 'download'}
        >
          {offlineMode && offline ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : SVGIcons.download}
        </Button>
      </div>
    </ListGroup.Item>
  );
});

// one row of the playlist panel, memoized for the same reason as QueueRow
const PlaylistTrackRow = React.memo(function PlaylistTrackRow({
  track,
  idx,
  active,
  dragged,
  themeColor,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  offlineMode = false,
  offline = false,
  onToggleOffline = null,
  dimmed = false
}) {
  return (
    <ListGroup.Item
      active={active}
      style={dimmed ? { opacity: 0.4 } : undefined}
      title={dimmed ? 'not saved on this phone' : undefined}
      className={`track-item border-0 d-flex justify-content-between align-items-start ${dragged ? 'opacity-50' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, idx)}
      onDragOver={(e) => onDragOver(e, idx)}
      onDrop={(e) => onDrop(e, idx)}
    >
      <div className="btn-group" style={{ position: 'relative', zIndex: 10, gap: '4px', marginRight: '12px', display: 'flex', flexShrink: 0 }}>
        <Button
          variant="outline-light"
          size="sm"
          className="trash-btn btn"
          data-tooltip="remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(idx);
          }}
          style={{
            borderRadius: '6px',
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            border: `1px solid ${dimBorderColor(themeColor)}`,
            background: 'transparent',
            transition: 'none',
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
        {offlineMode && onToggleOffline && (
          <Button
            variant="outline-light"
            size="sm"
            className="btn"
            title={offline ? 'saved for offline, tap to remove' : 'save for offline'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleOffline(track);
            }}
            style={{
              borderRadius: '6px',
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              border: `1px solid ${dimBorderColor(themeColor)}`,
              background: 'transparent',
              transition: 'none',
              padding: '4px 8px'
            }}
          >
            {offline ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : SVGIcons.download}
          </Button>
        )}
      </div>
      <div className="d-flex align-items-center gap-2" style={{ flex: 1 }}>
        <span className="drag-handle tooltip" data-tooltip="drag to reorder" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'grab' }}>
          {SVGIcons.drag}
        </span>
        <div style={{ flex: 1 }}>
          <Marquee className="fw-bold" text={track.title} style={{ maxWidth: '200px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
          <div className="text-muted small" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
            {track.author}
            {offlineMode && offline && <SavedTag themeColor={themeColor} />}
          </div>
        </div>
      </div>
    </ListGroup.Item>
  );
});

// memoized queue list component - isolated from parent re-renders
// (trackProgress ticks etc). every handler passed in has to keep the same
// identity between renders or this memo does nothing, see useStableCallback
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
  onClearQueue,
  offlineMode = false,
  offlineIds = null,
  offlineModeActive = false,
  savingProgress = null
}) {
  return (
    <>
      <ResizableListGroup storageKey="queue" defaultHeight={240}>
        {queue.map((item, idx) => (
          <QueueRow
            key={`${item.videoId || idx}-${idx}`}
            item={item}
            idx={idx}
            active={idx === currentIndex}
            themeColor={themeColor}
            onPlayTrack={onPlayTrack}
            onRemoveTrack={onRemoveTrack}
            onAddToPlaylist={onAddToPlaylist}
            onDownloadSingle={onDownloadSingle}
            offlineMode={offlineMode}
            offline={!!(offlineIds && offlineIds.has(item.videoId))}
            dimmed={offlineModeActive && !(offlineIds && offlineIds.has(item.videoId))}
          />
        ))}
      </ResizableListGroup>
      <div className="d-flex gap-2 mt-2">
        <Button
          variant="outline-light"
          size="sm"
          onClick={onProcessQueue}
          disabled={isDownloading || isQueueRunning || !!savingProgress}
          title={savingProgress ? `saving ${savingProgress.done} of ${savingProgress.total} songs for offline` : undefined}
          className="download-all-btn"
          style={{
            borderRadius: '6px',
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            border: `1px solid ${dimBorderColor(themeColor)}`,
            background: 'transparent',
            transition: 'none'
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
          {offlineMode ? (savingProgress ? `saving ${savingProgress.done}/${savingProgress.total}` : 'save all offline') : 'download all'}
        </Button>
        <Button
          variant="outline-light"
          size="sm"
          // what the fuck - onClick={onAddAllToPlaylist} was passing the
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
            transition: 'none'
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
            transition: 'none'
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
      <div className="d-flex justify-content-between align-items-center mt-2" style={{ gap: '8px' }}>
        <Button
          variant="outline-light"
          size="sm"
          onClick={(event) => jumpToPlayingRow(event.currentTarget)}
          disabled={currentIndex < 0 || currentIndex >= queue.length}
          title="scroll the queue to the song that is playing"
          style={{
            borderRadius: '6px',
            color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
            border: `1px solid ${dimBorderColor(themeColor)}`,
            background: 'transparent',
            transition: 'none',
            fontSize: '11px',
            padding: '2px 10px'
          }}
        >
          jump to playing
        </Button>
        <div className="text-muted small text-end" style={{ fontSize: '11px' }}>
          {queue.length} {queue.length === 1 ? 'song' : 'songs'}
        </div>
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
  hideListening = false,
  onHideListeningToggle,
  onLogin,
  onLogout,
  onAccountSettingsChanged
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
  const isBufferingRef = useRef(false);
  useEffect(() => { isBufferingRef.current = isBuffering; }, [isBuffering]);
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

  // the app icon follows the theme color: the home screen shortcut on the phone,
  // the window on the computer, the tab in a browser
  useEffect(() => {
    const timer = setTimeout(() => { applyAppIconColor(themeColor); }, 600);
    return () => clearTimeout(timer);
  }, [themeColor.r, themeColor.g, themeColor.b]);

  
  
  
  const handleThemeColorChange = useCallback((newColor) => {
    if (onThemeColorChange) {
      onThemeColorChange(newColor);
    } else {
      setLocalThemeColor(newColor);
      localStorage.setItem('music_theme_color_guest', `${newColor.r},${newColor.g},${newColor.b}`);
    }
  }, [onThemeColorChange]);

  
  const [playlists, setPlaylists] = useState(() => {
    return readStoredJson(user ? `music_playlists_user:${user.id}` : guestPlaylistsStorageKey, []);
  });
  const [currentPlaylistId, setCurrentPlaylistId] = useState(() => {
    const localPlaylists = readStoredJson(user ? `music_playlists_user:${user.id}` : guestPlaylistsStorageKey, []);
    return localPlaylists.length > 0 ? localPlaylists[0].id : '';
  });
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [editingPlaylistId, setEditingPlaylistId] = useState(null);
  const [playlistImport, setPlaylistImport] = useState(null); // { total, done, label } while running
  const importCancelRef = useRef(false);

  
  const [suggestions, setSuggestions] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState(null);

  // status text for the slow parts. each one counts up while it waits
  const searchSeconds = useElapsedSeconds(isSuggesting);
  const bufferingSeconds = useElapsedSeconds(isBuffering);
  // where a song that is not playing yet is stuck: waking the audio helper,
  // finding the song on youtube, loading its first part, or buffering later on
  const [bufferStage, setBufferStage] = useState('');
  // what the player says while it waits, in terms of what it is waiting for
  // this text is for a process that is hanging, so it says nothing for the first
  // few seconds: waiting to start, the helper answering or the first part arriving
  // all take that long normally and need no explaining
  const describeBuffering = ({ stage, seconds, shared = false, preparing = false, connected = true, waiting = null }) => {
    if (networkConfirmedDown) {
      return shared ? 'no connection, the room is out of reach' : 'no connection, this song is not saved for offline';
    }
    if (shared && !connected) return 'lost the connection to the room, reconnecting...';
    if (seconds < 3) return '';
    if (shared && preparing) return describeSyncWaiting(waiting, currentUserId, seconds);
    switch (stage) {
      case 'helper':
        return `the audio helper is slow to answer... ${seconds}s`;
      case 'source':
        if (seconds < 4) return 'finding the song on youtube...';
        if (seconds < 12) return `youtube is slow to answer, still finding the song... ${seconds}s`;
        return `youtube is still not answering well, trying again... ${seconds}s`;
      case 'start':
        return seconds < 8 ? 'loading the first part of the song...' : `slow connection, still loading the first part... ${seconds}s`;
      case 'buffering':
        return `slow connection, buffering... ${seconds}s`;
      default:
        return `still getting audio ready... ${seconds}s`;
    }
  };
  const personalBufferingText = describeBuffering({ stage: bufferStage, seconds: bufferingSeconds });

  // the phone app has its audio helper inside the app. if it is not answering
  // yet (just opened, or restarting) say so instead of letting searches and
  // plays fail without a word
  const [helperDown, setHelperDown] = useState(false);
  useEffect(() => {
    if (!isAndroidApp()) return undefined;
    let alive = true;
    let timer = null;
    const check = async () => {
      const ok = await probeLocalHelper(true).catch(() => false);
      if (!alive) return;
      setHelperDown(!ok);
      timer = setTimeout(check, ok ? 20000 : 1500);
    };
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // android's small floating player window. while it is open the page shows
  // the mini player card on top, the real page keeps running underneath
  const [isPip, setIsPip] = useState(false);
  useEffect(() => onPictureInPicture(setIsPip), []);
  // the visualizer loop reads this, it is not part of what that effect depends on
  const isPipRef = useRef(false);
  useEffect(() => { isPipRef.current = isPip; }, [isPip]);
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
    // older versions logged what was typed into password fields. the saved
    // logs from then are wiped once so none of that is left in the browser
    try {
      if (localStorage.getItem('music_debug_logs_scrubbed_v1') !== '1') {
        localStorage.removeItem('music_frontend_debug_logs');
        localStorage.setItem('music_debug_logs_scrubbed_v1', '1');
        return [];
      }
    } catch {
      return [];
    }
    const stored = readStoredJson('music_frontend_debug_logs', []);
    return Array.isArray(stored) ? stored : [];
  });
  const [backendDebugSnapshot, setBackendDebugSnapshot] = useState('');
  const [backendDebugError, setBackendDebugError] = useState('');
  const [backendDebugLoading, setBackendDebugLoading] = useState(false);
  const [backendDebugLoadedAt, setBackendDebugLoadedAt] = useState('');

  // first-run welcome dialog - shown once, only on a genuinely fresh
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

  // version check stuff - still used for the "new version available" banner.
  // versionMismatch means the server has a newer version than this copy
  const [currentVersion, setCurrentVersion] = useState(BUILT_VERSION || '1.0.0');
  const [versionMismatch, setVersionMismatch] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  // what pressing update does: 'live' downloads the new screens into the app, 'installer'
  // opens the download page, 'reload' (the web version) just loads the page again
  const [updateKind, setUpdateKind] = useState('reload');
  const [updateBusy, setUpdateBusy] = useState(false);
  // the signed list of the newest screens the phone was handed (see UiUpdater.kt)
  const updateEnvelopeRef = useRef('');
  // the banner stays away once closed, until an even newer version comes out
  const [dismissedVersion, setDismissedVersion] = useState('');

  const [activeTab, setActiveTab] = useState('main');
  // while a finger drags between tabs: the tab being moved towards, drawn beside the current one
  const [peek, setPeek] = useState(null);
  const pagerRef = useRef(null);

  // songs saved on the phone, so they play with no connection. the phone's helper
  // keeps the files, this keeps the list of which ones
  const [offlineIds, setOfflineIds] = useState(() => new Set());
  const offlineIdsRef = useRef(offlineIds);
  useEffect(() => { offlineIdsRef.current = offlineIds; }, [offlineIds]);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    let offlineTimer = null;
    const goOnline = () => {
      clearTimeout(offlineTimer);
      networkConfirmedDown = false;
      setIsOnline(true);
    };
    const goOffline = () => {
      clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => {
        networkConfirmedDown = true;
        setIsOnline(false);
      }, OFFLINE_CONFIRM_MS);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      clearTimeout(offlineTimer);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  // offline mode: on the phone, with no connection (or switched on by hand in
  // settings) the app only deals in the songs saved on the phone. it ends by
  // itself the moment the connection is back
  const [forceOffline, setForceOffline] = useState(() => {
    try { return localStorage.getItem('music_force_offline') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('music_force_offline', forceOffline ? '1' : '0'); } catch { /* not remembered */ }
  }, [forceOffline]);
  const offlineModeActive = isAndroidApp() && (!isOnline || forceOffline);
  // the social and collab tabs need a connection, so they are closed in this mode
  useEffect(() => {
    if (offlineModeActive && activeTab !== 'main') setActiveTab('main');
  }, [offlineModeActive, activeTab]);

  // what this device is called to the account's other devices, and what they are
  // playing right now (kept up to date over the websocket)
  const deviceInfo = useMemo(() => {
    let id = '';
    try {
      id = localStorage.getItem('music_device_id') || '';
      if (!id) {
        id = `d_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        localStorage.setItem('music_device_id', id);
      }
    } catch {
      id = `d_${Math.random().toString(36).slice(2, 10)}`;
    }
    const kind = isAndroidApp() ? 'phone' : (isTauriApp() ? 'computer' : 'browser');
    return { id, kind, name: kind };
  }, []);
  const [otherDevices, setOtherDevices] = useState({});
  const deviceCommandRef = useRef(() => {});
  const [, setRemoteTick] = useState(0);
  // the other device that is playing (or the one that changed last), with where
  // it has got to by now
  const remoteNow = (() => {
    const entries = Object.entries(otherDevices);
    if (!entries.length) return null;
    entries.sort((a, b) => (Number(b[1].state.playing) - Number(a[1].state.playing)) || (b[1].receivedAt - a[1].receivedAt));
    const [clientId, entry] = entries[0];
    const state = entry.state;
    const elapsed = state.playing ? (Date.now() - entry.receivedAt) / 1000 : 0;
    const position = state.position + elapsed;
    return {
      clientId,
      deviceName: (entry.device && entry.device.name) || 'device',
      playing: Boolean(state.playing),
      track: normalizeTrack({ videoId: state.videoId, title: state.title, author: state.author, thumbnail: state.thumbnail }),
      position: state.duration ? Math.min(position, state.duration) : position,
      duration: state.duration || 0
    };
  })();
  const remotePlaying = Boolean(remoteNow && remoteNow.playing);
  useEffect(() => {
    if (!remotePlaying) return undefined;
    const timer = setInterval(() => setRemoteTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [remotePlaying]);
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
  // private channels: made private here, joined with a code
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [joinCodeText, setJoinCodeText] = useState('');
  const [codeEntryFor, setCodeEntryFor] = useState('');
  const [codeEntryText, setCodeEntryText] = useState('');
  const [newChannelDescription, setNewChannelDescription] = useState('');
  const [channelDraftName, setChannelDraftName] = useState('');
  const [channelDraftDescription, setChannelDraftDescription] = useState('');
  const [socialPanelSides, setSocialPanelSides] = useState(() => readSnapLayout(socialLayoutStorageKey, SOCIAL_LAYOUT_DEFAULTS));
  const [collabPanelSides, setCollabPanelSides] = useState(() => readSnapLayout(collabLayoutStorageKey, COLLAB_LAYOUT_DEFAULTS));
  // the home tab's columns, and the order of the panels of every tab. an order
  // only exists for a tab once the layout editor has saved one
  const mainLayoutStorageKey = user?.id ? `music_main_layout:${user.id}` : 'music_main_layout:guest';
  const panelOrdersStorageKey = user?.id ? `music_panel_orders:${user.id}` : 'music_panel_orders:guest';
  const [mainPanelSides, setMainPanelSides] = useState(() => readSnapLayout(mainLayoutStorageKey, MAIN_LAYOUT_DEFAULTS));
  const [panelOrders, setPanelOrders] = useState(() => readStoredJson(panelOrdersStorageKey, {}));
  useEffect(() => {
    setMainPanelSides(readSnapLayout(mainLayoutStorageKey, MAIN_LAYOUT_DEFAULTS));
    setPanelOrders(readStoredJson(panelOrdersStorageKey, {}));
  }, [mainLayoutStorageKey, panelOrdersStorageKey]);
  const [showLayoutEditor, setShowLayoutEditor] = useState(false);
  const [layoutEditorTab, setLayoutEditorTab] = useState('main');
  const [layoutDraft, setLayoutDraft] = useState(null);
  const [draggedTile, setDraggedTile] = useState(null);
  const [draggingPanel, setDraggingPanel] = useState(null);
  const [activeDropColumn, setActiveDropColumn] = useState('');
  const [deleteUserConfirm, setDeleteUserConfirm] = useState(null); // { userId, username }
  // the number on the social tab is how many conversations have something
  // unread. it is worked out from the list itself, so it cannot disagree with
  // the little numbers next to each conversation
  const unreadDmCount = useMemo(() => conversationList.filter((entry) => Number(entry.unread_count) > 0).length, [conversationList]);
  const [unreadChannelCount, setUnreadChannelCount] = useState(0);

  // track last-viewed timestamps to calculate unread counts
  const lastViewedConversations = useRef({}); // { userId: timestamp }
  const lastViewedChannels = useRef({}); // { channelId: timestamp }

  const wsRef = useRef(null);
  // when the socket last went down (0 while it is up), to tell a blink from a real absence
  const wsDownSinceRef = useRef(0);
  const conversationListRef = useRef([]);
  const dmScrollRef = useRef(null);
  const channelScrollRef = useRef(null);
  const notifAudioRef = useRef(null);
  const notifAudio2Ref = useRef(null);
  const debugEntriesRef = useRef([]);
  const debugFlushTimeoutRef = useRef(null);
  const nativeConsoleRef = useRef({
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  });
  const lastListeningStateSentRef = useRef('');
  const selectedConversationRef = useRef('');
  const activeTabRef = useRef(activeTab);
  const offlineModeActiveRef = useRef(offlineModeActive);
  offlineModeActiveRef.current = offlineModeActive;
  const currentChannelRef = useRef('');
  const channelsRef = useRef([]);
  // the websocket follows the address the app is using, so switching to the
  // tunnel address (or back) makes this component draw again with the new url
  const [, setSocialBaseTick] = useState(0);
  useEffect(() => onSocialBaseChange(() => setSocialBaseTick((tick) => tick + 1)), []);
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
  const newestMessageOf = useCallback((channelId) => {
    let newest = null;
    channelMessages.forEach((m) => {
      if (m.server_id !== channelId) return;
      if (!newest || (m.created_at || 0) >= (newest.created_at || 0)) newest = m;
    });
    return newest;
  }, [channelMessages]);

  const calculateUnreadChannelCount = useCallback(() => {
    let count = 0;
    channels.forEach((ch) => {
      const lastMsg = newestMessageOf(ch.id);
      if (!lastMsg) return;
      const lastMsgAt = lastMsg.created_at || 0;
      const lastViewedAt = lastViewedChannels.current[ch.id] || 0;
      if (lastMsgAt > lastViewedAt && lastMsg.user_id !== currentUserId) {
        count++;
      }
    });
    return count;
  }, [channels, currentUserId, newestMessageOf]);

  // which conversations were opened and when. remembered between launches:
  // without that every conversation whose last message came from the other
  // person counted as unread again after each restart
  useEffect(() => {
    if (!currentUserId) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`music_dm_last_viewed:${currentUserId}`) || '{}');
      if (saved && typeof saved === 'object') {
        lastViewedConversations.current = { ...saved, ...lastViewedConversations.current };
      }
    } catch {
      // nothing saved yet
    }
  }, [currentUserId]);

  const markConversationRead = useCallback((userId) => {
    // the later of now and the last message: the server's clock can be ahead of
    // this one, and a message "from the future" would otherwise never count as read
    const lastEntry = (conversationListRef.current || []).find((entry) => entry.user_id === userId);
    const lastMessageSeconds = Math.floor(getComparableTimestamp(lastEntry?.last_message_at) / 1000);
    lastViewedConversations.current[userId] = Math.max(Math.floor(Date.now() / 1000), lastMessageSeconds);
    try {
      localStorage.setItem(`music_dm_last_viewed:${currentUserId}`, JSON.stringify(lastViewedConversations.current));
    } catch {
      // not remembered, only costs a badge after a restart
    }
    // the little number goes whether or not any message was still flagged unread
    setConversationList((prevList) => markConversationPreviewEntriesRead(prevList, userId));
    
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
  }, [currentUserId, getComparableTimestamp]);

  const markChannelRead = useCallback((channelId) => {
    const newest = newestMessageOf(channelId);
    lastViewedChannels.current[channelId] = Math.max(Math.floor(Date.now() / 1000), newest ? (newest.created_at || 0) : 0);
    setUnreadChannelCount(calculateUnreadChannelCount());
  }, [calculateUnreadChannelCount, newestMessageOf]);

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
  // which finger (or mouse) is dragging the seek bar
  const scrubPointerIdRef = useRef(null);
  const handleNextRef = useRef(() => {});
  const eqFiltersRef = useRef([]);
  const analyserRef = useRef(null);
  const playbackSourceRef = useRef('personal');
  const playbackQueueRef = useRef([]);
  const channelQueueRef = useRef(channelQueue);
  const channelPlayerStateRef = useRef(channelPlayerState);
  // how long the room has been waiting to start, for the text that explains it
  const syncWaitSeconds = useElapsedSeconds(channelPlayerState?.sync_phase === 'preparing');
  const bufferStageRef = useRef('');
  bufferStageRef.current = bufferStage;
  const lastQueueRefreshRef = useRef(0);
  // when the person last pressed join on a channel: a paused song of their own does not stop them hearing the room then
  const explicitJoinAtRef = useRef(0);
  // the player that floats over other apps (phone): ready, needs_permission or off.
  // read again when the app comes back, the permission is given on a system screen
  const [floatingStatus, setFloatingStatus] = useState('');
  // the mini player window of the desktop app: on by default, can be switched off
  const [miniPlayerOn, setMiniPlayerOn] = useState(() => {
    try { return window.localStorage.getItem('music_miniplayer') !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('music_miniplayer', miniPlayerOn ? 'on' : 'off'); } catch { /* not remembered */ }
    setMiniplayerEnabled(miniPlayerOn);
  }, [miniPlayerOn]);
  useEffect(() => {
    if (!isAndroidApp()) return undefined;
    const read = () => {
      try {
        setFloatingStatus(window.SmpNative.floatingStatus ? String(window.SmpNative.floatingStatus()) : '');
      } catch {
        setFloatingStatus('');
      }
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, []);
  const playRequestSerialRef = useRef(0);
  const autoplayRef = useRef(true);
  const lastSharedRevisionRef = useRef('');
  const sharedRecoveryTimeoutRef = useRef(null);
  const socialLayoutHydratedRef = useRef(true);
  const collabLayoutHydratedRef = useRef(true);
  const youtubeSyncReadyRef = useRef(false);
  const queueSyncReadyRef = useRef(false);

  // what was last saved to, or loaded from, the account. a change only goes to
  // the server when it differs from this, so data that just arrived from another
  // device is not sent straight back
  const lastSyncedPlaylistsRef = useRef('');
  const lastSyncedQueueRef = useRef('');
  // true from the moment of a local edit until it has been saved. an update from
  // another device that lands in that window waits, the local edit goes first
  const playlistSyncPendingRef = useRef(false);
  const queueSyncPendingRef = useRef(false);
  const accountChangeHandlerRef = useRef(() => {});
  const lastAccountLoadAtRef = useRef(0);
  // bumped to make the save effects run again, for edits made while offline
  const [syncTick, setSyncTick] = useState(0);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const MAX_STREAM_RETRIES = 3;
  // tracks whether the local client recently errored - used to prevent cascading skips from shared sync
  const localStreamErrorRef = useRef(false);
  const localStreamErrorTimerRef = useRef(null);
  // tracks the previous shared player is_playing state - used to detect pause→resume transitions
  const prevSharedPlayingRef = useRef(false);
  // personal player state persistence - saves the last paused position for resume
  const personalPlayerStateRef = useRef({ videoId: null, currentTime: 0, duration: 0 });
  // the song the solo player was on. the solo card keeps showing it, paused, while
  // this device is listening to the room instead
  const lastSoloTrackRef = useRef(null);

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


  // logging every hover/click/input while debug mode is on used to call
  // setDebugEntries synchronously per event - each one a full re-render of
  // this whole (huge) component. harmless on its own, but drag a native
  // range input (the theme color hue slider, eq bands) while the mouse
  // is constantly re-triggering hover logging mid-drag and the browser's
  // own drag tracking on that input gets stomped by the reconciliation,
  // so the slider just stops responding for as long as debug mode is on.
  // the ref is still updated immediately (nothing is lost, "copy all
  // logs" etc. always see everything) - only the visible React state
  // (and the re-render it causes) is throttled, decoupling how often the
  // UI updates from how often raw events fire
  const appendDebugEntry = useCallback((entry) => {
    const next = [...debugEntriesRef.current, entry].slice(-400);
    debugEntriesRef.current = next;
    if (debugFlushTimeoutRef.current) return;
    debugFlushTimeoutRef.current = setTimeout(() => {
      debugFlushTimeoutRef.current = null;
      setDebugEntries(debugEntriesRef.current);
    }, 250);
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
  // buttons - both just need the same combined text, one to the
  // clipboard and one to disk.
  const buildAllDebugLogsText = useCallback(() => {
    const frontendLogs = debugEntries.map((e) =>
      `${e.ts} [${e.category}] ${e.message}${e.details ? '\n' + formatDebugDetails(e.details) : ''}`
    ).join('\n\n');
    return `=== FRONTEND LOGS (${debugEntries.length} entries) ===\n\n${frontendLogs}\n\n=== BACKEND LOGS ===\n\n${backendDebugSnapshot || '(not loaded)'}\n`;
  }, [debugEntries, backendDebugSnapshot]);

  // debug console window chrome - draggable by its title bar, resizable via
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

  // the phone has no mini player until the app is allowed to display over other apps.
  // said once, the first time something plays
  useEffect(() => {
    if (!isAndroidApp() || !isPlaying || floatingStatus !== 'needs_permission') return;
    try {
      if (window.localStorage.getItem('music_mini_hint') === '1') return;
      window.localStorage.setItem('music_mini_hint', '1');
    } catch {
      return;
    }
    showNotification('for the mini player, allow display over other apps. it is in settings under mini player', 'info');
  }, [floatingStatus, isPlaying, showNotification]);

  const upsertConversationPreview = useCallback((message) => {
    if (!message?.sender_id || !message?.receiver_id) return;

    const countAsUnread = message.sender_id !== currentUserId && message.unread === true;
    setConversationList((prev) => upsertConversationPreviewEntries(prev, message, currentUserId, countAsUnread));
  }, [currentUserId]);

  const refreshBackendDebugLogs = useCallback(async () => {
    // /api/debug/logs needs no login when the server is on this machine
    // (the server only hands logs to local requests or admins), so dont gate
    // this on currentUserId. that meant backend logs never loaded while
    // signed out, which is exactly when this console tends to get used
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
  }, [addDebugLog]);

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

  // tell the account's other devices what this one is playing, when it changes
  // and every ten seconds while it plays (so they can follow the position).
  // sent straight over the socket: this is routine and would only fill the log
  useEffect(() => {
    if (!isConnected || !user) return undefined;
    const send = () => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const audio = audioRef.current;
      socket.send(JSON.stringify({
        type: 'device_state',
        device: deviceInfo,
        state: currentTrack ? {
          title: currentTrack.title,
          author: currentTrack.author,
          videoId: currentTrack.videoId,
          thumbnail: currentTrack.thumbnail || '',
          source: playbackSource,
          playing: isPlaying,
          position: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          duration: audio && Number.isFinite(audio.duration) ? audio.duration : 0
        } : null
      }));
    };
    send();
    if (!isPlaying) return undefined;
    const timer = setInterval(send, 10000);
    return () => clearInterval(timer);
  }, [isConnected, user, currentTrack, isPlaying, playbackSource, deviceInfo]);

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
      // silent fail - polling hits localhost without auth cookies during dev
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
      setConversationList((prev) => {
        const merged = normalizeConversationList(next, prev);
        // a chat that was just opened has no messages yet, so the server does not list it.
        // dropping it here made the first message to anyone new impossible to send
        const openId = selectedConversationRef.current;
        const placeholder = openId && !merged.some((entry) => entry.user_id === openId)
          ? (Array.isArray(prev) ? prev : []).find((entry) => entry.user_id === openId)
          : null;
        return placeholder ? [placeholder, ...merged] : merged;
      });
    } catch (error) {
      // silent fail - polling hits localhost without auth cookies during dev
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
    // the person list knows the name too, a brand new chat is not in the conversation list yet
    const targetUsername = targetEntry?.username
      || allUsers.find((entry) => entry.id === selectedConversationId)?.username
      || '';

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
  }, [addDebugLog, allUsers, currentUserId, currentUsername, dmText, pushDirectMessage, selectedConversationId, showNotification, upsertConversationPreview]);

  const joinChannel = useCallback(async (channel, code = '', options = {}) => {
    const targetChannel = typeof channel === 'string'
      ? channels.find((entry) => entry.id === channel)
      : channel;

    if (!targetChannel?.id) return;
    // pressing join means "let me hear it", being put back after opening the app does not
    if (!options.silent) explicitJoinAtRef.current = Date.now();
    try { window.localStorage.setItem(`music_last_channel:${currentUserId}`, targetChannel.id); } catch { /* not remembered */ }

    const alreadyJoined = Array.isArray(targetChannel.members)
      && targetChannel.members.some((member) => member.user_id === currentUserId);

    try {
      let channelPayload = targetChannel;

      if (!alreadyJoined) {
        const data = await fetchJson(`/api/servers/${encodeURIComponent(targetChannel.id)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
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

  // once the channels are known after opening the app: back into the one that was open
  const autoRejoinTriedRef = useRef(false);
  useEffect(() => {
    if (!currentUserId || currentChannelId || autoRejoinTriedRef.current || !channels.length) return;
    autoRejoinTriedRef.current = true;
    let savedId = '';
    try { savedId = window.localStorage.getItem(`music_last_channel:${currentUserId}`) || ''; } catch { /* nothing remembered */ }
    const channel = savedId && channels.find((entry) => entry.id === savedId && Array.isArray(entry.members) && entry.members.some((member) => member.user_id === currentUserId));
    if (channel) joinChannel(channel, '', { silent: true });
  }, [channels, currentChannelId, currentUserId, joinChannel]);

  const leaveChannel = useCallback(async (channelId = currentChannelId) => {
    if (!channelId) return;

    try {
      await fetchJson(`/api/servers/${encodeURIComponent(channelId)}/leave`, {
        method: 'POST'
      });
      try {
        if (window.localStorage.getItem(`music_last_channel:${currentUserId}`) === channelId) window.localStorage.removeItem(`music_last_channel:${currentUserId}`);
      } catch { /* nothing to forget */ }

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
  }, [currentChannelId, currentUserId, refreshChannels, refreshUsers, showNotification]);

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
          name,
          isPrivate: newChannelPrivate
        })
      });

      // a server from before private channels ignores the setting and makes an
      // ordinary public channel. that must not pass for a private one, so it is
      // taken down again and the person told
      if (newChannelPrivate && data.server && !data.server.is_private) {
        try { await fetchJson(`/api/servers/${encodeURIComponent(data.server.id)}`, { method: 'DELETE' }); } catch { /* it is still only a public channel */ }
        await refreshChannels();
        showNotification('this server has not been updated for private channels yet, so nothing was created', 'warning');
        return;
      }
      setNewChannelName('');
      setNewChannelPrivate(false);
      setNewChannelDescription('');
      await refreshChannels();
      if (data.server) {
        await joinChannel(data.server);
      }
    } catch (error) {
      showNotification(error.message || 'failed to create channel', 'warning');
    }
  }, [joinChannel, newChannelName, newChannelPrivate, refreshChannels, showNotification]);

  // joining a private channel with just its code, no need to find it in the list
  const joinChannelByCode = useCallback(async (rawCode) => {
    const code = String(rawCode || '').trim();
    if (!code) return;
    try {
      const data = await fetchJson('/api/servers/join-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      setJoinCodeText('');
      setCodeEntryFor('');
      setCodeEntryText('');
      await refreshChannels();
      if (data.server) {
        showNotification(data.alreadyMember ? `you are already in ${data.server.name}` : `joined ${data.server.name}`, 'success');
        await joinChannel(data.server);
      }
    } catch (error) {
      showNotification(error.message || 'that code did not work', 'warning');
    }
  }, [joinChannel, refreshChannels, showNotification]);

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

  // the whole of your queue into the room's queue: one request per song, one
  // refresh at the end (adding one at a time reloaded the room after every song)
  const [roomAddProgress, setRoomAddProgress] = useState(null);
  const addTracksToRoom = useCallback(async (tracks, label = 'your queue') => {
    if (!currentChannelId || roomAddProgress) return;
    // songs the room already has are left out, so pressing it twice does not double the queue
    const inRoom = new Set(channelQueueRef.current.map((track) => normalizeTrack(track).videoId));
    const list = (tracks || []).map((track) => normalizeTrack(track)).filter((track) => track.videoId && track.title && !inRoom.has(track.videoId));
    if (!list.length) {
      showNotification(`everything in ${label} is already in the room`, 'info');
      return;
    }
    let added = 0;
    for (let i = 0; i < list.length; i += 1) {
      setRoomAddProgress({ done: i, total: list.length });
      try {
        await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId: list[i].videoId,
            title: list[i].title,
            author: list[i].author,
            format: list[i].format,
            source: list[i].source,
            thumbnail: list[i].thumbnail,
            externalUrl: list[i].externalUrl,
            durationMs: list[i].durationMs
          })
        });
        added += 1;
      } catch (error) {
        addDebugLog('error', 'adding the queue to the room failed', { error: error.message || String(error) }, true);
        // three in a row failing means the room is not taking them, stop there
        if (added === 0 && i >= 2) break;
      }
    }
    setRoomAddProgress(null);
    await loadChannelState(currentChannelId);
    showNotification(added ? `added ${added} song${added === 1 ? '' : 's'} to the room's queue` : `could not add ${label} to the room`, added ? 'success' : 'warning');
  }, [addDebugLog, currentChannelId, loadChannelState, roomAddProgress, showNotification]);
  const addMyQueueToRoom = useCallback(() => addTracksToRoom(queueRef.current, 'your queue'), [addTracksToRoom]);

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
    const wantsPlay = nextState.is_playing === true;
    // a play request is only a request: nothing starts until the server says
    // everyone is ready. so locally it shows as "preparing" (load the track,
    // stay paused) and the server's reply decides when it actually plays.
    // a pause takes effect right away
    const optimisticState = normalizeChannelPlayerState({
      ...(channelPlayerState || {}),
      ...nextState,
      current_track_id: nextState.current_track_id ?? channelPlayerState?.current_track_id ?? null,
      is_playing: false,
      sync_phase: wantsPlay ? 'preparing' : 'paused',
      start_at_ms: null,
      current_time: nextState.current_time ?? channelPlayerState?.current_time ?? 0,
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

        lastSyncedPlaylistsRef.current = JSON.stringify(serializePlaylistsForSync(nextPlaylists));
        lastAccountLoadAtRef.current = Date.now();
        setPlaylists((prev) => [...nextPlaylists, ...prev.filter((playlist) => playlist.type === 'collab')]);
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

  // keep a copy of the account's playlists on the device, so they show offline
  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem(`music_playlists_user:${user.id}`, JSON.stringify(playlists.filter((playlist) => playlist.type !== 'collab')));
    } catch {
      // storage full or blocked, the server copy is the real one
    }
  }, [user, playlists]);

  useEffect(() => {
    if (!user || !youtubeSyncReadyRef.current) return;

    const body = serializePlaylistsForSync(playlists);
    const bodyJson = JSON.stringify(body);
    // nothing new to save: this is what the account already has
    if (bodyJson === lastSyncedPlaylistsRef.current) {
      playlistSyncPendingRef.current = false;
      return;
    }
    playlistSyncPendingRef.current = true;

    const syncTimer = setTimeout(async () => {
      try {
        await fetchJson('/api/user/playlists-sync', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ playlists: body })
        });
        lastSyncedPlaylistsRef.current = bodyJson;
      } catch (error) {
        console.warn('Playlist sync save error:', error);
      } finally {
        playlistSyncPendingRef.current = false;
      }
    }, 300);

    return () => clearTimeout(syncTimer);
  }, [user, playlists, syncTick]);

  useEffect(() => {
    if (!user) return;

    let ignore = false;
    queueSyncReadyRef.current = false;

    const loadAccountQueue = async () => {
      try {
        const data = await fetchJson('/api/user/queue');
        if (ignore) return;

        const nextQueue = serializeQueueForSync(data.queue);

        lastSyncedQueueRef.current = JSON.stringify(nextQueue);
        lastAccountLoadAtRef.current = Date.now();
        setQueue(nextQueue);
      } catch (error) {
        // no connection: the queue that was saved on this device stays
        console.warn('Queue sync load error:', error);
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

    const normalizedQueue = serializeQueueForSync(queue);
    const queueJson = JSON.stringify(normalizedQueue);
    // nothing new to save: this is what the account already has
    if (queueJson === lastSyncedQueueRef.current) {
      queueSyncPendingRef.current = false;
      return true;
    }
    queueSyncPendingRef.current = true;

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
      lastSyncedQueueRef.current = queueJson;
      queueSyncPendingRef.current = false;
      return true;
    } catch (error) {
      queueSyncPendingRef.current = false;
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

    if (JSON.stringify(serializeQueueForSync(queue)) !== lastSyncedQueueRef.current) {
      queueSyncPendingRef.current = true;
    }
    const syncTimer = setTimeout(() => {
      syncPersonalQueueNow('queue change');
    }, 300);

    return () => clearTimeout(syncTimer);
  }, [queue, syncPersonalQueueNow, user, syncTick]);

  // something changed on another device (or this one reconnected after being
  // away): fetch the new data and show it. it is marked as already saved, so it
  // is not sent back, which would only bounce between the devices
  accountChangeHandlerRef.current = (data) => {
    if (!user) return;
    if (data && data.origin && data.origin === CLIENT_ID) return;
    const scope = data && data.scope;
    const everything = scope === 'all';
    // right after a load there is nothing newer to fetch
    if (everything && Date.now() - lastAccountLoadAtRef.current < 4000) return;

    // edits made here that never reached the account (made offline) are sent
    // first. fetching now would replace them with the older copy on the server
    const playlistsUnsynced = youtubeSyncReadyRef.current
      && JSON.stringify(serializePlaylistsForSync(playlists)) !== lastSyncedPlaylistsRef.current;
    const queueUnsynced = queueSyncReadyRef.current
      && JSON.stringify(serializeQueueForSync(queue)) !== lastSyncedQueueRef.current;
    if (playlistsUnsynced || queueUnsynced) setSyncTick((tick) => tick + 1);

    if ((everything || scope === 'playlists') && youtubeSyncReadyRef.current && !playlistSyncPendingRef.current && !playlistsUnsynced) {
      fetchJson('/api/user/playlists').then((res) => {
        const next = (Array.isArray(res.playlists) ? res.playlists : []).map((playlist) => ({
          ...playlist,
          tracks: Array.isArray(playlist.tracks)
            ? playlist.tracks.map((track) => normalizeTrack(track)).filter((track) => track.videoId)
            : []
        }));
        const json = JSON.stringify(serializePlaylistsForSync(next));
        if (json === lastSyncedPlaylistsRef.current) return;
        lastSyncedPlaylistsRef.current = json;
        setPlaylists((prev) => [...next, ...prev.filter((playlist) => playlist.type === 'collab')]);
        setCurrentPlaylistId((prev) => next.find((playlist) => playlist.id === prev)?.id || next[0]?.id || '');
      }).catch(() => {});
    }

    if ((everything || scope === 'queue') && queueSyncReadyRef.current && !queueSyncPendingRef.current && !queueUnsynced) {
      fetchJson('/api/user/queue').then((res) => {
        const next = serializeQueueForSync(res.queue);
        const json = JSON.stringify(next);
        if (json === lastSyncedQueueRef.current) return;
        lastSyncedQueueRef.current = json;
        setQueue(next);
        // keep the highlight on the song that is playing, wherever it moved to
        const playing = currentTrackRef.current;
        if (playing && playbackSourceRef.current === 'personal') {
          const at = next.findIndex((track) => track.videoId === playing.videoId);
          if (at >= 0 && at !== playIndexRef.current) {
            playIndexRef.current = at;
            setPlayIndex(at);
            if (!queueRunningRef.current) setCurrentIndex(at);
          }
        }
      }).catch(() => {});
    }

    if ((everything || scope === 'settings') && typeof onAccountSettingsChanged === 'function') {
      onAccountSettingsChanged();
    }
  };

  useEffect(() => {
    playbackSourceRef.current = playbackSource;
    playbackQueueRef.current = playbackSource === 'shared' ? channelQueue : queue;
    if (playbackSource === 'personal' && currentTrack) lastSoloTrackRef.current = currentTrack;
  }, [channelQueue, playbackSource, queue, currentTrack]);

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

  // signing in to an empty account carries over what was made as a guest
  // (see guestTransfer.js), this tells the user it happened
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = window.sessionStorage.getItem('music_guest_transfer_note');
      if (!raw) return;
      window.sessionStorage.removeItem('music_guest_transfer_note');
      const moved = JSON.parse(raw);
      const parts = [];
      if (moved.tracks) parts.push(`${moved.tracks} saved songs in ${moved.playlists} playlist${moved.playlists === 1 ? '' : 's'}`);
      if (moved.queue) parts.push(`${moved.queue} queued songs`);
      if (moved.color) parts.push('your theme color');
      if (parts.length) showNotification(`moved ${parts.join(', ')} into your account`, 'success');
    } catch {
      // only a notice, nothing depends on it
    }
  }, [showNotification, user?.id]);

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

  // swipe sideways to change tab, like the pages of a phone's home screen: the
  // page follows the finger, the next tab slides in beside it, and on release it
  // either settles on that tab or springs back. a swipe is only claimed when it
  // starts clearly sideways, and never on something that has a drag of its own
  // (sliders, the seek bar, text boxes, lists that scroll sideways) or near the
  // screen edge where the phone's own back gesture lives
  useEffect(() => {
    const order = ['main', 'social', 'collab'];
    const ease = 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)';
    let start = null;
    let settling = false;
    const startsOnSomethingElse = (element) => {
      if (!element || !element.closest) return false;
      if (element.closest('input, textarea, select, button, a, [role="slider"], [data-no-swipe], .resize-handle, .modal, .dropdown-menu')) return true;
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 4) return true;
      }
      return false;
    };
    const neighbourFor = (side) => {
      const next = order[order.indexOf(activeTabRef.current) + side];
      if (!next) return null;
      if (offlineModeActiveRef.current && next !== 'main') return null;
      return next;
    };
    const onTouchStart = (event) => {
      if (settling || event.touches.length !== 1 || scrubbingRef.current || document.body.classList.contains('modal-open')) { start = null; return; }
      const touch = event.touches[0];
      const edge = 28;
      if (touch.clientX < edge || touch.clientX > window.innerWidth - edge || startsOnSomethingElse(event.target)) { start = null; return; }
      start = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastAt: Date.now(), velocity: 0, lock: null, side: 0, neighbour: null, scrollY: window.scrollY };
    };
    const onTouchMove = (event) => {
      if (!start || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!start.lock) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.4) {
          start.lock = 'x';
          start.side = dx < 0 ? 1 : -1;
          start.neighbour = neighbourFor(start.side);
          if (start.neighbour) setPeek({ tab: start.neighbour, side: start.side, top: start.scrollY });
        } else {
          start.lock = 'y';
        }
      }
      if (start.lock !== 'x') return;
      // the page does not scroll up and down while it is being swiped
      if (event.cancelable) event.preventDefault();
      const now = Date.now();
      // speed, measured over at least a few milliseconds so two events close together do not spike it
      const dt = now - start.lastAt;
      if (dt >= 8) {
        start.velocity = 0.7 * start.velocity + 0.3 * ((touch.clientX - start.lastX) / dt);
        start.lastX = touch.clientX;
        start.lastAt = now;
      }
      const el = pagerRef.current;
      if (!el) return;
      // towards the next tab the page follows the finger. the other way, or with
      // no tab to go to (the end, or offline), it only stretches a little
      const pull = -dx * start.side;
      const shift = start.neighbour ? (pull > 0 ? dx : 0) : Math.max(-60, Math.min(60, dx * 0.25));
      el.style.transition = 'none';
      el.style.transform = `translate3d(${shift}px, 0, 0)`;
    };
    const finish = (event, cancelled) => {
      if (!start) return;
      const swipe = start;
      start = null;
      if (swipe.lock !== 'x') return;
      const el = pagerRef.current;
      if (!el) { setPeek(null); return; }
      const touch = !cancelled && event.changedTouches && event.changedTouches[0];
      const dx = touch ? touch.clientX - swipe.x : 0;
      const pull = -dx * swipe.side;
      const width = window.innerWidth;
      const flicked = -swipe.velocity * swipe.side > 0.45;
      const goes = !!swipe.neighbour && !cancelled && (pull > width * 0.33 || (pull > 40 && flicked));
      settling = true;
      el.style.transition = ease;
      el.style.transform = goes ? `translate3d(${-swipe.side * width}px, 0, 0)` : 'translate3d(0, 0, 0)';
      setTimeout(() => {
        el.style.transition = 'none';
        if (goes) {
          // the new tab becomes the page in place and the offset is cleared in the
          // same step, so nothing is drawn in between
          flushSync(() => {
            setActiveTab(swipe.neighbour);
            setPeek(null);
          });
          el.style.transform = '';
          window.scrollTo(0, 0);
        } else {
          el.style.transform = '';
          setPeek(null);
        }
        settling = false;
      }, 250);
    };
    const onTouchEnd = (event) => finish(event, false);
    const onTouchCancel = (event) => finish(event, true);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    };
  }, []);

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
    if (activeTab === 'collab' && currentChannelId) {
      markChannelRead(currentChannelId);
    }
    // recalculate channel count whenever tab changes
    if (activeTab !== 'collab') {
      setUnreadChannelCount(calculateUnreadChannelCount());
    }
  }, [activeTab, calculateUnreadChannelCount, currentChannelId, markChannelRead]);

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

    // the user list is fetched again when someone comes or goes. a burst of changes (every device
    // that reconnects counts) used to be one request each, thousands in an evening for a handful
    // of people, so they are gathered into one, and none are made while the page is hidden
    let usersSoonTimer = null;
    let usersDirty = false;
    const refreshUsersSoon = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        usersDirty = true;
        return;
      }
      if (usersSoonTimer) return;
      usersSoonTimer = setTimeout(() => {
        usersSoonTimer = null;
        refreshUsers();
      }, 1500);
    };
    const onUsersVisible = () => {
      if (document.visibilityState === 'visible' && usersDirty) {
        usersDirty = false;
        refreshUsers();
      }
    };
    document.addEventListener('visibilitychange', onUsersVisible);

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
        if (!wsDownSinceRef.current) wsDownSinceRef.current = Date.now();
        // what the other devices were playing is unknown until the connection is back
        setOtherDevices({});
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
              // (re)connected: pick up anything that changed while away. a connection that only
              // dropped for a few seconds missed nothing worth downloading the whole queue,
              // the playlists and the settings again for
              if (!wsDownSinceRef.current || Date.now() - wsDownSinceRef.current > 15000) {
                accountChangeHandlerRef.current({ scope: 'all', origin: '' });
              }
              wsDownSinceRef.current = 0;
              break;

            case 'account_data_changed':
              accountChangeHandlerRef.current(data);
              break;

            case 'presence_update':
              refreshUsersSoon();
              break;

            case 'user_joined':
            case 'user_left':
              refreshUsersSoon();
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

            case 'device_states':
              setOtherDevices((prev) => {
                const next = { ...prev };
                (Array.isArray(data.devices) ? data.devices : []).forEach((entry) => {
                  if (entry && entry.clientId && entry.state) {
                    next[entry.clientId] = { device: entry.device, state: entry.state, receivedAt: Date.now() };
                  }
                });
                return next;
              });
              break;

            case 'device_state_changed':
              if (data.from && data.from.clientId) {
                setOtherDevices((prev) => {
                  const next = { ...prev };
                  if (data.state) {
                    next[data.from.clientId] = { device: data.from.device, state: data.state, receivedAt: Date.now() };
                  } else {
                    delete next[data.from.clientId];
                  }
                  return next;
                });
              }
              break;

            case 'device_command':
              deviceCommandRef.current(data.command);
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

            case 'sync_dropped':
              if (data.serverId === currentChannelRef.current) {
                // this player was not ready in time and the room started without it.
                // it stops following the room, pressing play there joins again
                const droppedAudio = audioRef.current;
                autoplayRef.current = false;
                if (droppedAudio) droppedAudio.pause();
                setIsPlaying(false);
                setPlaybackSource('personal');
                playbackSourceRef.current = 'personal';
                showNotification(data.reason || 'the room started without you, press play to join it', 'warning');
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
                // message in a channel the user isnt currently viewing - bump unread
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
                  tracks: Array.isArray(data.playlist.tracks) ? data.playlist.tracks : [],
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
                // the one who added it already has it (from the answer to their request)
                setPlaylists((prev) => prev.map((p) => (
                  p.id === data.playlistId && !p.tracks.some((t) => t.id === data.track.id)
                    ? { ...p, tracks: [...p.tracks, { ...normalizeTrack(data.track), id: data.track.id, addedAt: Date.now() }] }
                    : p
                )));
              }
              break;

            case 'collab_playlist_tracks_added':
              if (data.serverId === currentChannelRef.current && data.playlistId && Array.isArray(data.tracks)) {
                setPlaylists((prev) => prev.map((p) => {
                  if (p.id !== data.playlistId) return p;
                  const known = new Set(p.tracks.map((t) => t.id));
                  const fresh = data.tracks.filter((t) => !known.has(t.id)).map((t) => ({ ...normalizeTrack(t), id: t.id, addedAt: Date.now() }));
                  return fresh.length ? { ...p, tracks: [...p.tracks, ...fresh] } : p;
                }));
              }
              break;

            case 'collab_playlist_track_removed':
              if (data.serverId === currentChannelRef.current && data.playlistId && (data.trackId || data.trackIndex !== undefined)) {
                setPlaylists((prev) => prev.map((p) => (
                  p.id === data.playlistId
                    ? { ...p, tracks: data.trackId ? p.tracks.filter((t) => t.id !== data.trackId) : p.tracks.filter((_, i) => i !== data.trackIndex) }
                    : p
                )));
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
              if (data.serverId === currentChannelRef.current && data.playlistId && (data.tracks || data.trackIds)) {
                setPlaylists((prev) => prev.map((p) => {
                  if (p.id !== data.playlistId) return p;
                  if (data.tracks) return { ...p, tracks: data.tracks };
                  const byId = new Map(p.tracks.map((t) => [t.id, t]));
                  const ordered = data.trackIds.map((id) => byId.get(id)).filter(Boolean);
                  const rest = p.tracks.filter((t) => !data.trackIds.includes(t.id));
                  return { ...p, tracks: [...ordered, ...rest] };
                }));
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
      clearTimeout(usersSoonTimer);
      document.removeEventListener('visibilitychange', onUsersVisible);
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

  // re-read everything under the correct per-user key when switching between
  // guest and a logged-in account mid-session (login/logout) - the initial
  // useState reads above already used the right uid from the start (App
  // doesn't mount until AppWithAuth's own session check resolves, so
  // user?.id never "resolves late" post-mount anymore). skipping the very
  // first run matters: this used to fire unconditionally on mount too and
  // clobber whatever queue/playIndex a track click had *just* set with
  // whatever was still sitting in localStorage from the last session -
  // right track title on screen, wrong (stale) audio actually loaded
  const didHydrateUserScopedStateRef = useRef(false);
  useEffect(() => {
    if (!didHydrateUserScopedStateRef.current) {
      didHydrateUserScopedStateRef.current = true;
      return;
    }
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

  // persist the personal queue + where playback is in it - this is what
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
    if (queue.length === 0 && typeof stopPersonalPlayback === 'function') {
      stopPersonalPlayback();
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
    // single source of truth for the audio element's native muted flag.
    // setPlayVolume (dragging the slider back up while muted) only ever
    // updated the isMuted *state*, never audio.muted itself - so the UI
    // would show "unmuted" while the element was still actually silenced,
    // and the mute button then needed an extra click to catch up. syncing
    // it here from isMuted, whichever code path changed it, fixes that
    const audio = audioRef.current;
    if (audio) audio.muted = isMuted;
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
    if (!debugMode) return;
    refreshBackendDebugLogs();
  }, [debugMode, refreshBackendDebugLogs]);

  
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
      // nothing typed into a password box gets logged. these entries are
      // saved in the browser and copied out whenever the logs are shared
      if (e.target && e.target.type === 'password') return;
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
        value: target.type === 'password' ? '[hidden]' : (target.value?.slice(0, 100) || null)
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
      // bin - thats what made every bass-end bar/spoke look identical and
      // blocky af. 4096 gives 2048 bins (~20x finer than before), spreading
      // real detail across the low end instead of just mid/treble - still
      // under 100ms per analysis window so its not noticeable, cant even tell
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.8;
      // the default range tops out at -30dB, and loud music sits above that
      // for the bass bins, so they read as a flat 255 and every bar slammed
      // into the ceiling. a higher max leaves headroom so loud parts still
      // move instead of flattening out
      analyser.minDecibels = -95;
      analyser.maxDecibels = -10;
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
    const nextSource = options.source || (trackList === channelQueueRef.current ? 'shared' : 'personal');
    const shouldAutoplay = options.autoplay !== false;
    const shouldNotify = options.notify !== false;
    const shouldRestoreSavedPosition = options.restoreSavedPosition === true;
    const startTime = typeof options.startTime === 'number' && Number.isFinite(options.startTime)
      ? Math.max(0, options.startTime)
      : 0;
    // the queues are read from refs, not from the render this function was made
    // in. it used to be rebuilt every time the single player's queue changed, and
    // the shared playback effect depends on it, so every edit to the single
    // player's queue re-ran the shared playback logic
    const list = (trackList || (nextSource === 'shared' ? channelQueueRef.current : queueRef.current)).map((track) => normalizeTrack(track));
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
    // currentTrackRef, not the currentTrack state: this callback is memoized
    // and only rebuilt when the queues change, so the state value here can be
    // a track or two behind what is actually loaded in the player
    if (nextSource === 'shared' && playbackSourceRef.current !== 'shared' && audioRef.current?.src && Number.isFinite(audioRef.current.currentTime)) {
      personalPlayerStateRef.current = {
        videoId: currentTrackRef.current?.videoId || null,
        currentTime: audioRef.current.currentTime,
        duration: audioRef.current.duration || 0
      };
    }
    playbackSourceRef.current = nextSource;
    setPlaybackSource(nextSource);
    setPlayIndex(index);
    // currentIndex is the solo queue's highlighted row, the room's queue has its own
    if (nextSource !== 'shared') setCurrentIndex(index);
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

    // with no connection a song that is not saved has nothing to play from. move
    // on to a saved one, or stop and say why, instead of sitting on "getting
    // audio ready" until it times out and then skipping through the whole queue
    if (
      isAndroidApp() && nextSource !== 'shared'
      && networkConfirmedDown
      && !offlineIdsRef.current.has(track.videoId)
    ) {
      const savedLeft = list.some((item) => item && offlineIdsRef.current.has(normalizeTrack(item).videoId));
      setIsPlaying(false);
      setIsBuffering(false);
      if (savedLeft) {
        showNotification(`you are offline and "${track.title}" is not saved, skipping to a saved song`, 'warning');
        setTimeout(() => handleNextRef.current(), 400);
      } else {
        showNotification('you are offline and none of these songs are saved. connect to the internet, or save songs for offline first', 'warning');
      }
      return;
    }

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
      console.log('[PLAYTRACK] Saving personal player state before reset', { currentTime: audio.currentTime, videoId: currentTrackRef.current?.videoId });
      personalPlayerStateRef.current = {
        videoId: currentTrackRef.current?.videoId || null,
        currentTime: audio.currentTime,
        duration: audio.duration || 0
      };
    }

    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    // the retry paths reload whatever lastSrc holds. left alone it still
    // points at the previous track until this one finishes resolving, so a
    // retry timer that fires in that gap would play the old track's audio
    // under the new track's title
    delete audio.dataset.lastSrc;
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
    setBufferStage('helper');
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

    setBufferStage('source');
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

          audio._consecutiveFailures = (audio._consecutiveFailures || 0) + 1;
          if (audio._consecutiveFailures >= 3) {
            audio._consecutiveFailures = 0;
            showNotification('stopped: 3 songs in a row would not load. check your connection', 'error');
            return;
          }

          // only skip if nothing else was started in the meantime, or this
          // jumps past a track the user just picked
          setTimeout(() => {
            if (requestSerial !== playRequestSerialRef.current) return;
            handleNextRef.current();
          }, 1000);
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
        audio._consecutiveFailures = 0;
        if (shouldNotify) {
          showNotification(`playing: ${track.title}`, 'info');
        }
      }).catch((err) => {
        if (requestSerial !== playRequestSerialRef.current) {
          return;
        }
        console.warn('Audio play blocked:', err?.message || err);
        // play() rejects on its own the instant the element errors out -
        // onError already puts up a message for that case (and folds it
        // into the retry/stop logic), so toasting here too was just
        // showing the same failure twice. only genuinely new info (e.g.
        // an autoplay-policy block, where the element never errored at
        // all) still gets its own toast
        if (shouldNotify && !audio.error) {
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
  }, [showNotification]);

  const syncSharedPlayerFromAudio = useCallback((overrides = {}) => {
    if (playbackSourceRef.current !== 'shared' || !currentChannelId || !channelPlayerState?.current_track_id) {
      return;
    }

    const audio = audioRef.current;
    const nextState = buildSharedPlayerUpdate({
      currentTrackId: overrides.current_track_id ?? channelPlayerState.current_track_id,
      audioCurrentTime: audio?.currentTime,
      audioVolume: audio?.volume,
      // a seek keeps what the room is doing. the audio of a device that is mid-way
      // through a start (the room is preparing) is paused for a moment, and reporting
      // that paused the room for everyone when two seeks came close together
      isAudioPaused: overrides.is_playing !== undefined
        ? !overrides.is_playing
        : !(channelPlayerState.sync_phase === 'playing' || channelPlayerState.sync_phase === 'preparing' || channelPlayerState.is_playing),
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
        currentTime: liveSharedPosition(sharedState)
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
        startTime: liveSharedPosition(sharedState)
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
      // point audio.duration is NaN - used to write that straight into
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
      setBufferStage('');
      // the retry budget is for one bad stretch, not for a whole song. it only
      // got reset when a new track started, so a few unrelated hiccups spread
      // over a long song used up all the retries and then skipped the track.
      // once playback has run clean for a few seconds after a retry, the
      // slate is wiped
      if (audio._streamRetryCount > 0) {
        clearTimeout(audio._retryResetTimer);
        audio._retryResetTimer = setTimeout(() => {
          audio._streamRetryCount = 0;
          audio._stallCount = 0;
        }, 6000);
      }
      // defensive sync - loadedmetadata is SUPPOSED to fire before playing
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
      if (repeatMode === 'one' && playbackSourceRef.current !== 'shared') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        setIsPlaying(true);
      } else {
        // through the ref: this listener only gets rebuilt when the track or
        // index changes, so calling handleNext directly used a stale copy
        // that missed anything queued with "play next" or a shuffle toggle
        // since the current song started
        handleNextRef.current({ auto: true });
      }
    };

    // retry state for stream errors - prevents immediate skips on transient failures
    audio._streamRetryCount = audio._streamRetryCount || 0;

    const onError = () => {
      // a new load() clears audio.error, so an error event that is still
      // queued from a track we already moved on from shows up here with no
      // error on the element. it belongs to the old track, and acting on it
      // would tear down or skip past the one that is loading now
      if (!audio.error) {
        addDebugLog('playback', 'ignored a stale error event from a previous track', null, true);
        return;
      }

      clearTimeout(audio._retryResetTimer);
      if (audio._loadTimeout) {
        clearTimeout(audio._loadTimeout);
        audio._loadTimeout = null;
      }

      // a decode error on the very last packet of a track (the logs showed two
      // different songs failing 0.2s before their end, at the same spot) is
      // just the song ending. retrying it three times, toasting an error and
      // then skipping was the same outcome the long way round
      if (
        audio.error.code === 3
        && Number.isFinite(audio.duration)
        && audio.currentTime > 10
        && audio.duration - audio.currentTime < 2.5
      ) {
        addDebugLog('playback', 'decode error in the last moments of a track, treating it as the end', {
          videoId: currentTrack?.videoId,
          position: audio.currentTime,
          duration: audio.duration
        }, true);
        audio._streamRetryCount = 0;
        onEnded();
        return;
      }

      const error = audio.error;
      const errorCode = error ? error.code : 0;
      const errorMessage = error ? error.message : 'Unknown error';

      // retry network errors (2), aborted (1), unknown (0), AND decode
      // errors (3). decode errors from youtube's cdn are often transient -
      // just a corrupted segment on a specific edge server. only
      // src-not-supported (4) is truly permanent, everything else gets a shot
      const isRetryable = errorCode === 1 || errorCode === 2 || errorCode === 3 || errorCode === 0;

      if (isRetryable && audio._streamRetryCount < MAX_STREAM_RETRIES) {
        audio._streamRetryCount++;
        const delayMs = Math.min(1000 * Math.pow(2, audio._streamRetryCount - 1), 4000);
        const resumeAt = audio.currentTime;
        addDebugLog('error', `stream error (retryable, attempt ${audio._streamRetryCount}/${MAX_STREAM_RETRIES}): ${errorCode}`, { videoId: currentTrack?.videoId, code: errorCode, msg: errorMessage, resumeAt }, true);

        // retry: reload the same src after a backoff delay. without
        // capturing the position first, reloading drops it back to 0 -
        // which is what made a retried stream look like it "restarted"
        // instead of just quietly recovering in place. sneaky bug
        // a decode error is the player choking on one bad packet, and loading the
        // same spot again hits the same packet again (the log had nine tries in a
        // row failing at one timestamp). so a decode retry steps a little past it
        let retryAt = resumeAt;
        if (errorCode === 3) {
          const badPacketMicros = Number((/timestamp=(\d+)/.exec(errorMessage) || [])[1]);
          const badPacketAt = Number.isFinite(badPacketMicros) ? badPacketMicros / 1e6 : 0;
          retryAt = Math.max(resumeAt, badPacketAt) + 0.4 * audio._streamRetryCount;
        }
        audio._pendingStartTime = retryAt > 0 ? retryAt : null;
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

      // out of retries - recover locally for shared playback, skip for personal playback.
      // the raw code/message ("Playback error (4): MEDIA_ELEMENT_ERROR: ...") used to get
      // toasted here on top of the "stopping playback" / "playback failed: <title>" messages
      // for the exact same failure - three toasts for one event. logged, not toasted; the
      // retry-exhausted and 3-in-a-row cases below already say something more useful
      const message = error ? `Playback error (${error.code}): ${error.message}` : 'Playback failed';
      addDebugLog('error', message, { videoId: currentTrack?.videoId, code: errorCode }, true);
      if (audio._streamRetryCount >= MAX_STREAM_RETRIES) {
        showNotification(`stream failed after ${MAX_STREAM_RETRIES} retries: ${currentTrack?.title || 'track'}`, 'error');
        addDebugLog('error', `stream failed after ${MAX_STREAM_RETRIES} retries: ${currentTrack?.title}`, {
          videoId: currentTrack?.videoId,
          shared: playbackSourceRef.current === 'shared'
        }, true);
      }
      console.error('Audio element error (final):', error);

      // a stream that dies partway through a song is not a reason to jump to
      // the next one: songs should only advance when they reach their end.
      // remember where it got to so pressing play picks up from there. only a
      // track that never got going (or failed right at the end) still skips
      const playedSeconds = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const nearEnd = Number.isFinite(audio.duration) && audio.duration > 0 && playedSeconds >= audio.duration - 3;
      const failedMidSong = playbackSourceRef.current !== 'shared' && playedSeconds > 3 && !nearEnd;
      if (failedMidSong) {
        personalPlayerStateRef.current = {
          videoId: currentTrack?.videoId || null,
          currentTime: playedSeconds,
          duration: audio.duration || 0
        };
      }

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

      if (failedMidSong) {
        addDebugLog('playback', 'stream died mid song, staying on this track instead of skipping', { playedSeconds: Math.round(playedSeconds), videoId: currentTrack?.videoId }, true);
        showNotification('playback stopped', 'info');
        return;
      }

      // track consecutive stream failures to prevent infinite skip loops
      audio._consecutiveFailures = (audio._consecutiveFailures || 0) + 1;
      if (audio._consecutiveFailures >= 3) {
        addDebugLog('error', `${audio._consecutiveFailures} tracks failed in a row, stopping playback`, null, true);
        showNotification('multiple tracks failed - check if local helper is running', 'error');
        audio._consecutiveFailures = 0;
        return;
      }

      if (playbackSourceRef.current === 'shared') {
        scheduleSharedPlaybackRecovery('stream error');
        return;
      }

      // personal mode - skip to next track after a short delay, unless the
      // user (or a second error) already started something else
      const failedSerial = playRequestSerialRef.current;
      setTimeout(() => {
        if (failedSerial !== playRequestSerialRef.current) return;
        handleNextRef.current();
      }, 1000);
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
      setBufferStage('start');
      setTrackProgress({ current: pendingStartTime, duration: audio.duration || 0 });
    };

    const onLoadStart = () => {
      setIsBuffering(true);
    };

    const onWaiting = () => {
      setIsBuffering(true);
      setBufferStage('buffering');
      // not a clean stretch anymore, start the wait over
      clearTimeout(audio._retryResetTimer);
    };

    const onCanPlay = () => {
      setIsBuffering(false);
      setBufferStage('');
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
      // stream - not just on genuinely dead connections, false alarms
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
          // - reloading without this drops playback back to 0, which made
          // a stall recovery look like a random restart. same bug, same fix
          audio._pendingStartTime = resumeAt > 0 ? resumeAt : null;
          const stallSerial = playRequestSerialRef.current;
          setTimeout(() => {
            if (stallSerial !== playRequestSerialRef.current) return;
            const retrySrc = audio.dataset.lastSrc || audio.src;
            if (!retrySrc) return;
            audio.src = retrySrc;
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
          } else if (audio.currentTime > 3) {
            // stalled partway through a song: stop here and keep the spot
            // instead of skipping. play picks it back up from the same place
            personalPlayerStateRef.current = {
              videoId: currentTrack?.videoId || null,
              currentTime: audio.currentTime,
              duration: audio.duration || 0
            };
            audio.pause();
            setIsPlaying(false);
            setIsBuffering(false);
            addDebugLog('playback', 'stream stalled mid song, staying on this track instead of skipping', { videoId: currentTrack?.videoId }, true);
          } else {
            const stalledSerial = playRequestSerialRef.current;
            setTimeout(() => {
              if (stalledSerial !== playRequestSerialRef.current) return;
              handleNextRef.current();
            }, 1000);
          }
        }
      }
    };

    const onPointerMove = (event) => {
      if (!scrubbingRef.current) return;
      // only the finger that started the drag moves it, and a mouse whose button
      // came up outside the window is no longer dragging anything
      if (scrubPointerIdRef.current !== null && event.pointerId !== scrubPointerIdRef.current) return;
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        scrubbingRef.current = false;
        scrubPointerIdRef.current = null;
        return;
      }
      const container = playbackSourceRef.current !== 'shared' ? personalProgressBarRef.current : sharedProgressBarRef.current;
      // only seek when the bar and duration are both real
      const audio = audioRef.current;
      if (!container || !audio || !audio.duration) return;
      seekToClientX(event.clientX, container);
    };

    // a touch the browser takes over (to scroll, say) ends with pointercancel and
    // never a pointerup. without handling it the drag stayed "on" and the next
    // touch anywhere on the screen moved the song to that spot
    const onPointerUp = () => {
      scrubPointerIdRef.current = null;
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
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);

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
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);

      if (audio._loadTimeout) {
        clearTimeout(audio._loadTimeout);
      }
      clearTimeout(audio._retryResetTimer);
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
    // music actually puts its energy) are logarithmic - sampling bins
    // linearly across the bar count crams the entire audible low/mid range
    // into a handful of bars on the left and leaves most of the display
    // showing near-silent 5-20khz content. this maps bar position to a
    // log-spaced point between 20hz and 20khz (audible range, not the full
    // nyquist range up to sampleRate/2) and converts that to the matching
    // bin, so a log sweep - or just normal music - actually uses the whole
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
    // own frequency and the next bar's - NOT the average of that span. bar
    // width in hz grows with frequency (thats the whole point of the log
    // scale), so a high bar can span hundreds of bins while a low one spans
    // only one or two. averaging that span meant a single sine tone sitting
    // in a wide high-frequency bar got diluted by all the silent bins
    // around it - a full-scale 15khz tone would show up as barely a
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

    // scratch state for whichever preset is active - reset fresh every time
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
      // visible "wall" right at the halfway line - a particle rising from
      // the bass half into the treble half would abruptly switch which
      // level drives it, and since treble is usually way quieter than bass,
      // itd suddenly lose speed and shrink right at that boundary. looked
      // so weird. one straightforward pulse/rise for every particle now -
      // no per-particle branching, so no discontinuity - but folds in bass
      // alongside volume so the particles visibly swell and speed up
      // together with the bottom glow instead of moving on an unrelated signal
      const pulseFactor = f.isPlaying ? (0.3 + f.volumeLevel * 0.8 + f.bassPulse * 3.2) : 1;

      state.particles.forEach((particle) => {
        const volumeRise = f.isPlaying ? (f.volumeLevel * 0.6 + f.bassPulse * 2.2) : 0;
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
          // one flat color - plus a saturation/lightness bump so it reads
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
        // height itself pulses with bass too, not just opacity - makes the
        // bottom glow visibly swell on hits instead of just brightening.
        // a little bassLevel is blended in so the glow doesn't vanish to
        // nothing between hits, but bassPulse (the actual hit) is what
        // makes it swell
        const glowHeight = canvas.height * (0.3 + f.bassLevel * 0.06 + f.bassPulse * 0.16);
        const glowGradient = ctx.createLinearGradient(0, canvas.height - glowHeight, 0, canvas.height);
        const glowIntensity = Math.min(1, f.bassLevel * 0.2 + f.bassPulse * 0.55 + f.volumeLevel * 0.08);
        glowGradient.addColorStop(0, `hsla(${f.baseHue}, 70%, 50%, 0)`);
        glowGradient.addColorStop(0.3, `hsla(${f.baseHue}, 70%, 50%, ${glowIntensity * 0.3})`);
        glowGradient.addColorStop(0.6, `hsla(${f.baseHue}, 75%, 45%, ${glowIntensity * 0.5})`);
        glowGradient.addColorStop(1, `hsla(${f.baseHue}, 80%, 40%, ${glowIntensity * 0.7})`);
        ctx.fillStyle = glowGradient;
        ctx.fillRect(0, canvas.height - glowHeight, canvas.width, glowHeight);
      }
    };

    // bends instead of clipping: untouched up to 0.65, then eases toward 1 so
    // a loud passage keeps rising a little instead of going flat against a
    // hard ceiling (the old Math.min(1, x) is why the tops looked chopped off)
    const softCeiling = (x) => (x <= 0.65 ? x : 0.65 + 0.35 * Math.tanh((x - 0.65) / 0.35));

    const renderBars = (f) => {
      const barCount = 48;
      const gap = 3;
      const barWidth = canvas.width / barCount - gap;
      for (let i = 0; i < barCount; i++) {
        const raw = ampForBarRange(i, barCount, f.dataArray);
        // extra boost stacked on top of the bar's own reading, strongest
        // for the low (bass) bars and fading out toward the high end - a
        // real bass hit should visibly slam past where the raw spectrum
        // reading alone would put it, not just be "a bit taller than usual"
        const bassWeight = Math.max(0, 1 - i / (barCount * 0.3));
        const boosted = softCeiling(raw * (1 + f.bassPulse * bassWeight * 2.5));
        const height = f.isPlaying ? Math.max(4, boosted * canvas.height * 0.8) : 4;
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
      // bass swells both the line's glow and how tall its swings read, so
      // a heavy low end visibly punches the waveform outward instead of
      // just being "in there somewhere" along with everything else
      const bassBoost = f.isPlaying ? 1 + f.bassPulse * 0.9 : 0.05;
      ctx.beginPath();
      const midY = canvas.height / 2;
      // every other sample is plenty, there are far more samples than pixels
      const stride = 2;
      const sliceWidth = (canvas.width / f.timeData.length) * stride;
      let x = 0;
      for (let i = 0; i < f.timeData.length; i += stride) {
        const v = (f.timeData[i] - 128) / 128;
        const y = midY + v * midY * 0.8 * bassBoost;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      // the glow is a wide faint stroke under the sharp one. shadowBlur gave
      // the same look but blurs the whole path on the cpu every frame
      ctx.lineJoin = 'round';
      ctx.lineWidth = 9 + f.bassPulse * 9;
      ctx.strokeStyle = `hsla(${f.baseHue}, 85%, 60%, 0.14)`;
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `hsla(${f.baseHue}, 85%, 60%, 0.9)`;
      ctx.stroke();
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
      state.radialAngle += 0.002 + f.bassPulse * 0.012;
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2 + state.radialAngle;
        const raw = ampForBarRange(i, spokes, f.dataArray);
        // same "bass hits should visibly slam" boost bars gets, weighted
        // toward the low-frequency spokes
        const bassWeight = Math.max(0, 1 - i / (spokes * 0.3));
        const boosted = softCeiling(raw * (1 + f.bassPulse * bassWeight * 2.5));
        const len = baseRadius * 0.3 + boosted * baseRadius * 1.4;
        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + len);
        const y2 = cy + Math.sin(angle) * (baseRadius + len);
        // same hue all the way around, but lightness drifts smoothly with
        // angle so it doesn't read as one flat blob - no hard color jumps
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
      // bass drives most of the warp-speed feeling now instead of overall
      // volume - a bassy hit should visibly throw stars past the camera
      const speed = f.isPlaying ? 2 + f.volumeLevel * 4 + f.bassPulse * 16 : 1;
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
          // bass columns (low index) get boosted same as bars/radial, so
          // the left side of the grid visibly floods on a bass hit
          const bassWeight = Math.max(0, 1 - col / (cols * 0.3));
          const raw = Math.min(1, colAmps[col] * (1 + f.bassPulse * bassWeight * 2.5));
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
      // bass is the dominant driver here (not volume) - a quiet bassy
      // moment should still visibly swell/quicken the network, the way
      // particles leans on bassLevel for its own pulse+rise
      const pulseFactor = f.isPlaying ? (0.4 + f.bassPulse * 1.8) : 0.4;
      // drift speed tracks the music, bass first - a small volume term is
      // still in there so it's not completely inert on quiet/bassless
      // audio, but bass is what should actually be felt
      const speedMul = f.isPlaying ? 1 + f.bassPulse * 3.5 + f.volumeLevel * 0.6 : 1;
      state.nodes.forEach((node) => {
        node.x += node.vx * speedMul;
        node.y += node.vy * speedMul;
        if (node.x < 0) node.x = canvas.width;
        if (node.x > canvas.width) node.x = 0;
        if (node.y < 0) node.y = canvas.height;
        if (node.y > canvas.height) node.y = 0;
      });
      // connection range swells with bass too, so the whole web visibly
      // "expands" (more/longer links lighting up) on a hit, not just the
      // individual node dots
      const maxDist = 120 + f.bassPulse * 90;
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

      if (state.rippleTime === undefined) state.rippleTime = 0;
      if (!state.ripples) state.ripples = [];
      state.rippleTime += 0.03 + f.bassPulse * 0.05;

      // ceiling is 0.34 of the screen height now (it was 0.26). softCeiling
      // bends loud peaks instead of clipping them flat, and the analyser has
      // more headroom, so normal loud music no longer sits pinned at the top
      const heights = [];
      const amps = [];
      for (let i = 0; i < barCount; i++) {
        const raw = ampForBarRange(i, barCount, f.dataArray);
        amps.push(raw);
        const bassWeight = Math.max(0, 1 - i / (barCount * 0.3));
        const boosted = softCeiling(raw * (1 + f.bassPulse * bassWeight * 2.5));
        heights.push(f.isPlaying ? Math.max(2, boosted * canvas.height * 0.34) : 2);
      }

      // the real spectrum, sharp
      ctx.fillStyle = `hsla(${f.baseHue}, 85%, 60%, 0.75)`;
      for (let i = 0; i < barCount; i++) {
        ctx.fillRect(i * (barWidth + gap), midY - heights[i], barWidth, heights[i]);
      }

      // its reflection. drawn small and stretched back up, which softens the
      // edges like a blur would. ctx.filter = blur() did the same thing but
      // ran this preset at a few frames per second, canvas filters are very
      // slow. a small per-bar horizontal wobble keeps it reading as water
      const reflectScale = 0.25;
      const reflectW = Math.max(1, Math.round(canvas.width * reflectScale));
      const reflectH = Math.max(1, Math.round((canvas.height - midY) * reflectScale));
      if (!state.reflect) {
        state.reflect = document.createElement('canvas');
        state.reflectCtx = state.reflect.getContext('2d');
      }
      if (state.reflect.width !== reflectW || state.reflect.height !== reflectH) {
        state.reflect.width = reflectW;
        state.reflect.height = reflectH;
      }
      const rctx = state.reflectCtx;
      rctx.clearRect(0, 0, reflectW, reflectH);
      rctx.fillStyle = `hsla(${f.baseHue}, 85%, 60%, 0.35)`;
      for (let i = 0; i < barCount; i++) {
        const wobble = Math.sin(state.rippleTime * 1.5 + i * 0.4) * 2;
        rctx.fillRect((i * (barWidth + gap) + wobble) * reflectScale, 0, barWidth * reflectScale, heights[i] * reflectScale);
      }
      ctx.drawImage(state.reflect, 0, midY, canvas.width, canvas.height - midY);

      // ripples follow the music: a ripple goes out when the sound itself
      // jumps (a kick, a snare, any sudden hit in the low and mid range), not
      // on a timer and not only on huge bass hits. flux is how much the
      // spectrum rose since the last frame, and a hit is flux well above its
      // own recent average, so it adapts to quiet and loud songs alike
      if (!state.prevAmps) state.prevAmps = new Array(barCount).fill(0);
      let flux = 0;
      for (let i = 0; i < barCount; i++) {
        const rise = amps[i] - state.prevAmps[i];
        if (rise > 0) flux += rise * (i < barCount * 0.5 ? 1 : 0.4);
        state.prevAmps[i] = amps[i];
      }
      if (state.fluxMean === undefined) { state.fluxMean = flux; state.fluxVar = 0; }
      const fluxDev = flux - state.fluxMean;
      state.fluxMean += fluxDev * 0.04;
      state.fluxVar += (fluxDev * fluxDev - state.fluxVar) * 0.04;
      const fluxLimit = state.fluxMean + 1.1 * Math.sqrt(state.fluxVar) + 0.25;
      const nowMs = performance.now();
      if (f.isPlaying && flux > fluxLimit && nowMs - (state.lastRippleMs ?? -9999) > 140 && state.ripples.length < 7) {
        const strength = Math.min(1, 0.3 + (flux - fluxLimit) / (state.fluxMean + 0.8));
        state.ripples.push({ life: 0, strength });
        state.lastRippleMs = nowMs;
      }
      state.ripples = state.ripples.filter((ripple) => ripple.life < 1);
      if (state.ripples.length) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, midY, canvas.width, canvas.height - midY);
        ctx.clip();
        state.ripples.forEach((ripple) => {
          ripple.life += 0.012 + ripple.strength * 0.018;
          const radius = ripple.life * canvas.width * (0.35 + ripple.strength * 0.25);
          const alpha = (1 - ripple.life) * (0.15 + ripple.strength * 0.3);
          ctx.strokeStyle = `hsla(${f.baseHue}, 80%, 75%, ${alpha})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.ellipse(canvas.width / 2, midY, radius, radius * 0.15, 0, 0, Math.PI * 2);
          ctx.stroke();
        });
        ctx.restore();
      }
    };

    const renderOrbit = (f) => {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const orbiters = 8;
      if (state.orbitAngle === undefined) state.orbitAngle = 0;
      // old deltas (0.01 base, +0.02*volume) were so close together that
      // the audio-driven part was basically invisible - spin is now mostly
      // volume-driven instead of a near-constant idle crawl with a tiny
      // bonus tacked on
      const spinDelta = f.isPlaying ? 0.004 + f.volumeLevel * 0.09 : 0.004;
      state.orbitAngle += spinDelta;
      for (let i = 0; i < orbiters; i++) {
        // bass swing was capped at +40% radius, barely readable against
        // orbiters already 1.5-8.5x apart in base radius - +140% makes a
        // bass hit visibly punch the whole ring outward.
        const radius = (Math.min(canvas.width, canvas.height) * 0.08) * (i + 1.5) * (1 + f.bassPulse * 1.4);
        const angle = state.orbitAngle * (i % 2 === 0 ? 1 : -1) + i;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 0.6;
        // mostly theme-tinted, small ±10° drift per orbiter plus a
        // lightness stagger so they're visually distinct from each other
        // instead of one flat color, with brighter/more saturated tones
        // than before.
        const hue = (f.baseHue + (i - orbiters / 2) * 2.5 + 360) % 360;
        const lightness = 58 + (i % 4) * 8;
        const size = f.isPlaying ? 4 + f.volumeLevel * 5 + f.bassPulse * 17 : 4;
        ctx.fillStyle = `hsla(${hue}, 95%, ${lightness}%, 0.9)`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const renderFlowField = (f) => {
      if (state.flowTime === undefined) state.flowTime = 0;
      // used to be volume-only (bass had zero say in this one) - now bass
      // is what really pushes the bands, volume just keeps it from being
      // totally flat on quiet/bassless audio
      state.flowTime += 0.02 + f.volumeLevel * 0.01 + f.bassPulse * 0.05;
      const bands = 5;
      for (let b = 0; b < bands; b++) {
        const amplitude = (20 + f.volumeLevel * 15 + f.bassPulse * 65) * (1 - (b / bands) * 0.5);
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
      const pulse = f.isPlaying ? baseRadius * (1 + f.bassPulse * 1.8) : baseRadius;
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
      starfield: renderStarfield,
      pulseGrid: renderPulseGrid,
      network: renderNetwork,
      mirrorSpectrum: renderMirrorSpectrum,
      orbit: renderOrbit,
      flowField: renderFlowField,
      minimalPulse: renderMinimalPulse
    };

    // the desktop app can have a mini player window open that has no audio of
    // its own, so it is fed from here. nothing to feed on the web or the phone
    const feedMiniplayer = isTauriApp() && !isAndroidApp();

    const animate = () => {
      // cap at roughly 60fps. on a 120 or 144hz monitor this loop used to run
      // at the full refresh rate, which is double the work for nothing, and
      // it made the presets move faster there than on a 60hz screen
      const frameNow = performance.now();
      if (frameNow - (state.lastFrameAt || 0) < 13.5) {
        animationFrameId = requestAnimationFrame(animate);
        return;
      }
      state.lastFrameAt = frameNow;

      updateFadeTransition();
      const fadeProgress = fadeTransitionRef.current.progress;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const analyser = analyserRef.current;
      let dataArray = null;
      let timeData = null;
      let bassLevel = 0;
      let volumeLevel = 0;
      let bassPulse = 0;

      if (analyser && isPlaying) {
        // the two buffers are made once and refilled every frame, new ones
        // each frame (6kb at 60fps) was constant garbage for the collector
        if (!state.freqBuffer || state.freqBuffer.length !== analyser.frequencyBinCount) {
          state.freqBuffer = new Uint8Array(analyser.frequencyBinCount);
        }
        if (!state.timeBuffer || state.timeBuffer.length !== analyser.fftSize) {
          state.timeBuffer = new Uint8Array(analyser.fftSize);
        }
        dataArray = state.freqBuffer;
        timeData = state.timeBuffer;
        analyser.getByteFrequencyData(dataArray);
        analyser.getByteTimeDomainData(timeData);

        const bassLength = Math.floor(dataArray.length * 0.1);
        let bassSum = 0;
        for (let i = 0; i < bassLength; i++) bassSum += dataArray[i];
        bassLevel = bassSum / bassLength / 255;

        let volumeSum = 0;
        for (let i = 0; i < dataArray.length; i++) volumeSum += dataArray[i];
        volumeLevel = volumeSum / dataArray.length / 255;

        // bassLevel on its own turned out to be a bad "hit" signal - most
        // mixed music sits with a lot of raw energy in the low end more or
        // less constantly, so boosting straight off of it just made
        // everything sit permanently maxed out instead of actually pumping
        // with the beat. bassPulse tracks a slow-moving floor for the bass
        // band and only lights up when the current instant pushes above
        // it (fast attack, slow decay - the classic percussive-envelope
        // shape) so a sustained bassline reads as "present" without being
        // solid, and an actual kick/hit still visibly punches through
        if (state.bassBaseline === undefined) state.bassBaseline = bassLevel;
        state.bassBaseline += (bassLevel - state.bassBaseline) * 0.06;
        // 4.2 (was 3.5) because the analyser range was widened above, which
        // scales every level down a little
        const onset = Math.max(0, bassLevel - state.bassBaseline) * 4.2;
        state.bassPulse = Math.max(onset, (state.bassPulse || 0) * 0.85);
        bassPulse = Math.min(1, state.bassPulse);
      }

      const renderer = RENDERERS[visualizerPreset] || renderParticles;
      renderer({ baseHue, isPlaying, fadeProgress, bassLevel, bassPulse, volumeLevel, dataArray, timeData });

      // downsampled copy for the miniplayer's own background visualizer -
      // it has no audio context of its own (nothing plays there), so this
      // is literally the only way it can be reactive at all. throttled to
      // ~20fps and 24 points since its a 300x118 window, not worth full
      // resolution or a 60fps ipc call. no-ops cheaply when the miniplayer
      // isnt open. mirrors whichever preset is actually selected: same
      // log-scale frequency mapping the real bar-style renderers use
      // (linear bin sampling was clustering almost all the energy into the
      // first couple of points, since most of a track's energy sits in the
      // low end of a linear spectrum), or the raw waveform for "wave"
      // sent on every frame now (it used to be every third, which is where the
      // choppy look came from). at rest only the first "nothing playing" frame
      // goes out, so a paused player is not sending a message 60 times a second
      // the floating window on the phone gets the same frames, through a global
      const feedFrames = feedMiniplayer || isPipRef.current;
      if (feedFrames && (isPlaying || state.miniWasPlaying !== false)) {
        state.miniWasPlaying = isPlaying;
        let bins = null;
        let wave = null;
        if (dataArray) {
          bins = new Array(24);
          for (let i = 0; i < 24; i++) bins[i] = Math.round(ampForBarRange(i, 24, dataArray) * 255);
        }
        if (timeData) {
          // 96 points from the first quarter of the buffer. the old 24 points
          // were single samples picked far apart, which is not a waveform but
          // noise (that is what read as "too dense"). a short slice at a fine
          // step is a few smooth swings, which is what the main window shows
          const points = 96;
          const span = Math.floor(timeData.length / 4);
          wave = new Array(points);
          for (let i = 0; i < points; i++) wave[i] = timeData[Math.floor((i * span) / points)];
        }
        const frame = { baseHue, isPlaying, preset: visualizerPreset, bins, wave, bassPulse, volumeLevel };
        if (feedMiniplayer) {
          sendVisualizerFrame(frame);
          state.lastMiniSentAt = performance.now();
        }
        if (isPipRef.current) window.__smpVizFrame = frame;
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    animate();

    // the loop above runs on animation frames, which a window that is minimized or
    // covered does not get. the mini player is shown exactly then, and its
    // visualizer stood still. so a timer sends a frame whenever the loop has not for
    // a moment. the floating player on the phone is fed this way too (the app is
    // in the background whenever it shows)
    const onPhone = isAndroidApp() && typeof window !== 'undefined' && window.SmpNative && typeof window.SmpNative.vizFrame === 'function';
    let fallbackTimer = null;
    if (isPlaying && (feedMiniplayer || onPhone)) {
      const buildFrame = () => {
        const analyser = analyserRef.current;
        if (!analyser) return null;
        if (!state.freqBuffer || state.freqBuffer.length !== analyser.frequencyBinCount) state.freqBuffer = new Uint8Array(analyser.frequencyBinCount);
        if (!state.timeBuffer || state.timeBuffer.length !== analyser.fftSize) state.timeBuffer = new Uint8Array(analyser.fftSize);
        const freq = state.freqBuffer;
        const time = state.timeBuffer;
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(time);
        const bassLength = Math.max(1, Math.floor(freq.length * 0.1));
        let bassSum = 0;
        for (let i = 0; i < bassLength; i++) bassSum += freq[i];
        const bassLevel = bassSum / bassLength / 255;
        let volumeSum = 0;
        for (let i = 0; i < freq.length; i++) volumeSum += freq[i];
        if (state.bassBaseline === undefined) state.bassBaseline = bassLevel;
        state.bassBaseline += (bassLevel - state.bassBaseline) * 0.06;
        const onset = Math.max(0, bassLevel - state.bassBaseline) * 4.2;
        state.bassPulse = Math.max(onset, (state.bassPulse || 0) * 0.85);
        const bins = new Array(24);
        for (let i = 0; i < 24; i++) bins[i] = Math.round(ampForBarRange(i, 24, freq) * 255);
        const points = 96;
        const span = Math.floor(time.length / 4);
        const wave = new Array(points);
        for (let i = 0; i < points; i++) wave[i] = time[Math.floor((i * span) / points)];
        return { baseHue, isPlaying: true, preset: visualizerPreset, bins, wave, bassPulse: Math.min(1, state.bassPulse), volumeLevel: volumeSum / freq.length / 255 };
      };
      let fastTick = true;
      const tick = () => {
        if (feedMiniplayer) {
          if (performance.now() - (state.lastMiniSentAt || 0) < 150) return;
          const frame = buildFrame();
          if (frame) {
            sendVisualizerFrame(frame);
            state.lastMiniSentAt = performance.now();
          }
          return;
        }
        // the phone: about thirty frames a second (the window smooths between them)
        const frame = buildFrame();
        if (!frame) return;
        const text = `${Math.round(frame.baseHue)},${frame.bassPulse.toFixed(2)},${frame.preset === 'wave' ? 1 : 0};${frame.bins.join(',')};${frame.wave.join(',')}`;
        let drawn = false;
        try {
          drawn = Boolean(window.SmpNative.vizFrame(text));
        } catch {
          drawn = false;
        }
        // the window is only drawn while it is on screen. when it is not, a slow tick is
        // enough to notice it coming back
        if (drawn !== fastTick) {
          fastTick = drawn;
          clearInterval(fallbackTimer);
          fallbackTimer = setInterval(tick, drawn ? 33 : 400);
        }
      };
      fallbackTimer = setInterval(tick, 33);
    }

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationFrameId);
      if (fallbackTimer) clearInterval(fallbackTimer);
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

  
  // in offline mode every saved song also shows as one list of its own, so songs
  // that are in no playlist can be loaded too
  const savedSongsPlaylist = useMemo(() => {
    if (!offlineModeActive) return null;
    const meta = readLocalJSON('music_offline_meta', {});
    const known = new Map();
    playlists.forEach((playlist) => (playlist.tracks || []).forEach((track) => {
      const normalized = normalizeTrack(track);
      if (normalized.videoId) known.set(normalized.videoId, normalized);
    }));
    const tracks = [...offlineIds].map((id) => meta[id] || known.get(id)).filter(Boolean);
    return { id: '__saved__', name: 'saved songs', type: 'saved', tracks };
  }, [offlineModeActive, offlineIds, playlists]);
  const activePlaylists = savedSongsPlaylist ? [...playlists, savedSongsPlaylist] : playlists;
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
        // desktop app - no per-download "save as" prompt anymore (thank
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

  // the next (or previous) track of the room's queue, following the room's repeat
  // and shuffle. auto means a song ended by itself: repeat one plays it again,
  // and with repeat off the last song ends the queue. a button press always moves
  // on, past the end too. returns { track }, or { stop: true } at the end of the queue
  const pickSharedNext = useCallback(({ direction = 1, auto = false }) => {
    const list = channelQueueRef.current;
    const state = channelPlayerStateRef.current;
    if (!list.length) return null;
    const current = list.findIndex((track) => track.id === state?.current_track_id);
    const repeat = state?.repeat_mode || 'off';
    if (auto && repeat === 'one' && current >= 0) return { track: list[current] };
    if (state?.shuffle && direction > 0) {
      if (list.length === 1) return { track: list[0] };
      let pick = Math.floor(Math.random() * list.length);
      if (pick === current) pick = (pick + 1) % list.length;
      return { track: list[pick] };
    }
    let next = current >= 0 ? current + direction : 0;
    if (next >= list.length) {
      if (auto && repeat === 'off') return { stop: true };
      next = 0;
    }
    if (next < 0) next = list.length - 1;
    return { track: list[next] };
  }, []);

  const stepSharedPlayback = useCallback(async (direction) => {
    if (!currentChannelId || !channelQueue.length) return;
    const pick = pickSharedNext({ direction, auto: false });
    if (!pick || !pick.track) return;
    await playSharedTrack(pick.track, {
      autoplay: true,
      isPlaying: true,
      currentTime: 0
    });
  }, [channelQueue, currentChannelId, pickSharedNext, playSharedTrack]);

  // start listening to what the room is playing right now, at the room's own
  // spot, without touching the room itself. the room's play button on a device
  // that has its own music on used to pause the room for everyone, with that
  // device's own song position as the room's
  const joinRoomPlayback = useCallback(() => {
    const list = channelQueueRef.current;
    const state = channelPlayerStateRef.current;
    const index = list.findIndex((track) => track.id === state?.current_track_id);
    if (index < 0) return false;
    playTrackAtIndex(index, list, {
      source: 'shared',
      autoplay: Boolean(state.is_playing),
      notify: false,
      startTime: liveSharedPosition(state)
    });
    return true;
  }, [playTrackAtIndex]);

  const toggleSharedPlayback = useCallback(async () => {
    if (!currentChannelId) return;

    const liveState = channelPlayerStateRef.current;
    const roomIsGoing = liveState?.is_playing || liveState?.sync_phase === 'playing' || liveState?.sync_phase === 'preparing';
    if (playbackSourceRef.current !== 'shared' && roomIsGoing && joinRoomPlayback()) return;

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
  }, [addDebugLog, channelPlayerState, channelQueue, currentChannelId, currentTrack, joinRoomPlayback, pauseSharedPlayback, playSharedTrack, showNotification]);

  // === synced shared playback ===
  // a play, seek or skip does not start right away. the server first has every
  // listener load the track at the requested spot (phase "preparing"), each
  // player reports "ready" once it has enough buffered, and only then does the
  // server schedule one shared start time. these refs track that handshake.
  const syncReadyTimerRef = useRef(null);
  const reportedSyncRevisionRef = useRef('');
  const syncStartTimerRef = useRef(null);
  const scheduledStartRevisionRef = useRef('');
  const syncModeRef = useRef('no');

  // tell the server this player is loaded at targetTime and good to start. it
  // polls because "ready" is a state of the audio element, not a single event
  const armSyncReady = useCallback((revision, targetTime) => {
    if (!revision || String(revision).startsWith('local:')) return;
    if (reportedSyncRevisionRef.current === revision) return;
    clearInterval(syncReadyTimerRef.current);
    let lastReason = '';
    let lastReasonAt = 0;
    let stuckSince = 0;
    let wokeAt = 0;
    syncReadyTimerRef.current = setInterval(() => {
      const el = audioRef.current;
      if (!el) return;
      if (el.getAttribute('src') && el.paused && (el.seeking || el.readyState < 3) && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (!stuckSince) stuckSince = Date.now();
        if (Date.now() - stuckSince > 800 && Date.now() - wokeAt > 4000) {
          wokeAt = Date.now();
          const wasMuted = el.muted;
          el.muted = true;
          el.play().then(() => {
            setTimeout(() => {
              el.pause();
              el.muted = wasMuted;
            }, 350);
          }).catch(() => { el.muted = wasMuted; });
          addDebugLog('collab', 'woke a suspended player in the background', { revision }, true);
        }
      } else {
        stuckSince = 0;
      }
      // the src attribute, not currentSrc: after the player is torn down
      // (removeAttribute('src') then load()) currentSrc keeps the old address in
      // this browser, so a player with nothing loaded looked like it had a song
      const hasSource = Boolean(el.getAttribute('src'));
      const loaded = hasSource
        && el.readyState >= 3
        && !el.seeking
        && el._pendingStartTime == null
        && Math.abs((el.currentTime || 0) - targetTime) < 1.5;
      // ready means really ready: the track is loaded at the spot and buffered.
      // there is no giving up early, the room waits for this player and shows
      // everyone why. (the server drops a player that never gets ready, so one
      // broken player cannot hold the room silent for ever)
      if (loaded) {
        clearInterval(syncReadyTimerRef.current);
        reportedSyncRevisionRef.current = revision;
        sendWsMessage({ type: 'sync_ready', revision });
        addDebugLog('collab', 'sync ready sent', { revision }, true);
        return;
      }
      const reason = syncReasonFor(el, hasSource, targetTime, bufferStageRef.current);
      const now = Date.now();
      if (reason !== lastReason || now - lastReasonAt > 5000) {
        lastReason = reason;
        lastReasonAt = now;
        sendWsMessage({ type: 'sync_status', revision, reason });
      }
    }, 120);
  }, [addDebugLog, sendWsMessage]);

  useEffect(() => () => {
    clearInterval(syncReadyTimerRef.current);
    clearTimeout(syncStartTimerRef.current);
  }, []);

  // how this player stands for the barrier: "yes" it is playing the shared
  // track, "auto" it is on the shared tab with nothing else playing so it will
  // join in, "no" it is busy with its own music and should not hold anyone up
  useEffect(() => {
    let mode = 'no';
    if (currentChannelId) {
      if (playbackSource === 'shared') mode = 'yes';
      else if (activeTab === 'collab') {
        // "auto" is a promise to join in on its own when the room starts, and
        // the room waits for everyone who made it. a player that has a song of its
        // own loaded (paused or not) will not join, so it must not make it
        const el = audioRef.current;
        const free = Boolean(el) && el.paused && !isBuffering && (!el.getAttribute('src') || el.ended || Date.now() - explicitJoinAtRef.current < 20000);
        if (free) mode = 'auto';
      }
    }
    syncModeRef.current = mode;
    // isConnected is in the deps so this goes out again after every reconnect,
    // a new socket starts out as "no" on the server
    if (isConnected) sendWsMessage({ type: 'sync_presence', mode });
  }, [activeTab, currentChannelId, currentTrack, isBuffering, isConnected, isPlaying, playbackSource, sendWsMessage]);

  // === shared player sync - kicks in once the client's switched to shared playback ===
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const phase = channelPlayerState?.sync_phase
      || (channelPlayerState?.is_playing ? 'playing' : 'paused');

    // anything that is not a scheduled start cancels a pending one
    if (phase !== 'playing') {
      clearTimeout(syncStartTimerRef.current);
      scheduledStartRevisionRef.current = '';
    }

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

      // someone in the channel started the shared player and this one is free
      // (on the shared tab, nothing else playing): join in. a player that is
      // busy with its own music on another tab is left alone
      const joinIndex = channelQueue.findIndex((track) => track.id === channelPlayerState?.current_track_id);
      const someoneStarted = currentChannelId && joinIndex >= 0 && (phase === 'preparing' || phase === 'playing');
      if (currentChannelId && channelPlayerState?.current_track_id && joinIndex < 0 && (phase === 'preparing' || phase === 'playing')
        && Date.now() - lastQueueRefreshRef.current > 3000) {
        // the room is playing a song this player has never heard of, its copy of
        // the queue is behind. get the real one
        lastQueueRefreshRef.current = Date.now();
        loadChannelState(currentChannelId);
      }
      // "free" means nothing of your own is loaded or on its way. the gap between
      // two songs of your own queue (the player is paused while the next one is
      // being found) is not free: it used to count as free, so the room's song
      // took over in the middle of your queue and it carried on with the room's
      // two songs instead of your own. a song you paused yourself is not free
      // either, only an empty player or one whose last song has ended
      const justJoined = Date.now() - explicitJoinAtRef.current < 20000;
      const freeToJoin = activeTabRef.current === 'collab'
        && audio.paused
        && !isBufferingRef.current
        && (!audio.getAttribute('src') || audio.ended || justJoined);
      if (someoneStarted && freeToJoin) {
        playTrackAtIndex(joinIndex, channelQueue, {
          source: 'shared',
          autoplay: false,
          notify: false,
          startTime: liveSharedPosition(channelPlayerState)
        });
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
      playbackQueueRef.current = queueRef.current;
      return;
    }

    const nextIndex = channelQueue.findIndex((track) => track.id === channelPlayerState.current_track_id);
    if (nextIndex < 0) {
      if (Date.now() - lastQueueRefreshRef.current > 3000) {
        lastQueueRefreshRef.current = Date.now();
        sendWsMessage({ type: 'sync_status', revision: String(channelPlayerState.revision || ''), reason: 'getting the room queue' });
        loadChannelState(currentChannelId);
      }
      return;
    }

    const nextTrack = normalizeTrack(channelQueue[nextIndex]);
    const currentVideoId = currentTrack?.videoId || '';
    // in shared mode, only load a new track if the track id actually
    // changed and were not mid-way through handling a stream error
    const trackIdChanged = currentVideoId !== nextTrack.videoId;
    // the src attribute, not currentSrc (see armSyncReady). a player that was torn
    // down after an error or a stop kept its old currentSrc, so this said "a song
    // is loaded", nothing ever reloaded it, and it sat silent in a room that was
    // playing until the track changed
    const hasLoadedSource = Boolean(audio.getAttribute('src'));
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

    // volume and mute are this player's own. only the audio itself is shared
    audio.volume = isMuted ? 0 : volume;

    // preparing: get the track loaded at the requested spot, stay paused, and
    // report ready when buffered. nothing plays until the server schedules it
    if (phase === 'preparing') {
      autoplayRef.current = false;
      const position = Number(channelPlayerState.current_time || 0);
      if (shouldLoadTrack) {
        playTrackAtIndex(nextIndex, channelQueue, {
          source: 'shared',
          autoplay: false,
          notify: false,
          startTime: position
        });
      } else {
        if (!audio.paused) audio.pause();
        if (hasLoadedSource && audio.readyState >= 1 && Math.abs((audio.currentTime || 0) - position) > 0.3) {
          audio.currentTime = position;
        }
      }
      setIsPlaying(false);
      armSyncReady(channelPlayerState.revision, position);
      prevSharedPlayingRef.current = false;
      lastSharedRevisionRef.current = nextRevision;
      return;
    }

    if (shouldLoadTrack) {
      playTrackAtIndex(nextIndex, channelQueue, {
        source: 'shared',
        autoplay: channelPlayerState.is_playing,
        notify: false,
        startTime: liveSharedPosition(channelPlayerState)
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
      // everyone is ready and the server picked a start time a moment from
      // now. wait for it so all players begin together
      const waitMs = Math.max(0, (channelPlayerState.start_in_ms || 0) - (performance.now() - (channelPlayerState.received_at_perf || 0)));
      if (audio.paused && waitMs > 30) {
        autoplayRef.current = false;
        if (scheduledStartRevisionRef.current !== nextRevision) {
          scheduledStartRevisionRef.current = nextRevision;
          clearTimeout(syncStartTimerRef.current);
          syncStartTimerRef.current = setTimeout(() => {
            const el = audioRef.current;
            if (!el) return;
            autoplayRef.current = true;
            el.play().catch(() => {});
            setIsPlaying(true);
          }, waitMs);
        }
      } else {
        autoplayRef.current = true;
        if (audio.paused) {
          audio.play().catch(() => {});
        }
        setIsPlaying(true);
      }
    } else {
      autoplayRef.current = false;
      if (!audio.paused) {
        audio.pause();
      }
      setIsPlaying(false);
    }

    prevSharedPlayingRef.current = isNowPlaying;
    lastSharedRevisionRef.current = nextRevision;
  }, [armSyncReady, channelPlayerState, channelQueue, currentChannelId, currentTrack, isMuted, loadChannelState, playTrackAtIndex, playbackSource, sendWsMessage, volume]);

  // keeps this player on the room's clock. one that joined late started a second
  // or two behind (loading takes that long) and nothing moved it afterwards
  useEffect(() => {
    if (playbackSource !== 'shared') return undefined;
    const timer = setInterval(() => {
      const audio = audioRef.current;
      const state = channelPlayerStateRef.current;
      if (!audio || !state || !state.is_playing || state.sync_phase !== 'playing') return;
      const sinceArrival = (performance.now() - (state.received_at_perf || 0)) / 1000;
      if ((Number(state.start_in_ms) || 0) / 1000 > sinceArrival) return; // the shared start has not come yet
      // the room plays but this player is still paused well after the start (a page in the
      // background can miss the start): start it, the correction below then puts it on the spot
      if (audio.paused && audio.getAttribute('src') && sinceArrival - (Number(state.start_in_ms) || 0) / 1000 > 1.2 && !scrubbingRef.current) {
        audio.play().catch(() => {});
        setIsPlaying(true);
        return;
      }
      if (audio.paused || audio.seeking || audio.readyState < 3 || scrubbingRef.current || isBufferingRef.current) return;
      const live = Math.min(liveSharedPosition(state), Math.max(0, (audio.duration || Infinity) - 0.3));
      const gap = (audio.currentTime || 0) - live;
      if (Math.abs(gap) > 0.5) {
        addDebugLog('playback', `shared player was ${gap.toFixed(2)}s off the room, correcting`, { audio: audio.currentTime, live }, true);
        audio.currentTime = live;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [addDebugLog, playbackSource]);

  // opts.auto is set when a song ended on its own. in a shared room every
  // listener's player hits the end at about the same moment and each asks for
  // the next track, so the request names the track that ended and the server
  // only honors the first one
  // under shuffle the song after this one is picked ahead of time instead of the moment this one
  // ends, so it can be looked up (and on the phone downloaded) while this one plays and the change
  // is instant. handleNext plays the same pick. picks are kept as long as the song they were
  // made for is still the one playing and they are still in the queue
  const shufflePlanRef = useRef({ anchor: '', picks: [] });
  const planShuffleAhead = useCallback((list, anchorVideoId, count) => {
    const plan = shufflePlanRef.current;
    const picks = plan.anchor === anchorVideoId
      ? plan.picks.filter((id) => list.some((track) => track.videoId === id))
      : [];
    const candidates = list.filter((track) => track.videoId && track.videoId !== anchorVideoId);
    while (picks.length < count && candidates.length) {
      const last = picks.length ? picks[picks.length - 1] : anchorVideoId;
      const pool = candidates.length > 1 ? candidates.filter((track) => track.videoId !== last) : candidates;
      picks.push(pool[Math.floor(Math.random() * pool.length)].videoId);
    }
    shufflePlanRef.current = { anchor: anchorVideoId, picks };
    return picks.map((id) => list.find((track) => track.videoId === id)).filter(Boolean);
  }, []);

  const handleNext = useCallback((opts) => {
    const currentIndex = playIndexRef.current;
    const activeList = playbackSourceRef.current === 'shared' ? channelQueue : queue;
    logClient('handleNext', { currentIndex, queueLength: activeList.length, playNextQueueLength: playNextQueue.length });

    if (playbackSourceRef.current === 'shared' && currentChannelId) {
      if (!activeList.length) return;
      const auto = Boolean(opts && opts.auto === true);
      const pick = pickSharedNext({ direction: 1, auto });
      if (!pick) return;
      const endedTrackId = auto ? (channelPlayerStateRef.current?.current_track_id || undefined) : undefined;
      if (pick.stop) {
        // the last song ended and repeat is off: stop on it, back at the start
        updateCurrentChannelPlayer({
          current_track_id: channelPlayerStateRef.current?.current_track_id,
          is_playing: false,
          current_time: 0,
          auto_advance_from: endedTrackId
        });
        return;
      }
      updateCurrentChannelPlayer({
        current_track_id: pick.track.id,
        is_playing: true,
        current_time: 0,
        auto_advance_from: endedTrackId
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
      // the pick made ahead of time, which is also the one that was looked up already
      const here = list[currentIndex]?.videoId || '';
      const plan = shufflePlanRef.current;
      let planned = -1;
      if (plan.anchor === here && plan.picks.length) {
        planned = list.findIndex((track) => track.videoId === plan.picks[0]);
        if (planned >= 0) shufflePlanRef.current = { anchor: plan.picks[0], picks: plan.picks.slice(1) };
      }
      nextIndex = planned >= 0 ? planned : Math.floor(Math.random() * list.length);
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
  }, [channelPlayerState, channelQueue, currentChannelId, pickSharedNext, playNextQueue, playTrackAtIndex, queue, repeatMode, shuffle, updateCurrentChannelPlayer, volume]);

  
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
        // restoreSavedPosition so a track that stopped partway through (stream
        // died) resumes from where it stopped, it only applies when the saved
        // spot belongs to this same track
        playTrackAtIndex(startIndex, list, { source: 'personal', restoreSavedPosition: true });
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

  // media session - lock-screen/notification playback controls and metadata,
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

  // tauri miniplayer bridge - no-ops entirely outside tauri (browser/pwa),
  // see src/tauriApi.js
  const [isTauriDesktop, setIsTauriDesktop] = useState(false);
  useEffect(() => {
    isTauriApp().then((v) => {
      frontendLog('main', `isTauriApp() resolved: ${v}`);
      setIsTauriDesktop(v);
    });
  }, []);

  // Discord rich presence (the computer app only): what is playing shows on the Discord that is
  // running on this computer. the local server talks to it. the button only exists where that
  // works (it needs the application id set up in the server), and nothing is sent while the
  // listening activity is hidden on the account
  const [discordAvailable, setDiscordAvailable] = useState(false);
  const [discordOn, setDiscordOn] = useState(() => {
    try { return window.localStorage.getItem('music_discord_status') !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('music_discord_status', discordOn ? 'on' : 'off'); } catch { /* not remembered */ }
  }, [discordOn]);
  useEffect(() => {
    if (!isTauriDesktop || isAndroidApp()) return undefined;
    let stopped = false;
    fetch('/api/discord/status')
      .then((response) => (response.ok && (response.headers.get('content-type') || '').includes('json') ? response.json() : null))
      .then((status) => { if (!stopped) setDiscordAvailable(Boolean(status && status.available)); })
      .catch(() => {});
    return () => { stopped = true; };
  }, [isTauriDesktop]);
  // the phone cannot talk to Discord itself, but this computer knows what the account's phone
  // plays (the same relay that shows it in the app), so that is shown when nothing plays here
  const discordRemoteRef = useRef(null);
  discordRemoteRef.current = remoteNow;
  useEffect(() => {
    if (!discordAvailable) return undefined;
    const post = (body) => fetch('/api/discord/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});
    const ownPlaying = Boolean(currentTrack && currentTrack.title && isPlaying);
    const remotePlayingNow = !ownPlaying && Boolean(remotePlaying && discordRemoteRef.current && discordRemoteRef.current.track && discordRemoteRef.current.track.title);
    const ownPaused = Boolean(currentTrack && currentTrack.title) && !ownPlaying && !remotePlayingNow;
    if (!discordOn || hideListening || (!ownPlaying && !remotePlayingNow && !ownPaused)) {
      post({ clear: true });
      return undefined;
    }
    const send = () => {
      if (ownPlaying || ownPaused) {
        const audio = audioRef.current;
        post({
          title: currentTrack.title,
          artist: currentTrack.author || '',
          thumbnail: currentTrack.thumbnail || '',
          playing: ownPlaying,
          position: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          duration: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
          shared: playbackSource === 'shared'
        });
        return;
      }
      const remote = discordRemoteRef.current;
      if (!remote || !remote.track) return;
      post({
        title: remote.track.title,
        artist: remote.track.author || '',
        thumbnail: remote.track.thumbnail || '',
        playing: true,
        position: remote.position,
        duration: remote.duration,
        shared: false,
        device: 'phone'
      });
    };
    send();
    if (ownPaused) {
      // a song that has been paused for ten minutes is not what someone is listening to any more
      const stale = setTimeout(() => post({ clear: true }), 10 * 60 * 1000);
      return () => clearTimeout(stale);
    }
    // the progress bar on Discord is worked out from where the song was when this was sent,
    // a seek makes it drift, so it is sent again now and then
    const timer = setInterval(send, 30000);
    return () => clearInterval(timer);
  }, [currentTrack, discordAvailable, discordOn, hideListening, isPlaying, playbackSource, remotePlaying, remoteNow && remoteNow.track && remoteNow.track.videoId]);

  // looks for a newer version on the server the app belongs to: now, every ten
  // minutes, and when the window comes back into view
  useEffect(() => {
    let stopped = false;

    const runningVersion = async () => {
      if (BUILT_VERSION) return BUILT_VERSION;
      const response = await fetch('/package.json');
      const type = response.headers.get('content-type');
      if (!type || !type.includes('application/json')) return '';
      return (await response.json()).version || '';
    };

    const latestFromServer = async () => {
      const get = async () => {
        const response = await fetch(socialUrl('/api/version'), { cache: 'no-store' });
        const type = response.headers.get('content-type');
        if (!response.ok || !type || !type.includes('application/json')) throw new Error('no version');
        return (await response.json()).version || '';
      };
      try {
        return await get();
      } catch (err) {
        if (await retargetSocialBase()) return get();
        throw err;
      }
    };

    const check = async () => {
      try {
        const running = await runningVersion();
        const latest = await latestFromServer();
        if (stopped || !running || !latest) return;
        setCurrentVersion(running);
        setLatestVersion(latest);
        const newer = isNewerVersion(latest, running);
        setVersionMismatch(newer);
        if (!newer) return;

        let kind = 'reload';
        if (isAndroidApp()) {
          // the screens can be swapped in the app when this app knows how and the update is only
          // screens. otherwise the download page
          kind = 'installer';
          try {
            if (typeof window.SmpNative.uiUpdateCheck === 'function') {
              const manifestResponse = await fetch(socialUrl('/api/update/manifest'), { cache: 'no-store' });
              if (manifestResponse.ok) {
                const envelopeText = await manifestResponse.text();
                const verdict = JSON.parse(window.SmpNative.uiUpdateCheck(envelopeText));
                if (verdict.ok && verdict.canApply && verdict.newer) {
                  kind = 'live';
                  updateEnvelopeRef.current = envelopeText;
                }
              }
            }
          } catch {
            // stays on the download page
          }
        } else if (isTauriDesktop) {
          // the installed app asks its own server whether the new screens can be
          // downloaded into it. an installer too old for that, or an update that
          // needs a new installer, ends up as a download
          kind = 'installer';
          try {
            const response = await fetch('/api/update/status?force=1');
            const type = response.headers.get('content-type') || '';
            if (response.ok && type.includes('application/json')) {
              const status = await response.json();
              if (status.canApply && status.newer) kind = 'live';
            }
          } catch {
            // stays on the download page
          }
        }
        if (!stopped) setUpdateKind(kind);
      } catch (err) {
        console.log('Version check error:', err);
      }
    };

    check();
    const interval = setInterval(check, 10 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isTauriDesktop]);

  // screens that were downloaded for the app are kept once this page has run for a few seconds
  // without trouble. if it never gets this far the app goes back to the screens it came with
  useEffect(() => {
    if (!isAndroidApp() || typeof window.SmpNative.uiConfirm !== 'function') return undefined;
    const timer = setTimeout(() => {
      try { window.SmpNative.uiConfirm(); } catch { /* nothing to confirm */ }
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  const applyUpdate = useCallback(async () => {
    if (updateBusy) return;
    if (updateKind === 'installer') {
      openExternalUrl(RELEASES_URL);
      return;
    }
    if (updateKind !== 'live') {
      window.location.reload();
      return;
    }
    if (isAndroidApp()) {
      // the phone downloads and checks the new screens itself, this only waits for it to finish
      setUpdateBusy(true);
      let started = false;
      try {
        started = window.SmpNative.uiUpdateApply(updateEnvelopeRef.current, socialUrl('/').replace(/\/+$/, ''));
      } catch {
        started = false;
      }
      if (!started) {
        showNotification('could not update, try again in a bit', 'error');
        setUpdateBusy(false);
        return;
      }
      const began = Date.now();
      const poll = setInterval(() => {
        let progress = {};
        try { progress = JSON.parse(window.SmpNative.uiUpdateState()); } catch { /* look again */ }
        if (progress.state === 'done') {
          clearInterval(poll);
          setTimeout(() => window.location.reload(), 300);
        } else if (progress.state === 'failed' || Date.now() - began > 120000) {
          clearInterval(poll);
          showNotification('could not update, try again in a bit', 'error');
          setUpdateBusy(false);
        }
      }, 600);
      return;
    }
    setUpdateBusy(true);
    try {
      const response = await fetch('/api/update/apply', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        setTimeout(() => window.location.reload(), 250);
        return;
      }
      if (body.code === 'needs_installer') {
        setUpdateKind('installer');
        showNotification('this one needs the new installer', 'info');
      } else {
        showNotification('could not update, try again in a bit', 'error');
      }
    } catch {
      showNotification('could not update, try again in a bit', 'error');
    }
    setUpdateBusy(false);
  }, [showNotification, updateBusy, updateKind]);

  // desktop shortcut / taskbar pin are a windows-only concept (see
  // apply_shortcut_prefs in src-tauri/src/lib.rs, its a no-op everywhere
  // else) - mac installs by dragging into /Applications and pins to the
  // dock by hand, theres no matching checkbox to show there. cheap ua
  // sniff instead of pulling in @tauri-apps/plugin-os for one boolean
  const isWindowsDesktop = useMemo(() => /win/i.test(navigator.userAgent || navigator.platform || ''), []);

  // where downloads land - no more per-download "save as" dialog (finally).
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
  // any of them changes - trackProgress.current alone ticks several times a
  // sec during playback. the ready-listener used to live inside the same
  // effect as these values, so it was getting unsubscribed and resubscribed
  // constantly during playback, and - worse - could simply not exist yet at
  // the EXACT moment the miniplayer's very first "ready" announcement
  // arrived (most likely right after a fresh install, when both windows are
  // cold-starting webview2 for the first time and timing is least
  // predictable). took forever to figure out why it kept opening blank on
  // first launch. that's what left it stuck on "nothing playing" and the
  // default color despite a track actually being loaded - pausing meant
  // nothing was left ticking to ever naturally retrigger a resend and fix it
  const currentTrackRef = useRef(currentTrack);
  // shuffle, repeat and volume as the widget and the floating window show them
  const playerModesRef = useRef({ shuffle: false, repeat: 'off', volume: 1, muted: false });
  const nativeActionsRef = useRef({});
  const isPlayingRef = useRef(isPlaying);
  const trackProgressRef = useRef(trackProgress);
  const themeColorRef = useRef(themeColor);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => {
    playerModesRef.current = { shuffle, repeat: repeatMode, volume, muted: isMuted };
  }, [shuffle, repeatMode, volume, isMuted]);
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
          themeColor: themeColorRef.current,
          shuffle: playerModesRef.current.shuffle,
          repeat: playerModesRef.current.repeat,
          volume: playerModesRef.current.volume,
          muted: playerModesRef.current.muted,
          isBuffering: isBufferingRef.current,
          inRoom: playbackSourceRef.current === 'shared' && !!currentChannelRef.current
        }
      : {
          themeColor: themeColorRef.current,
          shuffle: playerModesRef.current.shuffle,
          repeat: playerModesRef.current.repeat,
          volume: playerModesRef.current.volume,
          muted: playerModesRef.current.muted,
          inRoom: playbackSourceRef.current === 'shared' && !!currentChannelRef.current
        };
  }, []);

  useEffect(() => {
    sendNowPlaying(buildNowPlayingPayload());
  }, [currentTrack, isPlaying, isBuffering, trackProgress.current, trackProgress.duration, themeColor, shuffle, repeatMode, volume, isMuted, playbackSource, currentChannelId, buildNowPlayingPayload]);

  // registered once and never torn down - the miniplayer can open at any
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
      else if (action === 'play') { if (!isPlayingRef.current) togglePlayPause(); }
      else if (action === 'pause') { if (isPlayingRef.current) togglePlayPause(); }
      else if (action === 'next') handleNext();
      else if (action === 'previous') handlePrevious();
      else if (action === 'shuffle') nativeActionsRef.current.shuffle?.();
      else if (action === 'repeat') nativeActionsRef.current.repeat?.();
      else if (action === 'mute') nativeActionsRef.current.mute?.();
      else if (action === 'volume_up') nativeActionsRef.current.volumeStep?.(0.1);
      else if (action === 'volume_down') nativeActionsRef.current.volumeStep?.(-0.1);
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
  // fixes) - since listening is normally sequential through a queue, warm
  // that resolve for whatevers coming up next while the current track is
  // still playing, so by the time playback actually gets there its already
  // cached server-side instead of resolving cold. skipped for
  // shared-channel playback (server dictates the queue, not us). under shuffle
  // the next picks are made ahead of time for this (see planShuffleAhead)
  useEffect(() => {
    if (!currentTrack || currentChannelId) return;
    // what plays next, in order: the songs queued to play next, then the queue after this one
    const ahead = [...playNextQueue];
    if (shuffle) {
      planShuffleAhead(queue, currentTrack.videoId, 2).forEach((track) => ahead.push(track));
    } else {
      for (let i = playIndex + 1; ahead.length < 2 && i < queue.length; i += 1) ahead.push(queue[i]);
      // repeat all: after the last song the queue starts over
      if (repeatMode === 'all') {
        for (let i = 0; ahead.length < 2 && i < Math.min(playIndex, queue.length); i += 1) ahead.push(queue[i]);
      }
    }
    // the phone has the next song downloaded whole whatever the network and the one after it on
    // wifi (see the audio helper), so a change of network does not cut a song or the next one,
    // and the next one starts at once. the computer only looks the next one up
    const wanted = ahead
      .slice(0, isAndroidApp() ? 2 : 1)
      .filter((track) => track?.videoId && track.videoId !== currentTrack.videoId);
    if (!wanted.length) return;
    wanted
      .reduce((chain, track, index) => chain.then(() => resolveMediaUrl(`/api/prefetch?videoId=${encodeURIComponent(track.videoId)}${isAndroidApp() ? `&full=${index === 0 ? 1 : 2}` : ''}`).then((url) => fetch(url))), Promise.resolve())
      .catch(() => {
        // best-effort - /api/stream just resolves cold when actually played
      });
  }, [currentTrack, queue, playIndex, shuffle, currentChannelId, playNextQueue, repeatMode, planShuffleAhead]);

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

  // the single player's queue was emptied or replaced. that only ends playback
  // when the single player is what is playing. when the audio element is on the
  // shared room's track, that track keeps going: a queue edit here has nothing
  // to do with it, and stopping it dropped this player out of the room until the
  // collab tab happened to be opened again
  const stopPersonalPlayback = () => {
    if (playbackSourceRef.current === 'shared') {
      setPlayNextQueue([]);
      return;
    }
    stopAndResetPlayback();
  };

  const toggleMute = () => {
    // audio.muted itself is synced from isMuted in one place (see the
    // isMutedRef effect above) instead of being set here directly, so
    // every path that can change mute state agrees with the DOM
    addDebugLog('playback', `toggle mute - will be ${!isMuted ? 'muted' : 'unmuted'}`);
    setIsMuted(!isMuted);
    showNotification(isMuted ? 'unmuted' : 'muted', 'info');
  };

  const setPlayVolume = (value) => {
    addDebugLog('playback', `volume changed to ${Math.round(value * 100)}%`);
    setVolume(value);
    const audio = audioRef.current;
    if (audio) audio.volume = value;
    if (value > 0 && isMuted) setIsMuted(false);
    // volume stays on this computer in shared playback too. it used to be
    // pushed to everyone, so one person turning it down changed the other's
    // speakers
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

  // where an import or "save all" should put its tracks: the selected
  // playlist, else the first regular one, else a brand new one. a new account
  // has no playlists at all, and refusing with "pick or create a playlist
  // first" there was a dead end, the import just did nothing
  const ensureTargetPlaylist = (suggestedName) => {
    const existing = activePlaylists.find((item) => item.id === currentPlaylistId)
      || activePlaylists.find((item) => item.type !== 'collab');
    if (existing) {
      if (existing.id !== currentPlaylistId) setCurrentPlaylistId(existing.id);
      return existing;
    }
    const cleanName = String(suggestedName || '').replace(/.[^.]+$/, '').trim().toLowerCase().slice(0, 100) || 'my playlist';
    const created = { id: generateId(), name: cleanName, tracks: [] };
    setPlaylists((prev) => [...prev, created]);
    setCurrentPlaylistId(created.id);
    return created;
  };

  const addAllToPlaylist = (playlistId = currentPlaylistId) => {
    if (!queue.length) {
      showNotification('queue is empty', 'warning');
      return;
    }
    const playlist = activePlaylists.find((item) => item.id === playlistId) || ensureTargetPlaylist('my queue');

    addDebugLog('playlist', `add all to "${playlist.name}": ${queue.length} tracks`);
    setPlaylists((prev) => prev.map((p) =>
      p.id === playlist.id
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
    // in offline mode only the saved songs can be loaded
    const loadable = offlineModeActive
      ? currentTracks.filter((track) => offlineIdsRef.current.has(track.videoId))
      : currentTracks;
    if (!loadable.length) {
      showNotification('none of these songs are saved on this phone', 'warning');
      return;
    }
    addDebugLog('playlist', `load "${playlist?.name}" to queue: ${loadable.length} tracks`);
    stopPersonalPlayback();
    setQueue(loadable.map((track) => normalizeTrack(track)));
    const leftOut = currentTracks.length - loadable.length;
    showNotification(
      leftOut > 0 ? `loaded ${loadable.length} saved song${loadable.length === 1 ? '' : 's'} from "${playlist?.name}" (${leftOut} not saved)` : `loaded "${playlist?.name}" to queue`,
      'success'
    );
  };

  // the solo player's buttons. the solo player and the room player are two players
  // with their own song, position and play state, and the one audio element only
  // plays one of them at a time. while this device is on the room, the solo card is
  // idle and its buttons bring the solo player back, where it was left
  const soloIndexOf = (track) => (track ? queueRef.current.findIndex((item) => item.videoId === track.videoId) : -1);
  const startSoloAt = (index) => {
    const list = queueRef.current;
    if (!list.length) {
      showNotification('your queue is empty, load something into it first', 'info');
      return;
    }
    playTrackAtIndex(Math.max(0, Math.min(index, list.length - 1)), list, { source: 'personal', restoreSavedPosition: true, notify: false });
  };
  const soloToggle = () => (playbackSource === 'shared' ? startSoloAt(Math.max(0, soloIndexOf(lastSoloTrackRef.current))) : togglePlayPause());
  const soloNext = () => (playbackSource === 'shared' ? startSoloAt(soloIndexOf(lastSoloTrackRef.current) + 1) : handleNext());
  const soloPrev = () => (playbackSource === 'shared' ? startSoloAt(Math.max(0, soloIndexOf(lastSoloTrackRef.current) - 1)) : handlePrevious());

  // another of this account's devices asked this one to pause or resume
  deviceCommandRef.current = (command) => {
    if (playbackSourceRef.current === 'shared') return;
    if (command === 'pause' && isPlaying) togglePlayPause();
    if (command === 'play' && !isPlaying && currentTrack) togglePlayPause();
  };

  // take over what another device is playing, from where it has got to. the
  // other one is told to pause so the same song is not playing twice
  const playRemoteHere = (remote) => {
    const list = [remote.track, ...queueRef.current.filter((item) => item.videoId !== remote.track.videoId)];
    setQueue(list);
    if (remote.playing) sendWsMessage({ type: 'device_command', to: remote.clientId, command: 'pause' });
    playTrackAtIndex(0, list, { source: 'personal', startTime: Math.max(0, remote.position), notify: false });
  };

  nativeActionsRef.current = {
    shuffle: () => setShuffle((s) => !s),
    repeat: () => cycleRepeatMode(),
    mute: () => toggleMute(),
    volumeStep: (delta) => setPlayVolume(Math.max(0, Math.min(1, Math.round((volumeRef.current + delta) * 10) / 10)))
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

  // shared by every "save this text as a file" action (debug logs already
  // did their own copy of this dance) - native save dialog on desktop,
  // plain browser download link otherwise
  const saveTextFile = async (filename, text, mimeType) => {
    if (isTauriDesktop) {
      const saved = await saveFileWithDialog(filename, new TextEncoder().encode(text));
      return !!saved;
    }
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  };

  const exportPlaylist = async (format) => {
    const playlist = activePlaylists.find((item) => item.id === currentPlaylistId);
    if (!playlist || !currentTracks.length) {
      showNotification('playlist is empty, nothing to export', 'warning');
      return;
    }
    const safeName = (playlist.name || 'playlist').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'playlist';
    try {
      if (format === 'json') {
        const text = JSON.stringify(playlistToExportObject(playlist), null, 2);
        await saveTextFile(`${safeName}.json`, text, 'application/json');
      } else {
        const text = playlistToCsv(playlist);
        await saveTextFile(`${safeName}.csv`, text, 'text/csv');
      }
      addDebugLog('playlist', `exported "${playlist.name}" as ${format}`, { trackCount: currentTracks.length }, true);
      showNotification(`exported "${playlist.name}" (${currentTracks.length} tracks)`, 'success');
    } catch (error) {
      addDebugLog('error', `playlist export failed: ${error.message}`, { error }, true);
      showNotification(`export failed: ${error.message}`, 'error');
    }
  };

  // csv rows rarely carry a videoId, so most imported entries need an
  // actual youtube search to resolve - this runs those sequentially
  // (not in parallel) so a 300-track csv doesn't just fire 300 requests
  // at once, and reports progress as it goes so the ui isn't just frozen
  // looking for that whole time
  const resolvePendingTracks = async (pending, onProgress) => {
    const resolved = [];
    const unmatched = [];
    for (let i = 0; i < pending.length; i++) {
      if (importCancelRef.current) break;
      const entry = pending[i];
      onProgress(i, entry.title || entry.videoId || '(untitled)');
      if (entry.videoId) {
        resolved.push(normalizeTrack({
          videoId: entry.videoId,
          title: entry.title || entry.videoId,
          author: entry.author,
          durationMs: entry.durationMs
        }));
        continue;
      }
      const query = [entry.title, entry.author].filter(Boolean).join(' ').trim();
      if (!query) {
        unmatched.push(entry);
        continue;
      }
      try {
        const results = await searchTracks(query);
        if (results.length) {
          resolved.push(normalizeTrack(results[0]));
        } else {
          unmatched.push(entry);
        }
      } catch {
        unmatched.push(entry);
      }
    }
    return { resolved, unmatched };
  };

  const importPlaylistFromFile = async () => {
    let file = null;
    try {
      if (isTauriDesktop) {
        file = await pickTextFile(['json', 'csv']);
        if (!file) return; // bailed out of the dialog
      } else {
        file = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,.csv,text/csv,application/json';
          input.onchange = () => {
            const picked = input.files?.[0];
            if (!picked) { resolve(null); return; }
            picked.text().then((text) => resolve({ name: picked.name, text })).catch(reject);
          };
          input.click();
        });
        if (!file) return;
      }
    } catch (error) {
      showNotification(`couldn't read that file: ${error.message}`, 'error');
      return;
    }

    // a new account has no playlist yet, so one is made from the file name
    const playlist = ensureTargetPlaylist(file.name);

    const trimmedText = file.text.trim();
    const isJson = /\.json$/i.test(file.name) || trimmedText.startsWith('{') || trimmedText.startsWith('[');
    let pending = [];
    let exactCount = 0;

    if (isJson) {
      try {
        const parsed = JSON.parse(file.text);
        const tracks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tracks) ? parsed.tracks : null;
        if (!tracks) throw new Error('no "tracks" array found in this file');
        pending = tracks.map((t) => ({
          title: t.title || '',
          author: t.author || t.artist || '',
          videoId: t.videoId || t.video_id || '',
          durationMs: Number(t.durationMs || t.duration_ms || 0) || 0
        }));
        exactCount = pending.filter((p) => p.videoId).length;
      } catch (error) {
        showNotification(`that doesn't look like a valid playlist export: ${error.message}`, 'error');
        return;
      }
    } else {
      pending = csvRowsToPendingTracks(parseCsvText(file.text));
      exactCount = pending.filter((p) => p.videoId).length;
    }

    if (!pending.length) {
      showNotification('no tracks found in that file', 'warning');
      return;
    }

    addDebugLog('playlist', `importing ${pending.length} tracks from ${file.name}`, { exactCount, needsSearch: pending.length - exactCount }, true);
    importCancelRef.current = false;
    setPlaylistImport({ total: pending.length, done: 0, label: 'starting...' });

    const { resolved, unmatched } = await resolvePendingTracks(pending, (done, label) => {
      setPlaylistImport({ total: pending.length, done, label });
    });

    setPlaylistImport(null);

    if (resolved.length) {
      setPlaylists((prev) => prev.map((p) =>
        p.id === playlist.id
          ? { ...p, tracks: [...p.tracks, ...resolved.map((track) => ({ ...track, addedAt: Date.now() }))] }
          : p
      ));
    }

    addDebugLog('playlist', `import finished: ${resolved.length} added, ${unmatched.length} unmatched`, {
      unmatchedTitles: unmatched.slice(0, 20).map((u) => u.title || u.videoId)
    }, true);

    if (unmatched.length) {
      showNotification(`imported ${resolved.length}/${pending.length} tracks, ${unmatched.length} couldn't be matched`, resolved.length ? 'warning' : 'error');
    } else {
      showNotification(`imported ${resolved.length} tracks into "${playlist.name}"`, 'success');
    }
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
        body: JSON.stringify({ id: newPlaylist.id, name: newPlaylist.name })
      });
    } catch (err) {
      showNotification('failed to save collab playlist to server', 'error');
      console.error('Collab playlist create error:', err);
    }
    setPlaylists((prev) => (prev.some((p) => p.id === newPlaylist.id) ? prev : [...prev, newPlaylist]));
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
      setPlaylists((prev) => prev.map((p) => (
        p.id === playlistId && !p.tracks.some((t) => t.id === savedTrack.id)
          ? { ...p, tracks: [...p.tracks, { ...savedTrack, addedAt: Date.now() }] }
          : p
      )));
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
    addDebugLog('collab_playlist', `load "${playlist?.name}" to your queue: ${currentCollabTracks.length} tracks`);
    setQueue((prev) => [...prev, ...currentCollabTracks.map((t) => normalizeTrack(t))]);
    showNotification(`added ${currentCollabTracks.length} song${currentCollabTracks.length === 1 ? '' : 's'} from "${playlist?.name}" to your queue`, 'success');
  };

  // the room's queue into the selected playlist. a collab playlist is saved on the
  // server (everyone in the channel gets it), an own playlist only here
  const addRoomQueueToCollabPlaylist = async () => {
    const playlist = playlists.find((p) => p.id === currentCollabPlaylistId);
    if (!playlist) return;
    const already = new Set((playlist.tracks || []).map((t) => normalizeTrack(t).videoId));
    const tracks = channelQueue.map((t) => normalizeTrack(t)).filter((t) => !already.has(t.videoId));
    if (!tracks.length) {
      showNotification(`everything in the room's queue is already in "${playlist.name}"`, 'info');
      return;
    }
    if (playlist.type !== 'collab') {
      setPlaylists((prev) => prev.map((p) => (p.id === playlist.id ? { ...p, tracks: [...p.tracks, ...tracks.map((t) => ({ ...t, addedAt: Date.now() }))] } : p)));
      showNotification(`added ${tracks.length} tracks to "${playlist.name}"`, 'success');
      return;
    }
    try {
      const result = await fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${playlist.id}/tracks-bulk`, {
        method: 'POST',
        body: JSON.stringify({ tracks })
      });
      const saved = (result.tracks || []).map((t) => ({ ...normalizeTrack(t), id: t.id, addedAt: Date.now() }));
      setPlaylists((prev) => prev.map((p) => {
        if (p.id !== playlist.id) return p;
        const known = new Set(p.tracks.map((t) => t.id));
        return { ...p, tracks: [...p.tracks, ...saved.filter((t) => !known.has(t.id))] };
      }));
      showNotification(`added ${saved.length} tracks to "${playlist.name}"`, 'success');
    } catch (err) {
      showNotification('failed to save the tracks to the collab playlist', 'error');
      console.error('Collab playlist add all error:', err);
    }
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
    if (playlist?.type === 'collab') {
      fetchJson(`/api/servers/${currentChannelId}/collab-playlists/${currentCollabPlaylistId}/order`, {
        method: 'PUT',
        body: JSON.stringify({ trackIds: newTracks.map((t) => t.id).filter(Boolean) })
      }).catch((err) => {
        showNotification('failed to save the new order', 'error');
        console.error('Collab playlist reorder error:', err);
      });
    }
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
    if (index < 0 || index >= queue.length) return;

    const next = queue.filter((_, i) => i !== index);
    const personalActive = playbackSourceRef.current !== 'shared';
    const currentPlayIndex = playIndexRef.current;
    // the track loaded in the player, playing or paused. a paused one used to
    // be left as the title while the index moved on to the next track, so the
    // next button then skipped a song
    const removingCurrentTrack = personalActive && index === currentPlayIndex;

    // everything is worked out from the queue above instead of inside the
    // setQueue updater: updaters have to be pure, and this one called
    // setPlayIndex and stopAndResetPlayback, which React runs twice in
    // development and shifted the index by two
    setQueue(next);

    if (!next.length) {
      stopPersonalPlayback();
      showNotification('removed from queue', 'info');
      return;
    }

    if (removingCurrentTrack) {
      stopAndResetPlayback();
      showNotification('current track removed from queue', 'info');
      return;
    }

    // keep the index on the same track that is loaded. only when playing from
    // the personal queue, otherwise the index belongs to the shared one
    if (personalActive && currentPlayIndex >= 0 && index < currentPlayIndex) {
      const shiftedIndex = currentPlayIndex - 1;
      playIndexRef.current = shiftedIndex;
      setPlayIndex(shiftedIndex);
      // the highlighted row follows currentIndex, which playback keeps equal
      // to playIndex. "download all" borrows it for its own progress while it
      // runs, so leave it alone then
      if (!queueRunningRef.current) setCurrentIndex(shiftedIndex);
    }

    showNotification('removed from queue', 'info');
  };

  const clearQueue = () => {
    setQueue([]);
    stopPersonalPlayback();
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
      // searching - warm those in the background so the resolve is already
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
      setSuggestionError(typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'you are offline, only songs saved for offline can play'
        : e.message);
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
    }, isAndroidApp() ? 350 : 150);
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

  // songs saved on the phone, so they play with no connection. the phone's helper
  // keeps the files, this keeps the list of which ones
  const [offlineProgress, setOfflineProgress] = useState(null); // { done, total, label } while saving

  // what the saved songs are called, kept on the phone so the list of saved
  // songs can be shown with no connection too
  const OFFLINE_META_KEY = 'music_offline_meta';
  const readOfflineMeta = () => readLocalJSON(OFFLINE_META_KEY, {});
  const rememberOfflineTrack = (track) => {
    if (!track || !track.videoId) return;
    try {
      const meta = readOfflineMeta();
      meta[track.videoId] = normalizeTrack(track);
      localStorage.setItem(OFFLINE_META_KEY, JSON.stringify(meta));
    } catch {
      // storage full, the songs are still saved
    }
  };
  const [offlineBytes, setOfflineBytes] = useState(0);

  const refreshOfflineIds = useCallback(async () => {
    if (!isAndroidApp()) return;
    try {
      const data = await fetchJson('/api/offline/list');
      setOfflineIds(new Set(Array.isArray(data.ids) ? data.ids : []));
      setOfflineBytes(Number(data.bytes) || 0);
    } catch {
      // the helper is not up yet, this runs again when it is
    }
  }, []);
  useEffect(() => {
    if (!helperDown) refreshOfflineIds();
  }, [helperDown, refreshOfflineIds]);

  const offlineConfirmRef = useRef(null);
  const saveTracksOffline = useCallback(async (tracks, label = 'songs') => {
    // each song once: a playlist can list the same song several times, and
    // saving it twice only made the count look short ("153 songs, 131 saved")
    const seenIds = new Set();
    const todo = (tracks || []).filter((track) => {
      if (!track || !track.videoId || offlineIdsRef.current.has(track.videoId) || seenIds.has(track.videoId)) return false;
      seenIds.add(track.videoId);
      return true;
    });
    const duplicates = (tracks || []).filter((track) => track && track.videoId).length - new Set((tracks || []).filter((track) => track && track.videoId).map((track) => track.videoId)).size;
    if (!todo.length) {
      showNotification('already saved for offline', 'info');
      return;
    }
    // a big batch over mobile data is a lot of data (about 4 MB a song), so the
    // first tap only says so and a second one within ten seconds starts it
    const onCellular = typeof navigator !== 'undefined' && navigator.connection && navigator.connection.type === 'cellular';
    if (onCellular && todo.length > 10) {
      const pending = offlineConfirmRef.current;
      if (!pending || pending.label !== label || Date.now() > pending.until) {
        offlineConfirmRef.current = { label, until: Date.now() + 10000 };
        showNotification(`this saves about ${todo.length * 4} MB over mobile data. tap again to start, or wait for wifi`, 'warning');
        return;
      }
      offlineConfirmRef.current = null;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showNotification('connect to the internet to save songs for offline', 'warning');
      return;
    }
    let saved = 0;
    let failed = 0;
    let finished = 0;
    setOfflineProgress({ done: 0, total: todo.length, label });
    // two songs at a time: each one spends its first seconds just finding the
    // link, so a second one keeps the phone busy instead of waiting
    let next = 0;
    let failedInARow = 0;
    const worker = async () => {
      while (next < todo.length) {
        const track = todo[next];
        next += 1;
        try {
          await fetchJson(`/api/offline/save?videoId=${encodeURIComponent(track.videoId)}`);
          saved += 1;
          failedInARow = 0;
          setOfflineIds((prev) => new Set(prev).add(track.videoId));
          rememberOfflineTrack(track);
        } catch (error) {
          failed += 1;
          failedInARow += 1;
          addDebugLog('error', `offline save failed: ${error.message}`, { videoId: track.videoId }, true);
          // the connection is probably gone, trying the rest would only fail the same way
          if (failedInARow >= 4) next = todo.length;
        }
        finished += 1;
        setOfflineProgress({ done: finished, total: todo.length, label });
      }
    };
    await Promise.all([worker(), worker()]);
    setOfflineProgress(null);
    const duplicateNote = duplicates > 0 ? `, ${duplicates} repeat${duplicates === 1 ? '' : 's'} left out` : '';
    showNotification(failed ? `saved ${saved} for offline, ${failed} failed${duplicateNote}` : `saved ${saved} for offline${duplicateNote}`, failed ? 'warning' : 'success');
  }, [addDebugLog, showNotification]);

  const toggleOffline = useCallback(async (item) => {
    if (!item || !item.videoId) return;
    if (offlineIdsRef.current.has(item.videoId)) {
      try {
        await fetchJson(`/api/offline/remove?videoId=${encodeURIComponent(item.videoId)}`);
        setOfflineIds((prev) => {
          const next = new Set(prev);
          next.delete(item.videoId);
          return next;
        });
        try {
          const meta = readOfflineMeta();
          delete meta[item.videoId];
          localStorage.setItem(OFFLINE_META_KEY, JSON.stringify(meta));
        } catch {}
        showNotification('removed from offline', 'info');
      } catch (error) {
        showNotification(`could not remove it: ${error.message}`, 'error');
      }
      return;
    }
    await saveTracksOffline([item], item.title || 'song');
  }, [saveTracksOffline, showNotification]);

  // take every saved song off the phone again
  const clearAllOffline = async () => {
    const ids = [...offlineIdsRef.current];
    if (!ids.length) return;
    let removed = 0;
    for (const id of ids) {
      try {
        await fetchJson(`/api/offline/remove?videoId=${encodeURIComponent(id)}`);
        removed += 1;
      } catch {
        // one that will not go is left, the rest still do
      }
    }
    try { localStorage.removeItem(OFFLINE_META_KEY); } catch { /* fine */ }
    await refreshOfflineIds();
    showNotification(`removed ${removed} saved song${removed === 1 ? '' : 's'} from this phone`, 'success');
  };
  const [confirmClearSaved, setConfirmClearSaved] = useState(false);
  useEffect(() => {
    if (!confirmClearSaved) return undefined;
    const timer = setTimeout(() => setConfirmClearSaved(false), 6000);
    return () => clearTimeout(timer);
  }, [confirmClearSaved]);

  const downloadSingle = async (item) => {
    // on the phone the download button saves the song into the app for offline
    // listening, there is no downloads folder to put a file in
    if (isAndroidApp()) {
      await toggleOffline(item);
      return;
    }
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

      // isDownloading was only ever set by the "download all" queue flow -
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
    if (isAndroidApp()) {
      await saveTracksOffline(queue, 'queue');
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
  // repeat and shuffle of the room belong to the room: the server keeps them and
  // anyone in it can change them
  const roomShuffle = Boolean(channelPlayerState?.shuffle);
  const roomRepeat = ['off', 'all', 'one'].includes(channelPlayerState?.repeat_mode) ? channelPlayerState.repeat_mode : 'off';
  const setRoomModes = async (patch) => {
    if (!currentChannelId) return;
    setChannelPlayerState((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      await fetchJson(`/api/server/${encodeURIComponent(currentChannelId)}/player-modes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
    } catch (error) {
      addDebugLog('error', 'changing the room repeat or shuffle failed', { error: error.message || String(error) }, true);
      showNotification(error.message || 'could not change the room player', 'warning');
      loadChannelState(currentChannelId);
    }
  };
  const toggleRoomShuffle = () => setRoomModes({ shuffle: !roomShuffle });
  const cycleRoomRepeat = () => {
    const modes = Object.keys(REPEAT_MODES);
    setRoomModes({ repeat_mode: modes[(modes.indexOf(roomRepeat) + 1) % modes.length] });
  };
  // a device that is not listening still shows where the room is, moving
  const [, setRoomTick] = useState(0);
  useEffect(() => {
    if (playbackSource === 'shared' || !channelPlayerState?.is_playing || activeTab !== 'collab') return undefined;
    const timer = setInterval(() => setRoomTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [activeTab, channelPlayerState?.is_playing, playbackSource]);
  const sharedTrackProgress = playbackSource === 'shared'
    ? trackProgress
    : {
        current: liveSharedPosition(channelPlayerState),
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
  // the social and collab views are plain on purpose: square corners, 1px
  // borders, no tinted fills, no glow. buttons turn theme colored on hover
  // through the .social-flat rules in index.css
  const inputStyle = {
    width: '100%',
    background: '#000',
    border: `1px solid ${dimBorderColor(themeColor)}`,
    borderRadius: 0,
    padding: '9px 10px',
    color: '#fff',
    fontSize: '12px',
    outline: 'none'
  };
  const primaryButtonStyle = {
    padding: '8px 12px',
    borderRadius: 0,
    border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    background: 'transparent',
    color: '#fff',
    fontSize: '11px',
    cursor: 'pointer'
  };
  const outlineButtonStyle = {
    padding: '8px 12px',
    borderRadius: 0,
    border: `1px solid ${dimBorderColor(themeColor)}`,
    background: 'transparent',
    color: '#fff',
    fontSize: '11px',
    cursor: 'pointer'
  };
  const dangerButtonStyle = {
    padding: '8px 12px',
    borderRadius: 0,
    border: '1px solid #ef4444',
    background: 'transparent',
    color: '#ef4444',
    fontSize: '11px',
    cursor: 'pointer'
  };
  const itemShellStyle = {
    padding: '10px 0',
    borderRadius: 0,
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${dimBorderColor(themeColor)}`
  };
  const wirePanelStyle = {
    border: `1px solid ${dimBorderColor(themeColor)}`,
    borderRadius: 0,
    background: 'transparent',
    boxShadow: 'none',
    padding: '14px 16px',
    overflow: 'visible',
    transition: 'none'
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
    padding: '6px 10px',
    borderRadius: 0,
    border: `1px solid ${dimBorderColor(themeColor)}`,
    background: active ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
    color: '#fff',
    fontSize: '11px'
  });
  const wireRowStyle = (active = false) => ({
    ...itemShellStyle,
    // the selected row gets a bar down the left edge instead of a tinted box
    borderLeft: active ? `3px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : '3px solid transparent',
    paddingLeft: '10px'
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
  const chatBubbleStyle = (isOwnMessage) => ({
    alignSelf: isOwnMessage ? 'flex-end' : 'flex-start',
    maxWidth: '78%',
    borderRadius: 0,
    padding: '9px 12px',
    border: `1px solid ${isOwnMessage ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : dimBorderColor(themeColor)}`,
    background: 'transparent',
    color: '#fff'
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

  // a name shows its owner's theme color while they are online and is gray when
  // they are not
  const onlineUserIds = new Set(allUsers.filter((entry) => entry.is_online).map((entry) => entry.id));
  onlineUserIds.add(currentUserId);
  const nameColorFor = (userId, online = onlineUserIds.has(userId)) => {
    if (!online) return '#6b7280';
    const color = userThemeColorMap[userId] || themeColor;
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  };

  const onlineDirectoryUsers = allUsersByLastActive.filter((entry) => (
    !friendSearch.trim() || entry.username.toLowerCase().includes(friendSearch.trim().toLowerCase())
  ));
  const currentShareCandidate = currentTrack || queue[playIndex] || queue[0] || null;
  const currentListeningActivity = useMemo(() => {
    if (!currentTrack || hideListening) {
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
    hideListening,
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
  // the grip that moves a panel to the other column. a plain drag grip, not a
  // button-looking box
  const panelHandleStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
    cursor: 'grab',
    marginLeft: 'auto'
  };
  const panelDropZoneStyle = (active = false) => ({
    minHeight: '44px',
    border: `1px dashed ${active ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : dimBorderColor(themeColor)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    color: active ? '#fff' : '#9ca3af',
    transition: 'none'
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
  // the saved order of a tab, with any panel it does not know about added at the end
  const panelOrderFor = (scope) => {
    const base = DEFAULT_PANEL_ORDERS[scope];
    const saved = panelOrders[scope];
    if (!Array.isArray(saved)) return base;
    return [...saved.filter((id) => base.includes(id)), ...base.filter((id) => !saved.includes(id))];
  };
  const orderIndex = (scope, panelId) => panelOrderFor(scope).indexOf(panelId);
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
  // a panel only has its title now. moving panels around is done in settings
  const renderPanelHandle = (scope, panelId, label = '') => (
    label ? (
      <div style={{ marginBottom: '12px' }}>
        <div style={wireSectionTitleStyle}>{label}</div>
      </div>
    ) : null
  );
  const renderPanelCard = (scope, panelId, label, content) => (
    <Card key={`${scope}-${panelId}`} data-panel={`${scope}-${panelId}`} style={{ '--panel-order': orderIndex(scope, panelId) }} className="glass card-hover shadow-sm border-0">
      <Card.Body className="card-body snap-panel-body" style={panelCardBodyStyle}>
        {renderPanelHandle(scope, panelId, label)}
        {content}
      </Card.Body>
    </Card>
  );
  const renderMessageGuide = (scope, title, detail) => (
    <div style={wireEmptyStyle}>
      <div style={{ color: '#fff', fontSize: '12px' }}>{title}</div>
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
            drop here
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
                    <div style={{ color: nameColorFor(entry.id, true), fontSize: '12px', fontWeight: 'bold' }}>{entry.username}</div>
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
        <div className="panel-split" style={panelSplitStyle}>
          <div style={{ ...sectionStackStyle, minWidth: 0 }}>
            <div className="convo-list" style={{ ...sectionStackStyle, maxHeight: '540px', overflowY: 'auto' }}>
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
                          <div style={{ color: nameColorFor(entry.user_id), fontSize: '12px', fontWeight: isActive ? '700' : hasUnread ? '700' : 'bold' }}>{entry.username}</div>
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
                            color: '#fff',
                            fontSize: '9px',
                            fontWeight: '700',
                            borderRadius: '50%',
                            width: '16px',
                            height: '16px',
                            padding: 0,
                            lineHeight: 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}>{entry.unread_count > 9 ? '9+' : entry.unread_count}</span>
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
          <div className="panel-split-side" style={{ ...sectionStackStyle, minWidth: 0, borderLeft: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.16)`, paddingLeft: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', paddingBottom: '8px', borderBottom: `1px solid rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.16)` }}>
              <div style={{ color: selectedConversation ? nameColorFor(selectedConversation.user_id) : '#fff', fontSize: '16px', fontWeight: 'bold' }}>
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
                      <div style={{ color: '#fff', fontSize: '13px', marginTop: '6px', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.message}</div>
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
            <div style={wireEmptyStyle}>theres nothing</div>
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
  const socialPanelOrder = panelOrderFor('social');
  const mainPanelOrder = panelOrderFor('main');
  const mainLeftIds = mainPanelOrder.filter((id) => mainPanelSides[id] !== 'right');
  const mainRightIds = mainPanelOrder.filter((id) => mainPanelSides[id] === 'right');
  const socialLeftPanelIds = socialPanelOrder.filter((panelId) => socialPanelSides[panelId] !== 'right');
  const socialRightPanelIds = socialPanelOrder.filter((panelId) => socialPanelSides[panelId] === 'right');
  // the player card, used for solo playback and for the shared room alike so
  // the two look and behave the same. only what feeds it differs (track,
  // progress, transport handlers). volume and eq are always this player's own
  // the player card. when this device has nothing loaded but another of the
  // account's devices is playing, the card shows that one's song, labelled with
  // where it is playing, with a button to bring it here
  const renderPlayerContent = (model) => {
    const remote = model.remote;
    if (remote && !model.track) {
      return (
        <>
          <div className="d-flex justify-content-center mb-3">
            <div className={`vinyl-record ${remote.playing ? '' : 'paused'}`}>
              <TrackThumbnail track={remote.track} className="record-thumb" alt="thumbnail" />
            </div>
          </div>
          <div className="text-center mb-2">
            <span style={{
              border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              fontSize: '11px',
              padding: '1px 8px',
              borderRadius: 'var(--border-radius-sm)'
            }}>
              {remote.playing ? 'playing' : 'paused'} on your {remote.deviceName}
            </span>
          </div>
          <div className="text-center mb-3">
            <Marquee className="fw-bold" text={remote.track.title} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
            <Marquee className="text-muted small" text={remote.track.author || ''} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
          </div>
          {remote.duration > 0 && (
            <div className="mb-3">
              <div style={{ height: '8px', background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`, borderRadius: 'var(--border-radius-sm)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, (remote.position / remote.duration) * 100)}%`, background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, transition: 'width 0.5s linear' }} />
              </div>
              <div className="d-flex justify-content-between mt-1">
                <span className="text-muted small" style={{ fontSize: '11px' }}>{formatTime(remote.position)}</span>
                <span className="text-muted small" style={{ fontSize: '11px' }}>{formatTime(remote.duration)}</span>
              </div>
            </div>
          )}
          <div className="d-flex justify-content-center gap-2 mb-3">
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => playRemoteHere(remote)}
              style={{ borderRadius: 'var(--border-radius-sm)', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
            >
              play here
            </Button>
            <Button
              variant="outline-light"
              size="sm"
              onClick={() => sendWsMessage({ type: 'device_command', to: remote.clientId, command: remote.playing ? 'pause' : 'play' })}
              style={{ borderRadius: 'var(--border-radius-sm)', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
            >
              {remote.playing ? 'pause there' : 'resume there'}
            </Button>
          </div>
        </>
      );
    }
    return (
      <>
        {renderPlayerContentBase(model)}
        {remote && remote.playing && (
          <div className="text-center text-muted small mb-2" style={{ fontSize: '11px' }}>
            also playing on your {remote.deviceName}: {remote.track.title}
          </div>
        )}
      </>
    );
  };
  const renderPlayerContentBase = (model) => (
    <>
                  {(model.heading || model.chip) && (
                    <div className="d-flex justify-content-between align-items-center mb-2" style={{ fontSize: '11px', gap: '8px' }}>
                      <span style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, letterSpacing: '0.04em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.heading}</span>
                      {model.chip && (
                        <span style={{
                          border: `1px solid ${model.chipActive ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : dimBorderColor(themeColor)}`,
                          color: model.chipActive ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : '#9ca3af',
                          padding: '0 8px',
                          borderRadius: 'var(--border-radius-sm)',
                          whiteSpace: 'nowrap'
                        }}>{model.chip}</span>
                      )}
                    </div>
                  )}
                  <div className="d-flex justify-content-center mb-3">
                    <div className={`vinyl-record ${model.playing ? '' : 'paused'}`}>
                      {model.track && (
                        <TrackThumbnail track={model.track} className="record-thumb" alt="thumbnail" />
                      )}
                    </div>
                </div>

                {}
                {model.track && (
                  <div className="text-center mb-3">
                    <Marquee className="fw-bold" text={model.track.title} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
                    <Marquee className="text-muted small" text={model.track.author || ''} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
                  </div>
                )}

                {}
                {model.progress.duration > 0 ? (
                  <div className="mb-3">
                    <div
                      ref={model.progressRef}
                      className="position-relative"
                      onPointerDown={(e) => {
                        if (model.seekEnabled === false) return;
                        e.preventDefault();
                        scrubbingRef.current = true;
                        scrubPointerIdRef.current = e.pointerId;
                        // the bar keeps this one finger until it lifts, so the drag
                        // cannot end up attached to some later touch elsewhere
                        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not every browser can */ }
                        seekToClientX(e.clientX, model.progressRef.current);
                      }}
                      style={{
                        height: '8px',
                        background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`,
                        borderRadius: '6px',
                        cursor: 'pointer',
                        touchAction: 'none'
                      }}
                    >
                      <div
                        className="position-absolute"
                        style={{
                          height: '100%',
                          width: `${(model.progress.current / model.progress.duration) * 100}%`,
                          borderRadius: '6px',
                          transition: 'width 0.1s linear',
                          background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                        }}
                      />
                      <div
                        className="position-absolute"
                        style={{
                          top: '50%',
                          left: `${(model.progress.current / model.progress.duration) * 100}%`,
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
                        {formatTime(model.progress.current)}
                      </span>
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        {formatTime(model.progress.duration)}
                      </span>
                    </div>
                  </div>
                ) : model.playing ? (
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
                          width: `${((model.progress.current % 10) / 10) * 100}%`,
                          borderRadius: '6px',
                          transition: 'width 0.15s linear',
                          background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                        }}
                      />
                    </div>
                    <div className="d-flex justify-content-between mt-1">
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        {formatTime(model.progress.current)}
                      </span>
                      <span className="text-muted small" style={{ fontSize: '11px' }}>
                        ?
                      </span>
                    </div>
                  </div>
                ) : (model.buffering || model.track) ? (
                  // used to render nothing here whenever duration, playing and
                  // buffering were all false at once (e.g. right after a failed
                  // stream), which was the "entire play bar disappears" bug. a
                  // track is selected in that state, so draw the bar empty
                  <div className="mb-3">
                    <div
                      className="position-relative"
                      style={{ height: '8px', background: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.2)`, borderRadius: '6px' }}
                    />
                    <div className="d-flex justify-content-between mt-1">
                      <span className="text-muted small" style={{ fontSize: '11px' }}>{formatTime(model.progress.current)}</span>
                      <span className="text-muted small" style={{ fontSize: '11px' }}>-:--</span>
                    </div>
                  </div>
                ) : null}

                {model.buffering && model.bufferingText && (
                  <div className="small text-center mb-3" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '12px' }}>{model.bufferingText}</div>
                )}

                {}
                <div className="d-flex justify-content-center align-items-center gap-2 mb-3">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={model.onShuffle || (() => {
                      addDebugLog('playback', `shuffle ${!shuffle ? 'enabled' : 'disabled'}`);
                      setShuffle((s) => !s);
                    })}
                    active={model.shuffleOn !== undefined ? model.shuffleOn : shuffle}
                    disabled={model.onShuffle ? false : !model.soloControls}
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
                    onClick={model.onPrev}
                    disabled={model.controlsDisabled}
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
                    onClick={model.onToggle}
                    disabled={model.controlsDisabled}
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
                    {model.playing ? SVGIcons.pause : SVGIcons.play}
                  </Button>
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={model.onNext}
                    disabled={model.controlsDisabled}
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
                    onClick={model.onRepeat || cycleRepeatMode}
                    active={(model.repeatValue !== undefined ? model.repeatValue : repeatMode) !== 'off'}
                    disabled={model.onRepeat ? false : !model.soloControls}
                    style={{
                      borderRadius: '6px',
                      width: '36px',
                      height: '36px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title={`repeat: ${REPEAT_MODES[model.repeatValue !== undefined ? model.repeatValue : repeatMode].label} (R)`}
                  >
                    {(model.repeatValue !== undefined ? model.repeatValue : repeatMode) === 'one' ? SVGIcons.repeatOne : SVGIcons.repeat}
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
                  <button
                    type="button"
                    className={`eq-toggle ${eqEnabled ? 'active' : ''}`}
                    onClick={() => {
                      setEqEnabled(!eqEnabled);
                      setShowEQ(!showEQ);
                    }}
                    title="equalizer (only changes your own sound)"
                  >
                    eq
                  </button>
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
                              ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                              : undefined,
                            color: selectedPreset === preset ? '#fff' : undefined,
                            border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`
                          }}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>

                    {}
                    <div className="d-flex justify-content-between px-2">
                      {eqValues.map((value, index) => (
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
                              // dragging a band on its own is a valid way to turn the eq on -
                              // it shouldnt only work after picking a preset first
                              setEqEnabled(true);
                            }}
                            className="eq-slider"
                            style={{
                              writingMode: 'vertical-lr',
                              direction: 'rtl',
                              height: '130px',
                              width: '24px'
                            }}
                          />
                          <span style={{ fontSize: '11px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
                            {index === 0 ? '32' : index === 9 ? '16k' : `${index * 1000 / 1000}k`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

    </>
  );

  const socialView = (
    <div className={`social-flat${panelOrders.social ? ' custom-order' : ''}`} style={snapLayoutStyle}>
      {renderPanelColumn('social', 'left', socialLeftPanelIds, socialPanels)}
      {renderPanelColumn('social', 'right', socialRightPanelIds, socialPanels)}
    </div>
  );
  const collabPanels = {
    setup: renderPanelCard('collab', 'setup', '',
      currentChannel ? (
        <div className="collab-setup-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <Card className="glass-dark p-3" style={{ maxHeight: '220px', overflow: 'hidden' }}>
            <div className="fw-bold mb-2" style={{ color: '#fff', fontSize: '12px' }}>server</div>
            <div style={{ fontSize: '11px', color: '#ccc' }}>
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>name:</span> {currentChannel.name}</div>
              {currentChannel.description && (
                <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>desc:</span> {currentChannel.description}</div>
              )}
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>host:</span> {currentChannel.host_username}</div>
              <div style={{ marginBottom: '4px' }}><span style={{ color: '#9ca3af' }}>members:</span> {currentChannelMembers.length}</div>
              {currentChannel.is_private ? (
                <div style={{ marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ color: '#9ca3af' }}>private, code:</span>
                  <strong style={{ letterSpacing: '0.12em', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{currentChannel.join_code || '...'}</strong>
                  {currentChannel.join_code ? (
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(currentChannel.join_code);
                          showNotification('code copied, send it to whoever you want to let in', 'success');
                        } catch {
                          showNotification(`the code is ${currentChannel.join_code}`, 'info');
                        }
                      }}
                      style={{ ...outlineButtonStyle, padding: '2px 8px', fontSize: '10px' }}
                    >
                      copy
                    </button>
                  ) : null}
                </div>
              ) : null}
              {currentChannel.host_id === currentUserId ? (
                <button
                  onClick={() => deleteChannel(currentChannel.id)}
                  style={{
                    ...dangerButtonStyle,
                    marginRight: '8px',
                    padding: '6px 12px',
                    fontSize: '10px',
                    marginTop: '6px',
                    transition: 'none'
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
              ) : null}
              {/* everyone can leave, the host too: the channel stays and the host can come back to it */}
                <button
                  onClick={() => leaveChannel(currentChannel.id)}
                  style={{
                    ...dangerButtonStyle,
                    padding: '6px 12px',
                    fontSize: '10px',
                    marginTop: '6px',
                    transition: 'none'
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
                  <div style={{ color: nameColorFor(member.user_id, member.user_id === currentUserId || Boolean(member.is_online)), fontSize: '11px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                        transition: 'none'
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
                        transition: 'none'
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
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#9ca3af', fontSize: '11px', cursor: 'pointer' }}>
              <input type="checkbox" checked={newChannelPrivate} onChange={(e) => setNewChannelPrivate(e.target.checked)} />
              private (people need a code to join)
            </label>
            <button
              onClick={createChannel}
              disabled={!newChannelName.trim()}
              style={{ ...primaryButtonStyle, opacity: newChannelName.trim() ? 1 : 0.5, cursor: newChannelName.trim() ? 'pointer' : 'not-allowed' }}
            >
              create {newChannelPrivate ? 'private ' : ''}channel
            </button>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              value={joinCodeText}
              onChange={(e) => setJoinCodeText(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') joinChannelByCode(joinCodeText); }}
              placeholder="have a code?"
              maxLength={12}
              style={{ ...inputStyle, flex: 1, letterSpacing: '0.1em' }}
            />
            <button
              onClick={() => joinChannelByCode(joinCodeText)}
              disabled={joinCodeText.trim().length < 6}
              style={{ ...outlineButtonStyle, opacity: joinCodeText.trim().length < 6 ? 0.5 : 1 }}
            >
              join
            </button>
          </div>
          <div style={{ ...sectionStackStyle, maxHeight: '260px', overflowY: 'auto' }}>
            {channels.length === 0 ? (
              <div style={wireEmptyStyle}>no channels yet</div>
            ) : channels.map((channel) => {
              const joined = joinedChannelIds.has(channel.id);
              const active = currentChannelId === channel.id;

              return (
                <div key={channel.id} style={wireRowStyle(active)}>
                  <div style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>
                    {channel.name}
                    {channel.is_private ? (
                      <span
                        title="private: you need the code to join"
                        style={{ marginLeft: '8px', padding: '0 6px', fontSize: '9px', fontWeight: 'normal', border: '1px solid #9ca3af', color: '#9ca3af', borderRadius: 'var(--border-radius-sm)' }}
                      >
                        private
                      </span>
                    ) : null}
                  </div>
                  <div style={{ color: '#9ca3af', fontSize: '10px', marginTop: '4px' }}>host: {channel.host_username} | {(channel.members || []).length} members</div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {channel.is_private && !joined && channel.host_id !== currentUserId ? (
                      <button
                        onClick={() => { setCodeEntryFor(codeEntryFor === channel.id ? '' : channel.id); setCodeEntryText(''); }}
                        style={primaryButtonStyle}
                      >
                        enter code
                      </button>
                    ) : (
                      <button onClick={() => joinChannel(channel)} style={primaryButtonStyle}>{active ? 'open' : joined ? 'rejoin' : 'join'}</button>
                    )}
                    {joined && <button onClick={() => leaveChannel(channel.id)} style={dangerButtonStyle}>leave</button>}
                  </div>
                  {channel.is_private && !joined && codeEntryFor === channel.id && (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      <input
                        autoFocus
                        value={codeEntryText}
                        onChange={(e) => setCodeEntryText(e.target.value.toUpperCase())}
                        onKeyDown={(e) => { if (e.key === 'Enter') joinChannel(channel, codeEntryText); }}
                        placeholder="code"
                        maxLength={12}
                        style={{ ...inputStyle, flex: 1, letterSpacing: '0.1em' }}
                      />
                      <button onClick={() => joinChannel(channel, codeEntryText)} disabled={codeEntryText.trim().length < 6} style={{ ...outlineButtonStyle, opacity: codeEntryText.trim().length < 6 ? 0.5 : 1 }}>join</button>
                    </div>
                  )}
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
                    <div style={{ color: nameColorFor(entry.id, true), fontSize: '12px', fontWeight: 'bold' }}>{entry.username}</div>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '11px', textTransform: 'lowercase', letterSpacing: '0.04em' }}>
              shared queue
            </div>
            <button
              onClick={(event) => jumpToPlayingRow(event.currentTarget)}
              disabled={!activeSharedTrack}
              title="scroll the queue to the song that is playing"
              style={{ ...outlineButtonStyle, padding: '2px 10px', fontSize: '10px', opacity: activeSharedTrack ? 1 : 0.5 }}
            >
              jump to playing
            </button>
          </div>
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
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Marquee className="fw-bold" text={track.title} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
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
                      transition: 'none',
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
                        transition: 'none',
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
                  transition: 'none',
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
                    transition: 'none'
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <div style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '11px', textTransform: 'lowercase', letterSpacing: '0.04em' }}>
                add from your queue
              </div>
              {queue.length > 0 && (
                <button
                  onClick={addMyQueueToRoom}
                  disabled={!!roomAddProgress}
                  style={{ ...outlineButtonStyle, padding: '2px 10px', fontSize: '10px', opacity: roomAddProgress ? 0.6 : 1 }}
                >
                  {roomAddProgress ? `adding ${roomAddProgress.done}/${roomAddProgress.total}` : `add all (${queue.length})`}
                </button>
              )}
            </div>
            <ListGroup variant="flush" style={{ maxHeight: '180px', overflowY: 'auto' }}>
              {queue.length === 0 ? (
                <div style={wireEmptyStyle}>your queue is empty</div>
              ) : queue.map((track, index) => (
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Marquee className="fw-bold" text={track.title} style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
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
                        transition: 'none',
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
                    <div style={{ color: '#fff', fontSize: '13px', marginTop: '6px', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.message}</div>
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
          {renderPlayerContent({
            track: activeSharedTrack,
            // a device that is not listening shows a play button: pressing it joins the room
            playing: playbackSource === 'shared' ? isPlaying : false,
            progress: sharedTrackProgress,
            progressRef: sharedProgressBarRef,
            buffering: channelPlayerState?.sync_phase === 'preparing' || (playbackSource === 'shared' && isBuffering) || !isConnected,
            bufferingText: describeBuffering({
              stage: bufferStage,
              seconds: channelPlayerState?.sync_phase === 'preparing' ? syncWaitSeconds : bufferingSeconds,
              shared: true,
              preparing: channelPlayerState?.sync_phase === 'preparing',
              connected: isConnected,
              waiting: channelPlayerState?.sync_waiting
            }),
            onPrev: () => stepSharedPlayback(-1),
            onToggle: toggleSharedPlayback,
            onNext: () => stepSharedPlayback(1),
            controlsDisabled: !channelQueue.length,
            soloControls: false,
            seekEnabled: playbackSource === 'shared',
            heading: `room player${currentChannel ? ` · ${currentChannel.name}` : ''}`,
            chip: playbackSource === 'shared'
              ? (isPlaying ? 'you are listening' : 'paused')
              : (channelPlayerState?.is_playing && activeSharedTrack ? 'playing, you are not listening' : 'not playing'),
            chipActive: playbackSource === 'shared' && isPlaying,
            shuffleOn: roomShuffle,
            repeatValue: roomRepeat,
            onShuffle: toggleRoomShuffle,
            onRepeat: cycleRoomRepeat
          })}
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
                transition: 'none'
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
                    transition: 'none'
                  }}
                >
                  {isCollabType ? SVGIcons.collabPlaylist : SVGIcons.folder}
                  {playlist.name}
                  {isCollabType && !canEdit && (
                    <span style={{ fontSize: '9px', color: '#9ca3af' }}>(read-only)</span>
                  )}
                  {isCollabType && canEdit && (
                    <Dropdown align="end" className="d-inline ms-1">
                      <Dropdown.Toggle as="span" className="border-0 bg-transparent p-0" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer', transition: 'none' }} onMouseEnter={(e) => {
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
                      <Button
                        variant="outline-light"
                        size="sm"
                        className="btn"
                        title="add to the room's queue"
                        onClick={(e) => {
                          e.stopPropagation();
                          addTrackToCurrentChannel(track);
                        }}
                        style={{
                          borderRadius: '6px',
                          color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                          border: `1px solid ${dimBorderColor(themeColor)}`,
                          background: 'transparent',
                          transition: 'none',
                          padding: '4px 8px'
                        }}
                      >
                        {SVGIcons.plus}
                      </Button>
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
                            transition: 'none',
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
                        <Marquee className="fw-bold" text={track.title} style={{ maxWidth: '200px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
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
            <div className="d-flex justify-content-between align-items-center mt-3 flex-wrap gap-2">
              <span className="text-muted small">{currentCollabTracks.length} tracks</span>
              <div className="d-flex gap-2 flex-wrap">
                {(() => {
                  const isCollabType = currentCollabPlaylist?.type === 'collab';
                  const canEdit = isCollabType ? canEditCollabPlaylist(currentCollabPlaylist) : true;
                  return (
                    <>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => addTracksToRoom(currentCollabTracks, 'this playlist')}
                        disabled={!!roomAddProgress}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        {roomAddProgress ? `adding ${roomAddProgress.done}/${roomAddProgress.total}` : 'add all to room queue'}
                      </Button>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={loadCollabPlaylistToQueue}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        load to my queue
                      </Button>
                      {canEdit && (
                    <>
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => {
                          if (!channelQueue.length) {
                            showNotification('shared queue is empty', 'warning');
                            return;
                          }
                          addRoomQueueToCollabPlaylist();
                        }}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        add all from queue
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
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </>
      )
    )
  };
  const collabPanelOrder = panelOrderFor('collab');
  // before joining a channel only the setup panel is shown. the others would
  // only say "join a channel", which is obvious
  const collabPanelShown = (panelId) => Boolean(currentChannel) || panelId === 'setup';
  const collabLeftPanelIds = collabPanelOrder.filter((panelId) => collabPanelSides[panelId] !== 'right' && collabPanelShown(panelId));
  const collabRightPanelIds = collabPanelOrder.filter((panelId) => collabPanelSides[panelId] === 'right' && collabPanelShown(panelId));
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
    <div className={`social-flat collab-flat${currentChannel ? ' in-channel' : ''}${panelOrders.collab ? ' custom-order' : ''}`} style={collabLayoutStyle}>
      {renderPanelColumn('collab', 'left', collabLeftPanelIds, collabPanels)}
      {renderPanelColumn('collab', 'right', collabRightPanelIds, collabPanels)}
    </div>
  );

  // a function, not a value: it reads mainPanels, which is built further down
  const renderMainView = () => (
    <div className="main-content">
      <div className={`row g-4 main-flat${panelOrders.main ? ' custom-order' : ''}`}>
        <div className="col-lg-6 d-flex flex-column gap-4">{mainLeftIds.map((panelId) => mainPanels[panelId])}</div>
        <div className="col-lg-6 d-flex flex-column gap-4">{mainRightIds.map((panelId) => mainPanels[panelId])}</div>
      </div>
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

  // handlers for the memoized queue and playlist lists. they keep one identity
  // for the life of the component so those lists can skip rendering when only
  // the progress bar ticked (see useStableCallback)
  // ---- layout editor: a dummy copy of each tab's panels that can be moved
  // around. saving it is what changes the real layout
  const openLayoutEditor = () => {
    setLayoutDraft({
      main: { sides: { ...MAIN_LAYOUT_DEFAULTS, ...mainPanelSides }, order: panelOrderFor('main') },
      social: { sides: { ...SOCIAL_LAYOUT_DEFAULTS, ...socialPanelSides }, order: panelOrderFor('social') },
      collab: { sides: { ...COLLAB_LAYOUT_DEFAULTS, ...collabPanelSides }, order: panelOrderFor('collab') }
    });
    setLayoutEditorTab('main');
    setShowSettingsModal(false);
    setShowLayoutEditor(true);
  };
  const changeDraft = (scope, update) => {
    setLayoutDraft((draft) => (draft ? { ...draft, [scope]: update(draft[scope]) } : draft));
  };
  const draftSetSide = (scope, id, side) => changeDraft(scope, (part) => ({ ...part, sides: { ...part.sides, [id]: side } }));
  const draftMoveTile = (scope, id, direction) => changeDraft(scope, (part) => {
    const sameColumn = part.order.filter((other) => (part.sides[other] === 'right') === (part.sides[id] === 'right'));
    const neighbour = sameColumn[sameColumn.indexOf(id) + direction];
    if (!neighbour) return part;
    const order = [...part.order];
    const a = order.indexOf(id);
    const b = order.indexOf(neighbour);
    [order[a], order[b]] = [order[b], order[a]];
    return { ...part, order };
  });
  // dropped on another tile: it goes into that tile's column, just before it.
  // dropped on an empty part of a column: it goes to the end of that column
  const draftDrop = (scope, draggedId, targetId, side) => changeDraft(scope, (part) => {
    if (!draggedId || draggedId === targetId) return part;
    const order = part.order.filter((id) => id !== draggedId);
    const toSide = targetId ? part.sides[targetId] : side;
    if (targetId) order.splice(order.indexOf(targetId), 0, draggedId);
    else order.push(draggedId);
    return { order, sides: { ...part.sides, [draggedId]: toSide === 'right' ? 'right' : 'left' } };
  });
  const draftReset = (scope) => {
    const defaults = { main: MAIN_LAYOUT_DEFAULTS, social: SOCIAL_LAYOUT_DEFAULTS, collab: COLLAB_LAYOUT_DEFAULTS }[scope];
    changeDraft(scope, () => ({ sides: { ...defaults }, order: [...DEFAULT_PANEL_ORDERS[scope]] }));
  };
  const saveLayoutDraft = () => {
    if (!layoutDraft) return;
    setMainPanelSides(layoutDraft.main.sides);
    setSocialPanelSides(layoutDraft.social.sides);
    setCollabPanelSides(layoutDraft.collab.sides);
    const nextOrders = {};
    ['main', 'social', 'collab'].forEach((scope) => {
      if (JSON.stringify(layoutDraft[scope].order) !== JSON.stringify(DEFAULT_PANEL_ORDERS[scope])) {
        nextOrders[scope] = layoutDraft[scope].order;
      }
    });
    setPanelOrders(nextOrders);
    try {
      localStorage.setItem(mainLayoutStorageKey, JSON.stringify(layoutDraft.main.sides));
      localStorage.setItem(panelOrdersStorageKey, JSON.stringify(nextOrders));
    } catch {
      // not remembered after a restart
    }
    setShowLayoutEditor(false);
    showNotification('layout saved', 'success');
  };

  const stableQueuePlay = useStableCallback((idx) => playTrackAtIndex(idx, queue, { source: 'personal' }));
  const stableQueueRemove = useStableCallback((idx) => removeFromQueue(idx));
  const stableQueueAddToPlaylist = useStableCallback((track) => addTrackToPlaylist(track));
  const stableQueueDownload = useStableCallback((item) => downloadSingle(item));
  const stableQueueProcess = useStableCallback(() => processQueue());
  const stableQueueSaveAll = useStableCallback(() => addAllToPlaylist());
  const stableQueueClear = useStableCallback(() => clearQueue());
  const stableRemovePlaylistTrack = useStableCallback((idx) => removeTrackFromPlaylist(idx));
  const stableToggleOffline = useStableCallback((track) => toggleOffline(track));
  const stableDragStart = useStableCallback((e, idx) => handleDragStart(e, idx));
  const stableDragOver = useStableCallback((e, idx) => handleDragOver(e, idx));
  const stableDrop = useStableCallback((e, idx) => handleDrop(e, idx));

  // the home tab as panels, so the layout editor can move them around
  const mainPanels = {
    search: (
            <Card key="main-search" data-panel="main-search" style={{ '--panel-order': orderIndex('main', 'search') }} className="glass card-hover shadow-sm border-0">
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
                      placeholder={offlineModeActive ? 'offline mode: search is off, load saved songs from a playlist' : 'search song title or just paste a link (playlist links supported)'}
                      style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}
                      disabled={isDownloading || isQueueRunning || offlineModeActive}
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
                      {searchSeconds < 4 ? 'searching...' : `still searching... ${searchSeconds}s`}
                    </div>
                  )}

                  {suggestionError && !isSuggesting && (
                    <div className="small mb-2" style={{ color: '#f87171' }}>
                      {suggestionError === 'no results found'
                        ? 'no results found, try different words'
                        : suggestionError.startsWith('you are offline') ? suggestionError : `search failed: ${suggestionError}`}
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
                            <Marquee className="fw-semibold" text={result.title} style={{ maxWidth: '250px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }} />
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
                        downloading{progress.total ? ` - ${Math.round((progress.loaded / progress.total) * 100)}%` : '...'}
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

              </Card.Body>
            </Card>
    ),
    queue: queue.length > 0 ? (
      <Card key="main-queue" data-panel="main-queue" style={{ '--panel-order': orderIndex('main', 'queue') }} className="glass card-hover shadow-sm border-0">
        <Card.Body>
          <QueueList
                      queue={queue}
                      currentIndex={currentIndex}
                      themeColor={themeColor}
                      onPlayTrack={stableQueuePlay}
                      onRemoveTrack={stableQueueRemove}
                      onAddToPlaylist={stableQueueAddToPlaylist}
                      onDownloadSingle={stableQueueDownload}
                      isDownloading={isDownloading}
                      isQueueRunning={isQueueRunning}
                      onProcessQueue={stableQueueProcess}
                      onAddAllToPlaylist={stableQueueSaveAll}
                      onClearQueue={stableQueueClear}
                      offlineMode={isAndroidApp()}
                      offlineIds={offlineIds}
                      offlineModeActive={offlineModeActive}
                      savingProgress={offlineProgress}
                    />
        </Card.Body>
      </Card>
    ) : null,
    player: (
            <Card key="main-player" data-panel="main-player" style={{ '--panel-order': orderIndex('main', 'player') }} className="glass card-hover shadow-sm border-0">
              <Card.Body>
                {}
                {renderPlayerContent({
                  // while this device is on the room player the solo card does not
                  // mirror it: it shows the song the solo player was on, paused
                  track: playbackSource === 'shared' ? lastSoloTrackRef.current : getCurrentTrack(),
                  playing: playbackSource !== 'shared' && isPlaying,
                  progress: playbackSource === 'shared'
                    ? (personalPlayerStateRef.current.videoId && lastSoloTrackRef.current && personalPlayerStateRef.current.videoId === lastSoloTrackRef.current.videoId
                      ? { current: personalPlayerStateRef.current.currentTime || 0, duration: personalPlayerStateRef.current.duration || 0 }
                      : { current: 0, duration: 0 })
                    : trackProgress,
                  progressRef: personalProgressBarRef,
                  buffering: playbackSource !== 'shared' && isBuffering,
                  bufferingText: personalBufferingText,
                  onPrev: soloPrev,
                  onToggle: soloToggle,
                  onNext: soloNext,
                  controlsDisabled: !queue.length,
                  soloControls: true,
                  seekEnabled: playbackSource !== 'shared',
                  heading: 'solo player',
                  chip: playbackSource === 'shared'
                    ? 'disabled while room player is active'
                    : (isPlaying ? 'playing' : (getCurrentTrack() ? 'paused' : null)),
                  chipActive: playbackSource !== 'shared' && isPlaying,
                  remote: remoteNow
                })}
              </Card.Body>
            </Card>
    ),
    playlists: (
            <Card key="main-playlists" data-panel="main-playlists" style={{ '--panel-order': orderIndex('main', 'playlists') }} className="glass card-hover shadow-sm border-0">
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
                      transition: 'none'
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
                  {activePlaylists.map((playlist) => (
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
                        transition: 'none'
                      }}
                    >
                      {playlist.type === 'collab' ? SVGIcons.collabPlaylist : SVGIcons.folder}
                      {playlist.name}
                      {playlist.type === 'collab' && (
                        <span style={{ fontSize: '9px', color: '#9ca3af' }}>(collab)</span>
                      )}
                      {playlist.type !== 'collab' && playlist.type !== 'saved' && playlist.id !== 'default' && (
                        <Dropdown align="end" className="d-inline ms-1">
                          <Dropdown.Toggle as="span" className="border-0 bg-transparent p-0" style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, cursor: 'pointer', transition: 'none' }} onMouseEnter={(e) => {
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
                  <ResizableListGroup storageKey="playlist" defaultHeight={300}>
                    {(() => {
                      const activeTrackKey = getTrackKey(currentTrack);
                      return currentTracks.map((track, idx) => (
                        <PlaylistTrackRow
                          key={`${getTrackKey(track)}-${idx}`}
                          track={track}
                          idx={idx}
                          active={activeTrackKey === getTrackKey(track)}
                          dragged={draggedTrack === idx}
                          themeColor={themeColor}
                          onRemove={stableRemovePlaylistTrack}
                          onDragStart={stableDragStart}
                          onDragOver={stableDragOver}
                          onDrop={stableDrop}
                          offlineMode={isAndroidApp()}
                          offline={offlineIds.has(track.videoId)}
                          onToggleOffline={stableToggleOffline}
                          dimmed={offlineModeActive && !offlineIds.has(track.videoId)}
                        />
                      ));
                    })()}
                  </ResizableListGroup>
                ) : (
                  <div className="text-center text-muted py-4">
                    <div className="small">this playlist is empty</div>
                  </div>
                )}

                {currentTracks.length > 0 && (
                  <div className="d-flex justify-content-between align-items-center mt-3 flex-wrap gap-2">
                    <span className="text-muted small">{currentTracks.length} tracks</span>
                    <div className="d-flex gap-2 flex-wrap">
                      <Button
                        variant="outline-light"
                        size="sm"
                        onClick={() => loadPlaylistToQueue()}
                        style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                      >
                        load to queue
                      </Button>
                      {isAndroidApp() && (
                        <Button
                          variant="outline-light"
                          size="sm"
                          onClick={() => saveTracksOffline(currentTracks, 'playlist')}
                          disabled={!!offlineProgress || offlineModeActive}
                          style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                          title={offlineProgress ? `saving ${offlineProgress.done} of ${offlineProgress.total} songs for offline` : 'download every song in this playlist into the app so it plays without internet'}
                        >
                          {offlineProgress ? `saving ${offlineProgress.done}/${offlineProgress.total}` : 'save offline'}
                        </Button>
                      )}
                      <Dropdown>
                        <Dropdown.Toggle
                          as="button"
                          type="button"
                          className="btn btn-outline-light btn-sm"
                          style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                        >
                          export
                        </Dropdown.Toggle>
                        <Dropdown.Menu className="glass-dark">
                          <Dropdown.Item onClick={() => exportPlaylist('json')}>
                            as json (round-trips back into this app)
                          </Dropdown.Item>
                          <Dropdown.Item onClick={() => exportPlaylist('csv')}>
                            as csv (spreadsheets, other playlist tools)
                          </Dropdown.Item>
                        </Dropdown.Menu>
                      </Dropdown>
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

                <div className="d-flex justify-content-end mt-2">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={importPlaylistFromFile}
                    disabled={!!playlistImport}
                    style={{ borderRadius: '6px', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: `1px solid ${dimBorderColor(themeColor)}` }}
                    title="import a .json (from this app) or .csv (title/artist columns) playlist file"
                  >
                    import tracks from file
                  </Button>
                </div>

                {playlistImport && (
                  <div className="mt-2">
                    <div className="d-flex justify-content-between small text-muted mb-1">
                      <span className="text-truncate" style={{ maxWidth: '70%' }}>matching: {playlistImport.label}</span>
                      <span>{playlistImport.done}/{playlistImport.total}</span>
                    </div>
                    <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.round((playlistImport.done / playlistImport.total) * 100)}%`,
                        background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        transition: 'width 0.15s linear'
                      }} />
                    </div>
                    <Button
                      variant="outline-danger"
                      size="sm"
                      className="mt-2"
                      onClick={() => { importCancelRef.current = true; }}
                      style={{ borderRadius: '6px' }}
                    >
                      cancel import
                    </Button>
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

    )
  };

  return (
    <ErrorBoundary>
      <Container className="py-4" style={{ maxWidth: '1200px' }} onClick={() => setChatUserPopup(null)}>
      {/* new version bar */}
      {versionMismatch && dismissedVersion !== latestVersion && (
        <div
          style={{
            // down in the corner where the toasts are, so it never covers a control
            position: 'fixed',
            left: '24px',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
            maxWidth: 'calc(100vw - 48px)',
            zIndex: 1000,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 14px',
            background: 'rgba(20, 20, 20, 0.95)',
            border: `1px solid ${dimBorderColor(themeColor)}`,
            borderRadius: '10px',
            color: '#fff',
            fontSize: '13px'
          }}
        >
          <span>new version <span style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{latestVersion}</span> available</span>
          <button
            onClick={applyUpdate}
            disabled={updateBusy}
            style={{
              background: 'transparent',
              border: `1px solid ${dimBorderColor(themeColor)}`,
              borderRadius: '6px',
              color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              cursor: 'pointer',
              fontSize: '12px',
              padding: '4px 12px',
              transition: 'none'
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
            {updateBusy ? 'updating...' : updateKind === 'installer' ? 'download' : updateKind === 'live' ? 'update' : 'refresh'}
          </button>
          <button
            onClick={() => setDismissedVersion(latestVersion)}
            style={{
              background: 'transparent',
              border: '1px solid transparent',
              borderRadius: '6px',
              color: '#9ca3af',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '4px 8px',
              transition: 'none'
            }}
          >
            later
          </button>
        </div>
      )}

      {}
      <canvas
        ref={particleCanvasRef}
        className="visualizer-canvas"
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
          borderBottom: `2px ${offlineModeActive ? 'dashed' : 'solid'} rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
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
        <span className="top-nav-user" style={{
          color: user ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.6)`,
          fontSize: '13px',
          fontWeight: user ? 'bold' : 'normal'
        }}>
          {user ? user.username : 'not signed in'}
        </span>
        {offlineModeActive && (
          <span
            title="offline mode: only songs saved on this phone can be loaded"
            style={{
              border: '1px dashed #9ca3af',
              color: '#9ca3af',
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: 'var(--border-radius-sm)',
              whiteSpace: 'nowrap'
            }}
          >
            offline mode
          </span>
        )}

        {}
        <div className="top-nav-title" style={{
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
            return (
              <div key={tab} style={{ position: 'relative' }}>
                <button
                  onClick={() => { if (!(offlineModeActive && tab !== 'main')) setActiveTab(tab); }}
                  title={offlineModeActive && tab !== 'main' ? 'needs a connection' : undefined}
                  style={{
                    opacity: offlineModeActive && tab !== 'main' ? 0.35 : 1,
                    padding: '6px 10px',
                    border: '1px solid',
                    borderColor: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    borderRadius: 'var(--border-radius-sm)',
                    background: activeTab === tab ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                    color: activeTab === tab ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    cursor: 'pointer',
                    fontSize: '12px',
                    transition: 'none',
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
                      borderRadius: '50%',
                      width: '16px',
                      height: '16px',
                      padding: 0,
                      lineHeight: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      {badgeCount > 9 ? '9+' : badgeCount}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {}
        <div className="top-nav-spacer" style={{ minWidth: '100px' }} />
      </div>

      {}
      <div style={{ height: '60px' }} />

      {helperDown && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '8px 12px',
            border: `1px solid ${dimBorderColor(themeColor)}`,
            color: '#9ca3af',
            fontSize: '12px',
            textAlign: 'center'
          }}
        >
          starting the audio helper... search and playback work in a moment
        </div>
      )}

      {offlineModeActive && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '8px 12px',
            border: '1px dashed #9ca3af',
            color: '#9ca3af',
            fontSize: '12px',
            textAlign: 'center'
          }}
        >
          offline mode: only the {offlineIds.size} song{offlineIds.size === 1 ? '' : 's'} saved on this phone can be loaded.
          {isOnline
            ? (
              <>
                {' '}
                <button
                  onClick={() => setForceOffline(false)}
                  style={{ background: 'none', border: 'none', color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, textDecoration: 'underline', padding: 0, fontSize: '12px' }}
                >
                  go back online
                </button>
              </>
            )
            : ' it goes back to normal by itself when you reconnect.'}
        </div>
      )}

      {offlineProgress && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '8px 12px',
            border: `1px solid ${dimBorderColor(themeColor)}`,
            color: '#9ca3af',
            fontSize: '12px',
            textAlign: 'center'
          }}
        >
          saving {offlineProgress.label} for offline: {offlineProgress.done} of {offlineProgress.total}
          <div style={{ height: '3px', marginTop: '6px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.round((offlineProgress.done / offlineProgress.total) * 100)}%`,
              background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
              transition: 'width 0.15s linear'
            }} />
          </div>
        </div>
      )}

      {isPip && <PipPlayer nowPlaying={buildNowPlayingPayload()} />}

      <Modal
        show={showLayoutEditor}
        onHide={() => setShowLayoutEditor(false)}
        centered
        size="lg"
        className="settings-modal"
        animation={false}
      >
        <Modal.Header closeButton style={{ borderBottom: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>
          <Modal.Title style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontSize: '18px' }}>change layout</Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: '#000', color: '#fff', padding: '20px' }}>
          {layoutDraft && (() => {
            const scope = layoutEditorTab;
            const part = layoutDraft[scope];
            const labels = PANEL_LABELS[scope];
            const columnIds = (side) => part.order.filter((id) => (part.sides[id] === 'right') === (side === 'right'));
            const tile = (id) => {
              const sideNow = part.sides[id] === 'right' ? 'right' : 'left';
              const smallButton = { background: 'transparent', border: `1px solid ${dimBorderColor(themeColor)}`, color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, padding: '2px 8px', fontSize: '12px', lineHeight: 1.2 };
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={(e) => { setDraggedTile({ scope, id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
                  onDragEnd={() => setDraggedTile(null)}
                  onDragOver={(e) => { if (draggedTile && draggedTile.scope === scope) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (draggedTile && draggedTile.scope === scope) draftDrop(scope, draggedTile.id, id); setDraggedTile(null); }}
                  style={{
                    border: `1px dashed rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    background: 'rgba(255,255,255,0.03)',
                    padding: '12px',
                    cursor: 'grab',
                    minHeight: '74px',
                    opacity: draggedTile && draggedTile.id === id ? 0.45 : 1
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontWeight: 'bold', fontSize: '13px' }}>{labels[id][0]}</div>
                      <div style={{ color: '#9ca3af', fontSize: '11px', marginTop: '2px' }}>{labels[id][1]}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button type="button" title="move up" onClick={() => draftMoveTile(scope, id, -1)} style={smallButton}>{'\u25B2'}</button>
                      <button type="button" title="move down" onClick={() => draftMoveTile(scope, id, 1)} style={smallButton}>{'\u25BC'}</button>
                      <button type="button" title={sideNow === 'left' ? 'move to the right column' : 'move to the left column'} onClick={() => draftSetSide(scope, id, sideNow === 'left' ? 'right' : 'left')} style={smallButton}>{sideNow === 'left' ? '\u25B6' : '\u25C0'}</button>
                    </div>
                  </div>
                </div>
              );
            };
            const column = (side) => (
              <div
                onDragOver={(e) => { if (draggedTile && draggedTile.scope === scope) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (draggedTile && draggedTile.scope === scope) draftDrop(scope, draggedTile.id, null, side); setDraggedTile(null); }}
                style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '120px', padding: '8px', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <div style={{ color: '#6b7280', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{side} column</div>
                {columnIds(side).map(tile)}
                {columnIds(side).length === 0 && <div style={{ color: '#6b7280', fontSize: '11px', padding: '14px 0', textAlign: 'center' }}>drop a panel here</div>}
              </div>
            );
            return (
              <>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                  {[['main', 'home'], ['social', 'social'], ['collab', 'collab']].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setLayoutEditorTab(key)}
                      style={{
                        padding: '6px 14px',
                        border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        background: layoutEditorTab === key ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                        color: layoutEditorTab === key ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        fontSize: '12px'
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ color: '#9ca3af', fontSize: '12px', marginBottom: '12px' }}>
                  these are stand-ins for the real panels. drag them, or use the arrows, then save and the tab is laid out this way.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {column('left')}
                  {column('right')}
                </div>
                <div style={{ color: '#9ca3af', fontSize: '11px', marginTop: '12px' }}>
                  on a phone, where everything is one column, it reads top to bottom: {part.order.map((id) => labels[id][0]).join(', then ')}.
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => draftReset(scope)} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${dimBorderColor(themeColor)}`, color: '#9ca3af', fontSize: '12px' }}>reset this tab</button>
                  <button type="button" onClick={() => setShowLayoutEditor(false)} style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${dimBorderColor(themeColor)}`, color: '#fff', fontSize: '12px' }}>cancel</button>
                  <button type="button" onClick={saveLayoutDraft} style={{ padding: '8px 18px', background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, border: 'none', color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>save layout</button>
                </div>
              </>
            );
          })()}
        </Modal.Body>
      </Modal>

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
          <div style={{ marginBottom: '30px', position: 'relative' }}>
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>account</h4>
            <AuthForm
              user={user}
              onAuthSuccess={onLogin}
              onLogout={onLogout}
              themeColor={themeColor}
            />
          </div>

          {}
          <div style={{ marginBottom: '30px' }}>
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>theme color</h4>

            {}
            <div
              style={{
                width: '100%',
                height: '30px',
                background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px',
                color: '#fff',
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
                  width: 8px;
                  height: 24px;
                  border-radius: 0;
                  background: #fff;
                  border: 1px solid #000;
                  cursor: pointer;
                }
                input[type="range"]::-moz-range-thumb {
                  width: 8px;
                  height: 24px;
                  border-radius: 0;
                  background: #fff;
                  border: 1px solid #000;
                  cursor: pointer;
                }
              `}</style>
            </div>

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
                  background: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  color: '#fff',
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
                      color: visualizerPreset === preset.key ? '#fff' : '#fff',
                      background: visualizerPreset === preset.key ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent'
                    }}
                  >
                    {preset.label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          </div>

          <div style={{ marginBottom: '30px' }}>
            <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>layout</h4>
            <button
              onClick={openLayoutEditor}
              style={{
                width: '100%',
                padding: '10px',
                background: 'transparent',
                border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              change layout
            </button>
          </div>

          {((isTauriDesktop && !isAndroidApp()) || (isAndroidApp() && floatingStatus)) && (
            <div style={{ marginBottom: '30px' }}>
              <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>mini player</h4>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {(() => {
                  const phone = isAndroidApp();
                  const needsPermission = phone && floatingStatus === 'needs_permission';
                  const on = phone ? floatingStatus === 'ready' : miniPlayerOn;
                  return (
                    <button
                      onClick={() => {
                        if (!phone) { setMiniPlayerOn((value) => !value); return; }
                        try {
                          if (needsPermission) {
                            const opened = window.SmpNative.requestFloatingPermission && window.SmpNative.requestFloatingPermission();
                            if (!opened) showNotification('could not open that settings screen, find the app under display over other apps in android settings', 'warning');
                          } else {
                            window.SmpNative.setFloatingEnabled(floatingStatus !== 'ready');
                            setFloatingStatus(String(window.SmpNative.floatingStatus()));
                          }
                        } catch {
                          showNotification('could not change the mini player', 'error');
                        }
                      }}
                      style={{
                        padding: '8px 14px',
                        background: on ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                        border: `1px solid ${dimBorderColor(themeColor)}`,
                        color: on ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                        fontSize: '12px'
                      }}
                    >
                      mini player: {needsPermission ? 'needs permission' : on ? 'on' : 'off'}
                    </button>
                  );
                })()}
              </div>
            </div>
          )}

          {isAndroidApp() && (
            <div style={{ marginBottom: '30px' }}>
              <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>home screen player</h4>
              <button
                onClick={() => {
                  try {
                    const asked = window.SmpNative.pinWidget && window.SmpNative.pinWidget();
                    showNotification(asked ? 'confirm in the box that popped up to add it' : 'your launcher does not allow adding it from here, long press the home screen and pick widgets', asked ? 'info' : 'warning');
                  } catch {
                    showNotification('could not ask for the widget', 'error');
                  }
                }}
                style={{
                  width: '100%',
                  marginLeft: 'auto',
                  marginRight: 'auto',
                  padding: '10px',
                  background: 'transparent',
                  border: `1px solid rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  cursor: 'pointer',
                  fontSize: '13px',
                  transition: 'none'
                }}
              >
                add the player widget to the home screen
              </button>
            </div>
          )}

          {isAndroidApp() && (
            <div style={{ marginBottom: '30px' }}>
              <h4 style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, marginBottom: '15px', fontSize: '14px', fontWeight: 'normal' }}>offline</h4>
              <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '10px' }}>
                saved on this phone: <strong style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` }}>{offlineIds.size}</strong> {offlineIds.size === 1 ? 'song' : 'songs'}
                {offlineBytes > 0 ? ` (${Math.max(1, Math.round(offlineBytes / (1024 * 1024)))} MB)` : ''}.
                tap the arrow on a song to save it. without a connection the app switches to offline mode by itself.
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setForceOffline((on) => !on)}
                  style={{
                    padding: '8px 14px',
                    background: forceOffline ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                    border: `1px solid ${dimBorderColor(themeColor)}`,
                    color: forceOffline ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                    fontSize: '12px'
                  }}
                >
                  offline mode: {forceOffline ? 'always on' : 'automatic'}
                </button>
                <button
                  onClick={() => {
                    if (!offlineIds.size) return;
                    if (!confirmClearSaved) { setConfirmClearSaved(true); return; }
                    setConfirmClearSaved(false);
                    clearAllOffline();
                  }}
                  disabled={!offlineIds.size}
                  style={{
                    padding: '8px 14px',
                    background: 'transparent',
                    border: '1px solid #ef4444',
                    color: '#ef4444',
                    fontSize: '12px',
                    opacity: offlineIds.size ? 1 : 0.4
                  }}
                >
                  {confirmClearSaved ? 'tap again to remove all' : 'remove all saved songs'}
                </button>
              </div>
            </div>
          )}

          {isTauriDesktop && !isAndroidApp() && (
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
                  transition: 'none'
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

          {user && (
            <div style={{ marginBottom: '15px' }}>
              <button
                onClick={() => onHideListeningToggle && onHideListeningToggle(!hideListening)}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: hideListening ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  borderRadius: '6px',
                  color: hideListening ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: hideListening ? 'bold' : 'normal'
                }}
              >
                what i'm listening to: {hideListening ? 'hidden' : 'shown'}
              </button>
            </div>
          )}

          {discordAvailable && (
            <div style={{ marginBottom: '15px' }}>
              <button
                onClick={() => setDiscordOn((on) => !on)}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: discordOn ? `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})` : 'transparent',
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  borderRadius: '6px',
                  color: discordOn ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: discordOn ? 'bold' : 'normal'
                }}
              >
                discord status: {discordOn ? 'on' : 'off'}
              </button>
            </div>
          )}

          {versionMismatch && (
            <div style={{ marginBottom: '15px' }}>
              <button
                onClick={applyUpdate}
                disabled={updateBusy}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: 'transparent',
                  border: `1px solid ${dimBorderColor(themeColor)}`,
                  borderRadius: '6px',
                  color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                {updateBusy ? 'updating...' : updateKind === 'installer' ? `download ${latestVersion}` : `update to ${latestVersion}`}
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
                color: debugMode ? '#fff' : `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`,
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: debugMode ? 'bold' : 'normal'
              }}
            >
              debug logs: {debugMode ? 'ON' : 'OFF'}
            </button>
          </div>

          <div style={{ marginTop: '24px', fontSize: '12px' }}>
            <a
              href="https://ko-fi.com/shibenchi"
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openExternalUrl('https://ko-fi.com/shibenchi');
              }}
              style={{ color: '#fff' }}
            >
              support the project
            </a>
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
            maxWidth: 'calc(100vw - 16px)',
            height: '380px',
            minWidth: '300px',
            minHeight: '200px',
            resize: 'both',
            overflow: 'auto',
            // below bootstrap's modal backdrop (1050) / modal (1055) on
            // purpose - this used to sit above both at 1200, so opening
            // settings while debug mode was on put the console's hit area
            // over the modal and swallowed every click meant for it. still
            // above the top nav bar (1000) for normal (no modal open) use
            zIndex: 1040,
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
              <div style={{ padding: '4px 8px', color: '#fff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#2a2a2a', flexShrink: 0 }}>
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
              <div style={{ padding: '4px 8px', color: '#fff', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#2a2a2a', flexShrink: 0 }}>
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

      <div style={peek ? { overflowX: 'clip' } : undefined}>
        <div ref={pagerRef} style={peek ? { position: 'relative', willChange: 'transform' } : undefined}>
          {(peek ? [activeTab, peek.tab] : [activeTab]).map((tab) => (
            // keyed by tab, so the tab that is dragged in is the same element once it
            // has arrived and is not built a second time
            <div
              key={tab}
              aria-hidden={tab !== activeTab ? true : undefined}
              style={tab === activeTab ? undefined : {
                position: 'absolute',
                top: peek.top,
                left: `${peek.side * 100}%`,
                width: '100%',
                pointerEvents: 'none'
              }}
            >
              {tab === 'main' ? renderMainView() : tab === 'social' ? socialView : collabView}
            </div>
          ))}
        </div>
      </div>

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
              maxLength={100}
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
              color: '#fff',
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
              maxLength={100}
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
              color: '#fff',
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

      {/* first-run welcome dialog - fresh installs only, see the effect above */}
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
            hi, i'm shibenchi. i built this because i got tired of paying for spotify or youtube
            premium, and every other music player either got discontinued or had its good features
            ripped out. it's just a private project, not something i'm trying to put out there. use
            it if you want, no risk to you.
          </p>
          <p style={{ color: `rgb(${themeColor.r}, ${themeColor.g}, ${themeColor.b})`, fontWeight: 'bold', marginTop: '20px' }}>
            quick rundown of how everything works:
          </p>
          <ul style={{ paddingLeft: '20px' }}>
            <li style={{ marginBottom: '8px' }}><strong>search:</strong> type a song name up top, or paste a youtube link (single video or playlist) and it'll pull it straight in.</li>
            <li style={{ marginBottom: '8px' }}><strong>queue:</strong> click a search result to add it, drag to reorder, hit play. shuffle/repeat/prev/next all work like you'd expect.</li>
            <li style={{ marginBottom: '8px' }}><strong>playlists:</strong> save the current queue as a playlist, or build one from scratch, from the playlists tab. you can export a playlist as json or csv and import it back later.</li>
            <li style={{ marginBottom: '8px' }}><strong>downloads:</strong> the download button on any track saves it as an mp3 (highest quality, thumbnail embedded) to wherever you pick.</li>
            <li style={{ marginBottom: '8px' }}><strong>eq & theme color:</strong> in settings, a real equalizer plus a theme color that tints basically the whole app.</li>
            <li style={{ marginBottom: '8px' }}><strong>background animation:</strong> also in settings, a bunch of audio-reactive visualizer styles, or none at all if you'd rather keep it plain.</li>
            <li style={{ marginBottom: '8px' }}><strong>miniplayer:</strong> pops up automatically when you minimize or click away from the main window, with basic playback controls. draggable, closable.</li>
            <li style={{ marginBottom: '0' }}><strong>accounts & social:</strong> make an account in settings to add friends, message them, and join a channel to listen to the same song at the same time. playback waits until everyone is ready, and your eq and volume stay your own.</li>
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
              color: '#fff',
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
