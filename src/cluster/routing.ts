/** What the dispatcher looks at to decide where a claimed message goes: its target device. */
export interface RoutableMessage {
  to: { device?: string };
}

export type Route = { kind: 'local' } | { kind: 'relay'; device: string };

/**
 * Local when the target names no device (blank counts as none) or names this one, compared
 * ignoring case; otherwise it is relayed to the named device (trimmed).
 */
export function routeForMessage(message: RoutableMessage, selfDevice: string): Route {
  const device = (message.to.device ?? '').trim();
  const isSelf = device === '' || device.toLowerCase() === selfDevice.toLowerCase();
  return isSelf ? { kind: 'local' } : { kind: 'relay', device };
}
