// a made up year of listening in the shape /api/wrapped answers with, so the wrapped story can be looked at without waiting for january 1st
// or for the club server to have the route. the numbers are invented. when this device knows enough songs (playlists, queue) the song and
// artist names are the person's own, so the pictures are real; otherwise the names are invented ones and the pictures are tiles.
// App.js opens it when the version in the settings is tapped five times quickly

const INVENTED = [
  ['Glass Hours', 'Neon Harbor'], ['Midnight Rental', 'Paper Satellites'], ['Slow Orbit', 'Neon Harbor'], ['Cheap Sunlight', 'Low Tide Club'],
  ['Paper Planes at 3am', 'Velvet Static'], ['Salt Water Radio', 'Mirror Lake'], ['Third Floor Weather', 'Low Tide Club'],
  ['Dial Tone Lullaby', 'Velvet Static'], ['Afterglow Motel', 'Paper Satellites'], ['Soft Machines', 'Mirror Lake'],
  ['Cold Open', 'Neon Harbor'], ['Tin Roof', 'Mirror Lake']
];
const INVENTED_ARTISTS = ['Neon Harbor', 'Paper Satellites', 'Low Tide Club', 'Velvet Static', 'Mirror Lake', 'Night Shift Choir', 'Copper Valley', 'Hollow Parade', 'Static Garden', 'Late Bloom'];

// the same numbers every time for one year
const seeded = (seed) => {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
};

export default function demoWrapped(now = new Date(), known = []) {
  const year = now.getFullYear();
  const rand = seeded(year * 7919 + 17);
  const from = Date.UTC(year, 0, 1) / 1000;
  const to = Date.UTC(year + 1, 0, 1) / 1000;
  const dayCount = Math.round((to - from) / 86400);

  // every day of the year, busier at weekends, with one long run of days in a row and one big day
  const days = [];
  const months = new Array(12).fill(0);
  const weekdays = new Array(7).fill(0);
  for (let i = 0; i < dayCount; i += 1) {
    const date = new Date(Date.UTC(year, 0, 1 + i));
    const dow = date.getUTCDay();
    const active = (i >= 200 && i <= 222) || rand() < (dow === 0 || dow === 6 ? 0.9 : 0.74);
    let seconds = active ? Math.round((1500 + rand() * 8500) * (dow === 0 || dow === 6 ? 1.4 : 1)) : 0;
    if (i === 340) seconds = 29400;
    days.push(seconds);
    months[date.getUTCMonth()] += seconds;
    weekdays[dow] += seconds;
  }
  const total = days.reduce((a, b) => a + b, 0);
  const hourShape = [4200, 3600, 2100, 900, 300, 200, 400, 900, 1500, 1800, 2200, 2600, 3000, 3300, 3100, 3600, 4400, 5200, 6000, 6800, 7400, 6900, 6100, 5300];
  const hourSum = hourShape.reduce((a, b) => a + b, 0);
  const hours = hourShape.map((v) => Math.round((v / hourSum) * total));

  let bestIndex = 0; let streak = 0; let bestStreak = 0;
  days.forEach((seconds, i) => {
    if (seconds > days[bestIndex]) bestIndex = i;
    streak = seconds > 0 ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
  });

  // the songs: the person's own when there are enough, else invented ones
  const pool = [];
  const step = known.length >= 10 ? known.length / 10 : 1;
  for (let i = 0; i < Math.min(10, known.length); i += 1) {
    const track = known[Math.floor(i * step)];
    pool.push({ title: track.title, author: track.author, video_id: track.videoId || '' });
  }
  for (let i = 0; pool.length < 10; i += 1) pool.push({ title: INVENTED[i % INVENTED.length][0], author: INVENTED[i % INVENTED.length][1], video_id: '' });

  const topTracks = pool.map((track, i) => {
    const seconds = Math.round(total * 0.0145 * Math.pow(0.84, i));
    const peak = (i * 5 + 2) % 12;
    const width = 1.3 + (i % 3) * 0.6;
    const weights = months.map((_, m) => Math.exp(-Math.pow(Math.min(Math.abs(m - peak), 12 - Math.abs(m - peak)), 2) / (2 * width * width)) * (0.85 + rand() * 0.3));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    return { ...track, seconds, plays: Math.max(2, Math.round(seconds / 245)), months: weights.map((w) => Math.round((w / weightSum) * seconds)) };
  });

  const monthLeaders = months.map((_, m) => {
    let best = topTracks[0];
    topTracks.forEach((track) => { if (track.months[m] > best.months[m]) best = track; });
    return { title: best.title, author: best.author, seconds: best.months[m], video_id: best.video_id };
  });

  // artists: the authors of those songs first, then invented ones
  const artists = [];
  topTracks.forEach((track) => {
    if (track.author && !artists.find((a) => a.author.toLowerCase() === track.author.toLowerCase())) artists.push({ author: track.author, top_title: track.title, video_id: track.video_id });
  });
  for (let i = 0; artists.length < 10; i += 1) {
    if (!artists.find((a) => a.author === INVENTED_ARTISTS[i % INVENTED_ARTISTS.length])) artists.push({ author: INVENTED_ARTISTS[i % INVENTED_ARTISTS.length], top_title: '', video_id: '' });
    if (i > 40) break;
  }
  const topArtists = artists.slice(0, 10).map((artist, i) => {
    const seconds = Math.round(total * 0.043 * Math.pow(0.86, i));
    return { ...artist, seconds, plays: Math.round(seconds / 250), tracks: Math.max(2, 31 - i * 3) };
  });

  const repeats = topTracks
    .map((track) => ({ title: track.title, author: track.author, seconds: track.seconds, video_id: track.video_id, plays: Math.max(2, Math.round((track.seconds / 245) * (0.8 + rand() * 0.8))) }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 8);

  return {
    year,
    from,
    to,
    complete: true,
    totals: {
      seconds: total,
      plays: Math.round(total / 230),
      tracks: 612,
      artists: 148,
      previous_seconds: Math.round(total * 0.72),
      new_tracks: 427,
      new_artists: 96
    },
    top_tracks: topTracks,
    top_artists: topArtists,
    repeats,
    month_leaders: monthLeaders,
    hours,
    weekdays,
    months,
    days,
    active_days: days.filter((s) => s > 0).length,
    best_streak: bestStreak,
    best_day: { day: new Date(Date.UTC(year, 0, 1 + bestIndex)).toISOString().slice(0, 10), seconds: days[bestIndex] },
    longest: { title: topTracks[0].title, author: topTracks[0].author, seconds: 3720 },
    first: { title: topTracks[3].title, author: topTracks[3].author, at: from + 3600 * 20 }
  };
}
