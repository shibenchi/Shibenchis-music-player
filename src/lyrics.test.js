import { cleanArtist, cleanTitle, fetchLyrics, lineIndexAt, lyricsDurationFit, parseLrc, titlePieces } from './lyrics';
import { lyricsDurationForTrack, lyricsLook, LYRICS_ERROR_MESSAGE, NO_LYRICS_MESSAGE } from './LyricsMode';

describe('lyrics metadata helpers', () => {
  test('removes upload noise while preserving the song title', () => {
    expect(cleanTitle('Nas - The World Is Yours (Official Video)')).toBe('Nas - The World Is Yours');
    expect(cleanArtist('NasVEVO')).toBe('Nas');
  });

  test('puts the song-name portion before artist and album hints', () => {
    expect(titlePieces('Illmatic - 10 - Nas - It Ain\'t Hard to Tell').pieces[0]).toBe('It Ain\'t Hard to Tell');
  });

  test('keeps lyrics black-and-white for a bright green theme', () => {
    expect(lyricsLook({ r: 50, g: 255, b: 50 })).toMatchObject({ ink: '#fff', base: 'rgb(0, 0, 0)', dark: true });
    expect(lyricsLook({ r: 25, g: 25, b: 25 })).toMatchObject({ ink: '#fff', base: 'rgb(0, 0, 0)', dark: true });
  });

  test('does not reuse the previous song duration while lyrics stay open across track changes', () => {
    const audio = { duration: 214, dataset: { trackVideoId: 'new-track', loadedTrackVideoId: 'old-track' } };

    expect(lyricsDurationForTrack({ videoId: 'new-track' }, audio, 214)).toBe(0);
    expect(lyricsDurationForTrack({ videoId: 'new-track', durationMs: 188000 }, audio, 214)).toBe(188);
    audio.dataset.loadedTrackVideoId = 'new-track';
    expect(lyricsDurationForTrack({ videoId: 'new-track' }, audio, 0)).toBe(214);
  });

  test('renders lyric lookup errors in lowercase', () => {
    expect(LYRICS_ERROR_MESSAGE).toBe('could not load lyrics');
  });

  test('rejects lyrics returned for a different Sinatra song', async () => {
    const wrongRecord = {
      artistName: 'Frank Sinatra',
      trackName: 'My Way',
      duration: 210,
      syncedLyrics: '[00:01.00]wrong song'
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => wrongRecord
    }));

    const result = await fetchLyrics({
      videoId: 'sinatra-wrong-lyrics-test',
      title: 'Frank Sinatra - The World We Knew (Over and Over)',
      author: 'Frank Sinatra'
    }, 210, { fetch: fetchImpl });

    expect(result.kind).toBe('none');
  });

  test('does not use a different song for the Siesta upload', async () => {
    const wrongRecord = {
      artistName: 'Samsa',
      trackName: 'Another Song',
      duration: 190,
      syncedLyrics: '[00:01.00]wrong song'
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => wrongRecord
    }));

    const result = await fetchLyrics({
      videoId: 'siesta-wrong-lyrics-test',
      title: 'Siesta (samsa x dismissedfit)',
      author: 'samsa'
    }, 190, { fetch: fetchImpl });

    expect(result.kind).toBe('none');
  });

  test('rejects a title match when the returned artist is different', async () => {
    const wrongRecord = {
      artistName: 'Another Artist',
      trackName: 'Siesta',
      duration: 190,
      syncedLyrics: '[00:01.00]wrong artist lyrics'
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => wrongRecord
    }));

    const result = await fetchLyrics({
      videoId: 'siesta-wrong-artist-test',
      title: 'Siesta',
      author: 'samsa'
    }, 190, { fetch: fetchImpl });

    expect(result.kind).toBe('none');
  });

  test('rejects the shorter Bless You recording when its lyric timing does not cover the track', () => {
    const fit = lyricsDurationFit({
      duration: 154,
      lines: [{ t: 4, text: 'first' }, { t: 112, text: 'last line of the short version' }]
    }, 190);

    expect(fit.matches).toBe(false);
  });

  test('uses the exact record duration stored in lyric metadata', () => {
    const fit = lyricsDurationFit({ identity: { duration: 154 }, lines: [{ t: 4 }, { t: 148 }] }, 190);

    expect(fit.matches).toBe(false);
  });

  test('chooses the full Bless You recording when search also returns a short alternate', async () => {
    const shortVersion = {
      artistName: 'The Chords',
      trackName: 'Bless You',
      duration: 154,
      syncedLyrics: '[00:04.00]short version\n[01:52.00]early ending'
    };
    const fullVersion = {
      artistName: 'The Chords',
      trackName: 'Bless You',
      duration: 190,
      syncedLyrics: '[00:05.00]correct version\n[02:55.00]full length ending'
    };
    const fetchImpl = jest.fn(async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname.endsWith('/get')) {
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => requestUrl.searchParams.get('artist_name') === 'The Chords' ? shortVersion : null
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => [shortVersion, fullVersion]
      };
    });

    const result = await fetchLyrics({
      videoId: 'bless-you-version-match-test',
      title: 'Bless You - The Chords',
      author: 'The Chords'
    }, 190, { fetch: fetchImpl });

    expect(result.kind).toBe('synced');
    expect(result.lines[0].text).toBe('correct version');
  });

  test('uses the requested copy when lyrics are unavailable', () => {
    expect(NO_LYRICS_MESSAGE).toBe("couldn't find lyrics for this song yet. matching gets better with every update");
    expect(NO_LYRICS_MESSAGE).toBe(NO_LYRICS_MESSAGE.toLowerCase());
  });
});

describe('LRC timing', () => {
  test('expands repeated timestamps and applies the file offset', () => {
    const parsed = parseLrc('[offset:500]\n[ar:Artist]\n[00:01.20][00:02.30]first <00:01.50> line');

    expect(parsed.offset).toBe(0.5);
    expect(parsed.lines).toEqual([
      { t: 1.7, text: 'first line' },
      { t: 2.8, text: 'first line' }
    ]);
  });

  test('selects the most recent line and returns -1 before the first', () => {
    const lines = [{ t: 2, text: 'one' }, { t: 5, text: 'two' }];

    expect(lineIndexAt(lines, 1.7, 0)).toBe(-1);
    expect(lineIndexAt(lines, 4.9, 0)).toBe(0);
    expect(lineIndexAt(lines, 5, 0)).toBe(1);
  });
});