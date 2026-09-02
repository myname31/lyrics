/**
 * LRCLIB Provider.
 * Fetches synced and plain lyrics from lrclib.net.
 */

import { config } from '../config.js;
import { parseLrc } from '../lrc-parser.js';
import { normalizeLyricsMetadata, normalizeForMatch } from '../track-metadata.js';

const LRCLIB_BASE = 'https://lrclib.net';
const USER_AGENT = 'TgMusicBot/1.0.0 (https://github.com/imamadi19/TgMusicBot)';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').includes('aborted');
}

function classifyFetchError(error) {
  if (isAbortError(error)) return 'timeout';
  const errMsg = String(error?.message || '');
  if (errMsg.includes('ENOTFOUND') || errMsg.includes('ECONNRESET') || errMsg.includes('EAI_AGAIN')) return 'network';
  if (errMsg.includes('ETIMEDOUT')) return 'timeout';
  return 'error';
}

function safeLrclibParam(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Fetch helper with timeout.
 */
async function fetchJson(url, timeoutMs) {
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
      return { status: 'notFound', data: null };
    }
    if (response.status === 400) {
      return { status: 'badRequest', data: null };
    }
    if (response.status === 429) {
      return { status: 'rateLimited', data: null };
    }
    if (response.status >= 500) {
      return { status: 'providerError', data: null };
    }
    if (!response.ok) {
      return { status: 'error', data: null };
    }

    const data = await response.json();
    return { status: 'success', data };
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      return { status: 'timeout', data: null };
    }
    return { status: classifyFetchError(error), data: null, error };
  }
}

/**
 * Fetch helper with retry for network/timeout/provider errors.
 */
async function fetchJsonWithRetry(url, timeoutMs, retries, context = {}) {
  let lastResult;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchJson(url, timeoutMs);
    if (res.status === 'success' || res.status === 'notFound' || res.status === 'badRequest' || res.status === 'rateLimited') {
      return res;
    }
    lastResult = res;
    if (attempt < retries) {
      const wait = 500 * (attempt + 1);
      if (config.lyricsDebug) {
        console.log(`[lyrics] LRCLIB fetch failed (${res.status}), retrying in ${wait}ms... (attempt ${attempt + 1}/${retries})`);
      }
      await delay(wait);
    }
  }
  return lastResult;
}

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
 * Fetch lyrics for a track using LRCLIB.
 * Returns standard provider format.
 */
