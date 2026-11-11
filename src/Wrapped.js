import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';

// the wrapped story of one year: full screen slides, one fact each, the way a year in music is told. it opens by itself on january 1st for
// the year that just ended (App.js decides that) and any year with listening can be opened again from the stats tab.
// tap the right side or press the right arrow for the next slide, the left side for the one before, escape closes it.
// the facts come from /api/wrapped (database.js getWrapped), nothing is worked out here except how to say it and how to draw it.
// every slide has its own palette, all of them built around the colour picked as the app's colour (paletteFor).
// thumbnails: the server knows the video of what was played since it started keeping it, for older listening `lookup(title, author)` finds
// the song among the ones this device knows (playlists, queue); a song nobody can find a picture for gets a plain tile with its first letter

const SLIDE_MS = 7000;
const LONG_SLIDE_MS = 10000;
const WEEKDAYS = ['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const minutesOf = (seconds) => Math.round((seconds || 0) / 60);
const hourText = (hour) => (hour % 12 === 0 ? 12 : hour % 12) + (hour < 12 ? ' am' : ' pm');
const dayText = (day) => {
  const date = new Date(day + 'T00:00:00Z');
  return MONTHS[date.getUTCMonth()] + ' ' + date.getUTCDate();
};
const timeText = (seconds) => {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's');
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return hours + ' hours';
};
const minutesText = (seconds) => minutesOf(seconds).toLocaleString() + ' min';

