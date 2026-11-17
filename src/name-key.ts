/**
 * (ADR-088 §7) How two names are compared — a contact's remark, my name for one of my addresses, and one against
 * the other: Unicode-normalised (NFC: a precomposed and a decomposed "café" are one name), without the white
 * space around them, whatever the case.
 */
export const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

/** A name as it is kept: NFC, trimmed (the case is the one you typed). */
export const nameAsKept = (name: string): string => name.normalize('NFC').trim();

/** The same name? */
export const sameName = (a: string, b: string): boolean => nameKey(a) === nameKey(b);
