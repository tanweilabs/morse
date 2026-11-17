/**
 * ADR-084: Morse's minimum Node.js is 22 — for NEW installs (site/install.sh refuses an
 * older one). An install that already runs on an older Node is never refused: it keeps
 * starting and updating, and only gets the hint below (`morse status`, the updater's log).
 */
export const MIN_NODE_MAJOR = 22;

/**
 * The hint for a Node older than the minimum; null on a supported one (and on a version
 * string that cannot be read — never a false alarm).
 */
export function nodeUpgradeHint(nodeVersion: string = process.versions.node): string | null {
  const v = nodeVersion.trim().replace(/^v/, '');
  const major = /^\d+/.test(v) ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return `v${v} — Node.js ${MIN_NODE_MAJOR}+ is recommended: on older Node.js every update has to compile the database module from source`;
}

/** The `node:` line of `morse status` — printed only when there is a hint. */
export function nodeStatusLine(nodeVersion: string = process.versions.node): string | null {
  const hint = nodeUpgradeHint(nodeVersion);
  return hint ? `node: ${hint}` : null;
}
