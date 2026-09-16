/**
 * End-of-game awards, computed from the round history and player stats.
 * @param {import('./Game.js').Game} game
 */
export function computeStats(game) {
  const players = [...game.players.values()];
  const best = (key) => {
    const max = Math.max(0, ...players.map((p) => p.stats[key]));
    if (max === 0) return null;
    return { names: players.filter((p) => p.stats[key] === max).map((p) => p.name), count: max };
  };

  let mostConvincing = null;
  for (const round of game.history) {
    for (const definition of round.definitions) {
      if (definition.isReal || definition.deleted || definition.votes === 0) continue;
      if (!mostConvincing || definition.votes > mostConvincing.votes) {
        mostConvincing = {
          term: round.term,
          text: definition.text,
          authors: definition.authors,
          votes: definition.votes,
        };
      }
    }
  }

  return {
    bestBluffer: best('fooled'),
    dictionaryPro: best('correct'),
    mostConvincing,
    roundsPlayed: game.history.length,
  };
}
