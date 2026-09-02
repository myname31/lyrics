/**
 * Lyrics runner scheduler.
 * Sends lyric lines as Telegram messages at appropriate timestamps.
 * Features: sync offset, correct start position, immediate first tick,
 * rate-limit-aware skipping, resync on seek, auto-next integration.
 */

const { config } = require('./config.js');
const { getLyrics } = require('./lyrics-service.js');
const { getCachedLyrics } = require('./lyrics-cache.js');
const { validateLyricsMatch } = require('./match-validator.js');

// Dynamic injection instances
let voicePlayer = null;
let chatCache = null;
let chatSettings = null;
let globalBotApi = null;

const activeRunners = new Map();
const lastStartResult = new Map();

function debugLog(...args) {
  if (config.lyricsDebug) console.log('[lyrics-runner]', ...args);
}

/**
 * Escape HTML special characters for Telegram messages.
 */
function htmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sets the global Bot API instance.
 * @param {any} api
 */
function setGlobalBotApi(api) {
  globalBotApi = api;
}

/**
 * Injects external dependencies dynamically.
 */
function setMusicPlayer(playerInstance) {
  voicePlayer = playerInstance;
}

function setChatCache(cacheInstance) {
  chatCache = cacheInstance;
}

function setChatSettings(settingsInstance) {
  chatSettings = settingsInstance;
}

/**
 * Normalizes track title/name text for loose comparison.
 */
