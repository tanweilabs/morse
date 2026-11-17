import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { externalHeaderPath } from '../daemon/local-api.js';

// Connecting 闪电说 (Shandianshuo), the first registered external agent (ADR-024).
//
// Its assistant runs inside a Tauri app (DeepSeek-Harness SDK runtime), which
// decides how it can reach Morse:
//   - its shell is a non-interactive bash with the app's bare GUI PATH
//     (/usr/bin:/bin:/usr/sbin:/sbin) and no $SHELL: no `morse`/`anyd`, no .zshrc;
//   - its sandbox is workspace-write: writing outside the workspace (e.g. ~/.morse)
//     needs approval, but reading, networking and seeing processes do not — hence
//     plain HTTP to the local daemon;
//   - a skill folder dropped in by hand stays switched off until its key is set in
//     skills-state.json.
// So `morse connect sds` writes three things into the app's own data directory —
// the skill, its switch, a block in AGENTS.md — and touches nothing else there.

export interface SdsPaths {
  appHome: string;
  workspace: string;
  skillDir: string;
  skillFile: string;
  stateFile: string;
  agentsFile: string;
}

export interface SdsChange {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'delete';
  /** What the file will contain; not set for a delete. */
  content?: string;
  /** A one-line explanation shown in the preview. */
  note: string;
}

// These keep the pre-Morse name on purpose (ADR-064): installs made by earlier
// releases are found by them — the skill folder, its switch key, the block fences.
const SKILL_NAME = 'anytoany';
const STATE_KEY = 'voice_assistant/' + SKILL_NAME; // the app files assistant skills under voice_assistant/
const FENCE_OPEN = '<!-- anytoany:begin -->';
const FENCE_CLOSE = '<!-- anytoany:end -->';

const DAEMON_PORT = 7433;

/** The external agent name 闪电说 registers and sends as; its local-API token (ADR-087) is stored under it. */
export const SDS_AGENT = 'sds';

/** Where the app keeps its data on macOS (bundle id cn.shandianshuo.desktop). */
export function defaultAppHome(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Shandianshuo');
}

/** The workspace the user moved it to, if the app's migration marker says so. */
function movedWorkspace(appHome: string): string | null {
  let marker: { workspacePath?: unknown };
  try {
    marker = JSON.parse(readFileSync(join(appHome, 'migrations', 'workspace-location-v1.json'), 'utf8')) as typeof marker;
  } catch {
    return null;
  }
  const moved = marker?.workspacePath;
  return typeof moved === 'string' && moved !== '' ? moved : null;
}

export function resolveSdsPaths(opts: { appHome?: string; home?: string } = {}): SdsPaths {
  const appHome = opts.appHome ?? defaultAppHome(opts.home);
  const workspace = movedWorkspace(appHome) ?? join(appHome, 'workspace');
  const skillDir = join(workspace, 'library', 'skills', SKILL_NAME);
  const skillFile = join(skillDir, 'SKILL.md');
  const stateFile = join(appHome, 'skills', 'skills-state.json'); // the app's own switch file, outside the workspace
  const agentsFile = join(workspace, 'AGENTS.md');
  return { appHome, workspace, skillDir, skillFile, stateFile, agentsFile };
}

/** Where our fenced block sits in `doc`: [index of the opening fence, index just past the closing one]. */
function fencedSpan(doc: string): [number, number] | null {
  const open = doc.indexOf(FENCE_OPEN);
  const close = doc.indexOf(FENCE_CLOSE);
  if (open < 0 || close < 0 || close < open) return null;
  return [open, close + FENCE_CLOSE.length];
}

/** Put `body` in our fenced block: replace the block if `existing` has one, else add it at the end. Nothing outside it changes. */
export function upsertMarkedBlock(existing: string, body: string): string {
  const block = [FENCE_OPEN, body, FENCE_CLOSE].join('\n');
  const span = fencedSpan(existing);
  if (span) return existing.slice(0, span[0]) + block + existing.slice(span[1]);
  if (existing === '') return block + '\n';
  // keep the user's text as it is, end it with a newline, then one blank line before ours
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + separator + block + '\n';
}

