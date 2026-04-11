/**
 * Message Splitting — breaks long responses into platform-safe chunks.
 * Splits at natural boundaries (paragraphs, then sentences) to keep
 * messages readable when they span multiple sends.
 */

const PLATFORM_LIMITS = {
  discord:  2000,
  telegram: 4096,
  slack:    40000,
};

/**
 * Split text into chunks that fit within a platform's message limit.
 * Prefers paragraph breaks (\n\n), then sentence breaks (. ), then hard break.
 *
 * @param {string} text
 * @param {string} [platform='discord'] - 'discord', 'telegram', or 'slack'
 * @returns {string[]} Array of chunks, each within platform limit
 */
function splitMessage(text, platform = 'discord') {
  const maxLen = PLATFORM_LIMITS[platform] || PLATFORM_LIMITS.discord;

  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point within maxLen
    let splitAt = -1;

    // 1. Try paragraph break (\n\n)
    const paraIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (paraIdx > 0) {
      splitAt = paraIdx;
    }

    // 2. Try single newline
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', maxLen);
      if (nlIdx > 0) splitAt = nlIdx;
    }

    // 3. Try sentence break (. followed by space or end)
    if (splitAt === -1) {
      const slice = remaining.slice(0, maxLen);
      const sentenceMatch = slice.match(/.*[.!?]\s/s);
      if (sentenceMatch) splitAt = sentenceMatch[0].length;
    }

    // 4. Try word break (space)
    if (splitAt === -1) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLen);
      if (spaceIdx > 0) splitAt = spaceIdx;
    }

    // 5. Hard break at maxLen (last resort)
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

module.exports = { splitMessage, PLATFORM_LIMITS };
