/**
 * Scrape Provider.
 * Scrapes plain lyrics from sites like AZLyrics and Genius sequentially.
 * Only uses native fetch + cheerio. No headless browsers.
 */

import * as cheerio from 'cheerio';
import { config } from '../../../config/index.js';
import { normalizeLyricsMetadata } from '../track-metadata.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').includes('aborted');
}

/**
 * Fetch helper with size limit and timeout.
 */
async function fetchHtmlWithLimit(url) {
  const timeoutMs = config.lyricsScrapeTimeoutMs ?? 8000;
  const maxBytes = config.lyricsScrapeMaxBytes ?? 1000000; // 1 MB

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 404) {
      return { status: 'notFound', html: null };
    }
    if (response.status === 429) {
      return { status: 'rateLimited', html: null };
    }
    if (!response.ok) {
      return { status: 'error', html: null };
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return { status: 'error', html: null, reason: 'size-limit-exceeded' };
    }

    // Read body chunk by chunk to enforce size limit
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let receivedLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedLength += value.length;
        if (receivedLength > maxBytes) {
          await reader.cancel();
          return { status: 'error', html: null, reason: 'size-limit-exceeded' };
        }
        chunks.push(value);
      }
      const chunksAll = new Uint8Array(receivedLength);
      let position = 0;
      for (let chunk of chunks) {
        chunksAll.set(chunk, position);
        position += chunk.length;
      }
      const html = new TextDecoder('utf-8').decode(chunksAll);
      return { status: 'success', html };
    } else {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { status: 'error', html: null, reason: 'size-limit-exceeded' };
      }
      return { status: 'success', html: text };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      return { status: 'timeout', html: null };
    }
    return { status: 'error', html: null, error };
  }
}

/**
 * Guesses AZLyrics URL from artist and title.
 */
function getAZLyricsUrl(artist, title) {
  const cleanStr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanA = cleanStr(artist);
  const cleanT = cleanStr(title);
  if (!cleanT || !cleanA) return null;
  return `https://www.azlyrics.com/lyrics/${cleanA}/${cleanT}.html`;
}

/**
 * Parses AZLyrics HTML.
 */
function parseAZLyrics(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  let lyrics = '';

  // 1. Try comment-based selector (most specific and stable)
  $('div').each((i, elem) => {
    const commentHtml = $(elem).html() || '';
    if (commentHtml.includes('licensing@azlyrics.com') || commentHtml.includes('Usage of azlyrics.com')) {
      lyrics = $(elem).text().trim();
      if (lyrics) return false;
    }
  });

  // 2. Sibling combination selector: `.ringtone ~ div`
  if (!lyrics) {
    const text = $('.ringtone ~ div').text().trim();
    if (text.length > 100 && text.split('\n').length > 5) {
      lyrics = text;
    }
  }

  // 3. Fallback logic: any div with no class/id that has high text content
  if (!lyrics) {
    $('div:not([class]):not([id])').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.length > 200 && text.split('\n').length > 8 && !$(elem).find('div').length) {
        lyrics = text;
        return false;
      }
    });
  }

  return lyrics;
}

/**
 * Guesses Genius URL from artist and title.
 */
function getGeniusUrl(artist, title) {
  const clean = (s) => String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const cleanA = clean(artist);
  const cleanT = clean(title);
  if (!cleanT) return null;
  
  if (cleanA) {
    return `https://genius.com/${cleanA}-${cleanT}-lyrics`;
  }
  return `https://genius.com/${cleanT}-lyrics`;
}

/**
 * Parses Genius HTML.
 */
function parseGeniusLyrics(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  let lyrics = '';

  // Genius has multiple elements with [data-lyrics-container="true"]
  $('[data-lyrics-container="true"]').each((i, elem) => {
    let innerHtml = $(elem).html() || '';
    // Replace <br> tags with newline
    innerHtml = innerHtml.replace(/<br\s*\/?>/gi, '\n');
    // Strip other HTML tags
    const text = cheerio.load(innerHtml).text().trim();
    lyrics += text + '\n\n';
  });

  // Fallback to legacy Genius lyrics selectors
  if (!lyrics) {
    $('.lyrics').each((i, elem) => {
      lyrics += $(elem).text().trim() + '\n\n';
    });
  }

  return lyrics.trim();
}

