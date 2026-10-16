// the title, artist, album and cover that an audio file carries about itself. mp3 (id3v2, id3v1), m4a/mp4/aac-in-mp4
// (the ilst atoms), flac and ogg/opus (vorbis comments) are read here; anything else, or a file with no tags, falls
// back to the file name. it only needs a Blob (a File is one), it reads just the parts it needs, and it never throws:
// a file it cannot read gives back the file name and nothing else

const ascii = (bytes, from, to) => {
  let out = '';
  for (let i = from; i < to && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

const u32 = (b, o) => ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
const u32le = (b, o) => ((b[o + 3] * 0x1000000) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o])) >>> 0;
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

const bytesOf = async (blob, from, to) => new Uint8Array(await blob.slice(from, Math.max(from, to)).arrayBuffer());

// text in the four encodings id3 uses: 0 latin1, 1 utf-16 with a bom, 2 utf-16 big endian, 3 utf-8
function decodeText(bytes, encoding) {
  try {
    if (encoding === 1 || encoding === 2) {
      let big = encoding === 2;
      let start = 0;
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { big = false; start = 2; }
      else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { big = true; start = 2; }
      return new TextDecoder(big ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(start));
    }
    if (encoding === 3) return new TextDecoder('utf-8').decode(bytes);
    return new TextDecoder('windows-1252').decode(bytes);
  } catch (e) {
    return ascii(bytes, 0, bytes.length);
  }
}

const clean = (text) => String(text || '').split('\u0000').map((part) => part.trim()).filter(Boolean).join(', ');

// where the terminator of a string in a given encoding is (two zero bytes for utf-16), or the end
function terminatorAt(bytes, from, encoding) {
  const wide = encoding === 1 || encoding === 2;
  for (let i = from; i < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) return i;
  }
  return bytes.length;
}

