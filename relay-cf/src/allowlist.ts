/**
 * The relay allowlist in Workers KV (also the handle directory):
 *
 *   <deviceId>  → {"handle":"mei","name":"mac-mini","addedAt":"…","via":"invite:…"}
 *   @<handle>   → ["<deviceId>", …]           (index: a person's devices)
 *
 * Written by the admin API (worker.ts), by invite redemption (invites.ts), or by
 * hand with `wrangler kv key put` — in which case both kinds of key must be kept.
 * Only the minimal KV surface is used so tests can pass a Map-backed fake.
 *
 * The same namespace also holds the frozen old-alias table of identity v3
 * (`alias:<handle>` → record, aliases.ts): loaded once with `wrangler kv bulk put`,
 * never written by the Worker, and not part of the allowlist — listings skip it.
 */

/** Keys of the frozen old-alias table (aliases.ts); never a device ID or an @handle index. */
export const ALIAS_PREFIX = 'alias:';

export interface AllowEntry {
  handle?: string;
  name?: string;
  addedAt?: string;
  /** How the device got here, e.g. "invite:3f9a1c2b7d4e" or "admin". */
  via?: string;
}

export interface AllowKV {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The part of KVNamespace.list used by listDeviceIds (a fake in tests). */
export interface AllowListKV {
  list(options?: { cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

/**
 * Every device ID on the allowlist: all pages of the namespace, without the @handle
 * indexes and the alias records that share it.
 */
export async function listDeviceIds(kv: AllowListKV): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    for (const k of page.keys) if (!k.name.startsWith('@') && !k.name.startsWith(ALIAS_PREFIX)) ids.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

export async function allowEntry(kv: AllowKV, id: string): Promise<AllowEntry | null> {
  const v = await kv.get(id, 'json');
  return v && typeof v === 'object' ? (v as AllowEntry) : null;
}

export async function isAllowlisted(kv: AllowKV, id: string): Promise<boolean> {
  return (await kv.get(id, 'json')) !== null;
}

export async function devicesOfHandle(kv: AllowKV, handle: string): Promise<string[]> {
  const v = await kv.get(`@${handle}`, 'json');
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function setHandleIndex(kv: AllowKV, handle: string, mutate: (ids: string[]) => string[]): Promise<void> {
  const ids = mutate(await devicesOfHandle(kv, handle));
  if (ids.length) await kv.put(`@${handle}`, JSON.stringify(ids));
  else await kv.delete(`@${handle}`);
}

/** Add or update a device; keeps the @handle index in step (moves it if the handle changed). */
export async function putDevice(kv: AllowKV, id: string, entry: AllowEntry): Promise<void> {
  const previous = await allowEntry(kv, id);
  await kv.put(id, JSON.stringify(entry));
  if (previous?.handle && previous.handle !== entry.handle) await setHandleIndex(kv, previous.handle, (ids) => ids.filter((x) => x !== id));
  if (entry.handle) {
    const handle = entry.handle;
    await setHandleIndex(kv, handle, (ids) => (ids.includes(id) ? ids : [...ids, id]));
  }
}

export async function removeDevice(kv: AllowKV, id: string): Promise<void> {
  const previous = await allowEntry(kv, id);
  await kv.delete(id);
  if (previous?.handle) await setHandleIndex(kv, previous.handle, (ids) => ids.filter((x) => x !== id));
}
