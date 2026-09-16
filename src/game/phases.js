export const PHASES = Object.freeze({
  LOBBY: 'LOBBY',
  WRITING: 'WRITING',
  MODERATION: 'MODERATION',
  VOTING: 'VOTING',
  REVEAL: 'REVEAL',
  SCOREBOARD: 'SCOREBOARD',
  GAME_OVER: 'GAME_OVER',
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  LOBBY: ['WRITING'],
  WRITING: ['MODERATION', 'WRITING', 'GAME_OVER'],
  MODERATION: ['VOTING', 'WRITING', 'GAME_OVER'],
  VOTING: ['REVEAL', 'GAME_OVER'],
  REVEAL: ['SCOREBOARD', 'GAME_OVER'],
  SCOREBOARD: ['WRITING', 'GAME_OVER'],
  GAME_OVER: ['LOBBY'],
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new GameError('invalidTransition', `Transition ${from} -> ${to} not allowed`);
  }
}

export class GameError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
