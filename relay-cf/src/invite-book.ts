import { DurableObject } from 'cloudflare:workers';
import { chargeAliasLookups, chargeNewAddresses, DEFAULT_ALIAS_LOOKUPS_PER_IP_PER_HOUR, DEFAULT_NEW_ADDRESSES_PER_IP_PER_HOUR } from './v3.js';
import { devicesOfHandle } from './allowlist.js';
import type { Env } from './hub.js';
import { createInvite, listInvites, revokeInvite, type AgentRegistrar } from './invites.js';
import { agentBook } from './hub.js';
import { createPairCode, handleClaim, redeemJoin, registerDevice, registerSettingsFromEnv, releaseHandle } from './register.js';

/**
 * InviteBook — ONE Durable Object (`idFromName('invites')`) that owns every
 * invite and, since ADR-036, every decision about who gets a handle: open
 * registration (random handles), pairing codes for adding a computer, and admin
 * release. A single, strongly consistent object makes "one use" exact and two
 * registrations can never get the same handle: every write runs inside
 * blockConcurrencyWhile, so racing requests are served one after the other. (The
 * class keeps its name: renaming a Durable Object class needs a migration and
 * would drop the stored invites.) Only the Worker reaches it — the admin routes
 * are checked for ADMIN_KEY before they are forwarded here.
 *
 *   POST   /join          {code, cert, ts, sig, name?, agent?}            invite (public, via POST /v1/join)
 *                         {handle, code, cert, ts, sig, name?, agent?}    pairing code (ADR-036)
 *   POST   /register      {cert, ts, sig, name?, agent?}  + x-morse-client-ip   (public, via POST /v1/register)
 *   POST   /pair-code     {cert, ts, sig}                                 (public, via POST /v1/pair-code)
 *   POST   /invites       {handle, uses?, ttlSec?, note?}
 *   GET    /invites
 *   DELETE /invites/<id>
 *   GET    /handles/<handle>                → the claim record (admin)
 *   POST   /handles/<handle>/release        → admin release (ADR-036)
 */