/** Take our fenced block out of `existing`; without one the text comes back as it was. */
export function removeMarkedBlock(existing: string): string {
  const span = fencedSpan(existing);
  if (!span) return existing;
  const before = existing.slice(0, span[0]).replace(/\n+$/, '\n');
  const after = existing.slice(span[1]).replace(/^\n+/, '');
  return before + after;
}

// ---- the text the assistant reads -------------------------------------------------

/** Its session id, as the app hands it to the shell. */
const SESSION_LINE = 'SID="${DSH_SESSION_ID:-${SHANDIANSHUO_DSH_SESSION_ID:-main}}"';

/**
 * The token header as a curl argument (ADR-087): `-H @<file>` makes curl read it from
 * a file only the user can read. The assistant may read files but not write ~/.morse,
 * and this way the token is in neither these instructions nor any command line
 * (`$(cat …)`, used once, put it where `ps` shows it). Quoted as one shell word.
 */
const tokenHeader = (headerFile: string): string => `-H @'${headerFile.split("'").join(`'\\''`)}'`;

/** A JSON body as one double-quoted shell word, so `$SID` inside it still expands. */
const shellJson = (value: unknown): string => `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;

const sessionRef = { agent: SDS_AGENT, sessionId: '$SID' };
const inboxBody = shellJson({ ...sessionRef, register: true, title: '闪电说助手' });
const sendBody = shellJson({ target: '@codex:sunoprompt', from: sessionRef, text: '请把登录页的报错修掉，改完回我' });

/** A curl command; each extra part goes on its own continuation line. */
const curl = (first: string, ...more: string[]): string => [`curl -s ${first}`, ...more].join(' \\\n  ');

const bash = (...lines: string[]): string => ['```bash', ...lines, '```'].join('\n');

interface Wiring {
  url: (endpoint: string) => string;
  auth: string;
}

const wiring = (port: number, tokenFile: string): Wiring => ({
  url: (endpoint) => `http://127.0.0.1:${port}/api/${endpoint}`,
  auth: tokenHeader(tokenFile),
});

const JSON_TYPE = "-H 'content-type: application/json'";

export function sdsSkillMarkdown(port: number = DAEMON_PORT, tokenFile: string = externalHeaderPath(SDS_AGENT)): string {
  const { url, auth } = wiring(port, tokenFile);
  const sections = [
    [
      '---',
      `name: ${SKILL_NAME}`,
      'description: 给这台电脑上的其他 AI agent 会话（Claude Code、Codex、Kimi、Z Code）派活、提问、收回信。用户说「让 Claude Code／Codex 去做…」「问一下某个会话」「有新消息／回信吗」「XX 项目那边进展如何」时使用。',
      '---',
    ].join('\n'),
    [
      '# Morse：和本机其他 AI agent 通信',
      '',
      '用户只跟你说话；真正干活的是专门的 agent 会话（Claude Code、Codex 等）。你负责把活派过去，再把它们的回信讲给用户听。',
      '',
      '所有操作都是对本机 Morse 服务发 HTTP 请求，用 `curl`（一定装着）。**别去运行 `anyd` 或 `morse` 命令**：它们不在你的 PATH 里，沙箱也不让它们写数据。',
    ].join('\n'),
    ['## 你是谁', '', '你的会话号这样取；收信、发信的命令都以这一行开头：', '', bash(SESSION_LINE)].join('\n'),
    [
      '## 一、收信（每轮对话一开始做一次）',
      '',
      bash(SESSION_LINE, curl(`-m 10 -X POST ${url('inbox')}`, auth, JSON_TYPE, `-d ${inboxBody}`)),
      '',
      '会返回 `{"count":N,"text":"...","messages":[...]}`。`count` 是 0 就不用提；不是 0 就把 `text` 里的内容**原样讲给用户**（谁发的、说了什么），没有的内容不要编。',
      '',
      '`register:true` 顺便把你登记成 `@sds`，这样别人才能回信给你。每次都带上，重复登记没有副作用。',
    ].join('\n'),
    [
      '## 二、看看能找谁',
      '',
      bash(curl(`-m 20 ${auth} "${url('sessions')}?q=项目关键词&limit=10"`)),
      '',
      '`q` 匹配会话标题或项目文件夹名；不写 `limit` 时最多给 50 条。每条结果有 `agent` 和 `title`，发信时写 `@<agent>:<title 里的一段>`，比如 `@codex:sunoprompt`。',
    ].join('\n'),
    [
      '## 三、发信（派活或提问）',
      '',
      bash(SESSION_LINE, curl(`-m 30 -X POST ${url('send')}`, auth, JSON_TYPE, `-d ${sendBody}`)),
      '',
      '- 返回 201 就是发出去了。返回 422 是没找到这个目标：先用第二步查到真实的 `title`，再发一次。',
      '- `from` 必须写你自己，回信才能回到你这里。',
      '- 对方看不到你和用户聊了什么，所以消息里要**把来龙去脉写全**。',
    ].join('\n'),
    [
      '## 要记住的',
      '',
      '- **回信不会马上来**：对方要花时间干活。发完告诉用户「已经交给它了」，下一轮再收信，不要原地等。',
      '- **你不会自己醒来**：只有用户跟你说话时你才会去收信。新消息到了，系统会弹一条 macOS 通知，提醒用户来问你。',
      '- curl 连不上，说明 Morse 服务没在运行：就照实告诉用户「Morse 服务没在跑」，别说已经发出去了。',
      "- 每条 curl 都要带上面那个 `-H @'…'`：curl 会从本机一个只有用户能读的文件里取出口令头，文件内容不要打印出来。`content-type` 也必须是 `application/json`。返回 401 说明口令不对或那个文件不在了：照实告诉用户「请在终端运行 morse connect sds --apply 重新接入」，不要重试。你只能用 `sds` 这个身份、用自己的会话收信和发信，不能带附件。",
    ].join('\n'),
  ];
  return sections.join('\n\n') + '\n';
}

