export { config, setLyricsConfig } from './lib/config.js';
export { parseLrc } from './lib/lrc-parser.js';
export { getLyrics, refreshLyrics, prefetchLyrics } from './lib/lyrics-service.js';
export { 
  startLyricsForChat, 
  stopLyricsForChat, 
  resyncLyricsForChat, 
  getLyricsStatus, 
  setGlobalBotApi 
} from './lib/lyrics-runner.js';
export { 
  setCachedLyrics, 
  getCachedLyrics, 
  clearLyricsCache, 
  setMongoDatabase 
} from './lib/lyrics-cache.js';
export { validateLyricsMatch } from './lib/match-validator.js';
export { normalizeTitle, normalizeLyricsMetadata } from './lib/track-metadata.js';
