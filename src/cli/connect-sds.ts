import { shortenHome } from '../format.js';

/** How `morse connect sds` lays a change out: the action in a column of nine, its note under the path. */
const ACTION_WIDTH = 9;
const NOTE_INDENT = ' '.repeat(2 + ACTION_WIDTH + 1);

/**
 * `morse connect sds [--uninstall] [--apply]`: wire 闪电说 (a desktop App with its own assistant, ADR-024) up
 * to Morse, or take that out again. Without --apply only the plan is shown — nothing is written.
 */
export async function connectSds(opts: { apply?: boolean; uninstall?: boolean; appHome?: string; port?: string }): Promise<void> {
  const { resolveSdsPaths, planSdsInstall, planSdsUninstall, applyChanges, SDS_AGENT } = await import('../integrations/sds.js');
  const { ensureExternalToken, removeExternalToken, explicitPort, daemonOfThisHome } = await import('../daemon/local-api.js');
  const paths = resolveSdsPaths(opts.appHome ? { appHome: opts.appHome } : {});
  const port = explicitPort(opts.port) ?? daemonOfThisHome()?.port ?? 7433;

  let plan: ReturnType<typeof planSdsInstall>;
  try {
    plan = opts.uninstall ? planSdsUninstall(paths) : planSdsInstall(paths, { port });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const out = [`闪电说 data dir: ${shortenHome(paths.appHome)}`, `workspace:      ${shortenHome(paths.workspace)}`, ''];
  for (const change of plan) out.push(`  ${change.action.padEnd(ACTION_WIDTH)} ${shortenHome(change.path)}`, `${NOTE_INDENT}↳ ${change.note}`);
  out.push('');
  for (const line of out) console.log(line);

  if (!opts.apply) {
    console.log('preview only — nothing was written. Re-run with --apply to write these changes.');
    return;
  }
  // (ADR-087) the app's own token for the local API: made when it is connected, gone when it is removed
  // (follow-up 1: the app names its own session id — the token may bind itself to one that is nobody else's)
  if (opts.uninstall) {
    removeExternalToken(SDS_AGENT);
    applyChanges(plan);
    console.log('removed.');
    return;
  }
  ensureExternalToken(SDS_AGENT, undefined, { open: true });
  applyChanges(plan);
  console.log('installed.');
  console.log('Restart 闪电说 (or just start a new message) and say 「有我的消息吗」 to test it.');
}