/** The standing instruction kept in the app's AGENTS.md, between our fences. */
function sdsAgentsBlock(port: number = DAEMON_PORT, tokenFile: string = externalHeaderPath(SDS_AGENT)): string {
  const { url, auth } = wiring(port, tokenFile);
  return [
    '## Morse：跨 agent 消息（由 `anyd connect sds` 写入，`anyd connect sds --uninstall` 可移除）',
    '',
    '每轮对话开始先悄悄收一次信；有新消息再告诉用户，没有就什么都不说：',
    '',
    bash(SESSION_LINE, curl(`-m 10 -X POST ${url('inbox')} ${auth} ${JSON_TYPE}`, `-d ${inboxBody}`)),
    '',
    `用户要「让 Claude Code／Codex 去做某事」或者问「那边怎么样了」时，加载 \`${SKILL_NAME}\` 技能，照它说的做。别运行 \`anyd\` 命令：它不在 PATH 里，沙箱也会拦住。`,
  ].join('\n');
}

// ---- reading what is there, planning, writing ------------------------------------

interface StateEntry {
  enabled: boolean;
  created_at: number;
}

type SkillState = Record<string, StateEntry>;

/** A file's text, or `fallback` when it cannot be read. */
function textOf(path: string, fallback = ''): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

/** The app's skill switches; an absent or broken file means none are set. */
function skillState(stateFile: string): SkillState {
  try {
    const value: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
    return value !== null && typeof value === 'object' ? (value as SkillState) : {};
  } catch {
    return {};
  }
}

const stateText = (state: SkillState): string => JSON.stringify(state, null, 2) + '\n';

/** A planned write of `content` to `path`, marked create / update / unchanged against what is there now. */
function plannedWrite(path: string, content: string, note: string): SdsChange {
  let action: SdsChange['action'];
  if (!existsSync(path)) action = 'create';
  else action = textOf(path) === content ? 'unchanged' : 'update';
  return { path, action, content, note };
}

export interface SdsDetection {
  appInstalled: boolean;
  skillInstalled: boolean;
  /** Whether its switch is on — the app ignores a skill whose switch is off, file or not. */
  skillEnabled: boolean;
}

