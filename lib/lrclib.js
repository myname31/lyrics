/**
 * LRCLIB API service to fetch lyrics.
 * Features: configurable timeout, in-flight request deduplication,
 * scored search result matching, prefetch support.
 */

import { config } from '../../config/index.js';
import { parseLrc } from './lrc-parser.js';
import { getCachedLyrics, setCachedLyrics, lyricsCacheKey, clearLyricsCacheForTrack } from './lyrics-cache.js';
import { normalizeLyricsMetadata, normalizeForMatch, normalizeTitle } from './track-metadata.js';
export { normalizeTitle, classifyFetchError, isAbortError };

const LRCLIB_BASE = 'https://lrclib.net';
const USER_AGENT = 'TgMusicBot/1.0.0';

/** In-flight request deduplication map: cacheKey -> Promise */
const inFlightRequests = new Map();

function debugLog(...args) {
  if (config.lyricsDebug) console.log('[lyrics]', ...args);
}

/**
 * Helper to make a JSON fetch request with configurable timeout.
 * @param {string} url
 * @returns {Promise<any>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').includes('aborted');
}

function classifyFetchError(error) {
  if (isAbortError(error)) return 'timeout';
  const errMsg = String(error?.message || '');
  if (errMsg.includes('ENOTFOUND')) return 'network';
  if (errMsg.includes('ECONNRESET')) return 'network';
  if (errMsg.includes('ETIMEDOUT')) return 'timeout';
  return 'http_or_unknown';
}

function safeLrclibParam(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Helper to make a JSON fetch request with configurable timeout.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.lyricsFetchTimeoutMs ?? 12000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 404) {
      return null;
    }

    if (response.status === 400) {
      const error = new Error(`LRCLIB HTTP error: 400 Bad Request`);
      error.code = 'LRCLIB_BAD_REQUEST';
      error.url = url;
      throw error;
    }

    if (response.status === 429) {
      const error = new Error(`LRCLIB Rate Limit: ${response.status}`);
      error.code = 'LRCLIB_RATE_LIMIT';
      error.url = url;
      throw error;
    }

    if (response.status >= 500) {
      const error = new Error(`LRCLIB Provider Error: ${response.status}`);
      error.code = 'LRCLIB_PROVIDER_ERROR';
      error.url = url;
      throw error;
    }

    if (!response.ok) {
      throw new Error(`LRCLIB HTTP error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      const timeoutError = new Error(`LRCLIB timeout after ${timeoutMs}ms.`);
      timeoutError.code = 'LRCLIB_TIMEOUT';
      timeoutError.url = url;
      timeoutError.timeoutMs = timeoutMs;
      throw timeoutError;
    }
    throw error;
  }
}

/**
 * Helper to fetch JSON with retries for timeout/network/provider errors.
 * @param {string} url
 * @param {object} options
 * @param {object} context
 */
