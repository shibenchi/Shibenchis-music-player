// a random pick that leans away from what was played lately.
// `history` holds the ids in the order they were played (the newest last). a song that was played k songs ago has the
// weight (k / window) squared, so the song before this one hardly ever comes back at once and a song is back at full
// weight once `window` other songs have been played. a song that was not played yet has full weight, and the song that
// is playing now has none (unless it is the only one)

export function recencyWindow(count) {
  return Math.max(3, Math.min(40, Math.ceil(count * 0.6)));
}

// the weight of every item, in the order of the items
export function recencyWeights(items, keyOf, history, currentKey) {
  const window = recencyWindow(items.length);
  const lastSeen = new Map(); // id -> how many songs ago (1 is the song before)
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (!lastSeen.has(history[i])) lastSeen.set(history[i], history.length - i);
  }
  return items.map((item) => {
    const key = keyOf(item);
    if (currentKey !== undefined && currentKey !== null && key === currentKey) return 0;
    const ago = lastSeen.get(key);
    if (ago === undefined) return 1;
    return Math.max(0.02, Math.min(1, ago / window) ** 2);
  });
}

// the index of the pick, or -1 for an empty list
export function pickWithRecencyPenalty(items, keyOf, history, currentKey, random = Math.random) {
  if (!items.length) return -1;
  if (items.length === 1) return 0;
  const weights = recencyWeights(items, keyOf, history || [], currentKey);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    // everything is the song that is playing (the same song several times): any of them
    return Math.floor(random() * items.length);
  }
  let point = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    point -= weights[i];
    if (point < 0) return i;
  }
  return weights.length - 1;
}

// writes a play into the history (not twice in a row, and not growing without end)
export function recordPlayed(history, key, cap = 400) {
  if (!key) return history;
  if (history[history.length - 1] !== key) history.push(key);
  if (history.length > cap) history.splice(0, history.length - cap);
  return history;
}
