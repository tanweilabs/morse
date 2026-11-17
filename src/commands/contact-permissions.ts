import { join } from 'node:path';
import type { Contact } from '../mailbox/contacts.js';
import { readAttendantConfig, morseDataDirOf } from '../plugins/attendant/config.js';
import { describePermissions, editPermissions, type PermissionFlags, permissionLines, type PermissionTarget, type PermissionView, updateConfigFile } from '../plugins/attendant/permissions.js';

/**
 * ADR-070: `morse contact set … --cwd/--tools/--allow/--rate/--reset` and
 * `morse contact <who>` — the built-in attendant's settings in ~/.morse/config.json,
 * edited and shown from the contact commands (no command of its own).
 */

/** Edit plugins.attendant for a contact or a group; throws (nothing written) when it would not validate. */
export function setPermissions(target: PermissionTarget, flags: PermissionFlags, env: NodeJS.ProcessEnv = process.env): { where: string; group: string } {
  const { ctx } = readAttendantConfig(env);
  const r = updateConfigFile(join(morseDataDirOf(env), 'config.json'), (root) => editPermissions(root, target, flags, ctx));
  return { where: r.where, group: target.kind === 'group' ? r.where.slice('plugins.attendant.groups.'.length) : target.contact.group };
}

/** What the attendant does with this contact's messages now. */
export function attendantView(c: Pick<Contact, 'id' | 'handle' | 'remark' | 'group' | 'state'> & { inherits?: string | null }, env: NodeJS.ProcessEnv = process.env): { view: PermissionView; lines: string[] } {
  const { settings, enabled } = readAttendantConfig(env);
  const view = describePermissions(settings, { id: c.id, handle: c.handle, remark: c.remark, inherits: c.inherits ?? null, group: c.group, state: c.state, self: c.id === 'self' }, enabled);
  return { view, lines: permissionLines(view) };
}

/** The same for any member of a group (no contact entry of their own). */
export function groupView(group: string, env: NodeJS.ProcessEnv = process.env): { view: PermissionView; lines: string[] } {
  return attendantView({ id: `group:${group}`, handle: null, remark: null, group, state: 'active' }, env);
}