/** Is 闪电说 on this machine, and is our skill there and switched on? (`morse setup`, `morse status --check`.) */
export function detectSds(paths: SdsPaths): SdsDetection {
  if (!existsSync(paths.appHome)) return { appInstalled: false, skillInstalled: false, skillEnabled: false };
  if (!existsSync(paths.skillFile)) return { appInstalled: true, skillInstalled: false, skillEnabled: false };
  return { appInstalled: true, skillInstalled: true, skillEnabled: skillState(paths.stateFile)[STATE_KEY]?.enabled === true };
}

/** The writes an install makes — skill, switch, AGENTS.md block, in that order — worked out without writing anything. */
export function planSdsInstall(
  paths: SdsPaths,
  opts: {
    port?: number;
    now?: () => number;
    /** The file curl takes the token header from (ADR-087); defaults to this home's. */
    tokenFile?: string;
  } = {},
): SdsChange[] {
  if (!existsSync(paths.appHome)) {
    throw new Error(`闪电说 not found at ${paths.appHome} — install the app first, or pass --app-home`);
  }
  const port = opts.port ?? DAEMON_PORT;
  const tokenFile = opts.tokenFile ?? externalHeaderPath(SDS_AGENT);

  const state = skillState(paths.stateFile);
  // keep the date of the first install; a new switch is stamped in seconds, as the app does
  const createdAt = state[STATE_KEY]?.created_at ?? Math.floor((opts.now ?? Date.now)() / 1000);
  const switchedOn: SkillState = { ...state, [STATE_KEY]: { enabled: true, created_at: createdAt } };

  const skill = plannedWrite(paths.skillFile, sdsSkillMarkdown(port, tokenFile), `技能本身（文件夹名 ${SKILL_NAME} 就是技能名）`);
  const toggle = plannedWrite(paths.stateFile, stateText(switchedOn), `打开技能开关 "${STATE_KEY}"（手动放进去的技能默认关着），别的开关不动`);
  const agents = plannedWrite(
    paths.agentsFile,
    upsertMarkedBlock(textOf(paths.agentsFile), sdsAgentsBlock(port, tokenFile)),
    '加上常驻指令块（块外的内容不动）',
  );
  return [skill, toggle, agents];
}

/** Undo exactly what an install wrote, worked out without writing anything. */
export function planSdsUninstall(paths: SdsPaths): SdsChange[] {
  const skill: SdsChange = {
    path: paths.skillFile,
    action: existsSync(paths.skillFile) ? 'delete' : 'unchanged',
    note: '删掉技能文件夹',
  };

  const { [STATE_KEY]: ours, ...others } = skillState(paths.stateFile);
  const toggle: SdsChange =
    ours !== undefined
      ? { path: paths.stateFile, action: 'update', content: stateText(others), note: `去掉 "${STATE_KEY}"，别的开关不动` }
      : { path: paths.stateFile, action: 'unchanged', note: '开关文件里没有我们的键' };

  const current = textOf(paths.agentsFile);
  const cleaned = removeMarkedBlock(current);
  const agents: SdsChange =
    cleaned !== current
      ? { path: paths.agentsFile, action: 'update', content: cleaned, note: '去掉常驻指令块' }
      : { path: paths.agentsFile, action: 'unchanged', note: 'AGENTS.md 里没有我们的块' };

  return [skill, toggle, agents];
}

/** Carry out a plan. Unchanged entries are skipped, so running it twice is harmless. A delete removes the file's whole folder. */
export function applyChanges(changes: SdsChange[]): void {
  for (const { path, action, content } of changes) {
    switch (action) {
      case 'unchanged':
        break;
      case 'delete':
        rmSync(dirname(path), { recursive: true, force: true });
        break;
      default:
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content ?? '', 'utf8');
    }
  }
}

/** The daemon port the installed skill talks to, or null without a skill (or a port in it). */
export function installedSdsPort(paths: SdsPaths): number | null {
  const found = textOf(paths.skillFile).match(/127\.0\.0\.1:(\d+)\/api\/inbox/);
  return found ? Number(found[1]) : null;
}
