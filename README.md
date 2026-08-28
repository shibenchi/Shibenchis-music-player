# Shibenchis-music-player
This is the public build of the music player I've been developing for a while. I'll flesh it out later, but for now I'll just put the installer. 

# Shibenchi's music player

I built this because I didn't want to keep paying for Spotify or YouTube Premium, and every other free music player out there either got discontinued or had its good features ripped out. So this is what I came up with. Search, queue, playlists, downloads, all in one place, with no required subscription or ads.

---

## about this new version, 1.3.1

Quick heads up on the version number; if you remember an older version of this, no, you didn't miss a bunch of releases between then and now. I'm running this off older code I picked back up, so I started a fresh numbering scheme instead of pretending it's a clean continuation from 1.0.0. Easier for me to just call it 1.3.1 and move on.

If you remember, this used to run through your browser. That was pretty archaic and honestly kind of a pain, sorry about that. It's a real native desktop app now. You can install it with an actual **MSI installer** like any other windows program, no terminal, no browser tab, no batch files to babysit. It's also just faster this way.

What changed:

- **native app** - installs and runs like a normal windows program now
- **miniplayer** - pops up on its own when you minimize or click away from the main window. small, always-on-top, draggable, basic controls. built this specifically because I wanted something out of the way I could glance at instead of tabbing back into the full window every time
- everything from before - search, queue, playlists, downloads, EQ, theme color, background visualizers have been optimized and improved
- a bunch of bug fixes I won't bore you with in the readme 
- **social features (friends, DMs, collab playlists etc) are out for now** - they depended on a shared backend that isn't running anymore. the code's still in there, it's just not reachable, so I turned it off instead of pushing something broken

---

## installing

1. grab the latest `.msi` from the [releases page](../../releases)
2. run it
3. that's it


Right now this is **windows only**. I don't own a mac myself, so a mac build is something I'm working through. No promises on timing, but it's not abandoned. If you're on a mac and want to help test whenever that's ready, hit me up (contact info at the bottom).

---

## what's actually in it

- search - type a song name, or drop in a youtube link (single video or a whole playlist) and it pulls it straight in
- queue - click a result to add it, drag to reorder, shuffle/repeat/prev/next all work the way you'd expect
- playlists - save your current queue as one, or build one from scratch
- downloads - grabs the highest quality audio available, embeds the thumbnail, saves wherever you point it (no more per-download "save as" dialog, that used to drive me nuts)
- a real equalizer, plus a theme color that tints basically the entire app
- a handful of audio-reactive background visualizer styles, or just turn them off if you'd rather keep it plain
- the miniplayer mentioned above
- everything persists locally - queue, downloads, playlists all survive closing and reopening the app

## running from source

You don't need any of this to just use the app this is only if you want to poke at the code or build it yourself.

```bash
git clone https://github.com/shibenchi/Shibenchis-music-player
cd Shibenchis-music-player
npm install
npm run dev
```

| command | what it does |
|---|---|
| `npm run dev` | frontend + backend together, for local dev |
| `npm run server` | just the backend, port 3001 |
| `npm run helper` | just the local yt-dlp/ffmpeg helper, port 3002 |
| `npm run react-start` | just the frontend, port 3000 |
| `npm run build` | production frontend build |
| `npm run desktop-dev` | run the actual native app shell against the dev stack |
| `npm run desktop-build` | build the real installable app (msi on windows) |
| `npm run install:clean` | nuke and reinstall dependencies |
| `npm run repair:native` | fixes better-sqlite3 if it gets out of sync with your node version |

**you'll need:** Node.js 18+, and if you're building the actual desktop app (not just running the dev servers), Rust plus Tauri's platform prerequisites, see https://tauri.app/start/prerequisites/

### dev ports

| port | what's on it |
|---|---|
| 3000 | frontend (dev only) |
| 3001 | backend api, also what the installed app itself talks to |
| 3002 | local yt-dlp/ffmpeg helper |
| `/smp-ws` on 3001 | websocket endpoint |

---

## troubleshooting

**app won't open after installing** - try running the installer again. if it still won't launch, check `%APPDATA%\com.shibenchi.musicplayer\rust_debug.log`, it logs pretty much everything.

**"port already in use" (only if you're running from source)** - something else on your machine already has 3000/3001/3002. close it, try again.

**something's broken building from source** - `npm run install:clean`, then `npm run repair:native` if it's specifically a native-module complaint.

---

## contact

bugs, questions, whatever it is, PLEASE reach out, I don't bite.

- Discord: **shibenchi**
- Email: **golden.boy.sanirya@gmail.com**
