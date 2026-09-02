const configModule = require('./lib/config.cjs');
const lrcParserModule = require('./lib/lrc-parser.cjs');
const lyricsServiceModule = require('./lib/lyrics-service.cjs');
const lyricsRunnerModule = require('./lib/lyrics-runner.cjs');
const lyricsCacheModule = require('./lib/lyrics-cache.cjs');
const matchValidatorModule = require('./lib/match-validator.cjs');
const trackMetadataModule = require('./lib/track-metadata.cjs');

module.exports = {
  // Config
  config: configModule.config,
  setLyricsConfig: configModule.setLyricsConfig,
  
  // Parser
  parseLrc: lrcParserModule.parseLrc,
  
  // Service
  getLyrics: lyricsServiceModule.getLyrics,
  refreshLyrics: lyricsServiceModule.refreshLyrics,
  prefetchLyrics: lyricsServiceModule.prefetchLyrics,
  
  // Runner
  startLyricsForChat: lyricsRunnerModule.startLyricsForChat,
  stopLyricsForChat: lyricsRunnerModule.stopLyricsForChat,
  resyncLyricsForChat: lyricsRunnerModule.resyncLyricsForChat,
  getLyricsStatus: lyricsRunnerModule.getLyricsStatus,
  setGlobalBotApi: lyricsRunnerModule.setGlobalBotApi,
  
  // Cache
  setCachedLyrics: lyricsCacheModule.setCachedLyrics,
  getCachedLyrics: lyricsCacheModule.getCachedLyrics,
  clearLyricsCache: lyricsCacheModule.clearLyricsCache,
  setMongoDatabase: lyricsCacheModule.setMongoDatabase,
  
  // Validator & Metadata
  validateLyricsMatch: matchValidatorModule.validateLyricsMatch,
  normalizeTitle: trackMetadataModule.normalizeTitle,
  normalizeLyricsMetadata: trackMetadataModule.normalizeLyricsMetadata
};
