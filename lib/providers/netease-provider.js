/**
 * NetEase Cloud Music Provider.
 * Fetches lyrics via unofficial HTTP APIs with search matching and fallback.
 */

import { config } from '../../../config/index.js';
import { parseLrc } from '../lrc-parser.js';
import { normalizeLyricsMetadata, normalizeForMatch } from '../track-metadata.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').includes('aborted');
}

/**
 * Fetch helper with timeout.
 */
async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.lyricsNeteaseTimeoutMs ?? 8000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      return { status: 'rateLimited', code: 429 };
    }
    if (response.status >= 500) {
      return { status: 'providerError', code: response.status };
    }
    if (!response.ok) {
      return { status: 'error', code: response.status };
    }

    const data = await response.json();
    return { status: 'success', data };
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      return { status: 'timeout', error };
    }
    return { status: 'error', error };
  }
}

/**
 * Helper to fetch with retry.
 */
async function fetchWithRetry(url, options = {}) {
  const retries = config.lyricsFetchRetries ?? 1; // Default to 1 retry
  let lastRes;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchWithTimeout(url, options);
    if (res.status === 'success' || res.status === 'rateLimited') {
      return res;
    }
    lastRes = res;
    if (attempt < retries) {
      await delay(400 * (attempt + 1));
    }
  }
  return lastRes;
}

function scoreSong(song, queryTitle, queryArtist, queryDurationSeconds) {
  let score = 0;

  const title = normalizeForMatch(song.name || '');
  const normalizedQueryTitle = normalizeForMatch(queryTitle);
  
  // Artist handling (NetEase can have multiple artists)
  const artistNames = (song.artists || []).map(a => normalizeForMatch(a.name || ''));
  const normalizedQueryArtist = normalizeForMatch(queryArtist);

  // 1. Title Score
  if (title === normalizedQueryTitle) {
    score += 120;
  } else if (title.includes(normalizedQueryTitle) || normalizedQueryTitle.includes(title)) {
    score += 60;
  } else {
    score -= 50;
  }

  // 2. Artist Score
  if (normalizedQueryArtist && normalizedQueryArtist.length >= 2) {
    const hasExactArtist = artistNames.some(name => name === normalizedQueryArtist);
    const hasPartialArtist = artistNames.some(name => name.includes(normalizedQueryArtist) || normalizedQueryArtist.includes(name));

    if (hasExactArtist) {
      score += 100;
    } else if (hasPartialArtist) {
      score += 50;
    } else {
      score -= 80;
    }
  }

  // 3. Duration Score (NetEase duration is in ms)
  const songDurationSeconds = song.duration ? song.duration / 1000 : 0;
  if (queryDurationSeconds > 0 && songDurationSeconds > 0) {
    const diff = Math.abs(queryDurationSeconds - songDurationSeconds);
    if (diff <= 3) {
      score += 80;
    } else if (diff <= 8) {
      score += 40;
    } else {
      score -= 30;
    }
  }

  return score;
}

/**
 * Fetch lyrics for a track using NetEase.
 */
