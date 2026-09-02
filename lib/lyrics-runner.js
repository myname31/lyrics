/**
 * Lyrics runner scheduler.
 * Sends lyric lines as Telegram messages at appropriate timestamps.
 * Features: sync offset, correct start position, immediate first tick,
 * rate-limit-aware skipping, resync on seek, auto-next integration.
 */

import { config } from './config.js';
import { voicePlayer } from '../player/player.js';
import { chatCache } from '../cache/chat-cache.js';
import { getLyrics } from './lyrics-service.js';
import { getCachedLyrics } from './lyrics-cache.js';
import { validateLyricsMatch } from './match-validator.js';
//import { htmlEscape } from '../../utils/telegram.js';

function htmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const activeRunners = new Map();
const lastStartResult = new Map();
let globalBotApi = null;

function debugLog(...args) {
  if (config.lyricsDebug) console.log('[lyrics-runner]', ...args);
}

/**
 * Sets the global Bot API instance.
 * @param {any} api
 */
export function setGlobalBotApi(api) {
  globalBotApi = api;
}

/**
 * HTML Escaper helper.
 * @param {string} str
 * @returns {string}
 */


/**
 * Normalizes track title/name text for loose comparison.
 */
export function normalizeTrackText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compares two track objects loosely.
 */
export function sameTrackLoose(activeTrack, requestedTrack) {
  if (!activeTrack || !requestedTrack) return false;

  const activeId = String(activeTrack.trackId || '').trim();
  const requestId = String(requestedTrack.trackId || '').trim();
  if (activeId && requestId && activeId === requestId) return true;

  const activeUrl = String(activeTrack.url || activeTrack.sourceUrl || '').trim();
  const requestUrl = String(requestedTrack.url || requestedTrack.sourceUrl || '').trim();
  if (activeUrl && requestUrl && activeUrl === requestUrl) return true;

  const activeTitle = normalizeTrackText(activeTrack.title || activeTrack.name);
  const requestTitle = normalizeTrackText(requestedTrack.title || requestedTrack.name);

  if (activeTitle && requestTitle) {
    if (activeTitle === requestTitle) return true;
    if (activeTitle.includes(requestTitle) || requestTitle.includes(activeTitle)) return true;
  }

  const activeDuration = Number(activeTrack.duration || 0);
  const requestDuration = Number(requestedTrack.duration || 0);
  if (activeTitle && requestTitle && activeDuration && requestDuration) {
    const durationClose = Math.abs(activeDuration - requestDuration) <= 3;
    const titleTokenOverlap = activeTitle.split(' ').some(w => w.length > 2 && requestTitle.includes(w));
    if (durationClose && titleTokenOverlap) return true;
  }

  return false;
}

/**
 * Calculate the current playback position in seconds, adjusted by sync offset.
 * Offset semantics: LYRICS_SYNC_OFFSET_MS negative = lyrics appear earlier (advance).
 * Formula: elapsed = rawMs - syncOffset
 * So offset=-1500 means elapsed is rawMs+1500, lyrics appear 1.5s earlier.
 * @param {object} activeTrack
 * @returns {number} position in seconds
 */
function playbackPositionSeconds(activeTrack) {
  if (!activeTrack?.startedAt) return 0;
  const startedMs = new Date(activeTrack.startedAt).getTime();
  const rawMs = Date.now() - startedMs;
  const syncOffset = config.lyricsSyncOffsetMs ?? 0;
  // elapsed = rawMs - syncOffset
  // offset=-1500: elapsed = rawMs + 1500 (lyrics advance)
  // offset=+1500: elapsed = rawMs - 1500 (lyrics delay)
  const adjustedMs = rawMs - syncOffset;
  return Math.max(0, adjustedMs / 1000);
}

/**
 * Find the initial lastSentIndex based on current playback position.
 * Sets the index so that lines already passed are skipped.
 * @param {Array<{time: number, text: string}>} lines
 * @param {number} currentPositionSeconds
 * @returns {number} The index of the last line that should be considered "already sent"
 */
