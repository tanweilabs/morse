import { dispatchOnce as coreDispatchOnce, type DispatcherOptions, type RunningDispatcher } from '../../src/daemon/dispatcher.js';
import { createLocalClient } from '../../src/plugin/local-client.js';
import { dispatchStep } from '../../src/plugins/dispatch/deliver.js';

/**
 * ADR-052: what the old single dispatcher did, as the core (outbound) + the dispatch
 * plugin (own-agent local mail) talking through the plugin contract in-process. The
 * dispatcher tests run against this, unchanged.
 */
export async function dispatchOnce(opts: DispatcherOptions): Promise<boolean> {
  if (await coreDispatchOnce(opts)) return true;
  return dispatchStep({
    core: createLocalClient(opts.mailbox),
    adapters: opts.adapters ?? new Map(),
    directory: opts.directory ?? (async () => []),
    ...(opts.isMonitored ? { isMonitored: opts.isMonitored } : {}),
    ...(opts.isSessionLive ? { isSessionLive: opts.isSessionLive } : {}),
    ...(opts.isPullOnly ? { isPullOnly: opts.isPullOnly } : {}),
    onEvent: (e) => {
      const message = opts.mailbox.getMessage(e.messageId);
      if (message && e.kind !== 'skipped') opts.onEvent?.({ kind: e.kind, message, ...(e.detail ? { detail: e.detail } : {}) });
    },
  });
}

export function startDispatcher(opts: DispatcherOptions, { intervalMs = 1000 }: { intervalMs?: number } = {}): RunningDispatcher {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      while (!stopped && (await dispatchOnce(opts))) {
        /* drain */
      }
    } catch {
      /* keep going */
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
