# Lyrics Engine

<p align="center">
  <b>A lightweight and modular lyrics engine for Node.js</b>
  <br>
  LRC Parsing · Multi-Provider · Caching · Validation · Realtime Lyrics
</p>

<p align="center">
  <a href="https://github.com/myname31/lyrics">
    <img src="https://img.shields.io/github/stars/myname31/lyrics?style=flat-square" alt="GitHub Stars">
  </a>
  <a href="https://github.com/myname31/lyrics/commits/main">
    <img src="https://img.shields.io/github/last-commit/myname31/lyrics?style=flat-square" alt="Last Commit">
  </a>
  <a href="https://github.com/myname31/lyrics/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/myname31/lyrics?style=flat-square" alt="License">
  </a>
</p>

---

## ✨ Features

* 🎵 LRC parser for timestamped lyrics
* 🔎 Multi-provider lyrics fetching
* ⚡ LRCLIB support
* 🌐 NetEase provider
* 🕸️ Optional scraping fallback
* 🎯 Lyrics metadata matching and validation
* 💾 Built-in lyrics caching
* ♻️ Concurrent request deduplication
* 🔄 Retry and provider failure handling
* ⏱️ Configurable request timeouts
* 🎚️ Configurable lyrics synchronization offset
* 📦 ESM and CommonJS support
* 💬 Realtime lyrics runner for Telegram
* 🔁 Automatic track-change handling
* 🗄️ Optional MongoDB cache integration

---

## 📥 Installation

Clone the repository:

```bash
git clone https://github.com/myname31/lyrics.git
cd lyrics
```

Install dependencies:

```bash
npm install
```

The project is designed to be used directly from the repository rather than published as an npm package.

---

## 🚀 Usage

### ESM

```js
import {
  getLyrics
} from './index.js';

const lyrics = await getLyrics({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});

console.log(lyrics);
```

### CommonJS

```js
const {
  getLyrics
} = require('./index.cjs');

const lyrics = await getLyrics({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});

console.log(lyrics);
```

---

## 🎼 LRC Parser

Parse raw LRC lyrics into timestamped lines:

```js
import { parseLrc } from './index.js';

const lines = parseLrc(`
[00:12.34]First line
[00:17.50]Second line
[00:21.80]Third line
`);

console.log(lines);
```

Output:

```js
[
  { time: 12.34, text: 'First line' },
  { time: 17.5, text: 'Second line' },
  { time: 21.8, text: 'Third line' }
]
```

---

## 🔍 Fetch Lyrics

Fetch lyrics using track metadata:

```js
const lyrics = await getLyrics({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});
```

The lyrics service automatically handles:

* Provider selection
* Search fallback
* Metadata matching
* Cache lookup
* Request deduplication
* Retry handling

---

## 🔄 Refresh Lyrics

Force a fresh lyrics lookup:

```js
const lyrics = await refreshLyrics({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});
```

---

## ⚡ Prefetch Lyrics

Lyrics can be prefetched before they are needed:

```js
await prefetchLyrics({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});
```

This can be useful when preparing lyrics for an upcoming track.

---

## 🔎 Provider Architecture

The engine uses multiple lyrics providers:

```text
                  getLyrics()
                       │
                       ▼
              ┌────────────────┐
              │ Provider Chain │
              └───────┬────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     LRCLIB        NetEase       Scraper
        │             │             │
        └─────────────┼─────────────┘
                      ▼
              Match Validation
                      │
                      ▼
                Lyrics Result
```

### Providers

| Provider | Type         | Default  |
| -------- | ------------ | -------- |
| LRCLIB   | API          | Enabled  |
| NetEase  | API          | Enabled  |
| Scraper  | Web scraping | Disabled |

The scraper can be enabled through configuration when additional fallback coverage is required.

---

## 🎯 Lyrics Matching

Lyrics are validated against the requested track.

```js
import { validateLyricsMatch } from './index.js';

const result = validateLyricsMatch(track, lyrics);

console.log(result);
```

The matching system can consider:

* Track title
* Artist
* Duration
* Provider metadata

This helps reduce incorrect matches between songs with similar names.

---

## 💾 Cache

The library contains an internal lyrics cache.

```js
import {
  getCachedLyrics,
  setCachedLyrics,
  clearLyricsCache
} from './index.js';
```

Clear the cache:

```js
clearLyricsCache();
```

MongoDB can also be configured as a cache backend:

```js
import { setMongoDatabase } from './index.js';

setMongoDatabase(db);
```