// ---- colours. the player colour is the main colour of every slide, eight schemes of it: the app itself (black, the colour as outline and
// text), the colour as the whole background, a deep dark shade of it, a pale tint, a glow of it on black, its two neighbours on the wheel
// (the colour stays the accent), and white on a dark shade. a slide takes the scheme of its place in the story, so two slides next to each
// other never share one. text is white, near black, or the colour itself, nothing grey
const wrapHue = (h) => ((h % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hsla = (h, s, l, a = 1) => `hsla(${Math.round(wrapHue(h))}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%, ${a})`;

function rgbToHsl({ r, g, b }) {
  const rr = r / 255; const gg = g / 255; const bb = b / 255;
  const max = Math.max(rr, gg, bb); const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 215, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: wrapHue(h * 60), s: s * 100, l: l * 100 };
}
function hslToRgb(h, s, l) {
  const sat = s / 100; const lig = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}
const luminance = ([r, g, b]) => {
  const c = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const rgbText = (rgb) => `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
// near black or white, whichever reads better on the colour
const inkOn = (rgb) => {
  const l = luminance(rgb);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? { text: '#000000', rgb: [0, 0, 0], dark: true } : { text: '#ffffff', rgb: [255, 255, 255], dark: false };
};

export function paletteFor(index, color) {
  const given = color || { r: 255, g: 89, b: 0 };
  const base = rgbToHsl(given);
  // a grey colour has no hue to build on, a cool blue stands in for it
  const H = base.s < 8 ? 215 : base.h;
  const S = clamp(base.s < 8 ? 75 : base.s, 60, 100);
  const main = base.s < 8 ? hslToRgb(H, S, 55) : [Math.round(given.r), Math.round(given.g), Math.round(given.b)];
  const mainCss = `rgb(${rgbText(main)})`;
  const mainA = (a) => `rgba(${rgbText(main)}, ${a})`;
  // the colour as text and outline on a dark background: itself, or a lighter step of it when it is too dark to read
  const onDark = base.s >= 8 && base.l >= 50 ? main : hslToRgb(H, S, 60);
  const onDarkCss = `rgb(${rgbText(onDark)})`;
  const schemes = [
    // 0 the app itself: black, the colour as outline and text, a little glow of it from below
    () => ({ bg: [`radial-gradient(circle at 50% 118%, ${mainA(0.3)}, transparent 58%)`, '#000000'], mid: [0, 0, 0], ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: onDark, panel: 'transparent' }),
    // 1 the colour as the whole background, text and outline in whichever of black and white reads
    () => {
      const ink = inkOn(main);
      return { bg: [`linear-gradient(170deg, ${mainCss}, ${hsla(H, S, base.s < 8 ? 45 : Math.max(20, base.l - 12))})`], mid: main, ink: ink.text, inkRgb: ink.rgb, dark: ink.dark, accent: ink.rgb, panel: 'transparent' };
    },
    // 2 a deep dark shade of the colour, the colour bright on it
    () => ({ bg: [`linear-gradient(165deg, ${hsla(H, S * 0.85, 17)}, ${hsla(H, S * 0.9, 8)})`], mid: hslToRgb(H, S * 0.85, 12), ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: onDark, panel: 'rgba(0, 0, 0, 0.28)' }),
    // 3 a pale tint of the colour, near black text and a dark step of the colour
    () => ({ bg: [`linear-gradient(170deg, ${hsla(H, 100, 94)}, ${hsla(H, 100, 86)})`], mid: hslToRgb(H, 100, 90), ink: hsla(H, 80, 10), inkRgb: hslToRgb(H, 80, 10), dark: true, accent: hslToRgb(H, 95, 33), panel: 'rgba(255, 255, 255, 0.5)' }),
    // 4 a glow of the colour on black, like the record in the player
    () => ({ bg: [`radial-gradient(circle at 50% 42%, ${mainA(0.58)}, ${mainA(0.14)} 44%, transparent 74%)`, '#000000'], mid: [20, 8, 8], ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: onDark, panel: 'rgba(0, 0, 0, 0.55)' }),
    // 5 dark, the neighbour on one side of the wheel, the colour itself as the accent
    () => ({ bg: [`radial-gradient(circle at 88% 8%, ${mainA(0.32)}, transparent 50%)`, `linear-gradient(160deg, ${hsla(H - 30, S * 0.85, 14)}, ${hsla(H - 18, S, 6)})`], mid: hslToRgb(H - 24, S * 0.9, 10), ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: onDark, panel: 'rgba(0, 0, 0, 0.3)' }),
    // 6 bright, the neighbour on the other side, a black panel on it like the panels of the app
    () => ({ bg: [`linear-gradient(160deg, ${hsla(H + 28, 95, 58)}, ${hsla(H + 12, 95, 46)})`], mid: [0, 0, 0], ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: onDark, panel: '#000000', line: onDark, top: inkOn(hslToRgb(H + 20, 95, 52)).rgb }),
    // 7 white on a dark shade of the colour
    () => ({ bg: [`linear-gradient(180deg, ${hsla(H, S * 0.6, 8)}, ${hsla(H, S, 24)})`], mid: hslToRgb(H, S * 0.8, 16), ink: '#ffffff', inkRgb: [255, 255, 255], dark: false, accent: [255, 255, 255], panel: 'rgba(255, 255, 255, 0.05)' })
  ];
  const s = schemes[((index % schemes.length) + schemes.length) % schemes.length]();
  const accentRgb = Array.isArray(s.accent) ? s.accent : onDark;
  const accent = `rgb(${rgbText(accentRgb)})`;
  const on = inkOn(accentRgb).text;
  return {
    background: s.bg.join(', '),
    ink: s.ink,
    inkRgb: rgbText(s.inkRgb),
    accent,
    accentRgb: rgbText(accentRgb),
    line: s.line ? `rgb(${rgbText(s.line)})` : accent,
    // the bar at the top sits on the background and not in the panel: the accent, unless that does not read on the background
    top: `rgb(${rgbText(s.top || accentRgb)})`,
    topRgb: rgbText(s.top || accentRgb),
    topOn: inkOn(s.top || accentRgb).text,
    panel: s.panel,
    on,
    dark: s.dark
  };
}

// a number, as it is (it used to count up, which was one more thing moving)
function CountUp({ value }) {
  return <span data-count={value}>{Number(value || 0).toLocaleString()}</span>;
}

// one line of a slide, it rises into place after the lines before it
const Rise = ({ at = 0, className = '', style, children, ...rest }) => (
  <div className={'wrapped-rise ' + className} style={{ animationDelay: (at * 0.22) + 's', ...style }} {...rest}>{children}</div>
);

// a thumbnail: the first address that loads, else a tile with the first letter
function Thumb({ sources, title, large, round }) {
  const [step, setStep] = useState(0);
  const src = sources[step];
  const letter = (String(title || '?').trim()[0] || '?').toUpperCase();
  return (
    <span className={'wrapped-thumb' + (large ? ' wrapped-thumb-large' : '') + (round ? ' wrapped-thumb-round' : '')} data-thumb={src ? 'image' : 'tile'}>
      {src
        ? <img src={src} alt="" draggable={false} onError={() => setStep((s) => s + 1)} />
        : <span className="wrapped-thumb-tile">{letter}</span>}
    </span>
  );
}

// the year of one song, month by month, as a small filled line with a dot on the best month
function Spark({ values }) {
  const w = 96; const h = 30; const step = w / 11;
  const max = Math.max(1, ...values);
  const y = (v) => h - 3 - (v / max) * (h - 8);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const peak = values.indexOf(Math.max(...values));
  return (
    <svg className="wrapped-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polygon className="wrapped-spark-fill" points={`0,${h} ${pts} ${w},${h}`} />
      <polyline className="wrapped-spark-line" points={pts} />
      <circle className="wrapped-spark-dot" cx={(peak * step).toFixed(1)} cy={y(values[peak]).toFixed(1)} r="2.6" />
    </svg>
  );
}

// the year as a calendar: one small square a day, columns are weeks, brighter is more music
function Calendar({ days, year }) {
  const first = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const max = Math.max(1, ...days);
  const cells = [...new Array(first).fill(null), ...days];
  const level = (seconds) => (seconds <= 0 ? 0 : Math.min(4, 1 + Math.floor((seconds / max) * 3.999)));
  return (
    <div className="wrapped-cal" data-chart="calendar" style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, 1fr)` }}>
      {cells.map((seconds, i) => <span key={i} className={'wrapped-cal-cell' + (seconds === null ? ' wrapped-cal-empty' : ` wrapped-cal-${level(seconds)}`)} />)}
    </div>
  );
}

