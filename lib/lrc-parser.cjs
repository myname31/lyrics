/**
 * Parser for synced lyrics in LRC format (.lrc).
 * Converts raw LRC text into a structured array of lyric lines with timestamps.
 */

const TIMESTAMP_REGEX = /\[(?:(\d{1,2}):)?(\d{2}):(\d{2})[\.:](\d{2,3})\]/g;

/**
 * Parses LRC format text.
 * @param {string} lrcText
 * @param {number} maxLines
 * @returns {Array<{time: number, text: string}>}
 */
exports.parseLrc = function(lrcText, maxLines = 500) {
  if (!lrcText || typeof lrcText !== 'string') {
    return [];
  }

  const lines = lrcText.split(/\r?\n/);
  const parsedLines = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Skip metadata tags like [ar:Artist], [ti:Title], [al:Album], [length:Time]
    if (trimmedLine.startsWith('[') && !trimmedLine.match(TIMESTAMP_REGEX)) {
      continue;
    }

    // Extract all timestamps in this line
    const times = [];
    let match;
    // Reset regex lastIndex just in case, though it's local
    TIMESTAMP_REGEX.lastIndex = 0;
    while ((match = TIMESTAMP_REGEX.exec(trimmedLine)) !== null) {
      const hh = parseInt(match[1] || '0', 10);
      const mm = parseInt(match[2], 10);
      const ss = parseInt(match[3], 10);
      const msStr = match[4];
      const ms = parseFloat(msStr) / Math.pow(10, msStr.length);
      
      const totalSeconds = hh * 3600 + mm * 60 + ss + ms;
      times.push(totalSeconds);
    }

    if (times.length === 0) continue;

    // The lyric text is the line content after removing all timestamps
    const lyricText = trimmedLine.replace(TIMESTAMP_REGEX, '').trim();
    if (!lyricText) continue;

    for (const time of times) {
      parsedLines.push({ time, text: lyricText });
    }
  }

  // Sort by time ascending
  parsedLines.sort((a, b) => a.time - b.time);

  // Remove duplicate consecutive empty lines (although we already skipped empty lyricText,
  // we keep this step or ensure we only take the first maxLines)
  const result = [];
  let lastText = '';
  for (const item of parsedLines) {
    if (item.text === lastText && item.text === '') {
      continue; // Skip consecutive empty texts (if empty was allowed)
    }
    result.push(item);
    lastText = item.text;
  }

  return result.slice(0, maxLines);
}
