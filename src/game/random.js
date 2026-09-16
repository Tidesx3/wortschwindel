import { randomBytes, randomInt, randomUUID } from 'node:crypto';

// Readable uppercase letters only: no O, I, L (and no digits at all).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateRoomCode(isTaken = () => false, length = 4) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error('Could not generate a unique room code');
}

export function randomId(bytes = 6) {
  return randomBytes(bytes).toString('base64url');
}

export function uuid() {
  return randomUUID();
}

export function shuffle(array, rand = Math.random) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
