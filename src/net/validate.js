import { GameError } from '../game/phases.js';

export function invalid(message = 'invalidPayload') {
  return new GameError('invalidPayload', message);
}

export function str(value, { max = 200, min = 0, name = 'value' } = {}) {
  if (typeof value !== 'string' || value.length > max || value.length < min) throw invalid(`${name} must be a string (${min}-${max})`);
  return value;
}

export function optionalStr(value, options) {
  if (value == null) return undefined;
  return str(value, options);
}

export function bool(value, name = 'value') {
  if (typeof value !== 'boolean') throw invalid(`${name} must be boolean`);
  return value;
}

export function int(value, { min = -Infinity, max = Infinity, name = 'value' } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer (${min}-${max})`);
  return value;
}

export function oneOf(value, allowed, name = 'value') {
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}

export function id(value, name = 'id') {
  return str(value, { min: 1, max: 64, name });
}

export function idList(value, { max = 50, name = 'ids' } = {}) {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${name} must be an array`);
  return value.map((item) => id(item, name));
}

export function object(value, name = 'payload') {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
  return value;
}
