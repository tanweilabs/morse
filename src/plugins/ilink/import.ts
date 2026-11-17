import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustedBaseUrl } from './ilink.js';
import { beijingNow, type Store } from './store.js';

/**
 * `morse plugin ilink import --from <weixin-bridge dir>` (ADR-053): reuse an existing binding so
 * the owner does not scan again. Copies the account (credentials, bound user) and the
 * long-poll cursor (+ the seen ids and anything still queued) into the plugin's own state
 * (0600). Refuses while the bridge or this plugin is running — two pollers on one binding
 * break it — and never prints a credential.
 */

const alive = (pidFile: string): number | null => {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    return pid > 0 && (process.kill(pid, 0), true) ? pid : null;
  } catch {
    return null;
  }
};

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export function importBridgeState(o: { from: string; store: Store; force?: boolean; profile?: string | null }): { ok: boolean; lines: string[]; claudeSession?: string } {
  const lines: string[] = [];
  const src = existsSync(join(o.from, 'state', 'account.json')) ? join(o.from, 'state') : o.from;
  const fail = (l: string) => ({ ok: false, lines: [...lines, `error: ${l}`] });
  const bridgePid = alive(join(src, 'run.pid'));
  if (bridgePid) return fail(`the bridge is still running (pid ${bridgePid}) — stop it first (two pollers on one binding break it); nothing was copied`);
  const ownPid = alive(o.store.path('run.pid'));
  if (ownPid && ownPid !== process.pid) return fail(`this plugin is running (pid ${ownPid}) — morse plugin disable ilink first`);
  if (existsSync(o.store.path('account.json')) && !o.force) return fail(`already bound (${o.store.path('account.json')}) — add --force to replace it`);

  const acc = readJson(join(src, 'account.json'));
  if (!acc) return fail(`no readable account.json in ${src}`);
  const str = (k: string) => (typeof acc[k] === 'string' && (acc[k] as string) ? (acc[k] as string) : null);
  const token = str('token');
  const allowedSender = str('allowedSender') ?? str('ownerUserId');
  let baseUrl: string;
  try {
    baseUrl = trustedBaseUrl(str('baseUrl') ?? '');
  } catch {
    return fail('the account has no WeChat base URL (only https hosts under weixin.qq.com / wechat.com are accepted)');
  }
  if (!token || !allowedSender) return fail('the account has no token or no bound user');
  o.store.writeJson('account.json', {
    token,
    botId: str('botId') ?? '',
    baseUrl,
    ownerUserId: str('ownerUserId') ?? allowedSender,
    allowedSender,
    boundAt: str('boundAt') ?? beijingNow(),
    importedAt: beijingNow(),
    importedFrom: src,
  });
  lines.push(`account copied (bot ${str('botId') ?? '?'}, bound ${str('boundAt') ?? '?'}) — the same binding, no new scan`);

  const inbox = readJson(join(src, 'inbox.json'));
  if (inbox) {
    const pending = Array.isArray(inbox['pending']) ? (inbox['pending'] as Array<{ id?: string }>) : [];
    const active = typeof inbox['active'] === 'string' ? inbox['active'] : null;
    // a message the bridge was in the middle of is not run a second time
    const kept = pending.filter((p) => p?.id !== active);
    o.store.writeJson('inbox.json', {
      cursor: typeof inbox['cursor'] === 'string' ? inbox['cursor'] : '',
      pending: kept,
      active: null,
      seen: Array.isArray(inbox['seen']) ? inbox['seen'] : [],
    });
    lines.push(`long-poll cursor copied${kept.length ? `, ${kept.length} queued message(s)` : ''}${active ? ' (the one it was in the middle of is dropped — resend it)' : ''}`);
  } else {
    o.store.remove('inbox.json');
    lines.push('no cursor found — WeChat may hand over recent messages again once');
  }
  o.store.remove('status.json');

  const sessions = readJson(join(src, 'session.json'));
  const claude = (sessions?.['claude'] as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof claude === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(claude)) {
    lines.push(
      o.profile
        ? `the bridge answered with Claude session ${claude}`
        : `the bridge answered with Claude session ${claude} — to keep that conversation: a dedicated launch profile + "plugins.ilink.profile", then  morse plugin ilink import --from … --profile <name>  (or "plugins.ilink.target": "@claude:${claude}")`,
    );
    return { ok: true, lines, claudeSession: claude };
  }
  return { ok: true, lines };
}