---

## ⚙️ Configuration

Configuration can be accessed and modified through:

```js
import {
  config,
  setLyricsConfig
} from './index.js';
```

Example:

```js
setLyricsConfig({
  lyricsDebug: true,
  lyricsEnableNetease: true,
  lyricsEnableScrapeFallback: true,
  lyricsSyncOffsetMs: -1000
});
```

### Available Options

| Option                          | Description                   |
| ------------------------------- | ----------------------------- |
| `lyricsDebug`                   | Enable debug logging          |
| `lyricsFetchTimeoutMs`          | Lyrics request timeout        |
| `lyricsPrefetchTimeoutMs`       | Prefetch timeout              |
| `lyricsNeteaseTimeoutMs`        | NetEase request timeout       |
| `lyricsFetchRetries`            | Number of retries             |
| `lyricsCacheSyncedDays`         | Synced lyrics cache lifetime  |
| `lyricsCachePlainDays`          | Plain lyrics cache lifetime   |
| `lyricsNotFoundCacheTtlMinutes` | Not-found cache lifetime      |
| `lyricsErrorCacheTtlMinutes`    | Error cache lifetime          |
| `lyricsSyncOffsetMs`            | Lyrics synchronization offset |
| `lyricsTickIntervalMs`          | Runner tick interval          |
| `lyricsMinSendIntervalMs`       | Minimum message interval      |
| `lyricsEnableNetease`           | Enable NetEase provider       |
| `lyricsEnableScrapeFallback`    | Enable scraping fallback      |

---

## 🤖 Telegram Realtime Lyrics

The project includes a realtime lyrics runner for Telegram bots.

Set the global Bot API:

```js
import { setGlobalBotApi } from './index.js';

setGlobalBotApi(bot.api);
```

### Start

```js
await startLyricsForChat(
  chatId,
  bot.api,
  track
);
```

### Stop

```js
stopLyricsForChat(chatId);
```

### Resync

```js
resyncLyricsForChat(chatId);
```

### Status

```js
const status = getLyricsStatus(chatId);

console.log(status);
```

The runner handles:

* Playback position
* Timestamp synchronization
* Configurable sync offset
* Duplicate lyric prevention
* Send interval limits
* Track changes
* Telegram rate limits

---

## 🧹 Track Metadata

Normalize track information using the built-in helpers:

```js
import {
  normalizeTitle,
  normalizeLyricsMetadata
} from './index.js';
```

Example:

```js
const metadata = normalizeLyricsMetadata({
  title: 'Song Title',
  artist: 'Artist Name',
  duration: 210
});
```

---

## 📚 Exports

### Lyrics

```js
getLyrics()
refreshLyrics()
prefetchLyrics()
```

### LRC

```js
parseLrc()
```

### Cache

```js
setCachedLyrics()
getCachedLyrics()
clearLyricsCache()
setMongoDatabase()
```

### Validation

```js
validateLyricsMatch()
```

### Metadata

```js
normalizeTitle()
normalizeLyricsMetadata()
```

### Telegram Runner

```js
startLyricsForChat()
stopLyricsForChat()
resyncLyricsForChat()
getLyricsStatus()
setGlobalBotApi()
```

### Configuration

```js
config
setLyricsConfig()
```

---

## 🗂️ Project Structure

```text
lyrics/
├── lib/
│   ├── providers/
│   │   ├── lrclib-provider.js
│   │   ├── netease-provider.js
│   │   └── scrape-provider.js
│   │
│   ├── config.js
│   ├── lrc-parser.js
│   ├── lyrics-cache.js
│   ├── lyrics-runner.js
│   ├── lyrics-service.js
│   ├── match-validator.js
│   └── track-metadata.js
│
├── index.js
├── index.cjs
├── package.json
├── README.md
└── LICENSE
```

---

## 🛠️ Development

Clone the repository:

```bash
git clone https://github.com/myname31/lyrics.git
cd lyrics
```

Install dependencies:

```bash
npm install
```

Run your application using the library directly from the repository.

---

## 🤝 Contributing

Contributions, improvements, and bug reports are welcome.

Before submitting a pull request:

1. Fork the repository
2. Create a new branch
3. Make your changes
4. Test the changes
5. Open a pull request

For major changes, consider opening an issue first.

---

## 📄 License

This project is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for the full license text.

---

## 👤 Author

**myname31**

[GitHub](https://github.com/myname31)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/myname31">myname31</a>
</p>