export async function getLyrics(track, options = {}) {
  // Check if enabled
  const enabled = config.lyricsEnableNetease !== false; // defaults to true
  if (!enabled) {
    return {
      provider: 'netease',
      status: 'error',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'provider-disabled',
      transient: false,
      debug: {}
    };
  }

  const meta = normalizeLyricsMetadata(track);
  if (!meta.title) {
    return {
      provider: 'netease',
      status: 'notFound',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'empty-title',
      transient: false,
      debug: { meta }
    };
  }

  // Query: artist ? `${artist} ${title}` : title
  const query = meta.artist ? `${meta.artist} ${meta.title}` : meta.title;
  const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=&type=1&limit=5&offset=0&s=${encodeURIComponent(query)}`;

  if (config.lyricsDebug) {
    console.log(`[lyrics] netease searching: ${query}`);
  }

  const searchRes = await fetchWithRetry(searchUrl);

  if (searchRes.status === 'rateLimited') {
    return {
      provider: 'netease',
      status: 'rateLimited',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'rate-limited',
      transient: true,
      debug: {}
    };
  }
  if (searchRes.status === 'timeout') {
    return {
      provider: 'netease',
      status: 'timeout',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'timeout',
      transient: true,
      debug: {}
    };
  }
  if (searchRes.status !== 'success') {
    return {
      provider: 'netease',
      status: 'error',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'search-failed',
      transient: true,
      debug: {}
    };
  }

  const songs = searchRes.data?.result?.songs || [];
  if (songs.length === 0) {
    return {
      provider: 'netease',
      status: 'notFound',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'no-search-results',
      transient: false,
      debug: {}
    };
  }

  // Score songs
  const scoredSongs = songs.map(song => ({
    song,
    score: scoreSong(song, meta.title, meta.artist, meta.durationSeconds)
  })).sort((a, b) => b.score - a.score);

  // Take the best candidate
  const best = scoredSongs[0];
  if (!best || best.score < 20) {
    return {
      provider: 'netease',
      status: 'notFound',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'low-score-match',
      transient: false,
      debug: { topScore: best?.score }
    };
  }

  const songId = best.song.id;
  const lyricUrl = `https://music.163.com/api/song/lyric?lv=-1&tv=-1&id=${songId}`;

  if (config.lyricsDebug) {
    console.log(`[lyrics] netease fetching lyrics for songId: ${songId} (score: ${best.score})`);
  }

  const lyricRes = await fetchWithRetry(lyricUrl);

  if (lyricRes.status === 'rateLimited') {
    return {
      provider: 'netease',
      status: 'rateLimited',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: String(songId),
      confidence: 0.5,
      reason: 'lyric-rate-limited',
      transient: true,
      debug: {}
    };
  }
  if (lyricRes.status === 'timeout') {
    return {
      provider: 'netease',
      status: 'timeout',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: String(songId),
      confidence: 0.5,
      reason: 'lyric-timeout',
      transient: true,
      debug: {}
    };
  }
  if (lyricRes.status !== 'success') {
    return {
      provider: 'netease',
      status: 'error',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: String(songId),
      confidence: 0.5,
      reason: 'lyric-fetch-failed',
      transient: true,
      debug: {}
    };
  }

  const lyricData = lyricRes.data;
  const rawLrc = lyricData?.lrc?.lyric || '';

  if (!rawLrc) {
    return {
      provider: 'netease',
      status: 'notFound',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: String(songId),
      confidence: 0.5,
      reason: 'no-lyric-field',
      transient: false,
      debug: {}
    };
  }

  // Parse LRC lyrics
  const parsedLines = parseLrc(rawLrc);
  const synced = parsedLines.length > 0;

  let plainLyrics = '';
  if (!synced) {
    // If not parseable as LRC, treat as plain lyrics
    plainLyrics = rawLrc.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
  } else {
    // Reconstruct plain lyrics from LRC lines for consistency
    plainLyrics = parsedLines.map(l => l.text).join('\n');
  }

  const confidence = Math.min(1.0, best.score / 350);
  const matchedTitle = best.song.name || '';
  const matchedArtist = (best.song.artists || []).map(a => a.name).filter(Boolean).join(', ');
  const matchedAlbum = best.song.album?.name || '';
  const matchedDuration = best.song.duration ? best.song.duration / 1000 : null;

  return {
    provider: 'netease',
    status: synced ? 'synced' : 'plainOnly',
    synced,
    lines: parsedLines,
    plainLyrics,
    sourceId: String(songId),
    confidence,
    reason: `netease-match (score: ${best.score})`,
    transient: false,
    matchedTitle,
    matchedArtist,
    matchedAlbum,
    matchedDuration,
    matchScore: best.score,
    debug: {
      score: best.score,
      songId
    }
  };
}
