import { fetchLyrics } from './lyrics';

const respond = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => null } });

describe('instrumental only when certain', () => {
  test('an exact match (name, artist and length) that is instrumental is said so', async () => {
    const r = await fetchLyrics({ videoId: 'inst-exact-1', title: 'Quiet Piano', author: 'Somebody' }, 200, { fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/get')) return respond(200, { trackName: 'Quiet Piano', artistName: 'Somebody', duration: 200, instrumental: true });
      return respond(200, []);
    } });
    expect(r.kind).toBe('instrumental');
  });

  test('a search hit that is instrumental but by another artist is not said (the standard "not found" instead)', async () => {
    const r = await fetchLyrics({ videoId: 'inst-other-2', title: 'Quiet Piano', author: 'Somebody' }, 200, { fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/get')) return respond(404, null);
      return respond(200, [{ trackName: 'Quiet Piano', artistName: 'Other Band', duration: 200, instrumental: true }]);
    } });
    expect(r.kind).toBe('none');
  });

  test('an exact match with a different length is not said to be instrumental', async () => {
    const r = await fetchLyrics({ videoId: 'inst-length-3', title: 'Quiet Piano', author: 'Somebody' }, 200, { fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/get')) return respond(200, { trackName: 'Quiet Piano', artistName: 'Somebody', duration: 260, instrumental: true });
      return respond(200, []);
    } });
    expect(r.kind).not.toBe('instrumental');
  });
});