function findInitialLastSentIndex(lines, currentPositionSeconds) {
  const graceSeconds = config.lyricsStartGraceSeconds ?? 1.5;
  const threshold = currentPositionSeconds - graceSeconds;

  if (threshold <= 0) return -1;

  let lastIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time < threshold) {
      lastIndex = i;
    } else {
      break;
    }
  }
  return lastIndex;
}

/**
 * Combines adjacent lyric lines if they are too close in time.
 * @param {Array<{time: number, text: string}>} lines
 * @param {number} startIndex
 * @returns {{text: string, nextIndex: number}}
 */
function getLyricTextAndNextIndex(lines, startIndex) {
  const maxLineLength = config.lyricsMaxLineLength ?? 300;
  let text = lines[startIndex].text;
  let nextIndex = startIndex;

  // Combine subsequent lines if timestamp gap is < 1.5 seconds
  while (nextIndex + 1 < lines.length) {
    const gap = lines[nextIndex + 1].time - lines[nextIndex].time;
    if (gap >= 0 && gap < 1.5) {
      const nextText = lines[nextIndex + 1].text;
      if (nextText && (text + '\n' + nextText).length <= maxLineLength) {
        text = text + '\n' + nextText;
        nextIndex++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return { text, nextIndex };
}

async function sendLyricsMessage(runner, text) {
  if (!runner.api?.sendMessage) {
    console.warn(`[lyrics-runner] Bot API sendMessage is not available for chat ${runner.chatId}`);
    return false;
  }

  try {
    await runner.api.sendMessage(runner.chatId, text, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    const retryAfter = error?.response?.parameters?.retry_after || error?.parameters?.retry_after;
    if (retryAfter) {
      runner.lastSentTimeMs = Date.now() + retryAfter * 1000;
      return false;
    }

    const desc = String(error?.description || error?.message || '').toLowerCase();
    if (
      desc.includes('chat not found') ||
      desc.includes('forbidden') ||
      desc.includes('bot was blocked')
    ) {
      stopLyricsForChat(runner.chatId, 'send-message-error');
      return false;
    }

    console.warn(`Lyrics runner failed to send message to chat ${runner.chatId}: ${error.message}`);
    return false;
  }
}

/**
 * The periodic tick handler for a chat's lyrics runner.
 * @param {string} chatId
 */
async function runTick(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (!runner) return;

  if (runner.isTickRunning) return;
  runner.isTickRunning = true;

  try {
    // 1. Check if the track is still active in player
  const activeTrack = voicePlayer.activeTrack(chatId);
  if (!activeTrack) {
    debugLog('no active track, stopping runner for', key);
    stopLyricsForChat(chatId, 'no-active-track');
    return;
  }

  // Ensure it is the same track
  const isSameTrack = sameTrackLoose(activeTrack, runner.track);

  if (!isSameTrack) {
    if (config.lyricsStrictTrackMatch) {
      debugLog('track changed (strict mismatch), stopping runner for', key);
      stopLyricsForChat(chatId, 'track-changed');
      return;
    } else {
      if (config.lyricsDebug) {
        console.log(`[lyrics-runner] [${key}] loose track mismatch warning (active vs runner), continuing since strict matches are disabled.`, {
          active: { title: activeTrack.title || activeTrack.name, trackId: activeTrack.trackId },
          runner: { title: runner.track.title || runner.track.name, trackId: runner.track.trackId }
        });
      }
    }
  }

  // 2. Skip if playback is paused
  if (chatCache.isPaused(chatId)) {
    return;
  }

  // 3. Calculate current playback position with sync offset
  if (!activeTrack.startedAt) return;
  const elapsedSeconds = playbackPositionSeconds(activeTrack);

  // 4. Find the matching lyric line index for current position
  let targetIndex = -1;
  for (let i = 0; i < runner.lines.length; i++) {
    if (runner.lines[i].time <= elapsedSeconds) {
      targetIndex = i;
    } else {
      break;
    }
  }

  // 5. Send lyric if we have a new line
  if (targetIndex !== -1 && targetIndex > runner.lastSentIndex) {
    const now = Date.now();
    const minInterval = config.lyricsMinSendIntervalMs ?? 1200;

    // Rate limit check
    if (now - runner.lastSentTimeMs < minInterval) {
      // Rate limited: update lastSentIndex to skip old lines,
      // but keep one behind so we send the latest on next allowed tick
      if (targetIndex > runner.lastSentIndex + 1) {
        runner.lastSentIndex = targetIndex - 1;
        debugLog('rate limited, advancing lastSentIndex to', runner.lastSentIndex);
      }
      return;
    }

    // Skip old threshold: if target line is way behind current position,
    // find the most recent line instead
    const skipThreshold = config.lyricsSkipOldLineThresholdSeconds ?? 3;
    if (elapsedSeconds - runner.lines[targetIndex].time > skipThreshold && targetIndex > runner.lastSentIndex + 1) {
      // Jump to the latest relevant line
      debugLog('skipping old lines, jumping from', runner.lastSentIndex, 'to', targetIndex);
    }

    const { text, nextIndex } = getLyricTextAndNextIndex(runner.lines, targetIndex);
    
    if (!text.trim()) {
      return;
    }

    const escapedText = htmlEscape(text);
    const messageText = `♪ ${escapedText}`;

    debugLog(`[${key}] sending line ${targetIndex} at ${elapsedSeconds.toFixed(1)}s: "${text.slice(0, 50)}..."`);

    const success = await sendLyricsMessage(runner, messageText);
    if (success) {
      runner.lastSentIndex = nextIndex;
      runner.lastSentTimeMs = now;
      runner.lastSentText = text;
    }
  }
  } finally {
    if (activeRunners.get(key) === runner) {
      runner.isTickRunning = false;
    }
  }
}

/**
 * Starts the lyrics runner for a chat.
 * @param {string|number} chatId
 * @param {any} ctxOrApi
 * @param {object} track
 * @param {object} [options={}]
 * @param {boolean} [options.silent=false] - If true, don't return user-facing messages for not-found
 * @param {boolean} [options.preferCache=false] - If true, only use cached lyrics (don't fetch)
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function startLyricsForChat(chatId, ctxOrApi, track, options = {}) {
  const key = String(chatId);
  const { silent = false, preferCache = false } = options;
  
  // Stop existing runner first
  stopLyricsForChat(key, 'restart');

  const api = ctxOrApi?.api || ctxOrApi || globalBotApi;
  if (!api) {
    console.warn(`[lyrics-runner] Bot API instance is not available for chat ${chatId} (globalBotApi is not set)`);
    const result = { success: false, message: 'apiUnavailable' };
    lastStartResult.set(key, result);
    return result;
  }

  try {
    let lyricsResult;
    const bypassNotFound = Boolean(options.force || options.bypassNotFoundCache);

    if (preferCache) {
      lyricsResult = await getCachedLyrics(track);
      if (!lyricsResult || (lyricsResult.status === 'notFound' && bypassNotFound)) {
        debugLog('no cache or notFound bypass, fetching for', track.title || track.name);
        lyricsResult = await getLyrics(track, { bypassNotFoundCache: bypassNotFound });
      }
    } else {
      lyricsResult = await getLyrics(track, { bypassNotFoundCache: bypassNotFound });
    }

    if (!lyricsResult || !lyricsResult.synced || lyricsResult.lines.length === 0) {
      let msg = 'notFound';
      if (lyricsResult?.status === 'plainOnly') {
        msg = 'plainOnly';
      } else if (lyricsResult?.status === 'rateLimited') {
        msg = 'rateLimited';
      } else if (lyricsResult?.status === 'timeout') {
        msg = 'timeout';
      } else if (lyricsResult?.status === 'error') {
        msg = 'error';
      }
      let errReason = lyricsResult?.reason;
      const result = { success: false, message: msg, error: errReason };
      lastStartResult.set(key, result);
      if (silent) {
        debugLog('no synced lyrics (silent mode), skipping for', track.title || track.name);
        return result;
      }
      return result;
    }

    const validation = validateLyricsMatch(track, lyricsResult);
    if (!validation.ok) {
      const result = { success: false, message: 'lyricsMismatch', reason: validation.reason };
      lastStartResult.set(key, result);
      return result;
    }

    // Calculate initial position from active track
    const activeTrack = voicePlayer.activeTrack(chatId);
    if (!activeTrack) {
      debugLog('no active track in voicePlayer, aborting start for chat', key);
      const result = { success: false, message: 'noActiveTrack' };
      lastStartResult.set(key, result);
      return result;
    }
    const isSameTrack = sameTrackLoose(activeTrack, track);
    if (!isSameTrack) {
      if (config.lyricsStrictTrackMatch) {
        debugLog('active track is different from requested track, aborting start for chat', key);
        const result = { success: false, message: 'trackMismatch' };
        lastStartResult.set(key, result);
        return result;
      } else {
        if (config.lyricsDebug) {
          console.log(`[lyrics-runner] active track mismatch warning (active vs requested) for chat=${key}, continuing since strict matches are disabled.`, {
            active: { title: activeTrack.title || activeTrack.name, trackId: activeTrack.trackId },
            requested: { title: track.title || track.name, trackId: track.trackId }
          });
        }
      }
    }

    const currentPosition = playbackPositionSeconds(activeTrack);
    const initialLastSentIndex = findInitialLastSentIndex(lyricsResult.lines, currentPosition);

    if (config.lyricsDebug) {
      console.log(`[lyrics-runner] runner started for chat=${key} position=${currentPosition.toFixed(2)}s initialIndex=${initialLastSentIndex} totalLines=${lyricsResult.lines.length} provider=${lyricsResult.provider || 'lrclib'}`);
    }

    const runner = {
      chatId: key,
      api,
      track: {
        ...track,
        startedAt: activeTrack.startedAt || track.startedAt
      },
      lines: lyricsResult.lines,
      lastSentIndex: initialLastSentIndex,
      lastSentTimeMs: 0,
      lastSentText: '',
      provider: lyricsResult.provider || 'lrclib',
      sourceId: lyricsResult.sourceId || '',
      startedAt: Date.now(),
      timer: null,
      isTickRunning: false
    };

    activeRunners.set(key, runner);

    // Immediately run the first tick (don't wait for interval)
    await runTick(key).catch(err => console.error(`Error in initial lyrics tick for chat ${key}:`, err));

    // Set up recurring tick interval
    const tickInterval = config.lyricsTickIntervalMs ?? 300;
    runner.timer = setInterval(() => {
      runTick(key).catch(err => console.error(`Error in lyrics tick for chat ${key}:`, err));
    }, tickInterval);

    const result = { success: true, provider: runner.provider };
    lastStartResult.set(key, result);
    return result;
  } catch (error) {
    console.error(`Failed to start lyrics runner for chat ${key}:`, error);
    const result = { success: false, message: 'error', error: error.message };
    lastStartResult.set(key, result);
    return result;
  }
}

/**
 * Starts lyrics for a chat only if lyrics are enabled for that chat.
 * Used for auto-start scenarios (auto-next, first play, etc.)
 * @param {string|number} chatId
 * @param {any} ctxOrApi
 * @param {object} track
 * @param {object} [options={}]
 * @returns {Promise<{success: boolean, message?: string, skipped?: boolean}>}
 */
export async function startLyricsForChatIfEnabled(chatId, ctxOrApi, track, options = {}) {
  const key = String(chatId);
  try {
    const { getLyricsEnabled } = await import('../db/chat-settings.js');
    const enabled = await getLyricsEnabled(chatId);
    
    if (config.lyricsDebug) {
      console.log(`[lyrics-runner] startLyricsForChatIfEnabled check: chat=${chatId} enabled=${enabled}`);
    }

    if (!enabled) {
      const result = { success: false, skipped: true, message: 'disabled' };
      lastStartResult.set(key, result);
      return result;
    }

    if (config.lyricsAutoStart === false && options.force !== true) {
      if (config.lyricsDebug) {
        console.log(`[lyrics-runner] auto-start skipped because lyricsAutoStart is disabled: chat=${chatId}`);
      }
      const result = { success: false, skipped: true, message: 'autoStartDisabled' };
      lastStartResult.set(key, result);
      return result;
    }

    const api = ctxOrApi?.api || ctxOrApi || globalBotApi;
    const apiAvailable = !!api;
    if (config.lyricsDebug) {
      console.log(`[lyrics-runner] api available check: chat=${chatId} available=${apiAvailable}`);
    }

    if (!api) {
      console.warn(`[lyrics-runner] Bot API instance is not available for auto-start in chat ${chatId}`);
      const result = { success: false, message: 'apiUnavailable' };
      lastStartResult.set(key, result);
      return result;
    }

    const result = await startLyricsForChat(chatId, api, track, { silent: true, preferCache: true, ...options });
    
    if (config.lyricsDebug) {
      console.log(`[lyrics-runner] startLyricsForChat result for chat=${chatId}: success=${result.success} message=${result.message || ''}`);
    }

    return result;
  } catch (error) {
    console.error(`[lyrics-runner] startLyricsForChatIfEnabled error for chat ${chatId}:`, error);
    const result = { success: false, message: 'error', error: error?.message };
    lastStartResult.set(key, result);
    return result;
  }
}

/**
 * Stops the lyrics runner for a chat.
 * @param {string|number} chatId
 * @param {string} [reason='unknown']
 * @returns {boolean} True if a runner was stopped
 */
export function stopLyricsForChat(chatId, reason = 'unknown') {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (runner) {
    if (config.lyricsDebug) {
      console.log(`[lyrics-runner] stopping runner for chat=${key} reason=${reason}`);
    }
    if (runner.timer) {
      clearInterval(runner.timer);
    }
    activeRunners.delete(key);
    return true;
  }
  return false;
}

/**
 * Resync the lyrics runner position after a seek operation.
 * @param {string|number} chatId
 */
export function resyncLyricsForChat(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (!runner) return;

  const activeTrack = voicePlayer.activeTrack(chatId);
  if (!activeTrack) return;

  const pos = playbackPositionSeconds(activeTrack);
  const newIndex = findInitialLastSentIndex(runner.lines, pos);
  debugLog(`resync for ${key}: position=${pos.toFixed(1)}s, oldIndex=${runner.lastSentIndex}, newIndex=${newIndex}`);
  runner.lastSentIndex = newIndex;
  runner.lastSentTimeMs = 0; // Allow immediate send after resync
  
  // Immediately run a tick to send the lyric at the seeked position without waiting
  runTick(key).catch(err => console.error(`Error in resync lyrics tick for chat ${key}:`, err));
}

/**
 * Gets the lyrics runner status for a chat.
 * @param {string|number} chatId
 * @returns {object} Status object
 */
export function getLyricsStatus(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  const activeTrack = voicePlayer.activeTrack(chatId);
  const lastResult = lastStartResult.get(key) || null;
  const apiAvailable = !!(runner?.api || globalBotApi);

  if (runner) {
    const currentPosition = activeTrack ? playbackPositionSeconds(activeTrack) : 0;
    return {
      active: true,
      track: runner.track,
      lastSentText: runner.lastSentText,
      lastSentIndex: runner.lastSentIndex,
      currentPosition: Math.round(currentPosition * 10) / 10,
      totalLines: runner.lines.length,
      provider: runner.provider,
      sourceId: runner.sourceId,
      startedAt: runner.startedAt,
      syncOffsetMs: config.lyricsSyncOffsetMs ?? 0,
      apiAvailable,
      lastResult,
      trackMatchLoose: activeTrack ? sameTrackLoose(activeTrack, runner.track) : false
    };
  }
  return {
    active: false,
    track: null,
    lastSentText: null,
    lastSentIndex: -1,
    currentPosition: 0,
    totalLines: 0,
    provider: null,
    sourceId: null,
    startedAt: null,
    syncOffsetMs: config.lyricsSyncOffsetMs ?? 0,
    apiAvailable,
    lastResult,
    trackMatchLoose: false
  };
}

export function stopAllLyrics() {
  for (const [key, runner] of activeRunners.entries()) {
    if (runner.timer) clearInterval(runner.timer);
    activeRunners.delete(key);
  }
}
