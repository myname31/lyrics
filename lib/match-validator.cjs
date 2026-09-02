const { normalizeLyricsMetadata, normalizeForMatch } = require('./track-metadata.js');

function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = [];

  for (let i = 1; i <= m; i++) {
    curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr.push(Math.min(
        curr[j - 1] + 1, // Insertion
        prev[j] + 1,     // Deletion
        prev[j - 1] + cost // Substitution
      ));
    }
    prev = curr;
  }
  return prev[n];
}

function levenshteinSimilarity(s1, s2) {
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return 1.0 - dist / maxLength;
}

function getTitleSimilarity(title1, title2) {
  const t1 = normalizeForMatch(title1);
  const t2 = normalizeForMatch(title2);
  if (!t1 || !t2) return 0;
  if (t1 === t2) return 1.0;
  if (t1.includes(t2) || t2.includes(t1)) return 0.85;

  const words1 = t1.split(/\s+/).filter(w => w.length > 0);
  const words2 = t2.split(/\s+/).filter(w => w.length > 0);
  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let intersectionSize = 0;
  for (const w of set1) {
    if (set2.has(w)) {
      intersectionSize++;
    }
  }
  const tokenOverlap = intersectionSize / Math.max(words1.length, words2.length);
  const levSim = levenshteinSimilarity(t1, t2);

  return Math.max(tokenOverlap, levSim);
}

function getArtistSimilarity(artist1, artist2) {
  const a1 = normalizeForMatch(artist1);
  const a2 = normalizeForMatch(artist2);
  if (!a1 || !a2) return 0;
  if (a1 === a2) return 1.0;
  if (a1.includes(a2) || a2.includes(a1)) return 0.85;

  const words1 = a1.split(/\s+/).filter(w => w.length > 0);
  const words2 = a2.split(/\s+/).filter(w => w.length > 0);
  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let intersectionSize = 0;
  for (const w of set1) {
    if (set2.has(w)) {
      intersectionSize++;
    }
  }
  const tokenOverlap = intersectionSize / Math.max(words1.length, words2.length);
  const levSim = levenshteinSimilarity(a1, a2);

  return Math.max(tokenOverlap, levSim);
}

/**
 * Validates whether the lyrics result matches the played track.
 * @param {object} track - Current playing track info
 * @param {object} result - Lyric search result from provider
 * @returns {object} Validation result
 */
function validateLyricsMatch(track, result) {
  if (!track || !result) {
    return {
      ok: false,
      confidence: 0,
      reason: 'invalidArgs',
      details: { titleSimilarity: 0, artistSimilarity: 0, durationDiff: null, providerConfidence: 0 }
    };
  }

  const meta = normalizeLyricsMetadata(track);

  const matchedTitle = result.matchedTitle || '';
  const matchedArtist = result.matchedArtist || '';
  const matchedDuration = (result.matchedDuration !== undefined && result.matchedDuration !== null)
    ? Number(result.matchedDuration)
    : null;
  const providerConfidence = result.confidence !== undefined ? Number(result.confidence) : 0.5;

  const rawTitle = track.title || track.name || '';
  const metadataTitle = meta.title || '';

  // Calculate Title Similarity
  const simRaw = getTitleSimilarity(rawTitle, matchedTitle);
  const simMeta = getTitleSimilarity(metadataTitle, matchedTitle);
  const titleSimilarity = Math.max(simRaw, simMeta);

  // Calculate Artist Similarity
  const hasOriginalArtist = Boolean(track.artist && track.artist.trim());
  const rawArtistSim = getArtistSimilarity(track.artist || '', matchedArtist);
  const metaArtistSim = getArtistSimilarity(meta.artist || '', matchedArtist);

  let artistSimilarity = 1.0;
  if (hasOriginalArtist) {
    artistSimilarity = Math.max(rawArtistSim, metaArtistSim);
  } else if (meta.artist) {
    artistSimilarity = metaArtistSim;
  }

  // Calculate Duration Difference
  let durationDiff = null;
  if (meta.durationSeconds > 0 && matchedDuration !== null && matchedDuration > 0) {
    durationDiff = Math.abs(meta.durationSeconds - matchedDuration);
  }

  // Calculate overall confidence score
  const titleWeight = 0.5;
  const artistWeight = 0.3;
  const durationWeight = 0.2;

  let durationScore = 1.0;
  if (durationDiff !== null) {
    if (durationDiff <= 3) durationScore = 1.0;
    else if (durationDiff <= 8) durationScore = 0.8;
    else if (durationDiff <= 20) durationScore = 0.5;
    else if (durationDiff <= 45) durationScore = 0.2;
    else durationScore = 0.0;
  }

  const confidence = (titleSimilarity * titleWeight) +
                     (artistSimilarity * artistWeight) +
                     (durationScore * durationWeight);

  const durationOkay = (durationDiff === null) || (durationDiff <= 8);

  const details = {
    titleSimilarity,
    artistSimilarity,
    durationDiff,
    providerConfidence
  };

  // E. Reject conditions
  if (titleSimilarity < 0.45) {
    return { ok: false, confidence, reason: 'lowConfidenceTitle', details };
  }
  if (hasOriginalArtist && artistSimilarity < 0.35) {
    return { ok: false, confidence, reason: 'artistMismatch', details };
  }
  if (durationDiff !== null && durationDiff > 45 && titleSimilarity < 0.9) {
    return { ok: false, confidence, reason: 'durationMismatch', details };
  }
  if (providerConfidence < 0.4 && !matchedTitle.trim()) {
    return { ok: false, confidence, reason: 'lowConfidenceNoTitle', details };
  }

  // G. Low confidence (0.45 <= titleSimilarity < 0.65)
  if (titleSimilarity < 0.65) {
    return { ok: false, confidence, reason: 'lowConfidenceTitle', details };
  }

  // F. Accept conditions
  const isLrclibMatchScoreHigh = result.provider === 'lrclib' && result.matchScore !== undefined && result.matchScore >= 150;

  if (
    (titleSimilarity >= 0.75 && durationOkay) ||
    (titleSimilarity >= 0.65 && artistSimilarity >= 0.5) ||
    (titleSimilarity >= 0.9) ||
    isLrclibMatchScoreHigh
  ) {
    return { ok: true, confidence, reason: 'matchAccepted', details };
  }

  return { ok: false, confidence, reason: 'lowConfidence', details };
}

module.exports = {
  validateLyricsMatch
};