// ---- mp3: id3v2 at the start, id3v1 in the last 128 bytes ---------------------
async function readId3v2(file) {
  const head = await bytesOf(file, 0, 10);
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return null;
  const version = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  const buf = await bytesOf(file, 10, 10 + Math.min(size, 16 * 1024 * 1024));
  const out = {};
  let pos = 0;
  if (flags & 0x40) pos = version === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4;
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  while (pos + headerLength <= buf.length) {
    const id = ascii(buf, pos, pos + idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let frameSize;
    if (version === 2) frameSize = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    else if (version === 4) frameSize = syncsafe(buf, pos + 4);
    else frameSize = u32(buf, pos + 4);
    const body = buf.subarray(pos + headerLength, pos + headerLength + frameSize);
    pos += headerLength + frameSize;
    if (!frameSize) continue;
    if (body.length < frameSize) break;
    const text = () => clean(decodeText(body.subarray(1), body[0]));
    if (id === 'TIT2' || id === 'TT2') out.title = out.title || text();
    else if (id === 'TPE1' || id === 'TP1') out.artist = out.artist || text();
    else if ((id === 'TPE2' || id === 'TP2') && !out.albumArtist) out.albumArtist = text();
    else if (id === 'TALB' || id === 'TAL') out.album = out.album || text();
    else if (id === 'TLEN' || id === 'TLE') {
      const ms = Number(text());
      if (Number.isFinite(ms) && ms > 0) out.durationMs = ms;
    } else if ((id === 'APIC' || id === 'PIC') && !out.cover && body.length > 8) {
      const encoding = body[0];
      let mime;
      let at;
      if (id === 'PIC') {
        mime = /^(jpg|jpeg)$/i.test(ascii(body, 1, 4)) ? 'image/jpeg' : 'image/png';
        at = 4;
      } else {
        const mimeEnd = terminatorAt(body, 1, 0);
        mime = ascii(body, 1, mimeEnd) || 'image/jpeg';
        at = mimeEnd + 1;
      }
      at += 1; // the picture type
      const descEnd = terminatorAt(body, at, encoding);
      at = descEnd + (encoding === 1 || encoding === 2 ? 2 : 1);
      if (at < body.length) out.cover = { bytes: body.slice(at), mime: mime.includes('/') ? mime : 'image/' + mime };
    }
  }
  return out;
}

async function readId3v1(file) {
  if (file.size < 128) return null;
  const tail = await bytesOf(file, file.size - 128, file.size);
  if (ascii(tail, 0, 3) !== 'TAG') return null;
  const field = (from, to) => clean(decodeText(tail.subarray(from, to), 0));
  return { title: field(3, 33), artist: field(33, 63), album: field(63, 93) };
}

// ---- mp4 / m4a: moov > udta > meta > ilst ------------------------------------
function* boxes(buf, from, to) {
  let pos = from;
  while (pos + 8 <= to) {
    let size = u32(buf, pos);
    const type = ascii(buf, pos + 4, pos + 8);
    let header = 8;
    if (size === 1 && pos + 16 <= to) { size = u32(buf, pos + 8) * 0x100000000 + u32(buf, pos + 12); header = 16; }
    else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) size = Math.max(header, to - pos);
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function parseMoov(buf) {
  const out = {};
  for (const box of boxes(buf, 0, buf.length)) {
    if (box.type === 'mvhd') {
      const version = buf[box.start];
      const scaleAt = box.start + (version === 1 ? 20 : 12);
      const timescale = u32(buf, scaleAt);
      const duration = version === 1 ? u32(buf, scaleAt + 4) * 0x100000000 + u32(buf, scaleAt + 8) : u32(buf, scaleAt + 4);
      if (timescale > 0 && duration > 0) out.durationMs = Math.round((duration / timescale) * 1000);
    } else if (box.type === 'udta') {
      for (const meta of boxes(buf, box.start, box.end)) {
        if (meta.type !== 'meta') continue;
        for (const list of boxes(buf, meta.start + 4, meta.end)) {
          if (list.type !== 'ilst') continue;
          for (const item of boxes(buf, list.start, list.end)) {
            for (const data of boxes(buf, item.start, item.end)) {
              if (data.type !== 'data') continue;
              const kind = u32(buf, data.start) & 0xffffff;
              const payload = buf.subarray(data.start + 8, data.end);
              if (item.type === '©nam') out.title = clean(decodeText(payload, 3));
              else if (item.type === '©ART') out.artist = clean(decodeText(payload, 3));
              else if (item.type === 'aART') out.albumArtist = clean(decodeText(payload, 3));
              else if (item.type === '©alb') out.album = clean(decodeText(payload, 3));
              else if (item.type === 'covr' && !out.cover && payload.length) out.cover = { bytes: payload.slice(), mime: kind === 14 ? 'image/png' : 'image/jpeg' };
            }
          }
        }
      }
    }
  }
  return out;
}

async function readMp4(file) {
  const head = await bytesOf(file, 0, 12);
  if (head.length < 12 || ascii(head, 4, 8) !== 'ftyp') return null;
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = await bytesOf(file, pos, pos + 16);
    let size = u32(h, 0);
    const type = ascii(h, 4, 8);
    let header = 8;
    if (size === 1) { size = u32(h, 8) * 0x100000000 + u32(h, 12); header = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < header) return null;
    if (type === 'moov') {
      if (size - header > 64 * 1024 * 1024) return null;
      return parseMoov(await bytesOf(file, pos + header, pos + size));
    }
    pos += size;
  }
  return null;
}

// ---- vorbis comments (flac blocks, ogg vorbis, opus) --------------------------
function parseVorbisComments(buf, at) {
  const out = {};
  try {
    const vendor = u32le(buf, at);
    let pos = at + 4 + vendor;
    const count = u32le(buf, pos);
    pos += 4;
    for (let i = 0; i < count && pos + 4 <= buf.length; i += 1) {
      const length = u32le(buf, pos);
      pos += 4;
      if (pos + length > buf.length) break;
      const entry = decodeText(buf.subarray(pos, pos + length), 3);
      pos += length;
      const eq = entry.indexOf('=');
      if (eq < 1) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = clean(entry.slice(eq + 1));
      if (!value) continue;
      if (key === 'TITLE' && !out.title) out.title = value;
      else if (key === 'ARTIST' && !out.artist) out.artist = value;
      else if (key === 'ALBUMARTIST' && !out.albumArtist) out.albumArtist = value;
      else if (key === 'ALBUM' && !out.album) out.album = value;
    }
  } catch (e) { /* what was read stays */ }
  return out;
}

async function readFlac(file) {
  const head = await bytesOf(file, 0, 4);
  if (ascii(head, 0, 4) !== 'fLaC') return null;
  const out = {};
  let pos = 4;
  for (let guard = 0; guard < 64 && pos + 4 <= file.size; guard += 1) {
    const h = await bytesOf(file, pos, pos + 4);
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const length = (h[1] << 16) | (h[2] << 8) | h[3];
    pos += 4;
    if (type === 0 && length >= 18) {
      const b = await bytesOf(file, pos, pos + 18);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const totalSamples = (b[13] & 0x0f) * 0x100000000 + u32(b, 14);
      if (sampleRate > 0 && totalSamples > 0) out.durationMs = Math.round((totalSamples / sampleRate) * 1000);
    } else if (type === 4 && length < 4 * 1024 * 1024) {
      Object.assign(out, parseVorbisComments(await bytesOf(file, pos, pos + length), 0));
    } else if (type === 6 && !out.cover && length < 16 * 1024 * 1024) {
      const b = await bytesOf(file, pos, pos + length);
      let at = 4;
      const mimeLength = u32(b, at);
      const mime = ascii(b, at + 4, at + 4 + mimeLength);
      at += 4 + mimeLength;
      const descLength = u32(b, at);
      at += 4 + descLength + 16;
      const dataLength = u32(b, at);
      at += 4;
      if (dataLength > 0 && at + dataLength <= b.length) out.cover = { bytes: b.slice(at, at + dataLength), mime: mime || 'image/jpeg' };
    }
    pos += length;
    if (last) break;
  }
  return out;
}

async function readOgg(file) {
  const head = await bytesOf(file, 0, 4);
  if (ascii(head, 0, 4) !== 'OggS') return null;
  const buf = await bytesOf(file, 0, 256 * 1024);
  const text = ascii(buf, 0, buf.length);
  let at = text.indexOf('OpusTags');
  if (at >= 0) return parseVorbisComments(buf, at + 8);
  at = text.indexOf('\u0003vorbis');
  if (at >= 0) return parseVorbisComments(buf, at + 7);
  return {};
}

// ---- the name of the file, when it says more than nothing ----------------------
export function tagsFromFileName(name) {
  const bare = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  const base = bare.replace(/_/g, ' ').trim();
  const stripped = bare.replace(/^\d{1,3}\s*[-._)]\s*/, '').replace(/_/g, ' ').trim() || base;
  const split = /^(.+?)\s+-\s+(.+)$/.exec(stripped);
  if (split) return { artist: split[1].trim(), title: split[2].trim() };
  return { title: stripped || 'untitled', artist: '' };
}

// {title, artist, album, durationMs (0 when the file does not say), cover: {bytes, mime} | null}
export async function readAudioTags(file) {
  let found = null;
  try {
    found = (await readMp4(file)) || (await readFlac(file)) || (await readOgg(file)) || (await readId3v2(file));
    if (!found || (!found.title && !found.artist)) {
      const v1 = await readId3v1(file);
      if (v1 && (v1.title || v1.artist)) found = { ...(found || {}), ...v1 };
    }
  } catch (e) {
    found = null;
  }
  const fromName = tagsFromFileName(file && file.name);
  const tags = found || {};
  return {
    title: tags.title || fromName.title,
    artist: tags.artist || tags.albumArtist || fromName.artist || '',
    album: tags.album || '',
    durationMs: Number(tags.durationMs) || 0,
    cover: tags.cover || null
  };
}
