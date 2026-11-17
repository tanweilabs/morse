import { DurableObject } from 'cloudflare:workers';
import { allowEntry } from './allowlist.js';
import { dropDevice, getNickname, listAgents, registerAgent, removeAgent, renameAgent, resetBook, resolveAgent, setDefaultAgent, setNickname, type Outcome } from './agents.js';
import type { Env } from './hub.js';
import { normalizeHandle } from './protocol.js';

/**
 * AgentBook — ONE Durable Object per person (`idFromName(handle)`) holding that
 * person's agent directory (ADR-033, logic in agents.ts). A Durable Object rather
 * than Workers KV because the directory needs read-modify-write that cannot be
 * raced: a name is unique within a handle, a rename is atomic, the default is "the
 * first registered". KV is eventually consistent (two devices could both "win" a
 * name); D1 would work too but needs a database to create and bind, while a DO is
 * one migration line and is already how invites are kept. Every mutation runs in
 * blockConcurrencyWhile, so requests are served strictly one after another.
 *
 * Only the Worker (signed POST /v1/agents, the invite join, admin routes) and the
 * DeviceHubs (lookups) reach it; callers have already checked who is asking.
 *
 *   POST /register {handle, agent, device, dryRun?}
 *   POST /op       {handle, op, agent?, to?, device}      op = add | remove | default | rename
 *   GET  /resolve?handle=&agent=                          → AgentRecord | null (no agent = the default)
 *   GET  /list                                            → {default, agents}
 *   POST /drop     {handle, device}                       → the device left the allowlist
 *   POST /admin-remove {agent}                            → admin frees a name
 *   GET  /profile                                         → {nickname|null}   (ADR-036)
 *   POST /profile  {handle, nickname, device}             → set / clear ('') the nickname
 *   POST /reset                                           → admin released the handle: wipe everything
 */
export class AgentBook extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = async (): Promise<Record<string, unknown>> => {
      try {
        return ((await request.json()) as Record<string, unknown>) ?? {};
      } catch {
        return {};
      }
    };
    const reply = (r: Outcome) => Response.json(r.body, { status: r.status });
    const memberOf = (handle: string) => async (device: string) => (await allowEntry(this.env.ALLOWLIST, device))?.handle === handle;
    const serial = <T>(fn: () => Promise<T>): Promise<T> => this.ctx.blockConcurrencyWhile(fn);
    const store = this.ctx.storage;

    if (url.pathname === '/resolve') return Response.json(await resolveAgent(store, url.searchParams.get('agent')));
    if (url.pathname === '/list') return Response.json({ ...(await listAgents(store)), nickname: await getNickname(store) });
    if (url.pathname === '/profile' && request.method === 'GET') return Response.json({ nickname: await getNickname(store) });
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    if (url.pathname === '/reset') return Response.json({ dropped: await serial(() => resetBook(store)) });

    const b = await body();
    const handle = typeof b['handle'] === 'string' ? normalizeHandle(b['handle']) : null;
    const device = typeof b['device'] === 'string' ? b['device'] : '';
    if (url.pathname === '/admin-remove') return reply(await serial(() => removeAgent(store, { agent: b['agent'] })));
    if (!handle || !device) return Response.json({ error: 'bad request', code: 'bad_request' }, { status: 400 });

    if (url.pathname === '/register') {
      return reply(await serial(() => registerAgent(store, { agent: b['agent'], device }, memberOf(handle), { dryRun: b['dryRun'] === true })));
    }
    if (url.pathname === '/profile') {
      const r = await serial(() => setNickname(store, { nickname: b['nickname'], device }));
      if (r.status === 200) console.log(`relay: nickname of ${handle} ${r.body['nickname'] ? 'set' : 'cleared'} by ${device.slice(0, 7)}`);
      return reply(r);
    }
    if (url.pathname === '/drop') return Response.json({ dropped: await serial(() => dropDevice(store, device)) });
    if (url.pathname === '/op') {
      const r = await serial(async (): Promise<Outcome> => {
        switch (b['op']) {
          case 'add':
            return registerAgent(store, { agent: b['agent'], device }, memberOf(handle));
          case 'remove':
            return removeAgent(store, { agent: b['agent'], device });
          case 'default':
            return setDefaultAgent(store, { agent: b['agent'] });
          case 'rename':
            return renameAgent(store, { agent: b['agent'], to: b['to'], device }, memberOf(handle));
          default:
            return { status: 400, body: { error: 'unknown op', code: 'bad_op' } };
        }
      });
      if (r.status === 200) console.log(`relay: agent ${String(b['op'])} ${handle}/${String(b['to'] || b['agent'])} by ${device.slice(0, 7)}`);
      return reply(r);
    }
    return new Response('not found', { status: 404 });
  }
}
