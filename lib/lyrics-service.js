/**
 * Lyrics Service.
 * Coordinates multi-provider lyric retrieval with caching, backoff, and concurrency management.
 */

import { config } from './config.js';
import { getCachedLyrics, setCachedLyrics, lyricsCacheKey, clearLyricsCacheForTrack, getLyricsCacheInfo } from './lyrics-cache.js';
import { getLyrics as lrclibGetLyrics } from './providers/lrclib-provider.js';
import { getLyrics as neteaseGetLyrics } from './providers/netease-provider.js';
import { getLyrics as scrapeGetLyrics } from './providers/scrape-provider.js';
import { validateLyricsMatch } from './match-validator.js';

/** Global in-flight request deduplication map: cacheKey -> Promise */
const inFlightRequests = new Map();

/** Provider backoff registry: providerName -> expiryTimestamp */
const providerBackoffs = new Map();

/** Global concurrency tracking for provider fetches */
let activeFetchesCount = 0;
const fetchQueue = [];

function runWithGlobalConcurrency(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      activeFetchesCount++;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeFetchesCount--;
        if (fetchQueue.length > 0) {
          const nextTask = fetchQueue.shift();
          nextTask();
        }
      }
    };

    if (activeFetchesCount < 2) {
      task();
    } else {
      fetchQueue.push(task);
    }
  });
}

function isProviderBackedOff(providerName) {
  const expiry = providerBackoffs.get(providerName);
  if (expiry && Date.now() < expiry) {
    return true;
  }
  return false;
}

function setProviderBackoff(providerName, durationMs = 60000) {
  if (config.lyricsDebug) {
    console.log(`[lyrics] Setting backoff for ${providerName} for ${durationMs}ms`);
  }
  providerBackoffs.set(providerName, Date.now() + durationMs);
}

/**
 * Main internal function to retrieve lyrics across all providers sequentially.
 */
async function fetchLyricsChain(track, options = {}) {
  const providers = [
    { name: 'lrclib', fetchFn: lrclibGetLyrics, enabled: true },
    { name: 'netease', fetchFn: neteaseGetLyrics, enabled: config.lyricsEnableNetease !== false },
    { name: 'scrape', fetchFn: scrapeGetLyrics, enabled: config.lyricsEnableScrapeFallback === true }
  ];

  let bestPlainFallback = null;
  const transientErrors = [];
  const triedProviders = [];
  let allNotFounds = true;

  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }

    if (isProviderBackedOff(provider.name)) {
      if (config.lyricsDebug) {
        console.log(`[lyrics] skipping backed-off provider: ${provider.name}`);
      }
      triedProviders.push({ provider: provider.name, skipped: true, reason: 'backoff' });
      continue;
    }

    triedProviders.push({ provider: provider.name, skipped: false });

    if (config.lyricsDebug) {
      console.log(`[lyrics] trying provider: ${provider.name}`);
    }

    try {
      // Execute provider fetch under global concurrency limit
      const result = await runWithGlobalConcurrency(() => provider.fetchFn(track, options));

      if (!result) {
        allNotFounds = false;
        transientErrors.push({ provider: provider.name, status: 'error', reason: 'empty-response' });
        continue;
      }

      // Log provider result compactly as requested
      const trackIdentifier = track.title || track.name || '';
      if (result.status === 'rateLimited') {
        const retryAfter = 60; // default 60s
        console.log(`[lyrics] provider=${provider.name} status=rateLimited track="${trackIdentifier}" retryAfter=${retryAfter}`);
        setProviderBackoff(provider.name, retryAfter * 1000);
        allNotFounds = false;
        transientErrors.push({ provider: provider.name, status: 'rateLimited', reason: result.reason });
        continue;
      }

      if (result.status === 'timeout') {
        console.log(`[lyrics] provider=${provider.name} status=timeout track="${trackIdentifier}"`);
        allNotFounds = false;
        transientErrors.push({ provider: provider.name, status: 'timeout', reason: result.reason });
        continue;
      }

      if (result.status === 'error') {
        console.log(`[lyrics] provider=${provider.name} status=error track="${trackIdentifier}" reason="${result.reason}"`);
        allNotFounds = false;
        transientErrors.push({ provider: provider.name, status: 'error', reason: result.reason });
        continue;
      }

      if (result.status === 'notFound') {
        // Successful search, just not found
        continue;
      }

      // If we reach here, provider returned synced or plainOnly
      allNotFounds = false;

      if (result.status === 'synced' && result.synced) {
        const validation = validateLyricsMatch(track, result);

        if (!validation.ok) {
          console.warn(`[lyrics] rejected provider=${provider.name} reason=${validation.reason} track="${track.title || track.name}" matched="${result.matchedArtist} - ${result.matchedTitle}"`);
          transientErrors.push({
            provider: provider.name,
            status: 'rejected',
            reason: validation.reason,
            details: validation.details
          });
          continue;
        }

        console.log(`[lyrics] provider=${provider.name} status=synced lines=${result.lines?.length || 0}`);
        
        const finalResult = {
          ...result,
          confidence: validation.confidence,
          matchValidation: validation,
          fetchedAt: Date.now(),
          debug: {
            ...result.debug,
            triedProviders,
            transientErrors
          }
        };
        await setCachedLyrics(track, finalResult);
        return finalResult;
      }

      if (result.status === 'plainOnly') {
        const validation = validateLyricsMatch(track, result);
        const isPlainValid = validation.ok || (
          validation.details.titleSimilarity >= 0.40 &&
          !(track.artist && track.artist.trim() && validation.details.artistSimilarity < 0.25)
        );

        if (!isPlainValid) {
          console.warn(`[lyrics] rejected plain provider=${provider.name} reason=${validation.reason} track="${track.title || track.name}" matched="${result.matchedArtist} - ${result.matchedTitle}"`);
          transientErrors.push({
            provider: provider.name,
            status: 'rejectedPlain',
            reason: validation.reason,
            details: validation.details
          });
          continue;
        }

        console.log(`[lyrics] provider=${provider.name} status=plainOnly source=${result.sourceId || 'unknown'}`);
        
        // Save the best plain lyrics fallback
        if (!bestPlainFallback || (validation.confidence && validation.confidence > (bestPlainFallback.confidence || 0))) {
          bestPlainFallback = {
            ...result,
            confidence: validation.confidence,
            matchValidation: validation
          };
        }
        // Continue search to see if other providers have synced lyrics
      }

    } catch (err) {
      allNotFounds = false;
      transientErrors.push({ provider: provider.name, status: 'error', reason: err.message });
      console.error(`[lyrics] Unexpected error executing provider ${provider.name}:`, err.message);
    }
  }

  // All providers completed
  if (bestPlainFallback) {
    const finalResult = {
      ...bestPlainFallback,
      fetchedAt: Date.now(),
      debug: {
        ...bestPlainFallback.debug,
        triedProviders,
        transientErrors
      }
    };
    await setCachedLyrics(track, finalResult);
    return finalResult;
  }

  // If we had transient errors and no definitive not-found across all enabled providers, return error
  if (transientErrors.length > 0 && !allNotFounds) {
    console.log(`[lyrics] all providers failed transient=true`);
    const errorStatus = transientErrors[0].status; // e.g. 'rateLimited' or 'timeout' or 'error'
    const finalErrorResult = {
      provider: transientErrors[0].provider,
      status: errorStatus,
      synced: false,
      lines: [],
      plainLyrics: '',
      sourceId: '',
      confidence: 0,
      reason: transientErrors[0].reason || 'transient-error',
      transient: true,
      debug: { triedProviders, transientErrors }
    };
    // Cache transient errors for 1 minute
    await setCachedLyrics(track, finalErrorResult);
    return finalErrorResult;
  }

  // If everything was successfully processed but not found
  const notFoundResult = {
    provider: 'none',
    status: 'notFound',
    synced: false,
    lines: [],
    plainLyrics: '',
    sourceId: '',
    confidence: 0,
    reason: 'no-lyrics-found-across-all-providers',
    transient: false,
    debug: { triedProviders, transientErrors }
  };

  await setCachedLyrics(track, notFoundResult);
  return notFoundResult;
}