function normalizeTrackText(value) {
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
function sameTrackLoose(activeTrack, requestedTrack) {
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
 * Calculate current playback position in seconds adjusted by sync offset.
 */
function playbackPositionSeconds(activeTrack) {
  if (!activeTrack?.startedAt) return 0;
  const startedMs = new Date(activeTrack.startedAt).getTime();
  const rawMs = Date.now() - startedMs;
  const syncOffset = config.lyricsSyncOffsetMs ?? 0;
  const adjustedMs = rawMs - syncOffset;
  return Math.max(0, adjustedMs / 1000);
}

/**
 * Find initial lastSentIndex based on playback position.
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
 * Combines adjacent lyric lines if close in time.
 */
function getLyricTextAndNextIndex(lines, startIndex) {
  const maxLineLength = config.lyricsMaxLineLength ?? 300;
  let text = lines[startIndex].text;
  let nextIndex = startIndex;

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
 * Periodic tick handler.
 */
async function runTick(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (!runner) return;

  if (runner.isTickRunning) return;
  runner.isTickRunning = true;

  try {
    // 1. Check active track if voicePlayer injected
    let activeTrack = null;
    if (voicePlayer && typeof voicePlayer.activeTrack === 'function') {
      activeTrack = voicePlayer.activeTrack(chatId);
      if (!activeTrack) {
        debugLog('no active track, stopping runner for', key);
        stopLyricsForChat(chatId, 'no-active-track');
        return;
      }

      const isSameTrack = sameTrackLoose(activeTrack, runner.track);

      if (!isSameTrack) {
        if (config.lyricsStrictTrackMatch) {
          debugLog('track changed (strict mismatch), stopping runner for', key);
          stopLyricsForChat(chatId, 'track-changed');
          return;
        } else if (config.lyricsDebug) {
          console.log(`[lyrics-runner] [${key}] loose track mismatch warning (active vs runner), continuing since strict matches are disabled.`);
        }
      }
    } else {
      activeTrack = runner.track;
    }

    // 2. Skip if playback is paused
    if (chatCache && typeof chatCache.isPaused === 'function' && chatCache.isPaused(chatId)) {
      return;
    }

    // 3. Calculate position
    const elapsedSeconds = playbackPositionSeconds(activeTrack);

    // 4. Find matching line
    let targetIndex = -1;
    for (let i = 0; i < runner.lines.length; i++) {
      if (runner.lines[i].time <= elapsedSeconds) {
        targetIndex = i;
      } else {
        break;
      }
    }

    // 5. Send lyric if new line found
    if (targetIndex !== -1 && targetIndex > runner.lastSentIndex) {
      const now = Date.now();
      const minInterval = config.lyricsMinSendIntervalMs ?? 1200;

      if (now - runner.lastSentTimeMs < minInterval) {
        if (targetIndex > runner.lastSentIndex + 1) {
          runner.lastSentIndex = targetIndex - 1;
        }
        return;
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
 */
async function startLyricsForChat(chatId, ctxOrApi, track, options = {}) {
  const key = String(chatId);
  const { silent = false, preferCache = false } = options;
  
  stopLyricsForChat(key, 'restart');

  const api = ctxOrApi?.api || ctxOrApi || globalBotApi;
  if (!api) {
    console.warn(`[lyrics-runner] Bot API instance is not available for chat ${chatId}`);
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
        lyricsResult = await getLyrics(track, { bypassNotFoundCache: bypassNotFound });
      }
    } else {
      lyricsResult = await getLyrics(track, { bypassNotFoundCache: bypassNotFound });
    }

    if (!lyricsResult || !lyricsResult.synced || lyricsResult.lines.length === 0) {
      let msg = lyricsResult?.status || 'notFound';
      const result = { success: false, message: msg, error: lyricsResult?.reason };
      lastStartResult.set(key, result);
      return result;
    }

    const validation = validateLyricsMatch(track, lyricsResult);
    if (!validation.ok) {
      const result = { success: false, message: 'lyricsMismatch', reason: validation.reason };
      lastStartResult.set(key, result);
      return result;
    }

    let activeTrack = track;
    if (voicePlayer && typeof voicePlayer.activeTrack === 'function') {
      const currentActive = voicePlayer.activeTrack(chatId);
      if (currentActive) {
        activeTrack = currentActive;
      }
    }

    const currentPosition = playbackPositionSeconds(activeTrack);
    const initialLastSentIndex = findInitialLastSentIndex(lyricsResult.lines, currentPosition);

    const runner = {
      chatId: key,
      api,
      track: {
        ...track,
        startedAt: activeTrack.startedAt || track.startedAt || new Date().toISOString()
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

    await runTick(key).catch(err => console.error(`Error in initial lyrics tick for chat ${key}:`, err));

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
 * Auto-start check.
 */
async function startLyricsForChatIfEnabled(chatId, ctxOrApi, track, options = {}) {
  const key = String(chatId);
  try {
    let enabled = true;
    if (chatSettings && typeof chatSettings.getLyricsEnabled === 'function') {
      enabled = await chatSettings.getLyricsEnabled(chatId);
    }

    if (!enabled) {
      const result = { success: false, skipped: true, message: 'disabled' };
      lastStartResult.set(key, result);
      return result;
    }

    if (config.lyricsAutoStart === false && options.force !== true) {
      const result = { success: false, skipped: true, message: 'autoStartDisabled' };
      lastStartResult.set(key, result);
      return result;
    }

    const api = ctxOrApi?.api || ctxOrApi || globalBotApi;
    if (!api) {
      const result = { success: false, message: 'apiUnavailable' };
      lastStartResult.set(key, result);
      return result;
    }

    return await startLyricsForChat(chatId, api, track, { silent: true, preferCache: true, ...options });
  } catch (error) {
    console.error(`[lyrics-runner] startLyricsForChatIfEnabled error for chat ${chatId}:`, error);
    const result = { success: false, message: 'error', error: error?.message };
    lastStartResult.set(key, result);
    return result;
  }
}

/**
 * Stops the lyrics runner for a chat.
 */
function stopLyricsForChat(chatId, reason = 'unknown') {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (runner) {
    if (runner.timer) {
      clearInterval(runner.timer);
    }
    activeRunners.delete(key);
    return true;
  }
  return false;
}

/**
 * Resync position after seek.
 */
function resyncLyricsForChat(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  if (!runner) return;

  let activeTrack = runner.track;
  if (voicePlayer && typeof voicePlayer.activeTrack === 'function') {
    activeTrack = voicePlayer.activeTrack(chatId) || runner.track;
  }

  const pos = playbackPositionSeconds(activeTrack);
  const newIndex = findInitialLastSentIndex(runner.lines, pos);
  runner.lastSentIndex = newIndex;
  runner.lastSentTimeMs = 0;
  
  runTick(key).catch(err => console.error(`Error in resync lyrics tick for chat ${key}:`, err));
}

/**
 * Status getter.
 */
function getLyricsStatus(chatId) {
  const key = String(chatId);
  const runner = activeRunners.get(key);
  const lastResult = lastStartResult.get(key) || null;
  const apiAvailable = !!(runner?.api || globalBotApi);

  if (runner) {
    let activeTrack = runner.track;
    if (voicePlayer && typeof voicePlayer.activeTrack === 'function') {
      activeTrack = voicePlayer.activeTrack(chatId) || runner.track;
    }
    const currentPosition = playbackPositionSeconds(activeTrack);
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
      trackMatchLoose: sameTrackLoose(activeTrack, runner.track)
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

function stopAllLyrics() {
  for (const [key, runner] of activeRunners.entries()) {
    if (runner.timer) clearInterval(runner.timer);
    activeRunners.delete(key);
  }
}

module.exports = {
  setGlobalBotApi,
  setMusicPlayer,
  setChatCache,
  setChatSettings,
  normalizeTrackText,
  sameTrackLoose,
  startLyricsForChat,
  startLyricsForChatIfEnabled,
  stopLyricsForChat,
  resyncLyricsForChat,
  getLyricsStatus,
  stopAllLyrics
};