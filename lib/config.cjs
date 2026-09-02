const config = {
  lyricsDebug: false,
  lyricsFetchTimeoutMs: 12000,
  lyricsPrefetchTimeoutMs: 8000,
  lyricsNeteaseTimeoutMs: 8000,
  lyricsScrapeTimeoutMs: 8000,
  lyricsFetchRetries: 1,
  lyricsCacheSyncedDays: 30,
  lyricsCachePlainDays: 7,
  lyricsNotFoundCacheTtlMinutes: 15,
  lyricsErrorCacheTtlMinutes: 1,
  lyricsSyncOffsetMs: 0,
  lyricsTickIntervalMs: 300,
  lyricsMinSendIntervalMs: 1200,
  lyricsEnableNetease: true,
  lyricsEnableScrapeFallback: false,
  lyricsExactMaxCandidates: 3,
  lyricsSearchMaxQueries: 3,
  lyricsScrapeMaxBytes: 1000000
};

function setLyricsConfig(userConfig = {}) {
  Object.assign(config, userConfig);
}

module.exports = { config, setLyricsConfig };