/**
 * Retrieves lyrics for a track, first checking cache, then the sequential provider chain.
 */
export async function getLyrics(track, options = {}) {
  if (!track) return null;

  const forceRefresh = Boolean(options.forceRefresh);
  const bypassNotFoundCache = Boolean(options.bypassNotFoundCache);

  if (forceRefresh) {
    await clearLyricsCacheForTrack(track);
  }

  if (!forceRefresh) {
    const cached = await getCachedLyrics(track);
    if (cached) {
      if (cached.status === 'notFound' && bypassNotFoundCache) {
        if (config.lyricsDebug) {
          console.log(`[lyrics] cache hit but bypassing notFound cache for: ${track.title || track.name}`);
        }
      } else {
        console.log(`[lyrics] cache hit status=${cached.status} provider=${cached.provider}`);
        return cached;
      }
    }
  }

  const key = lyricsCacheKey(track);
  if (!key) return null;

  if (inFlightRequests.has(key)) {
    if (config.lyricsDebug) {
      console.log(`[lyrics] deduplicating in-flight request for: ${track.title || track.name}`);
    }
    return inFlightRequests.get(key);
  }

  const mode = options.mode || 'auto';
  const isPrefetch = mode === 'prefetch';
  const silent = options.silent ?? isPrefetch;

  const mergedOptions = {
    ...options,
    mode,
    silent
  };

  const fetchPromise = fetchLyricsChain(track, mergedOptions)
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, fetchPromise);
  return fetchPromise;
}

/**
 * Force refresh of lyrics by clearing cache first.
 */
export async function refreshLyrics(track) {
  return getLyrics(track, { forceRefresh: true });
}

/**
 * Prefetch lyrics for a track in a safe, fire-and-forget manner.
 */
export async function prefetchLyrics(track) {
  try {
    if (config.lyricsDebug) {
      console.log(`[lyrics] prefetch started for: ${track?.title || track?.name}`);
    }
    return await getLyrics(track, {
      mode: 'prefetch',
      silent: true
    });
  } catch (error) {
    if (config.lyricsDebug) {
      console.log(`[lyrics] prefetch failed for: ${track?.title || track?.name}`, error.message);
    }
    return null;
  }
}
