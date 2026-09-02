/**
 * Persistent and In-Memory Cache for Lyrics.
 * If MongoDB is connected, it uses MongoDB. Else, falls back to in-memory cache.
 * TTL is determined dynamically based on the lyrics status.
 */

import { config } from '../../config/index.js';
import { isDatabaseConnected, db } from '../db/mongo.js';
import { validateLyricsMatch } from './match-validator.js';
import { normalizeForMatch } from './track-metadata.js';

// In-memory cache fallback map
const memoryCache = new Map();

function getTtlMs(status, synced, linesCount, plainLyrics) {
  if (status === 'synced') {
    return (config.lyricsCacheSyncedDays ?? 30) * 24 * 60 * 60 * 1000;
  }
  if (status === 'plainOnly') {
    return (config.lyricsCachePlainDays ?? 7) * 24 * 60 * 60 * 1000;
  }
  if (status === 'notFound') {
    return (config.lyricsNotFoundCacheTtlMinutes ?? 15) * 60 * 1000;
  }
  if (status === 'error' || status === 'rateLimited' || status === 'timeout') {
    return (config.lyricsErrorCacheTtlMinutes ?? 1) * 60 * 1000;
  }
  if (status === 'lowConfidence') {
    return 1 * 24 * 60 * 60 * 1000; // 1 day
  }
  
  // Dynamic fallback
  if (synced && linesCount > 0) {
    return (config.lyricsCacheSyncedDays ?? 30) * 24 * 60 * 60 * 1000;
  }
  if (plainLyrics) {
    return (config.lyricsCachePlainDays ?? 7) * 24 * 60 * 60 * 1000;
  }
  return (config.lyricsNotFoundCacheTtlMinutes ?? 15) * 60 * 1000;
}

function getCollection() {
  if (isDatabaseConnected()) {
    try {
      const col = db().collection('lyrics_cache');
      // Create indexes in the background
      col.createIndex({ key: 1 }, { unique: true }).catch(() => {});
      col.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      return col;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Generates a stable unique cache key for a track.
 */
export function lyricsCacheKey(track) {
  if (!track) return '';

  let id = '';
  if (track.trackId) {
    id = String(track.trackId).trim();
  } else {
    const url = String(track.url || track.sourceUrl || '').trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
          const videoId = parsed.searchParams.get('v') || parsed.pathname.replace('/', '');
          if (videoId) id = videoId;
        } else {
          id = parsed.href;
        }
      } catch {
        id = url;
      }
    }
  }

  const normalizedTitle = normalizeForMatch(track.title || track.name || '');
  if (!normalizedTitle) return ''; // jangan cache jika title kosong

  const normalizedArtist = normalizeForMatch(track.artist || '');

  let roundedDuration = '0';
  if (track.duration) {
    roundedDuration = String(Math.round(Number(track.duration)));
  }

  const safeId = String(id || 'notrackid').replace(/:/g, '_');

  return `lyrics:v2:${safeId}:${normalizedTitle}:${normalizedArtist}:${roundedDuration}`;
}

export const getCacheKey = lyricsCacheKey;

async function deleteCacheKey(key) {
  memoryCache.delete(key);
  const col = getCollection();
  if (col) {
    try {
      await col.deleteOne({ key });
    } catch (e) {
      // ignore
    }
  }
}

/**
 * Gets cached lyrics for a track.
 */
export async function getCachedLyrics(track) {
  const key = lyricsCacheKey(track);
  if (!key) return null;

  const now = Date.now();
  const col = getCollection();
  let item = null;

  if (col) {
    try {
      const doc = await col.findOne({ key });
      if (doc) {
        if (doc.expireAt && now > doc.expireAt) {
          await col.deleteOne({ key });
        } else {
          item = doc.value;
        }
      }
    } catch (e) {
      if (config.lyricsDebug) {
        console.error('[lyrics-cache] MongoDB get error, falling back to memory:', e.message);
      }
    }
  }

  if (!item) {
    // Memory fallback
    const memItem = memoryCache.get(key);
    if (memItem) {
      const ttl = getTtlMs(memItem.status, memItem.synced, memItem.lines?.length || 0, memItem.plainLyrics);
      if (now - memItem.fetchedAt > ttl) {
        memoryCache.delete(key);
      } else {
        item = memItem;
      }
    }
  }

  if (!item) return null;

  // Track fingerprint validation (jauh beda check)
  if (item.trackFingerprint) {
    const fp = item.trackFingerprint;
    const normCurrentTitle = normalizeForMatch(track.title || track.name || '');
    const normFpTitle = normalizeForMatch(fp.title || '');
    const titleChanged = normCurrentTitle !== normFpTitle && 
                         !normCurrentTitle.includes(normFpTitle) && 
                         !normFpTitle.includes(normCurrentTitle);

    let durationDiff = null;
    if (track.duration && fp.duration) {
      const tDur = typeof track.duration === 'number' ? track.duration : parseInt(track.duration, 10);
      const fpDur = typeof fp.duration === 'number' ? fp.duration : parseInt(fp.duration, 10);
      if (tDur && fpDur) durationDiff = Math.abs(tDur - fpDur);
    }

    if (titleChanged || (durationDiff !== null && durationDiff > 60)) {
      if (config.lyricsDebug) {
        console.log(`[lyrics-cache] track fingerprint mismatch for key: ${key}. Deleting cache.`);
      }
      await deleteCacheKey(key);
      return null;
    }
  }

  // Exact validator check if matchedTitle is available
  if (item.matchedTitle) {
    const validation = validateLyricsMatch(track, item);
    if (!validation.ok) {
      if (config.lyricsDebug) {
        console.log(`[lyrics-cache] validateLyricsMatch failed for cached item of key: ${key}. Reason: ${validation.reason}. Deleting cache.`);
      }
      await deleteCacheKey(key);
      return null;
    }
  }

  return item;
}

