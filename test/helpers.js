import { Game } from '../src/game/Game.js';

export const WORDS = [
  { term: 'Apokope', article: 'die', wordClass: 'Substantiv', definition: 'wegfall eines Lauts am Wortende', category: 'Sprache', difficulty: 2 },
  { term: 'Fiale', article: 'die', definition: 'Türmchen an gotischen Bauten.', category: 'Architektur', difficulty: 3 },
  { term: 'Pedell', article: 'der', definition: 'Hausmeister einer Hochschule.', category: 'Schule', difficulty: 1 },
  { term: 'Drumlin', article: 'der', definition: 'Hügel aus Gletschergeröll.', category: 'Geografie', difficulty: 3 },
];

export function createGame({ players = ['Anna', 'Ben', 'Chris'], settings = {}, now = 1_000 } = {}) {
  const game = new Game({
    code: 'ABCD',
    hostToken: 'host-token',
    settings: { wordlist: 'test', readAloudMode: false, ...settings },
    getWordlists: () => ({ test: { title: 'Test', words: WORDS } }),
    blockedWords: ['doof'],
    now,
  });
  game.setHostConnected(true, now);
  const ids = players.map((name) => game.addPlayer({ name }, now).id);
  return { game, ids };
}

/** Plays up to MODERATION with the given texts (index-aligned with ids; null = no answer). */
export function toModeration(game, ids, texts, now = 2_000) {
  game.startGame(now);
  ids.forEach((id, i) => {
    if (texts[i]) game.submitDefinition(id, texts[i], now);
  });
  if (game.phase === 'WRITING') game.endWriting(now);
}

export function ballotEntryBy(game, predicate) {
  return game.round.ballot.find(predicate);
}

export function ownEntry(game, playerId) {
  return ballotEntryBy(game, (e) => e.authorIds.includes(playerId));
}

export function realEntry(game) {
  return ballotEntryBy(game, (e) => e.isReal);
}

export function moderationDefinitionOf(game, playerId) {
  return game.round.definitions.find((d) => d.authorIds.includes(playerId));
}
