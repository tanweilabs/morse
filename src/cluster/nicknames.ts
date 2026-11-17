/**
 * ADR-065: Morse has no nicknames — names are the viewer's remarks (./remarks.ts).
 * Only the relay protocol's normalisation is left here: the relay (relay-cf) still
 * accepts an old client's profile nickname, and its tests import this rule.
 */

/** Same rule as the relay (relay-cf/src/protocol.ts normalizeNickname). */
export function normalizeNickname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, 32).join('').trim();
}