export default function Wrapped({ data, color, onClose, lookup }) {
  const [index, setIndex] = useState(0);
  const rootRef = useRef(null);

  // the addresses a picture can come from for one song or artist
  const sourcesOf = useCallback((title, author, videoId) => {
    const found = lookup ? lookup(title, author) : null;
    const id = videoId || (found && found.videoId) || '';
    const list = [];
    if (id) list.push(`https://img.youtube.com/vi/${id}/mqdefault.jpg`, `https://img.youtube.com/vi/${id}/hqdefault.jpg`);
    if (found && found.thumbnail) list.push(found.thumbnail);
    return list;
  }, [lookup]);

  const slides = useMemo(() => {
    if (!data) return [];
    const t = data.totals;
    const list = [];
    const topArtist = data.top_artists[0];
    const topSong = data.top_tracks[0];
    const totalMinutes = minutesOf(t.seconds);
    const songSources = (track) => sourcesOf(track.title, track.author, track.video_id);
    const artistSources = (artist) => sourcesOf(artist.top_title || '', artist.author, artist.video_id);
    const share = (value, top) => Math.max(3, Math.round((value / Math.max(1, top)) * 100));

    list.push({
      key: 'intro',
      body: (
        <>
          <Rise at={0} className="wrapped-small">your</Rise>
          <Rise at={1} className="wrapped-huge" data-wrapped-year>{data.year}</Rise>
          <Rise at={2} className="wrapped-big">{data.complete ? 'wrapped' : 'wrapped so far'}</Rise>
        </>
      )
    });

    const days = t.seconds / 86400;
    const change = t.previous_seconds > 0 ? Math.round(((t.seconds - t.previous_seconds) / t.previous_seconds) * 100) : null;
    list.push({
      key: 'minutes',
      body: (
        <>
          <Rise at={0} className="wrapped-small">you listened for</Rise>
          <Rise at={1} className="wrapped-huge"><CountUp value={totalMinutes} /></Rise>
          <Rise at={2} className="wrapped-big">minutes</Rise>
          <Rise at={3} className="wrapped-note">{days >= 1 ? `that is ${Math.round(days * 10) / 10} days of music` : `that is ${timeText(t.seconds)} of music`}</Rise>
          {change !== null && change !== 0 ? <Rise at={4} className="wrapped-note">{change > 0 ? `${change}% more than ${data.year - 1}` : `${Math.abs(change)}% less than ${data.year - 1}`}</Rise> : null}
        </>
      )
    });

    list.push({
      key: 'counts',
      body: (
        <>
          <Rise at={0} className="wrapped-small">you played</Rise>
          <Rise at={1} className="wrapped-huge"><CountUp value={t.tracks} /></Rise>
          <Rise at={2} className="wrapped-big">different songs</Rise>
          {t.artists ? <Rise at={3} className="wrapped-note">from {t.artists.toLocaleString()} artist{t.artists === 1 ? '' : 's'}</Rise> : null}
        </>
      )
    });

    if (topArtist) {
      list.push({
        key: 'artist',
        body: (
          <>
            <Rise at={0} className="wrapped-small">your top artist</Rise>
            <Rise at={1}><Thumb large round sources={artistSources(topArtist)} title={topArtist.author} /></Rise>
            <Rise at={2} className="wrapped-name" data-wrapped-top-artist>{topArtist.author}</Rise>
            <Rise at={3} className="wrapped-note">{minutesOf(topArtist.seconds).toLocaleString()} minutes{topArtist.tracks > 1 ? ` across ${topArtist.tracks} songs` : ''}</Rise>
            {topArtist.top_title ? <Rise at={4} className="wrapped-note">most of it {topArtist.top_title}</Rise> : null}
          </>
        )
      });
    }

    // the top 5 songs and the top 5 artists on one slide, side by side
    const fiveSongs = data.top_tracks.slice(0, 5);
    const fiveArtists = data.top_artists.slice(0, 5);
    const twinRow = (kind, item, i, top) => (kind === 'artist' ? (
      <div key={item.author} className="wrapped-trow" data-wrapped-row>
        <span className="wrapped-rank">{i + 1}</span>
        <Thumb round sources={artistSources(item)} title={item.author} />
        <span className="wrapped-row-text">
          <span className="wrapped-row-name">{item.author}</span>
          <span className="wrapped-row-sub">{minutesText(item.seconds)}</span>
          <span className="wrapped-trow-bar"><span style={{ width: share(item.seconds, top) + '%' }} /></span>
        </span>
      </div>
    ) : (
      <div key={item.title + item.author} className="wrapped-trow" data-wrapped-row>
        <span className="wrapped-rank">{i + 1}</span>
        <Thumb sources={songSources(item)} title={item.title} />
        <span className="wrapped-row-text">
          <span className="wrapped-row-name">{item.title}</span>
          <span className="wrapped-row-sub">{[item.author, minutesText(item.seconds)].filter(Boolean).join(' | ')}</span>
          <span className="wrapped-trow-bar"><span style={{ width: share(item.seconds, top) + '%' }} /></span>
        </span>
      </div>
    ));
    if (fiveSongs.length > 1 || fiveArtists.length > 1) {
      list.push({
        key: 'tops',
        ms: LONG_SLIDE_MS,
        body: (
          <>
            <Rise at={0} className="wrapped-small">your top 5</Rise>
            <div className="wrapped-twin" data-chart="tops">
              <div className="wrapped-summary-col" data-chart="songs">
                {fiveSongs.length ? <div className="wrapped-summary-label">songs</div> : null}
                <div className="wrapped-chart wrapped-chart-summary">
                  {fiveSongs.map((track, i) => twinRow('song', track, i, fiveSongs[0].seconds))}
                </div>
              </div>
              <div className="wrapped-summary-col" data-chart="artists">
                {fiveArtists.length ? <div className="wrapped-summary-label">artists</div> : null}
                <div className="wrapped-chart wrapped-chart-summary">
                  {fiveArtists.map((artist, i) => twinRow('artist', artist, i, fiveArtists[0].seconds))}
                </div>
              </div>
            </div>
          </>
        )
      });
    }

    if (topSong) {
      list.push({
        key: 'song',
        body: (
          <>
            <Rise at={0} className="wrapped-small">your number one song</Rise>
            <Rise at={1}><Thumb large sources={songSources(topSong)} title={topSong.title} /></Rise>
            <Rise at={2} className="wrapped-name wrapped-name-song" data-wrapped-top-song>{topSong.title}</Rise>
            {topSong.author ? <Rise at={3} className="wrapped-big wrapped-sub wrapped-sub-line">{topSong.author}</Rise> : null}
            <Rise at={4} className="wrapped-note">{topSong.plays.toLocaleString()} play{topSong.plays === 1 ? '' : 's'}, {minutesOf(topSong.seconds).toLocaleString()} minutes</Rise>
          </>
        )
      });
    }

    // the favourites through the year: when each of them was the one you could not put down
    const curved = data.top_tracks.slice(0, 5).filter((track) => Array.isArray(track.months) && track.months.some((v) => v > 0));
    if (curved.length) {
      list.push({
        key: 'curves',
        ms: LONG_SLIDE_MS,
        body: (
          <>
            <Rise at={0} className="wrapped-small">your top songs through the year</Rise>
            <div className="wrapped-chart" data-chart="curves">
              {curved.map((track, i) => {
                const peak = track.months.indexOf(Math.max(...track.months));
                return (
                  <Rise key={track.title + track.author} at={1 + i * 0.6} className="wrapped-trow wrapped-trow-curve" data-wrapped-row>
                    <span className="wrapped-rank">{i + 1}</span>
                    <Thumb sources={songSources(track)} title={track.title} />
                    <span className="wrapped-row-text">
                      <span className="wrapped-row-name">{track.title}</span>
                      <span className="wrapped-row-sub">peaked in {MONTHS[peak]}</span>
                    </span>
                    <Spark values={track.months} />
                  </Rise>
                );
              })}
            </div>
            <Rise at={5} className="wrapped-axis wrapped-axis-spark"><span>jan</span><span>dec</span></Rise>
          </>
        )
      });
    }

    // the songs played again and again, counted by plays and not by minutes
    const repeats = Array.isArray(data.repeats) ? data.repeats.slice(0, 5) : [];
    if (repeats.length) {
      const top = repeats[0].plays;
      list.push({
        key: 'repeats',
        body: (
          <>
            <Rise at={0} className="wrapped-small">the one you could not stop playing</Rise>
            <Rise at={1} className="wrapped-huge wrapped-huge-small" data-wrapped-repeat><CountUp value={repeats[0].plays} />x</Rise>
            <Rise at={2} className="wrapped-big wrapped-sub-line">{repeats[0].title}</Rise>
            <div className="wrapped-chart" data-chart="repeats">
              {repeats.map((track, i) => (
                <Rise key={track.title + track.author} at={3 + i * 0.5} className="wrapped-trow" data-wrapped-row>
                  <span className="wrapped-rank">{i + 1}</span>
                  <Thumb sources={songSources(track)} title={track.title} />
                  <span className="wrapped-row-text">
                    <span className="wrapped-row-name">{track.title}</span>
                    <span className="wrapped-row-sub">{track.plays.toLocaleString()} plays{track.author ? ' | ' + track.author : ''}</span>
                    <span className="wrapped-trow-bar"><span style={{ width: share(track.plays, top) + '%' }} /></span>
                  </span>
                </Rise>
              ))}
            </div>
          </>
        )
      });
    }

    // the song that led each month
    const leaders = Array.isArray(data.month_leaders) ? data.month_leaders : [];
    if (leaders.some(Boolean)) {
      list.push({
        key: 'monthly',
        ms: LONG_SLIDE_MS,
        body: (
          <>
            <Rise at={0} className="wrapped-small">your song of each month</Rise>
            <div className="wrapped-chart wrapped-chart-months" data-chart="monthly">
              {leaders.map((lead, i) => (lead ? (
                <Rise key={i} at={1 + i * 0.3} className="wrapped-trow wrapped-trow-month" data-wrapped-row>
                  <span className="wrapped-rank wrapped-month-tag">{MONTHS[i].slice(0, 3)}</span>
                  <Thumb sources={songSources(lead)} title={lead.title} />
                  <span className="wrapped-row-text">
                    <span className="wrapped-row-name">{lead.title}</span>
                    {lead.author ? <span className="wrapped-row-sub">{lead.author}</span> : null}
                  </span>
                </Rise>
              ) : null))}
            </div>
          </>
        )
      });
    }

    const peakHour = data.hours.indexOf(Math.max(...data.hours));
    const peakDay = data.weekdays.indexOf(Math.max(...data.weekdays));
    if (t.seconds > 0) {
      const persona = peakHour >= 22 || peakHour < 5 ? 'night owl' : peakHour < 9 ? 'early bird' : peakHour < 17 ? 'daytime listener' : 'evening listener';
      const topHour = Math.max(1, ...data.hours);
      const topWeekday = Math.max(1, ...data.weekdays);
      list.push({
        key: 'time',
        body: (
          <>
            <Rise at={0} className="wrapped-small">you listen most at</Rise>
            <Rise at={1} className="wrapped-huge" data-wrapped-hour>{hourText(peakHour)}</Rise>
            <Rise at={2} className="wrapped-big">{persona}</Rise>
            <Rise at={3} className="wrapped-bars wrapped-bars-hours" data-chart="hours" aria-hidden="true">
              {data.hours.map((seconds, i) => (
                <span key={i} className={'wrapped-bar' + (i === peakHour ? ' wrapped-bar-top' : '')} style={{ height: Math.max(3, Math.round((seconds / topHour) * 100)) + '%' }} />
              ))}
            </Rise>
            <Rise at={3} className="wrapped-axis wrapped-axis-hours"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></Rise>
            <Rise at={4} className="wrapped-note">and most on {WEEKDAYS[peakDay]}</Rise>
            <Rise at={4} className="wrapped-bars wrapped-bars-week" data-chart="weekdays" aria-hidden="true">
              {data.weekdays.map((seconds, i) => (
                <span key={i} className={'wrapped-bar' + (i === peakDay ? ' wrapped-bar-top' : '')} style={{ height: Math.max(3, Math.round((seconds / topWeekday) * 100)) + '%' }} />
              ))}
            </Rise>
            <Rise at={4} className="wrapped-axis wrapped-axis-week"><span>sun</span><span>mon</span><span>tue</span><span>wed</span><span>thu</span><span>fri</span><span>sat</span></Rise>
          </>
        )
      });
    }

    if (data.best_day) {
      list.push({
        key: 'day',
        body: (
          <>
            <Rise at={0} className="wrapped-small">your biggest day</Rise>
            <Rise at={1} className="wrapped-name" data-wrapped-best-day>{dayText(data.best_day.day)}</Rise>
            <Rise at={2} className="wrapped-big wrapped-sub">{timeText(data.best_day.seconds)} of music</Rise>
            {data.best_streak > 1 ? <Rise at={3} className="wrapped-note">your longest streak was {data.best_streak} days in a row</Rise> : null}
          </>
        )
      });
    }

    if (Array.isArray(data.days) && data.days.length >= 365 && data.active_days > 0) {
      list.push({
        key: 'calendar',
        body: (
          <>
            <Rise at={0} className="wrapped-small">your year in days</Rise>
            <Rise at={1} className="wrapped-big" data-wrapped-active>{data.active_days.toLocaleString()} days with music</Rise>
            <Rise at={2} className="wrapped-calwrap"><Calendar days={data.days} year={data.year} /></Rise>
            <Rise at={3} className="wrapped-note">each square is a day, the brighter the more you listened</Rise>
          </>
        )
      });
    }

    const busiest = data.months.indexOf(Math.max(...data.months));
    if (t.seconds > 0) {
      const top = Math.max(1, ...data.months);
      list.push({
        key: 'month',
        body: (
          <>
            <Rise at={0} className="wrapped-small">your month</Rise>
            <Rise at={1} className="wrapped-huge wrapped-month" data-wrapped-month>{MONTHS[busiest]}</Rise>
            <Rise at={2} className="wrapped-bars" aria-hidden="true">
              {data.months.map((seconds, i) => (
                <span key={i} className={'wrapped-bar' + (i === busiest ? ' wrapped-bar-top' : '')} style={{ height: Math.max(4, Math.round((seconds / top) * 100)) + '%' }} />
              ))}
            </Rise>
            <Rise at={3} className="wrapped-note">{minutesOf(data.months[busiest]).toLocaleString()} minutes that month</Rise>
          </>
        )
      });
    }

    if (t.new_artists > 0 || t.new_tracks > 0) {
      list.push({
        key: 'new',
        body: (
          <>
            <Rise at={0} className="wrapped-small">you found</Rise>
            <Rise at={1} className="wrapped-huge"><CountUp value={t.new_artists} /></Rise>
            <Rise at={2} className="wrapped-big">new artists</Rise>
            <Rise at={3} className="wrapped-note">and {t.new_tracks.toLocaleString()} new song{t.new_tracks === 1 ? '' : 's'}</Rise>
          </>
        )
      });
    }

    // the last panel: the whole year on one page, with the pictures
    {
      const sumTracks = data.top_tracks.slice(0, 5);
      const sumArtists = data.top_artists.slice(0, 5);
      const persona = peakHour >= 22 || peakHour < 5 ? 'night owl' : peakHour < 9 ? 'early bird' : peakHour < 17 ? 'daytime listener' : 'evening listener';
      const sumTop = sumTracks.length ? sumTracks[0].seconds : 1;
      const sumArtistTop = sumArtists.length ? sumArtists[0].seconds : 1;
      const facts = [];
      if (t.tracks) facts.push([t.tracks.toLocaleString(), t.tracks === 1 ? 'song' : 'songs']);
      if (t.artists) facts.push([t.artists.toLocaleString(), t.artists === 1 ? 'artist' : 'artists']);
      if (t.seconds > 0) facts.push([MONTHS[busiest], 'busiest month']);
      if (t.seconds > 0) facts.push([hourText(peakHour), persona]);
      if (data.best_day) facts.push([timeText(data.best_day.seconds), 'on ' + dayText(data.best_day.day)]);
      if (data.best_streak > 1) facts.push([data.best_streak + ' days', 'longest streak']);
      if (Array.isArray(data.repeats) && data.repeats[0]) facts.push([data.repeats[0].plays.toLocaleString() + 'x', 'most replayed']);
      if (data.active_days > 0) facts.push([data.active_days.toLocaleString(), 'days with music']);
      list.push({
        key: 'summary',
        body: (
          <>
            <div className="wrapped-summary-head">
              <span className="wrapped-small">{data.year} wrapped</span>
              <span className="wrapped-big" data-wrapped-summary-minutes>{totalMinutes.toLocaleString()} minutes</span>
            </div>
            {topArtist ? (
              <div className="wrapped-summary-hero" data-summary-artist>
                <Thumb round sources={artistSources(topArtist)} title={topArtist.author} />
                <span className="wrapped-row-text">
                  <span className="wrapped-row-sub">top artist</span>
                  <span className="wrapped-row-name wrapped-hero-name">{topArtist.author}</span>
                </span>
              </div>
            ) : null}
            <div className="wrapped-summary-grid">
              <div className="wrapped-summary-col">
                {sumTracks.length ? <div className="wrapped-summary-label">top songs</div> : null}
                <div className="wrapped-chart wrapped-chart-summary" data-chart="summary-songs">
                  {sumTracks.map((track, i) => (
                    <div key={track.title + track.author} className="wrapped-trow" data-wrapped-row>
                      <span className="wrapped-rank">{i + 1}</span>
                      <Thumb sources={songSources(track)} title={track.title} />
                      <span className="wrapped-row-text">
                        <span className="wrapped-row-name">{track.title}</span>
                        <span className="wrapped-row-sub">{[track.author, minutesText(track.seconds)].filter(Boolean).join(' | ')}</span>
                        <span className="wrapped-trow-bar"><span style={{ width: share(track.seconds, sumTop) + '%' }} /></span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="wrapped-summary-col wrapped-summary-col-b">
                {sumArtists.length ? <div className="wrapped-summary-label">top artists</div> : null}
                <div className="wrapped-chart wrapped-chart-summary" data-chart="summary-artists">
                  {sumArtists.map((artist, i) => (
                    <div key={artist.author} className="wrapped-trow" data-wrapped-row>
                      <span className="wrapped-rank">{i + 1}</span>
                      <Thumb round sources={artistSources(artist)} title={artist.author} />
                      <span className="wrapped-row-text">
                        <span className="wrapped-row-name">{artist.author}</span>
                        <span className="wrapped-row-sub">{minutesText(artist.seconds)}</span>
                        <span className="wrapped-trow-bar"><span style={{ width: share(artist.seconds, sumArtistTop) + '%' }} /></span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="wrapped-facts" data-summary-facts>
              {facts.slice(0, 6).map(([value, label]) => (
                <span key={label + value} className="wrapped-fact"><b>{value}</b><i>{label}</i></span>
              ))}
            </div>
            <div className="wrapped-close-row">
              <Button
                variant="outline-light"
                size="sm"
                data-wrapped-done
                onClick={(event) => { event.stopPropagation(); onClose(); }}
                style={{ borderRadius: '6px' }}
              >
                close
              </Button>
            </div>
          </>
        )
      });
    }
    return list;
  }, [data, onClose, sourcesOf]);

  const swipe = useRef({ x: 0, y: 0, at: 0, active: false, done: 0 });
  const last = slides.length - 1;
  const go = useCallback((next) => setIndex((current) => Math.max(0, Math.min(last, typeof next === 'function' ? next(current) : next))), [last]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      else if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Enter') { event.preventDefault(); go((i) => i + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); go((i) => i - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  useEffect(() => {
    if (rootRef.current) rootRef.current.focus({ preventScroll: true });
  }, []);

  const palette = useMemo(() => paletteFor(index, color), [index, color]);

  if (!data || !slides.length) return null;
  const slide = slides[Math.min(index, last)];
  const swipeStart = (event) => {
    if (event.target && event.target.closest && event.target.closest('button')) return;
    swipe.current.x = event.clientX;
    swipe.current.y = event.clientY;
    swipe.current.at = Date.now();
    swipe.current.active = true;
  };
  const swipeEnd = (event) => {
    const s = swipe.current;
    if (!s.active) return;
    s.active = false;
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - s.at < 1000) {
      s.done = Date.now();
      go((i) => i + (dx < 0 ? 1 : -1));
    }
  };
  const swipeCancel = () => { swipe.current.active = false; };
  const tapGo = (target) => { if (Date.now() - swipe.current.done < 450) return; go(target); };

  return (
    <div
      ref={rootRef}
      className="wrapped-overlay"
      data-wrapped={data.year}
      data-wrapped-slide={slide.key}
      data-wrapped-index={index}
      data-wrapped-ink={palette.dark ? 'dark' : 'light'}
      role="dialog"
      aria-label={`${data.year} wrapped`}
      tabIndex={-1}
      onPointerDown={swipeStart}
      onPointerUp={swipeEnd}
      onPointerCancel={swipeCancel}
      style={{
        '--w-ink': palette.ink,
        '--w-ink-rgb': palette.inkRgb,
        '--w-accent': palette.accent,
        '--w-accent-rgb': palette.accentRgb,
        '--w-line': palette.line,
        '--w-top': palette.top,
        '--w-top-rgb': palette.topRgb,
        '--w-top-on': palette.topOn,
        '--w-panel': palette.panel,
        '--w-on': palette.on
      }}
    >
      <div className="wrapped-bg" style={{ background: palette.background }} />
      <div className="wrapped-top">
        <div className="wrapped-progress">
          {slides.map((item, i) => (
            <span key={item.key} className="wrapped-progress-seg">
              <span
                className={'wrapped-progress-fill' + (i < index ? ' wrapped-done' : '') + (i === index && i < last ? ' wrapped-running' : '') + (i === index && i === last ? ' wrapped-done' : '')}
                style={i === index && i < last ? { animationDuration: (item.ms || SLIDE_MS) + 'ms' } : undefined}
                onAnimationEnd={i === index && i < last ? () => go(index + 1) : undefined}
              />
            </span>
          ))}
        </div>
        <button type="button" className="wrapped-x" aria-label="close" data-wrapped-close onClick={onClose}>close</button>
      </div>
      <div className="wrapped-zone wrapped-zone-back" data-wrapped-back onClick={() => tapGo(index - 1)} />
      <div className="wrapped-zone wrapped-zone-next" data-wrapped-next onClick={() => tapGo(index + 1)} />
      <div className={'wrapped-slide wrapped-slide-' + slide.key} key={slide.key}>
        <div className="wrapped-card" data-wrapped-card>{slide.body}</div>
      </div>
    </div>
  );
}
