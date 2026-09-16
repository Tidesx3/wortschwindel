export const DEFAULT_POINTS = Object.freeze({
  correctVote: 2, // voted for the real definition
  perFooled: 1, // per foreign vote on your own invented definition
  markedCorrect: 3, // moderation marked your answer as (essentially) correct
});

export function isVotable(definition) {
  return !definition.deleted && !definition.markedCorrect;
}

function emptyResult() {
  return { total: 0, votedReal: false, votedFor: null, fooledCount: 0, markedCorrect: false };
}

/**
 * Scores one round. Pure function.
 * @param {object} args
 * @param {Array<{id: string, isReal: boolean, authorIds: string[], deleted?: boolean, markedCorrect?: boolean}>} args.definitions
 * @param {Record<string, string>} args.votes playerId -> definitionId
 * @param {string[]} args.playerIds all players taking part in this round
 * @param {typeof DEFAULT_POINTS} args.points
 * @returns {{players: Record<string, object>, votesByDefinition: Record<string, string[]>}}
 */
export function scoreRound({ definitions, votes, playerIds, points = DEFAULT_POINTS }) {
  const players = {};
  for (const id of playerIds) players[id] = emptyResult();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const votesByDefinition = {};
  for (const definition of definitions) {
    if (isVotable(definition)) votesByDefinition[definition.id] = [];
  }

  for (const [voterId, definitionId] of Object.entries(votes)) {
    const result = players[voterId];
    const definition = byId.get(definitionId);
    if (!result || !definition || !isVotable(definition)) continue;
    // Own votes are rejected on input already; ignore them defensively here too.
    if (definition.authorIds.includes(voterId)) continue;
    votesByDefinition[definition.id].push(voterId);
    result.votedFor = definition.id;
    if (definition.isReal) {
      result.votedReal = true;
      result.total += points.correctVote;
    } else {
      for (const authorId of definition.authorIds) {
        if (!players[authorId]) continue;
        players[authorId].fooledCount += 1;
        players[authorId].total += points.perFooled;
      }
    }
  }

  for (const definition of definitions) {
    if (definition.isReal || definition.deleted || !definition.markedCorrect) continue;
    for (const authorId of definition.authorIds) {
      if (!players[authorId]) continue;
      players[authorId].markedCorrect = true;
      players[authorId].total += points.markedCorrect;
    }
  }

  return { players, votesByDefinition };
}