export class InviteBook extends DurableObject<Env> {
  /** The join's agent (ADR-033) goes into that person's AgentBook. */
  private agentRegistrar(): AgentRegistrar {
    return {
      register: async (handle, agent, device, dryRun) => {
        const res = await agentBook(this.env, handle).fetch('https://agents/register', { method: 'POST', body: JSON.stringify({ handle, agent, device, dryRun }) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = async (): Promise<unknown> => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    if (url.pathname === '/join' && request.method === 'POST') {
      const req = await body();
      const agents = this.agentRegistrar();
      const r = await this.ctx.blockConcurrencyWhile(() => redeemJoin(this.ctx.storage, this.env.ALLOWLIST, req, Date.now(), agents));
      if (r.status === 200) {
        console.log(`relay: JOINED ${String(r.body['id']).slice(0, 7)} → ${String(r.body['handle'])}${r.body['agent'] ? `/${String(r.body['agent'])}` : ''}${(req as { handle?: unknown } | null)?.handle !== undefined ? ' (pairing code)' : ''}${r.body['already'] ? ' (already a member, nothing used)' : ''}${r.body['agentError'] ? ` (agent: ${String(r.body['agentError'])})` : ''}`);
      } else {
        console.log(`relay: join refused (${r.status} ${String(r.body['code'])})`);
      }
      return Response.json(r.body, { status: r.status });
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      const req = await body();
      const settings = registerSettingsFromEnv(this.env);
      const ip = request.headers.get('x-morse-client-ip');
      const r = await this.ctx.blockConcurrencyWhile(() =>
        registerDevice(this.ctx.storage, this.env.ALLOWLIST, req, { ip, settings, agents: this.agentRegistrar() }),
      );
      if (r.status === 200) {
        console.log(`relay: REGISTERED ${String(r.body['id']).slice(0, 7)} → ${String(r.body['handle'])}${r.body['agent'] ? `/${String(r.body['agent'])}` : ''}${r.body['already'] ? ' (already a member, nothing created)' : ''}`);
      } else {
        console.log(`relay: register refused (${r.status} ${String(r.body['code'])})`);
      }
      return Response.json(r.body, { status: r.status });
    }
    if (url.pathname === '/new-addresses' && request.method === 'POST') {
      // ADR-073 / spec §15.1 #2: new v3 addresses first published from one IP per hour
      const b = ((await body()) ?? {}) as { n?: unknown; perHour?: unknown };
      const ip = request.headers.get('x-morse-client-ip');
      const n = typeof b.n === 'number' ? b.n : 1;
      const perHour = typeof b.perHour === 'number' ? b.perHour : DEFAULT_NEW_ADDRESSES_PER_IP_PER_HOUR;
      const r = await this.ctx.blockConcurrencyWhile(() => chargeNewAddresses(this.ctx.storage, ip, n, perHour));
      if (!r.ok) console.log(`relay v3: refused ${n} new address(es) — over ${perHour} from one network this hour`);
      return Response.json(r, { status: r.ok ? 200 : 429 });
    }
    if (url.pathname === '/alias-lookups' && request.method === 'POST') {
      // ADR-077: GET /v3/alias/… is public — one IP gets a fixed number of lookups an hour
      const b = ((await body()) ?? {}) as { perHour?: unknown };
      const perHour = typeof b.perHour === 'number' ? b.perHour : DEFAULT_ALIAS_LOOKUPS_PER_IP_PER_HOUR;
      const r = await this.ctx.blockConcurrencyWhile(() => chargeAliasLookups(this.ctx.storage, request.headers.get('x-morse-client-ip'), perHour));
      return Response.json(r, { status: r.ok ? 200 : 429 });
    }
    if (url.pathname === '/pair-code' && request.method === 'POST') {
      const req = await body();
      const r = await this.ctx.blockConcurrencyWhile(() => createPairCode(this.ctx.storage, this.env.ALLOWLIST, req));
      console.log(r.status === 200 ? `relay: pairing code issued for ${String(r.body['handle'])}` : `relay: pairing code refused (${r.status} ${String(r.body['code'])})`);
      return Response.json(r.body, { status: r.status });
    }
    const hm = /^\/handles\/([^/]+)(\/release)?$/.exec(url.pathname);
    if (hm) {
      const handle = decodeURIComponent(hm[1]!);
      if (!hm[2] && request.method === 'GET') return Response.json({ claim: await handleClaim(this.ctx.storage, handle) });
      if (hm[2] && request.method === 'POST') {
        const r = await this.ctx.blockConcurrencyWhile(() => releaseHandle(this.ctx.storage, this.env.ALLOWLIST, handle));
        console.log(`relay: handle ${handle} RELEASED by admin (${r.devices.length} device(s))`);
        return Response.json(r);
      }
    }
    if (url.pathname === '/invites' && request.method === 'POST') {
      const r = await createInvite(this.ctx.storage, await body(), Date.now(), registerSettingsFromEnv(this.env).reserved);
      if (r.status === 200) {
        const handle = String(r.body['handle']);
        r.body['existingDevices'] = (await devicesOfHandle(this.env.ALLOWLIST, handle)).length;
        console.log(`relay: invite ${String(r.body['id'])} created for ${handle} (${String(r.body['uses'])} use(s))`);
      }
      return Response.json(r.body, { status: r.status });
    }
    if (url.pathname === '/invites' && request.method === 'GET') {
      return Response.json({ invites: await listInvites(this.ctx.storage) });
    }
    const m = /^\/invites\/([^/]+)$/.exec(url.pathname);
    if (m && request.method === 'DELETE') {
      const id = decodeURIComponent(m[1]!);
      const removed = await revokeInvite(this.ctx.storage, id);
      return Response.json({ id, removed });
    }
    return new Response('not found', { status: 404 });
  }
}