function extractMetadataFromHtml(html, source) {
  if (!html) return { matchedTitle: '', matchedArtist: '' };
  try {
    const $ = cheerio.load(html);
    const titleText = $('title').text().trim();
    if (source === 'azlyrics') {
      const match = titleText.match(/^(.*?)\s*-\s*(.*?)\s*Lyrics\s*\|\s*AZLyrics\.com/i);
      if (match) {
        return {
          matchedArtist: match[1].trim(),
          matchedTitle: match[2].trim()
        };
      }
    } else if (source === 'genius') {
      const match = titleText.match(/^(.*?)\s*[–-—]\s*(.*?)\s*Lyrics\s*\|\s*Genius\s*Lyrics/i);
      if (match) {
        return {
          matchedArtist: match[1].trim(),
          matchedTitle: match[2].trim()
        };
      }
    }
  } catch (e) {
    // ignore
  }
  return { matchedTitle: '', matchedArtist: '' };
}

/**
 * Fetch lyrics using Scrape provider.
 */
export async function getLyrics(track, options = {}) {
  // Check if enabled via config
  const enabled = config.lyricsEnableScrapeFallback === true;
  if (!enabled) {
    return {
      provider: 'scrape',
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
      provider: 'scrape',
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

  // Generate URL tasks
  const tasks = [];
  for (const cand of meta.candidates) {
    // 1. AZLyrics
    const azUrl = getAZLyricsUrl(cand.artist, cand.title);
    if (azUrl) {
      tasks.push({ source: 'azlyrics', url: azUrl, parser: parseAZLyrics });
    }
    // 2. Genius
    const geniusUrl = getGeniusUrl(cand.artist, cand.title);
    if (geniusUrl) {
      tasks.push({ source: 'genius', url: geniusUrl, parser: parseGeniusLyrics });
    }
  }

  // Deduplicate tasks by URL
  const seenUrls = new Set();
  const uniqueTasks = [];
  for (const t of tasks) {
    if (!seenUrls.has(t.url)) {
      seenUrls.add(t.url);
      uniqueTasks.push(t);
    }
  }

  let rateLimitedCount = 0;
  let timeoutCount = 0;
  let errorCount = 0;

  // Run tasks sequentially
  for (const task of uniqueTasks) {
    if (config.lyricsDebug) {
      console.log(`[lyrics] scraping source: ${task.source} URL: ${task.url}`);
    }

    const res = await fetchHtmlWithLimit(task.url);

    if (res.status === 'rateLimited') {
      rateLimitedCount++;
      continue;
    }
    if (res.status === 'timeout') {
      timeoutCount++;
      continue;
    }
    if (res.status === 'notFound') {
      continue;
    }
    if (res.status !== 'success') {
      errorCount++;
      continue;
    }

    // Try parsing
    try {
      const plainLyrics = task.parser(res.html);
      if (plainLyrics && plainLyrics.length > 50) {
        if (config.lyricsDebug) {
          console.log(`[lyrics] successfully scraped lyrics from ${task.source}`);
        }
        const metaInfo = extractMetadataFromHtml(res.html, task.source);
        const hasMeta = Boolean(metaInfo.matchedTitle);
        const confidence = hasMeta ? 0.6 : 0.3;

        return {
          provider: 'scrape',
          status: 'plainOnly',
          synced: false,
          lines: [],
          plainLyrics,
          sourceId: task.source,
          confidence,
          reason: `scraped-${task.source}`,
          transient: false,
          matchedTitle: metaInfo.matchedTitle,
          matchedArtist: metaInfo.matchedArtist,
          matchedAlbum: '',
          matchedDuration: null,
          matchScore: hasMeta ? 60 : 20,
          debug: { source: task.source, url: task.url }
        };
      }
    } catch (e) {
      console.warn(`[lyrics] Failed to parse scraped content from ${task.source}:`, e.message);
    }
  }

  // Handle transient errors if any tasks failed with them
  if (rateLimitedCount > 0) {
    return {
      provider: 'scrape',
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

  if (timeoutCount > 0) {
    return {
      provider: 'scrape',
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

  return {
    provider: 'scrape',
    status: 'notFound',
    synced: false,
    lines: [],
    plainLyrics: '',
    sourceId: '',
    confidence: 0,
    reason: 'no-matching-lyrics-found',
    transient: false,
    debug: {}
  };
}
