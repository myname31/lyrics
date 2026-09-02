/**
 * Track metadata normalization helper for lyrics lookup.
 */

export function normalizeTitle(title) {
  return cleanTitleTags(title);
}

/**
 * Clean common tags and noise from song titles.
 * @param {string} text
 * @returns {string}
 */
export function cleanTitleTags(text) {
  if (!text) return '';
  let cleaned = text;

  // Remove text in parentheses/brackets representing video types or extra details
  cleaned = cleaned.replace(/[\(\[](?:official\s+video|official\s+music\s+video|official\s+audio|lyric\s+video|lyrics|audio|hd|4k|hq|visualizer|mv|m\/v|lirik|official|music\s+video|lirik\s+video)[\)\]]/gi, '');

  // Remove quotes around official video / lyrics etc.
  cleaned = cleaned.replace(/["'](?:official\s+video|official\s+music\s+video|lyrics|audio|hd|4k|hq|lirik)["']/gi, '');

  // Remove #shorts
  cleaned = cleaned.replace(/#shorts\b/gi, '');

  // Remove video noise at the end (e.g. - Official Video, | Visualizer)
  cleaned = cleaned.replace(/\s*[-–—:|]\s*(?:official\s+video|official\s+music\s+video|lyric\s+video|lyrics|audio|hd|4k|hq|official|visualizer|mv|m\/v|lirik)\s*$/gi, '');
  cleaned = cleaned.replace(/\s+(?:official\s+video|official\s+music\s+video|lyric\s+video|lyrics|audio|hd|4k|hq|official|visualizer|mv|m\/v|lirik)\s*$/gi, '');

  // Remove empty parentheses/brackets resulting from tag cleaning (e.g. "()", "[]")
  cleaned = cleaned.replace(/[\(\[]\s*[\)\]]/g, '');

  // Remove double spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove surrounding quotes from the title
  cleaned = cleaned.replace(/^['"‘“`']\s*(.+?)\s*['"’”`']$/, '$1');

  return cleaned.trim();
}

/**
 * Parse artist and title from a raw string using common separators.
 * @param {string} rawTitle
 * @returns {{artist: string, title: string}|null}
 */
export function splitArtistTitle(rawTitle) {
  if (!rawTitle) return null;
  // Match separators: -, – (en-dash), — (em-dash), :, |
  // Allow optional whitespace before/after separator. For colon, make sure it has spaces or is followed by space
  const match = rawTitle.match(/^(.+?)\s*[-–—|]\s*(.+)$/) || rawTitle.match(/^(.+?)\s*:\s+(.+)$/);
  if (match) {
    return { artist: match[1].trim(), title: match[2].trim() };
  }
  return null;
}

/**
 * Normalize a string for matching comparison (Unicode-friendly lowercase alphanumeric).
 * Supports non-Latin alphabets and handles accents using NFKD normalization.
 * @param {string} str
 * @returns {string}
 */
export function normalizeForMatch(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes track metadata and produces lookup candidates.
 * @param {object} track
 * @returns {object}
 */
export function normalizeLyricsMetadata(track) {
  const rawTitle = (track.title || track.name || '').trim();
  const trackArtist = (track.artist || '').trim();
  const album = (track.album || '').trim();

  // 1. Duration calculation
  let durationSeconds = 0;
  if (track.duration) {
    if (typeof track.duration === 'number') {
      durationSeconds = Math.round(track.duration);
    } else if (typeof track.duration === 'string') {
      const parts = track.duration.split(':');
      if (parts.length === 2) {
        durationSeconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      } else if (parts.length === 3) {
        durationSeconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
      } else {
        durationSeconds = parseInt(track.duration, 10) || 0;
      }
    }
  }

  // 2. Split logic
  const splitRes = splitArtistTitle(rawTitle);
  let splitArtist = '';
  let splitTitle = '';
  if (splitRes) {
    const cleanedSplitTitle = cleanTitleTags(splitRes.title);
    if (cleanedSplitTitle.length >= 2 && splitRes.artist.length <= 80 && splitRes.artist.length > 0) {
      splitArtist = splitRes.artist;
      splitTitle = cleanedSplitTitle;
    }
  }

  // Primary normalization
  let artist = trackArtist;
  let title = '';
  const rawTitleCleaned = cleanTitleTags(rawTitle);

  if (artist) {
    title = rawTitleCleaned;
    // Remove artist prefix if present
    const artistEscaped = artist.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const prefixRegex = new RegExp(`^${artistEscaped}\\s*[-–—:|]\\s*`, 'i');
    if (prefixRegex.test(title)) {
      title = title.replace(prefixRegex, '');
    } else {
      const prefixRegexNoSep = new RegExp(`^${artistEscaped}\\s+`, 'i');
      if (prefixRegexNoSep.test(title)) {
        title = title.replace(prefixRegexNoSep, '');
      }
    }
    title = cleanTitleTags(title);
  } else {
    if (splitArtist && splitTitle) {
      artist = splitArtist;
      title = splitTitle;
    } else {
      artist = '';
      title = rawTitleCleaned;
    }
  }

  // Clean artist of featuring/ft names
  const cleanFeaturedArtist = (art) => art.replace(/\s+(?:ft\.?|feat\.?|featuring)\s+.+$/gi, '').trim();
  const cleanSplitArtist = splitArtist ? cleanFeaturedArtist(splitArtist) : '';
  const cleanPrimaryArtist = artist ? cleanFeaturedArtist(artist) : '';

  // Generate candidates
  const rawCandidates = [
    { title, artist, reason: 'normalized-primary' },
    { title: rawTitleCleaned, artist: trackArtist, reason: 'raw-cleaned' }
  ];

  if (splitTitle && splitArtist) {
    rawCandidates.push({ title: splitTitle, artist: splitArtist, reason: 'split-artist-title' });
    if (cleanSplitArtist !== splitArtist) {
      rawCandidates.push({ title: splitTitle, artist: cleanSplitArtist, reason: 'split-artist-cleaned' });
    }
  }

  if (cleanPrimaryArtist !== artist) {
    rawCandidates.push({ title, artist: cleanPrimaryArtist, reason: 'primary-artist-cleaned' });
  }

  // Fallback to title-only
  rawCandidates.push({ title: title || rawTitleCleaned, artist: '', reason: 'title-only' });

  // Deduplicate candidates
  const candidates = [];
  const seen = new Set();
  for (const c of rawCandidates) {
    if (!c.title) continue;
    const key = `${normalizeForMatch(c.title)}|${normalizeForMatch(c.artist)}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(c);
    }
  }

  return {
    rawTitle,
    title,
    artist,
    album,
    durationSeconds,
    candidates,
    debug: {
      splitArtist,
      splitTitle,
      rawTitleCleaned
    }
  };
}