/**
 * Sets cached lyrics for a track.
 */
export async function setCachedLyrics(track, lyricsData) {
  const key = lyricsCacheKey(track);
  if (!key) return;

  let status = lyricsData.status;
  if (!status) {
    if (lyricsData.synced) {
      status = 'synced';
    } else if (lyricsData.plainLyrics && lyricsData.plainLyrics !== '[Instrumental]') {
      status = 'plainOnly';
    } else if (lyricsData.plainLyrics === '[Instrumental]') {
      status = 'plainOnly';
    } else {
      status = 'notFound';
    }
  }

  const isLowConfidence = status === 'lowConfidence' || (lyricsData.matchValidation && !lyricsData.matchValidation.ok);
  const synced = isLowConfidence ? false : Boolean(lyricsData.synced);
  const finalStatus = isLowConfidence ? 'lowConfidence' : status;

  const now = Date.now();
  const linesCount = lyricsData.lines?.length || 0;
  const ttl = getTtlMs(finalStatus, synced, linesCount, lyricsData.plainLyrics);

  const value = {
    provider: lyricsData.provider || 'unknown',
    synced,
    lines: lyricsData.lines || [],
    plainLyrics: lyricsData.plainLyrics || '',
    sourceId: String(lyricsData.sourceId || ''),
    fetchedAt: now,
    status: finalStatus,
    reason: lyricsData.reason || '',
    debug: lyricsData.debug || null,

    // Fingerprint fields
    trackFingerprint: {
      key,
      title: track.title || track.name || '',
      artist: track.artist || '',
      duration: track.duration || '',
      trackId: track.trackId || '',
      url: track.url || track.sourceUrl || ''
    },
    matchedTitle: lyricsData.matchedTitle || '',
    matchedArtist: lyricsData.matchedArtist || '',
    matchedDuration: lyricsData.matchedDuration !== undefined ? lyricsData.matchedDuration : null,
    confidence: lyricsData.confidence !== undefined ? lyricsData.confidence : 0.0,
    matchValidation: lyricsData.matchValidation || null
  };

  const col = getCollection();
  if (col) {
    try {
      const expireAt = new Date(now + ttl);
      await col.updateOne(
        { key },
        { $set: { key, value, expireAt } },
        { upsert: true }
      );
      // Also update memory cache to keep in sync
      memoryCache.set(key, value);
      return;
    } catch (e) {
      if (config.lyricsDebug) {
        console.error('[lyrics-cache] MongoDB set error:', e.message);
      }
    }
  }

  // Memory fallback
  memoryCache.set(key, value);

  // Clean up memory cache
  cleanupExpiredMemory();
}

/**
 * Removes expired cache entries from memory.
 */
function cleanupExpiredMemory() {
  const now = Date.now();
  for (const [key, item] of memoryCache.entries()) {
    const ttl = getTtlMs(item.status, item.synced, item.lines?.length || 0, item.plainLyrics);
    if (now - item.fetchedAt > ttl) {
      memoryCache.delete(key);
    }
  }
}

/**
 * Clears lyrics cache for a specific track.
 */
export async function clearLyricsCacheForTrack(track) {
  const key = lyricsCacheKey(track);
  if (!key) return false;

  memoryCache.delete(key);

  const col = getCollection();
  if (col) {
    try {
      const res = await col.deleteOne({ key });
      return res.deletedCount > 0;
    } catch (e) {
      if (config.lyricsDebug) {
        console.error('[lyrics-cache] MongoDB delete error:', e.message);
      }
    }
  }

  return true;
}

/**
 * Gets cache info for a track.
 */
export async function getLyricsCacheInfo(track) {
  const key = lyricsCacheKey(track);
  if (!key) return null;

  const now = Date.now();
  let item = null;

  const col = getCollection();
  if (col) {
    try {
      const doc = await col.findOne({ key });
      if (doc) {
        item = doc.value;
      }
    } catch (e) {
      if (config.lyricsDebug) {
        console.error('[lyrics-cache] MongoDB info error:', e.message);
      }
    }
  }

  if (!item) {
    item = memoryCache.get(key);
  }

  if (!item) return null;

  const ttl = getTtlMs(item.status, item.synced, item.lines?.length || 0, item.plainLyrics);
  const isExpired = now - item.fetchedAt > ttl;

  return {
    key,
    item,
    isExpired,
    ttl,
    ageSeconds: Math.round((now - item.fetchedAt) / 1000)
  };
}

/**
 * Clears the entire lyrics cache.
 */
export async function clearLyricsCache() {
  memoryCache.clear();
  const col = getCollection();
  if (col) {
    try {
      await col.deleteMany({});
    } catch (e) {
      if (config.lyricsDebug) {
        console.error('[lyrics-cache] MongoDB clear error:', e.message);
      }
    }
  }
}

/**
 * Legacy clearCache export for backward compatibility.
 */
export async function clearCache() {
  await clearLyricsCache();
}
