import { pointFactor } from './modifiers.js';

export const DEFAULT_POINTS = Object.freeze({
  correctVote: 2, // voted for the real definition
  perFooled: 1, // per foreign vote on your own invented definition
  markedCorrect: 3, // moderation marked your answer as (essentially) correct
  favorite: 2, // "Publikumsliebling": most favourite votes (modifier)
});

export function isVotable(definition) {
  return !definition.deleted && !definition.markedCorrect;
}

function emptyResult() {
  return {
    total: 0,
    votedReal: false,
    votedFor: null,
    fooledCount: 0,
    markedCorrect: false,
    correctPoints: 0,
    fooledPoints: 0,
    markedPoints: 0,
    favoritePoints: 0,
    favoriteWinner: false,
  };
}

/**
 * Scores one round. Pure function.
 * @param {object} args
 * @param {Array<{id: string, isReal: boolean, authorIds: string[], deleted?: boolean, markedCorrect?: boolean}>} args.definitions
 * @param {Record<string, string>} args.votes playerId -> definitionId
 * @param {string[]} args.playerIds all players taking part in this round
 * @param {typeof DEFAULT_POINTS} args.points
 * @param {string[]} [args.modifiers] active round modifiers
 * @param {string[]} [args.catchupIds] players doubled by "Aufholjagd"
 * @param {Record<string, string>} [args.favorites] playerId -> definitionId ("Publikumsliebling")
 */
export function scoreRound({ definitions, votes, playerIds, points = DEFAULT_POINTS, modifiers = [], catchupIds = [], favorites = {} }) {
  const players = {};
  for (const id of playerIds) players[id] = emptyResult();
  const factor = (playerId, kind) => pointFactor(modifiers, catchupIds, playerId, kind);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const votesByDefinition = {};
  // definitionId -> authorId -> points earned through that definition
  const entryPoints = {};
  for (const definition of definitions) {
    if (isVotable(definition)) votesByDefinition[definition.id] = [];
    entryPoints[definition.id] = {};
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
      const gained = (points.correctVote ?? 0) * factor(voterId, 'correct');
      result.votedReal = true;
      result.correctPoints += gained;
      result.total += gained;
    } else {
      for (const authorId of definition.authorIds) {
        const author = players[authorId];
        if (!author) continue;
        const gained = (points.perFooled ?? 0) * factor(authorId, 'fooled');
        author.fooledCount += 1;
        author.fooledPoints += gained;
        author.total += gained;
        entryPoints[definition.id][authorId] = (entryPoints[definition.id][authorId] ?? 0) + gained;
      }
    }
  }

  for (const definition of definitions) {
    if (definition.isReal || definition.deleted || !definition.markedCorrect) continue;
    for (const authorId of definition.authorIds) {
      const author = players[authorId];
      if (!author) continue;
      const gained = (points.markedCorrect ?? 0) * factor(authorId, 'marked');
      author.markedCorrect = true;
      author.markedPoints += gained;
      author.total += gained;
      entryPoints[definition.id][authorId] = (entryPoints[definition.id][authorId] ?? 0) + gained;
    }
  }

  let favorite = null;
  if (modifiers.includes('favorite')) {
    const favoriteVotes = {};
    for (const [voterId, definitionId] of Object.entries(favorites)) {
      const definition = byId.get(definitionId);
      if (!players[voterId] || !definition || !isVotable(definition)) continue;
      if (definition.authorIds.includes(voterId)) continue;
      (favoriteVotes[definitionId] ??= []).push(voterId);
    }
    // Only invented definitions can win; the real one just collects votes.
    const candidates = Object.entries(favoriteVotes).filter(([id]) => !byId.get(id).isReal);
    const best = Math.max(0, ...candidates.map(([, voters]) => voters.length));
    const winnerIds = best > 0 ? candidates.filter(([, voters]) => voters.length === best).map(([id]) => id) : [];
    for (const definitionId of winnerIds) {
      for (const authorId of byId.get(definitionId).authorIds) {
        const author = players[authorId];
        if (!author) continue;
        const gained = (points.favorite ?? 0) * factor(authorId, 'favorite');
        author.favoriteWinner = true;
        author.favoritePoints += gained;
        author.total += gained;
      }
    }
    favorite = { votesByDefinition: favoriteVotes, winnerIds, count: best };
  }

  return { players, votesByDefinition, entryPoints, favorite };
}