async function fetchJsonWithRetry(url, options = {}, context = {}) {
  const retries = options.retries ?? config.lyricsFetchRetries ?? 1;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      const code = error.code || classifyFetchError(error);
      const isTimeout = ['LRCLIB_TIMEOUT', 'LYRICS_TIMEOUT', 'timeout'].includes(code);
      
      if (isTimeout) {
        const queryOrCandidate = context.query || context.candidate || '';
        const timeoutVal = error.timeoutMs || options.timeoutMs || config.lyricsFetchTimeoutMs;
        if (context.type === 'exact') {
          console.warn(`[lyrics] LRCLIB exact timeout candidate="${queryOrCandidate}" attempt=${attempt + 1} timeout=${timeoutVal}ms`);
        } else if (context.type === 'search') {
          console.warn(`[lyrics] LRCLIB search timeout query="${queryOrCandidate}" attempt=${attempt + 1} timeout=${timeoutVal}ms`);
        }
      }

      const retryable = ['LRCLIB_TIMEOUT', 'LYRICS_TIMEOUT', 'timeout', 'network', 'LRCLIB_PROVIDER_ERROR', 'LYRICS_PROVIDER_ERROR'].includes(code);
      if (!retryable || attempt >= retries) throw error;
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * Score a search result against the query criteria.
 */
function scoreResult(result, queryTitle, queryArtist, queryDuration) {
  let score = 0;

  const resultTitle = normalizeForMatch(result.trackName || result.name || '');
  const normalizedQueryTitle = normalizeForMatch(queryTitle);
  const resultArtist = normalizeForMatch(result.artistName || '');
  const normalizedQueryArtist = normalizeForMatch(queryArtist);

  if (resultTitle === normalizedQueryTitle) {
    score += 120;
  } else if (resultTitle.includes(normalizedQueryTitle) || normalizedQueryTitle.includes(resultTitle)) {
    score += 60;
  } else {
    score -= 80;
  }

  if (normalizedQueryArtist && normalizedQueryArtist.length >= 2) {
    if (resultArtist === normalizedQueryArtist) {
      score += 100;
    } else if (resultArtist.includes(normalizedQueryArtist) || normalizedQueryArtist.includes(resultArtist)) {
      score += 50;
    } else {
      score -= 100;
    }
  }

  if (queryDuration > 0 && result.duration > 0) {
    const diff = Math.abs(queryDuration - result.duration);
    if (diff <= 3) {
      score += 80;
    } else if (diff <= 8) {
      score += 40;
    }
  }

  if (result.syncedLyrics) {
    score += 300;
  } else if (result.plainLyrics) {
    score += 20;
  }

  const isQueryRemix = normalizedQueryTitle.includes('remix');
  const isQueryLive = normalizedQueryTitle.includes('live');
  const isQueryKaraoke = normalizedQueryTitle.includes('karaoke');

  const isResultRemix = resultTitle.includes('remix') || (result.trackName || '').toLowerCase().includes('remix');
  const isResultLive = resultTitle.includes('live') || (result.trackName || '').toLowerCase().includes('live');
  const isResultKaraoke = resultTitle.includes('karaoke') || (result.trackName || '').toLowerCase().includes('karaoke');

  if (isResultRemix && !isQueryRemix) score -= 30;
  if (isResultLive && !isQueryLive) score -= 30;
  if (isResultKaraoke && !isQueryKaraoke) score -= 30;

  return score;
}

function titleSimilarity(title1, title2) {
  const t1 = normalizeForMatch(title1);
  const t2 = normalizeForMatch(title2);
  if (!t1 || !t2) return 0;
  if (t1 === t2) return 1.0;
  if (t1.includes(t2) || t2.includes(t1)) return 0.8;
  
  const words1 = t1.split(/\s+/).filter(w => w.length > 1);
  const words2 = t2.split(/\s+/).filter(w => w.length > 1);
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const intersection = words1.filter(w => words2.includes(w));
  const overlap = intersection.length / Math.max(words1.length, words2.length);
  return overlap;
}

/**
 * Internal fetch function that does the actual LRCLIB API calls.
 */
async function fetchLyricsInternal(track, options = {}) {
  const meta = normalizeLyricsMetadata(track);
  if (!meta.rawTitle.trim()) return null;

  let bestPlainFallback = null;
  const triedUrls = [];
  let apiCallsSucceeded = 0;
  let hasTimeout = false;
  let hasNetworkError = false;
  let hasRateLimit = false;
  let hasProviderError = false;
  let badRequestCount = 0;

  const durationSeconds = Number(meta.durationSeconds);
  const isDurationValid = Number.isInteger(durationSeconds) && durationSeconds > 0 && durationSeconds < 86400;

  const exactTasks = [];
  for (const candidate of meta.candidates) {
    if (!candidate.title) continue;

    const cleanTitle = safeLrclibParam(candidate.title, 180);
    if (cleanTitle.length < 2) continue;

    const cleanArtist = candidate.artist ? safeLrclibParam(candidate.artist, 120) : '';
    const cleanAlbum = meta.album ? safeLrclibParam(meta.album, 180) : '';

    const validatedCandidate = {
      ...candidate,
      title: cleanTitle,
      artist: cleanArtist,
      album: cleanAlbum
    };

    if (validatedCandidate.artist && isDurationValid) {
      exactTasks.push({
        candidate: validatedCandidate,
        useDuration: true,
        priority: 1
      });
    }

    if (validatedCandidate.artist) {
      exactTasks.push({
        candidate: validatedCandidate,
        useDuration: false,
        priority: 2
      });
    }

    if (!validatedCandidate.artist) {
      if (validatedCandidate.reason === 'raw-cleaned') {
        exactTasks.push({
          candidate: validatedCandidate,
          useDuration: isDurationValid,
          priority: 4
        });
      } else {
        exactTasks.push({
          candidate: validatedCandidate,
          useDuration: isDurationValid,
          priority: 3
        });
      }
    }
  }

  exactTasks.sort((a, b) => a.priority - b.priority);
  const seenExactUrls = new Set();
  const uniqueExactTasks = [];

  for (const task of exactTasks) {
    const params = new URLSearchParams();
    params.append('track_name', task.candidate.title);
    if (task.candidate.artist) params.append('artist_name', task.candidate.artist);
    if (task.candidate.album) params.append('album_name', task.candidate.album);
    if (task.useDuration && isDurationValid) {
      params.append('duration', String(durationSeconds));
    }
    const url = `${LRCLIB_BASE}/api/get?${params.toString()}`;
    if (!seenExactUrls.has(url)) {
      seenExactUrls.add(url);
      uniqueExactTasks.push({ ...task, url });
    }
  }

  const maxExact = options.lyricsExactMaxCandidates ?? config.lyricsExactMaxCandidates ?? 3;
  const exactTasksToRun = uniqueExactTasks.slice(0, maxExact);

  for (const task of exactTasksToRun) {
    if (badRequestCount >= 2) {
      if (config.lyricsDebug) {
        console.log(`[lyrics] Stopped exact lookup loop: hit 2 bad requests`);
      }
      break;
    }

    let result = null;
    triedUrls.push({ type: 'exact', url: task.url, candidate: task.candidate, useDuration: task.useDuration });
    debugLog('exact lookup trying:', task.url, `(reason: ${task.candidate.reason}, duration: ${task.useDuration})`);

    try {
      result = await fetchJsonWithRetry(task.url, options, { type: 'exact', candidate: task.candidate.title });
      apiCallsSucceeded++;
    } catch (error) {
      const code = error.code || classifyFetchError(error);
      if (code === 'LRCLIB_BAD_REQUEST') {
        badRequestCount++;
        console.log(`[lyrics] LRCLIB exact bad request skipped candidate="${task.candidate.title}"`);
        continue;
      }
      
      const isTimeout = ['LRCLIB_TIMEOUT', 'LYRICS_TIMEOUT', 'timeout'].includes(code);
      const isNetwork = ['LRCLIB_NETWORK', 'network'].includes(code);
      const isRateLimit = ['LRCLIB_RATE_LIMIT', 'LYRICS_RATE_LIMIT'].includes(code);
      const isProvider = ['LRCLIB_PROVIDER_ERROR', 'LYRICS_PROVIDER_ERROR'].includes(code);
      
      if (isTimeout) {
        hasTimeout = true;
      } else if (isNetwork) {
        hasNetworkError = true;
      } else if (isRateLimit) {
        hasRateLimit = true;
      } else if (isProvider) {
        hasProviderError = true;
      }
      
      const isKnownFailure = isTimeout || isNetwork || isRateLimit || isProvider;
      if (!isKnownFailure) {
        console.warn(`LRCLIB exact lookup error: ${error.message}`);
      }
    }

    if (result) {
      const parsedLines = result.syncedLyrics ? parseLrc(result.syncedLyrics) : [];
      if (result.syncedLyrics && parsedLines.length > 0) {
        debugLog('Exact match found with synced lyrics via /api/get, id:', result.id);
        const finalResult = {
          provider: 'lrclib',
          synced: true,
          lines: parsedLines,
          plainLyrics: result.plainLyrics || '',
          sourceId: String(result.id || ''),
          fetchedAt: Date.now(),
          status: 'synced',
          reason: `exact-match-synced (${task.candidate.reason})`,
          debug: {
            meta,
            triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
            searchQueries: [],
            topResults: [],
            chosenResult: {
              id: result.id,
              artistName: result.artistName,
              trackName: result.trackName,
              duration: result.duration,
              hasSynced: true
            },
            reason: `exact-match-synced (${task.candidate.reason})`,
            cacheKey: lyricsCacheKey(track)
          }
        };
        setCachedLyrics(track, finalResult);
        return finalResult;
      } else if (result.instrumental) {
        debugLog('Exact match found as instrumental via /api/get, id:', result.id);
        const finalResult = {
          provider: 'lrclib',
          synced: false,
          lines: [],
          plainLyrics: '[Instrumental]',
          sourceId: String(result.id || ''),
          fetchedAt: Date.now(),
          status: 'plainOnly',
          reason: `exact-match-instrumental (${task.candidate.reason})`,
          debug: {
            meta,
            triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
            searchQueries: [],
            topResults: [],
            chosenResult: {
              id: result.id,
              artistName: result.artistName,
              trackName: result.trackName,
              duration: result.duration,
              hasSynced: false
            },
            reason: `exact-match-instrumental (${task.candidate.reason})`,
            cacheKey: lyricsCacheKey(track)
          }
        };
        setCachedLyrics(track, finalResult);
        return finalResult;
      } else if (result.plainLyrics) {
        debugLog('Exact match plain-only found via /api/get, saving as fallback, id:', result.id);
        if (!bestPlainFallback) {
          bestPlainFallback = {
            result,
            candidate: task.candidate,
            parsedLines
          };
        }
      }
    }
  }

  const searchTasks = [];
  const primaryCandidate = meta.candidates.find(c => c.reason === 'normalized-primary') || meta.candidates[0];

  if (primaryCandidate && primaryCandidate.artist && primaryCandidate.title) {
    searchTasks.push({ query: `${primaryCandidate.artist} - ${primaryCandidate.title}`, priority: 1 });
  }
  for (const c of meta.candidates) {
    if (c.artist && c.title) {
      searchTasks.push({ query: `${c.artist} - ${c.title}`, priority: 1 });
    }
  }

  if (primaryCandidate && primaryCandidate.artist && primaryCandidate.title) {
    searchTasks.push({ query: `${primaryCandidate.artist} ${primaryCandidate.title}`, priority: 2 });
  }
  for (const c of meta.candidates) {
    if (c.artist && c.title) {
      searchTasks.push({ query: `${c.artist} ${c.title}`, priority: 2 });
    }
  }

  if (primaryCandidate && primaryCandidate.title) {
    searchTasks.push({ query: primaryCandidate.title, priority: 3 });
  }
  if (meta.debug.rawTitleCleaned) {
    searchTasks.push({ query: meta.debug.rawTitleCleaned, priority: 3 });
  }
  for (const c of meta.candidates) {
    if (c.title) {
      searchTasks.push({ query: c.title, priority: 3 });
    }
  }

  searchTasks.sort((a, b) => a.priority - b.priority);
  const seenQueries = new Set();
  const uniqueSearchTasks = [];
  for (const task of searchTasks) {
    const cleanedQuery = safeLrclibParam(task.query, 180);
    if (cleanedQuery.length < 2) continue;
    
    const normalizedQ = cleanedQuery.toLowerCase();
    if (!seenQueries.has(normalizedQ)) {
      seenQueries.add(normalizedQ);
      uniqueSearchTasks.push({ query: cleanedQuery, priority: task.priority });
    }
  }

  const maxSearch = options.lyricsSearchMaxQueries ?? config.lyricsSearchMaxQueries ?? 3;
  const queriesToRun = uniqueSearchTasks.slice(0, maxSearch);
  const allSearchResults = new Map();

  for (const task of queriesToRun) {
    try {
      const searchParams = new URLSearchParams();
      searchParams.append('q', task.query);
      const url = `${LRCLIB_BASE}/api/search?${searchParams.toString()}`;
      triedUrls.push({ type: 'search', url, query: task.query });

      debugLog('search trying query:', url);

      const results = await fetchJsonWithRetry(url, options, { type: 'search', query: task.query });
      apiCallsSucceeded++;

      if (Array.isArray(results)) {
        for (const item of results) {
          if (item && item.id) {
            allSearchResults.set(item.id, item);
          }
        }
      }
    } catch (error) {
      const code = error.code || classifyFetchError(error);
      
      const isTimeout = ['LRCLIB_TIMEOUT', 'LYRICS_TIMEOUT', 'timeout'].includes(code);
      const isNetwork = ['LRCLIB_NETWORK', 'network'].includes(code);
      const isRateLimit = ['LRCLIB_RATE_LIMIT', 'LYRICS_RATE_LIMIT'].includes(code);
      const isProvider = ['LRCLIB_PROVIDER_ERROR', 'LYRICS_PROVIDER_ERROR'].includes(code);
      
      if (isTimeout) {
        hasTimeout = true;
      } else if (isNetwork) {
        hasNetworkError = true;
      } else if (isRateLimit) {
        hasRateLimit = true;
      } else if (isProvider) {
        hasProviderError = true;
      }
      
      const isKnownFailure = isTimeout || isNetwork || isRateLimit || isProvider;
      if (!isKnownFailure) {
        console.warn(`LRCLIB search query failed for "${task.query}": ${error.message}`);
      }
    }
  }

  if (apiCallsSucceeded === 0) {
    if (hasTimeout) {
      const timeoutErr = new Error('LRCLIB API is unreachable or all requests timed out.');
      timeoutErr.code = 'LRCLIB_TIMEOUT';
      throw timeoutErr;
    } else if (hasNetworkError) {
      const networkErr = new Error('LRCLIB API is unreachable due to network error.');
      networkErr.code = 'LRCLIB_NETWORK';
      throw networkErr;
    } else if (hasRateLimit) {
      const rateLimitErr = new Error('LRCLIB API rate limited.');
      rateLimitErr.code = 'LRCLIB_RATE_LIMIT';
      throw rateLimitErr;
    } else if (hasProviderError) {
      const providerErr = new Error('LRCLIB API provider error.');
      providerErr.code = 'LRCLIB_PROVIDER_ERROR';
      throw providerErr;
    } else if (badRequestCount > 0) {
      const badRequestErr = new Error('LRCLIB exact lookup bad request.');
      badRequestErr.code = 'LRCLIB_BAD_REQUEST';
      throw badRequestErr;
    } else {
      throw new Error('LRCLIB API is unreachable or all requests failed.');
    }
  }

  const scoredResults = [];
  for (const result of allSearchResults.values()) {
    const score = scoreResult(result, meta.title, meta.artist, meta.durationSeconds);
    scoredResults.push({ result, score });
  }

  scoredResults.sort((a, b) => b.score - a.score);

  if (config.lyricsDebug && scoredResults.length > 0) {
    console.log('[lyrics] Top scored search results:');
    scoredResults.slice(0, 5).forEach((sr, idx) => {
      console.log(`  ${idx + 1}. [Score: ${sr.score}] "${sr.result.artistName}" - "${sr.result.trackName}" (Duration: ${sr.result.duration}s, Synced: ${!!sr.result.syncedLyrics}, ID: ${sr.result.id})`);
    });
  }

  let chosenResult = null;
  let selectionReason = '';

  const syncedResults = scoredResults.filter(sr => sr.result.syncedLyrics);
  const reasonableSynced = syncedResults.filter(sr => sr.score >= 150);

  if (reasonableSynced.length > 0) {
    chosenResult = reasonableSynced[0].result;
    selectionReason = `best-synced-search (score: ${reasonableSynced[0].score})`;
  } else if (syncedResults.length > 0) {
    const bestSimilaritySynced = syncedResults
      .map(sr => ({ ...sr, similarity: titleSimilarity(sr.result.trackName, meta.title) }))
      .filter(sr => sr.similarity >= 0.4)
      .sort((a, b) => b.similarity - a.similarity || b.score - a.score);

    if (bestSimilaritySynced.length > 0) {
      chosenResult = bestSimilaritySynced[0].result;
      selectionReason = `low-confidence-synced (similarity: ${bestSimilaritySynced[0].similarity.toFixed(2)}, score: ${bestSimilaritySynced[0].score})`;
    }
  }

  if (!chosenResult && bestPlainFallback) {
    chosenResult = bestPlainFallback.result;
    selectionReason = `exact-plain-fallback`;
  }

  if (!chosenResult && scoredResults.length > 0) {
    const bestSearch = scoredResults[0];
    if (bestSearch.score >= 40) {
      chosenResult = bestSearch.result;
      selectionReason = `best-search-fallback (score: ${bestSearch.score})`;
    }
  }

  const topResultsDebug = scoredResults.slice(0, 5).map(sr => ({
    score: sr.score,
    id: sr.result.id,
    artistName: sr.result.artistName,
    trackName: sr.result.trackName,
    duration: sr.result.duration,
    hasSynced: !!sr.result.syncedLyrics
  }));

  const chosenResultDebug = chosenResult ? {
    id: chosenResult.id,
    artistName: chosenResult.artistName,
    trackName: chosenResult.trackName,
    duration: chosenResult.duration,
    hasSynced: !!chosenResult.syncedLyrics
  } : null;

  const debugObject = {
    meta,
    triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
    searchQueries: queriesToRun.map(q => q.query),
    topResults: topResultsDebug,
    chosenResult: chosenResultDebug,
    reason: selectionReason,
    cacheKey: lyricsCacheKey(track)
  };

  if (!chosenResult) {
    debugLog('No lyrics found for:', meta.rawTitle);
    const emptyResult = {
      provider: 'lrclib',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      fetchedAt: Date.now(),
      status: 'notFound',
      reason: 'no-matching-results',
      debug: debugObject
    };
    setCachedLyrics(track, emptyResult);
    return emptyResult;
  }

  if (chosenResult.instrumental) {
    const instrumentalResult = {
      provider: 'lrclib',
      synced: false,
      lines: [],
      plainLyrics: '[Instrumental]',
      sourceId: String(chosenResult.id || ''),
      fetchedAt: Date.now(),
      status: 'plainOnly',
      reason: selectionReason + ' (instrumental)',
      debug: debugObject
    };
    setCachedLyrics(track, instrumentalResult);
    return instrumentalResult;
  }

  const hasSynced = Boolean(chosenResult.syncedLyrics);
  const parsedLines = hasSynced ? parseLrc(chosenResult.syncedLyrics) : [];
  const isLowConfidence = selectionReason.startsWith('low-confidence-synced');

  const finalResult = {
    provider: 'lrclib',
    synced: hasSynced && parsedLines.length > 0,
    lines: parsedLines,
    plainLyrics: chosenResult.plainLyrics || '',
    sourceId: String(chosenResult.id || ''),
    fetchedAt: Date.now(),
    status: isLowConfidence ? 'lowConfidence' : (hasSynced && parsedLines.length > 0 ? 'synced' : 'plainOnly'),
    reason: selectionReason,
    debug: debugObject
  };

  setCachedLyrics(track, finalResult);
  debugLog('cached lyrics, synced:', finalResult.synced, 'lines:', finalResult.lines.length, 'reason:', selectionReason);
  return finalResult;
}

/**
 * Fetches lyrics for a track with in-flight deduplication.
 * First checks cache, then tries LRCLIB API.
 * @param {object} track
 * @param {object} [options]
 * @returns {Promise<object|null>} The lyric data object
 */
export async function getLyrics(track, options = {}) {
  if (!track) return null;

  const forceRefresh = Boolean(options.forceRefresh);
  const bypassNotFoundCache = Boolean(options.bypassNotFoundCache);

  if (forceRefresh) {
    clearLyricsCacheForTrack(track);
  }

  if (!forceRefresh) {
    const cached = getCachedLyrics(track);
    if (cached) {
      if (cached.status === 'notFound' && bypassNotFoundCache) {
        debugLog('cache hit but bypassing notFound cache for:', track.title || track.name);
      } else {
        debugLog('cache hit for:', track.title || track.name);
        return cached;
      }
    }
  }

  const key = lyricsCacheKey(track);
  if (!key) return null;

  if (inFlightRequests.has(key)) {
    debugLog('deduped in-flight request for:', track.title || track.name);
    return inFlightRequests.get(key);
  }

  const mode = options.mode || 'auto';
  const isPrefetch = mode === 'prefetch';
  const silent = options.silent ?? isPrefetch;
  const timeoutMs = options.timeoutMs ?? (isPrefetch ? config.lyricsPrefetchTimeoutMs : config.lyricsFetchTimeoutMs);
  const retries = options.retries ?? (isPrefetch ? 0 : config.lyricsFetchRetries);

  const mergedOptions = {
    ...options,
    mode,
    silent,
    timeoutMs,
    retries
  };

  const fetchPromise = fetchLyricsInternal(track, mergedOptions)
    .catch(error => {
      const code = error.code || classifyFetchError(error);
      const isTimeout = ['LRCLIB_TIMEOUT', 'LYRICS_TIMEOUT', 'timeout'].includes(code);
      const isNetwork = ['LRCLIB_NETWORK', 'network'].includes(code);
      const isRateLimit = ['LRCLIB_RATE_LIMIT', 'LYRICS_RATE_LIMIT'].includes(code);
      const isProvider = ['LRCLIB_PROVIDER_ERROR', 'LYRICS_PROVIDER_ERROR'].includes(code);
      const isBadRequest = ['LRCLIB_BAD_REQUEST', 'badRequest'].includes(code);

      let reason = 'error';
      if (isTimeout) reason = 'timeout';
      else if (isNetwork) reason = 'network';
      else if (isRateLimit) reason = 'rateLimited';
      else if (isProvider) reason = 'providerError';
      else if (isBadRequest) reason = 'badRequest';

      if (isPrefetch || silent) {
        if (config.lyricsDebug) {
          console.log(`[lyrics] prefetch skipped due to LRCLIB ${reason} for "${track.title || track.name}"`);
        }
      } else {
        if (isTimeout) {
          console.warn(`[lyrics] LRCLIB unavailable after retries for "${track.title || track.name}": timeout`);
        } else {
          console.warn(`[lyrics] LRCLIB unavailable after retries for "${track.title || track.name}": ${error.message}`);
        }
      }

      const errorResult = {
        success: false,
        message: reason,
        provider: 'lrclib',
        synced: false,
        lines: [],
        plainLyrics: '',
        sourceId: '',
        fetchedAt: Date.now(),
        status: 'error',
        reason,
        transient: true
      };

      setCachedLyrics(track, errorResult);
      return errorResult;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, fetchPromise);
  return fetchPromise;
}

/**
 * Forces a refresh of the lyrics for a track by clearing the cache first.
 * @param {object} track
 * @returns {Promise<object|null>}
 */
export async function refreshLyrics(track) {
  return getLyrics(track, { forceRefresh: true });
}

/**
 * Prefetch lyrics for a track (fire-and-forget, safe).
 * Returns the promise but does not throw.
 * @param {object} track
 * @returns {Promise<object|null>}
 */
export async function prefetchLyrics(track) {
  try {
    debugLog('prefetch started for:', track?.title || track?.name);
    return await getLyrics(track, {
      mode: 'prefetch',
      silent: true,
      timeoutMs: config.lyricsPrefetchTimeoutMs
    });
  } catch (error) {
    if (config.lyricsDebug) {
      debugLog('prefetch failed for:', track?.title || track?.name, error?.message);
    }
    return null;
  }
}
