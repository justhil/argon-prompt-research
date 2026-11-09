export const ERR_MINIMAL_NOT_SUPPORTED = 'ERR_MINIMAL_NOT_SUPPORTED: MINIMAL thinking_level is rejected on Gemini 4 Argon';
export const ALLOWED_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function validateArgonThinking(level = 'HIGH') {
  if (level === 'MINIMAL' || !ALLOWED_LEVELS.has(level)) {
    throw new Error(ERR_MINIMAL_NOT_SUPPORTED);
  }
  return level;
}