export async function getLyrics(track, options = {}) {
  const meta = normalizeLyricsMetadata(track);
  if (!meta.rawTitle.trim()) {
    return {
      provider: 'lrclib',
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

  const isPrefetch = options.mode === 'prefetch';
  const timeoutMs = options.timeoutMs ?? (isPrefetch ? config.lyricsPrefetchTimeoutMs : config.lyricsFetchTimeoutMs) ?? 12000;
  const retries = options.retries ?? (isPrefetch ? 0 : config.lyricsFetchRetries) ?? 1;

  let bestPlainFallback = null;
  const triedUrls = [];
  let apiCallsSucceeded = 0;
  
  let rateLimitedCount = 0;
  let timeoutCount = 0;
  let errorCount = 0;
  let badRequestCount = 0;

  const durationSeconds = Number(meta.durationSeconds);
  const isDurationValid = Number.isInteger(durationSeconds) && durationSeconds > 0 && durationSeconds < 86400;

  // Build exact lookup candidates
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
      exactTasks.push({ candidate: validatedCandidate, useDuration: true, priority: 1 });
    }
    if (validatedCandidate.artist) {
      exactTasks.push({ candidate: validatedCandidate, useDuration: false, priority: 2 });
    }
    if (!validatedCandidate.artist) {
      exactTasks.push({
        candidate: validatedCandidate,
        useDuration: isDurationValid,
        priority: validatedCandidate.reason === 'raw-cleaned' ? 4 : 3
      });
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

  const maxExact = config.lyricsExactMaxCandidates ?? 3;
  const exactTasksToRun = uniqueExactTasks.slice(0, maxExact);

  for (const task of exactTasksToRun) {
    if (badRequestCount >= 2) {
      break;
    }

    triedUrls.push({ type: 'exact', url: task.url, candidate: task.candidate.title });

    const response = await fetchJsonWithRetry(task.url, timeoutMs, retries, { type: 'exact', query: task.candidate.title });
    
    if (response.status === 'rateLimited') {
      rateLimitedCount++;
      continue;
    }
    if (response.status === 'timeout') {
      timeoutCount++;
      continue;
    }
    if (response.status === 'badRequest') {
      badRequestCount++;
      continue;
    }
    if (response.status === 'notFound') {
      apiCallsSucceeded++;
      continue;
    }
    if (response.status !== 'success') {
      errorCount++;
      continue;
    }

    apiCallsSucceeded++;
    const result = response.data;

    if (result) {
      const parsedLines = result.syncedLyrics ? parseLrc(result.syncedLyrics) : [];
      if (result.syncedLyrics && parsedLines.length > 0) {
        return {
          provider: 'lrclib',
          status: 'synced',
          synced: true,
          lines: parsedLines,
          plainLyrics: result.plainLyrics || '',
          sourceId: String(result.id || ''),
          confidence: 1.0,
          reason: `exact-match-synced (${task.candidate.reason})`,
          transient: false,
          matchedTitle: result.trackName || '',
          matchedArtist: result.artistName || '',
          matchedAlbum: result.albumName || '',
          matchedDuration: result.duration !== undefined ? result.duration : null,
          matchScore: 500,
          debug: {
            triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
            reason: `exact-match-synced (${task.candidate.reason})`
          }
        };
      } else if (result.instrumental) {
        return {
          provider: 'lrclib',
          status: 'plainOnly',
          synced: false,
          lines: [],
          plainLyrics: '[Instrumental]',
          sourceId: String(result.id || ''),
          confidence: 1.0,
          reason: `exact-match-instrumental (${task.candidate.reason})`,
          transient: false,
          matchedTitle: result.trackName || '',
          matchedArtist: result.artistName || '',
          matchedAlbum: result.albumName || '',
          matchedDuration: result.duration !== undefined ? result.duration : null,
          matchScore: 500,
          debug: {
            triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
            reason: `exact-match-instrumental (${task.candidate.reason})`
          }
        };
      } else if (result.plainLyrics) {
        if (!bestPlainFallback) {
          bestPlainFallback = {
            result,
            candidate: task.candidate,
            parsedLines,
            confidence: 0.9,
            reason: `exact-plain-fallback (${task.candidate.reason})`
          };
        }
      }
    }
  }

  // Fallback to search query
  const searchTasks = [];
  const primaryCandidate = meta.candidates.find(c => c.reason === 'normalized-primary') || meta.candidates[0];

  if (primaryCandidate && primaryCandidate.artist && primaryCandidate.title) {
    searchTasks.push({ query: `${primaryCandidate.artist} - ${primaryCandidate.title}`, priority: 1 });
  }
  for (const c of meta.candidates) {
    if (c.artist && c.title) {
      searchTasks.push({ query: `${c.artist} - ${c.title}`, priority: 1 });
      searchTasks.push({ query: `${c.artist} ${c.title}`, priority: 2 });
    }
  }
  if (primaryCandidate && primaryCandidate.title) {
    searchTasks.push({ query: primaryCandidate.title, priority: 3 });
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

  const maxSearch = config.lyricsSearchMaxQueries ?? 3;
  const queriesToRun = uniqueSearchTasks.slice(0, maxSearch);
  const allSearchResults = new Map();

  for (const task of queriesToRun) {
    const searchParams = new URLSearchParams();
    searchParams.append('q', task.query);
    const url = `${LRCLIB_BASE}/api/search?${searchParams.toString()}`;
    triedUrls.push({ type: 'search', url, query: task.query });

    const response = await fetchJsonWithRetry(url, timeoutMs, retries, { type: 'search', query: task.query });
    
    if (response.status === 'rateLimited') {
      rateLimitedCount++;
      continue;
    }
    if (response.status === 'timeout') {
      timeoutCount++;
      continue;
    }
    if (response.status === 'notFound') {
      apiCallsSucceeded++;
      continue;
    }
    if (response.status !== 'success') {
      errorCount++;
      continue;
    }

    apiCallsSucceeded++;
    const results = response.data;

    if (Array.isArray(results)) {
      for (const item of results) {
        if (item && item.id) {
          allSearchResults.set(item.id, item);
        }
      }
    }
  }

  // Handle errors if no queries succeeded
  if (apiCallsSucceeded === 0) {
    if (rateLimitedCount > 0) {
      return {
        provider: 'lrclib',
        status: 'rateLimited',
        synced: false,
        lines: [],
        plainLyrics: '',
        sourceId: '',
        confidence: 0,
        reason: 'rate-limited',
        transient: true,
        debug: { triedUrls }
      };
    }
    if (timeoutCount > 0) {
      return {
        provider: 'lrclib',
        status: 'timeout',
        synced: false,
        lines: [],
        plainLyrics: '',
        sourceId: '',
        confidence: 0,
        reason: 'timeout',
        transient: true,
        debug: { triedUrls }
      };
    }
    return {
      provider: 'lrclib',
      status: 'error',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: 'request-failed',
      transient: true,
      debug: { triedUrls }
    };
  }

  // Score search results
  const scoredResults = [];
  for (const result of allSearchResults.values()) {
    const score = scoreResult(result, meta.title, meta.artist, meta.durationSeconds);
    scoredResults.push({ result, score });
  }
  scoredResults.sort((a, b) => b.score - a.score);

  let chosenResult = null;
  let selectionReason = '';
  let finalConfidence = 0.0;

  const syncedResults = scoredResults.filter(sr => sr.result.syncedLyrics);
  const reasonableSynced = syncedResults.filter(sr => sr.score >= 150);

  if (reasonableSynced.length > 0) {
    chosenResult = reasonableSynced[0].result;
    selectionReason = `best-synced-search (score: ${reasonableSynced[0].score})`;
    finalConfidence = Math.min(1.0, reasonableSynced[0].score / 400);
  } else if (syncedResults.length > 0) {
    const bestSimilaritySynced = syncedResults
      .map(sr => ({ ...sr, similarity: titleSimilarity(sr.result.trackName, meta.title) }))
      .filter(sr => sr.similarity >= 0.4)
      .sort((a, b) => b.similarity - a.similarity || b.score - a.score);

    if (bestSimilaritySynced.length > 0) {
      chosenResult = bestSimilaritySynced[0].result;
      selectionReason = `low-confidence-synced (similarity: ${bestSimilaritySynced[0].similarity.toFixed(2)}, score: ${bestSimilaritySynced[0].score})`;
      finalConfidence = 0.5;
    }
  }

  if (!chosenResult && bestPlainFallback) {
    chosenResult = bestPlainFallback.result;
    selectionReason = bestPlainFallback.reason;
    finalConfidence = bestPlainFallback.confidence;
  }

  if (!chosenResult && scoredResults.length > 0) {
    const bestSearch = scoredResults[0];
    if (bestSearch.score >= 40) {
      chosenResult = bestSearch.result;
      selectionReason = `best-search-fallback (score: ${bestSearch.score})`;
      finalConfidence = 0.4;
    }
  }

  if (!chosenResult) {
    return {
      provider: 'lrclib',
      status: 'notFound',
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0.0,
      reason: 'no-matching-results',
      transient: false,
      debug: {
        triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
        reason: 'no-matching-results'
      }
    };
  }

  const matchedTitle = chosenResult.trackName || '';
  const matchedArtist = chosenResult.artistName || '';
  const matchedAlbum = chosenResult.albumName || '';
  const matchedDuration = chosenResult.duration !== undefined ? chosenResult.duration : null;
  const matchScoreObj = scoredResults.find(sr => sr.result.id === chosenResult.id);
  const matchScore = matchScoreObj ? matchScoreObj.score : (bestPlainFallback && chosenResult.id === bestPlainFallback.result.id ? 450 : 0);

  if (chosenResult.instrumental) {
    return {
      provider: 'lrclib',
      status: 'plainOnly',
      synced: false,
      lines: [],
      plainLyrics: '[Instrumental]',
      sourceId: String(chosenResult.id || ''),
      confidence: finalConfidence,
      reason: selectionReason + ' (instrumental)',
      transient: false,
      matchedTitle,
      matchedArtist,
      matchedAlbum,
      matchedDuration,
      matchScore,
      debug: {
        triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
        reason: selectionReason
      }
    };
  }

  const hasSynced = Boolean(chosenResult.syncedLyrics);
  const parsedLines = hasSynced ? parseLrc(chosenResult.syncedLyrics) : [];
  const isLowConfidence = selectionReason.startsWith('low-confidence-synced');

  let status = 'plainOnly';
  if (hasSynced && parsedLines.length > 0) {
    status = 'synced';
  }

  return {
    provider: 'lrclib',
    status,
    synced: status === 'synced',
    lines: parsedLines,
    plainLyrics: chosenResult.plainLyrics || '',
    sourceId: String(chosenResult.id || ''),
    confidence: finalConfidence,
    reason: selectionReason,
    transient: false,
    matchedTitle,
    matchedArtist,
    matchedAlbum,
    matchedDuration,
    matchScore,
    debug: {
      triedUrls: triedUrls.map(u => ({ type: u.type, url: u.url })),
      reason: selectionReason
    }
  };
}
