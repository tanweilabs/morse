import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser, systemExec, type AclDeps } from './acl.js';
import { isWindows } from './platform.js';
import { system32 } from './which.js';

/**
 * The daemon starts when the user logs on to Windows (ADR-080): a scheduled task for THIS
 * user, not elevated — and when Windows refuses to register it, the HKCU "Run" value instead.
 * Never a Windows service: that needs administrator rights and runs outside the user's
 * session, where the agents' session files and logins are not. Logging off stops the daemon;
 * the relay's offline mailbox keeps the mail meanwhile (ADR-073).
 *
 * Checked on a real Windows 11 (2026-11-15, docs/guides/windows-test-log.zh-CN.md): a
 * non-administrator can register the task for itself (even from an SSH session); run with
 * `schtasks /Run` it starts the daemon in the user's desktop session, without a window, and the
 * daemon outlives the task's own process. NOT yet seen: a real logon, and the Run-value fallback.
 */

export const AUTOSTART_TASK = 'MorseDaemon';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Windows ignores a Run value longer than this. */
const RUN_VALUE_MAX = 260;

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What the task / Run value runs: start the daemon in the background and return at once. */
const START_ARGS = 'start --background --no-wait';

export function runCommandLine(node: string, cli: string): string {
  return `"${node}" "${cli}" ${START_ARGS}`;
}

/**
 * The task definition. The three settings that differ from Task Scheduler's defaults matter on
 * a laptop: no 72-hour execution limit, start on battery, keep running on battery.
 */
export function taskXml(o: { node: string; cli: string; workdir: string; sid: string; account?: string }): string {
  // the account name comes from whoami in the console code page; if it did not decode cleanly, the SID names the same user
  const who = o.account && !/[�?]/.test(o.account) ? o.account : o.sid;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>Morse daemon - starts when you log on (https://morse.im)</Description></RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(who)}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${xml(o.sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    `  <Actions Context="Author"><Exec><Command>${xml(o.node)}</Command><Arguments>${xml(`"${o.cli}" ${START_ARGS}`)}</Arguments><WorkingDirectory>${xml(o.workdir)}</WorkingDirectory></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\r\n');
}

export interface AutostartDeps extends AclDeps {
  /** The node and dist/cli.js the daemon runs with (absolute paths). */
  node: string;
  cli: string;
  /** Where the daemon starts (the user's home). */
  workdir: string;
}

const said = (r: { stdout: string; stderr: string; code: number }): string => (r.stderr + r.stdout).trim().replace(/\s+/g, ' ') || `exit ${r.code}`;

export type AutostartKind = 'task' | 'run-key' | 'none';

export function autostartStatus(deps: Pick<AutostartDeps, 'platform' | 'exec' | 'env'>): { kind: AutostartKind } {
  if (!isWindows(deps.platform)) return { kind: 'none' };
  const exec = deps.exec ?? systemExec;
  if (exec(system32('schtasks.exe', deps.env), ['/Query', '/TN', AUTOSTART_TASK]).code === 0) return { kind: 'task' };
  if (exec(system32('reg.exe', deps.env), ['query', RUN_KEY, '/v', AUTOSTART_TASK]).code === 0) return { kind: 'run-key' };
  return { kind: 'none' };
}

/**
 * Register the logon start: the scheduled task; if Windows refuses it, the Run value. Exactly
 * one of the two is left in place. Throws when neither can be written.
 */
export function enableAutostart(deps: AutostartDeps): { kind: 'task' | 'run-key'; detail: string } {
  if (!isWindows(deps.platform)) throw new Error('morse autostart works only on Windows — on macOS / Linux the installer sets up launchd / systemd');
  const exec = deps.exec ?? systemExec;
  const schtasks = system32('schtasks.exe', deps.env);
  const reg = system32('reg.exe', deps.env);
  let taskError: string;
  const file = join(deps.tmpdir ?? tmpdir(), `morse-task-${randomBytes(6).toString('hex')}.xml`);
  try {
    const { sid, account } = currentUser(deps);
    // schtasks reads the definition as UTF-16 (with a byte-order mark)
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ node: deps.node, cli: deps.cli, workdir: deps.workdir, sid, account }), 'utf16le')]));
    const r = exec(schtasks, ['/Create', '/TN', AUTOSTART_TASK, '/XML', file, '/F']);
    if (r.code === 0) {
      exec(reg, ['delete', RUN_KEY, '/v', AUTOSTART_TASK, '/f']); // an earlier fallback: never both
      return { kind: 'task', detail: `scheduled task "${AUTOSTART_TASK}" (runs when you log on)` };
    }
    taskError = said(r);
  } catch (e) {
    taskError = e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(file, { force: true });
  }
  const line = runCommandLine(deps.node, deps.cli);
  if (line.length > RUN_VALUE_MAX) {
    throw new Error(`could not set up the logon start: scheduled task: ${taskError}; Run value: the command is ${line.length} characters, Windows ignores more than ${RUN_VALUE_MAX}`);
  }
  const r = exec(reg, ['add', RUN_KEY, '/v', AUTOSTART_TASK, '/t', 'REG_SZ', '/d', line, '/f']);
  if (r.code !== 0) throw new Error(`could not set up the logon start: scheduled task: ${taskError}; Run value: ${said(r)}`);
  exec(schtasks, ['/Delete', '/TN', AUTOSTART_TASK, '/F']);
  return { kind: 'run-key', detail: `registry Run value "${AUTOSTART_TASK}" (the scheduled task was refused: ${taskError})` };
}

export function disableAutostart(deps: Pick<AutostartDeps, 'platform' | 'exec' | 'env'>): { removed: Array<'task' | 'run-key'> } {
  if (!isWindows(deps.platform)) throw new Error('morse autostart works only on Windows — on macOS / Linux the installer sets up launchd / systemd');
  const exec = deps.exec ?? systemExec;
  const removed: Array<'task' | 'run-key'> = [];
  if (exec(system32('schtasks.exe', deps.env), ['/Delete', '/TN', AUTOSTART_TASK, '/F']).code === 0) removed.push('task');
  if (exec(system32('reg.exe', deps.env), ['delete', RUN_KEY, '/v', AUTOSTART_TASK, '/f']).code === 0) removed.push('run-key');
  return { removed };
}
