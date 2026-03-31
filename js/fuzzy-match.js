function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function bestMatch(guess, candidates, maxDistance = 2) {
  const norm = guess.toUpperCase().replace(/[^A-Z]/g, '');
  if (!norm) return null;

  let best = null;
  let bestDist = maxDistance + 1;

  for (const word of candidates) {
    if (norm === word) return { word, distance: 0 };
    const dist = levenshtein(norm, word);
    if (dist < bestDist) {
      bestDist = dist;
      best = word;
    }
  }

  return bestDist <= maxDistance ? { word: best, distance: bestDist } : null;
}
