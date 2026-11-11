# Shibenchi's music player

I built this on top of a lot of other open source music players. I wanted the basics you'd expect (search, a queue, playlists) and then all the things I kept wishing a player had while I was using it every day. It's a windows app, with an android app for the phone that plays the same way.

---

## about the versions

The numbers restart at 1.3.1 on purpose. I picked up older code and started a fresh numbering instead of pretending it's a clean line from 1.0.0, so if you remember an older version, you didn't miss a pile of releases.

It used to run in your browser, which was annoying to use and annoying to support. And then it was a desktop ""app"" (electron wrapper). It's a real, native desktop app now. The windows build is an MSI, installed like any other program. The android build is an APK you install directly, since it isn't on the play store (the audio side works the way it does, and the store doesn't like that).

---

## what's in it

**listening**
- search for a song, or paste a youtube link (a single video or a whole playlist) and it pulls the tracks in.
- a queue you can search, reorder, shuffle and repeat. recent changes are kept, so a song you removed or a playlist you deleted can be put back.
- playlists. build one from scratch, save your queue as one, or import and export them.
- your own audio files (mp3, flac, m4a) can go in the queue and in playlists too.
- synced lyrics for a lot of songs, from the lrclib database. when a song only has plain lyrics, they show as text, since there's no timing to follow.
- downloads go into a folder you pick, with the best audio available and the thumbnail embedded. no save dialog every time.
- on the phone you can save songs to the device and play them with no connection. on a pc you'd do this by just utilizing downloads.

**looks**
- an equalizer with presets and per-band sliders.
- a theme color that tints the whole app. there's a simple hue bar, or a full picker with hue, saturation and lightness.
- background visualizers that react to the music and follow the theme color. there are a few styles, or you can turn them off if you'd rather keep it plain.
- ctrl + h hides everything except the visualizer. press it again to bring the interface back.
- a miniplayer on the computer. it pops up when you minimize or click away from the main window, stays on top, and you can drag it wherever you want.
- on the phone: a home screen widget, a media notification, a floating miniplayer and a live wallpaper.

**with other people**
- friends, private messages and rooms where you listen together. messages are end to end encrypted. these run on my server so they only work while it's up. everything else works without it.
- a "wrapped" at the end of the year, and listening stats.

**other bits**
- discord rich presence, so people can see what you're playing.
- the app can update its screens (visual side) on its own, so most changes reach you without reinstalling. some changes still need a new installer, where the app will automatically download and update itself using the most recent one on the github.

---

## installing

**windows**
1. grab the latest `.msi` from the [releases page](../../releases)
2. run it

**android**
1. grab the `.apk` from the same releases page
2. open it on your phone and allow installs from that source when it asks

Node and cloning is only for people working on the source (below).

Right now this is windows and android only, I don't have a mac to build or test on, so a mac build is something I'm still working toward. no promises on timing, but it isn't abandoned. if you're on a mac and want to help test when it's ready, reach out (contact info at the bottom).

---

## running from source (yap)

You don't need any of this to use the app. This is only if you want to poke at the code or build it yourself;

```bash
git clone https://github.com/shibenchi/Shibenchis-music-player
cd Shibenchis-music-player
npm install
npm run dev
```

| command | what it does |
|---|---|
| `npm run dev` | frontend and backend together, for local development |
| `npm run server` | just the backend, port 3001 |
| `npm run helper` | just the local yt-dlp and ffmpeg helper, port 3002 |
| `npm run react-start` | just the frontend, port 3000 |
| `npm run build` | production frontend build |
| `npm run desktop-dev` | the native app shell, running against the dev stack |
| `npm run desktop-build` | builds the installable app (an MSI on windows) |
| `npm run install:clean` | removes and reinstalls dependencies |
| `npm run repair:native` | fixes better-sqlite3 when it falls out of sync with your node version |

**you'll need:** Node.js 18 or newer. If you're building the desktop app (not just running the dev servers), you also need Rust and Tauri's platform prerequisites: https://tauri.app/start/prerequisites/

When you run from source, the backend runs on your own machine, so friends, messages and rooms work against your local server.

### dev ports

| port | what's on it |
|---|---|
| 3000 | frontend (dev only) |
| 3001 | backend api |
| 3002 | local yt-dlp and ffmpeg helper |
| `/smp-ws` on 3001 | websocket endpoint |

---

## troubleshooting

**the app won't open after installing:** run the installer again. if it still won't launch, check `%APPDATA%\com.shibenchi.musicplayer\rust_debug.log`, it logs most of what happens.

**"port already in use" (only when running from source):** something else on your machine is using 3000, 3001 or 3002. close it and try again.

**something breaks when building from source:** run `npm run install:clean`, then `npm run repair:native` if the error is about a native module.

---

## contact

bugs, questions, whatever. please reach out, I don't bite.

- Discord: **shibenchi**
- Email: **golden.boy.sanirya@gmail.com**
