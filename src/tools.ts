import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Proxy302Client, Proxy302Error, type TokenRow } from './client.js';
import { fetchThroughProxy, type ProxyEndpoint } from './fetchPage.js';
import { formatBytes, mask, proxyUrl } from './format.js';

type Area = { id: number; name: string; code?: string; pid?: number };

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
const safe = <A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) => async (args: A) => { try { return await fn(args); } catch (e) { return fail(e); } };

export async function resolveArea(client: Proxy302Client, type: 'country' | 'state' | 'city', input: string, pid?: string): Promise<Area> {
  if (/^\d+$/.test(input.trim())) return { id: Number(input), name: input };
  const rows = (await client.areas(type, pid, input.trim())).data;
  const q = input.trim().toLowerCase();
  let exact = rows.filter(r => r.name.toLowerCase() === q || r.code?.toLowerCase() === q);
  // The API filters on the name, so a code like "US" finds Australia and Russia but not United States: look codes up in the full list.
  if (!exact.length && /^[a-z]{2,3}$/i.test(input.trim())) exact = (await client.areas(type, pid)).data.filter(r => r.code?.toLowerCase() === q);
  const pick = exact.length === 1 ? exact : !exact.length && rows.length === 1 ? rows : [];
  if (pick.length === 1) return pick[0]!;
  if (!rows.length) throw new Proxy302Error(`No ${type} matches "${input}". Use list_countries / list_regions to see valid names.`);
  throw new Proxy302Error(`"${input}" matches several ${type}s: ${rows.slice(0, 10).map(r => `${r.name} (id ${r.id})`).join(', ')}. Pass the exact name or id.`);
}

function toEndpoint(row: TokenRow): ProxyEndpoint | null {
  if (!row.username || !row.passwd || !row.host || !row.port) return null;
  return { host: row.host, port: Number(row.port), username: row.username, password: row.passwd };
}

function describeToken(row: TokenRow, includeCredentials: boolean) {
  const endpoint = toEndpoint(row);
  return {
    token_id: row.token_id ?? row.id, kind: `${row.generate ?? ''}/${row.proxy_type ?? ''}`, area: row.proxy_area || 'any',
    protocol: row.network ?? 'http', status: row.status, connection_state: row.connection_state,
    expires_at: row.expired_on ? new Date(row.expired_on * 1000).toISOString() : null,
    traffic_used: row.traffic_usage !== undefined ? formatBytes(row.traffic_usage) : undefined,
    host: row.host, port: row.port, username: row.username,
    password: includeCredentials ? row.passwd : mask(row.passwd),
    ...(includeCredentials && endpoint ? { connection_url: proxyUrl(row.network ?? 'http', endpoint.username, endpoint.password, endpoint.host, endpoint.port) } : {}),
  };
}

function matchesCountry(row: TokenRow, countryName: string): boolean {
  return (row.proxy_area ?? '').split(' - ')[0]!.trim().toLowerCase() === countryName.toLowerCase();
}
/** Exactly this place: a city proxy does not answer a country request. */
const sameArea = (row: TokenRow, label: string) => (row.proxy_area ?? '').split(' - ').map(part => part.trim().toLowerCase()).filter(part => part && part !== '-').join(' - ') === label.toLowerCase();
/** s 1/2 = premium line, 3/4 = budget line. */
function lineOf(row: TokenRow): 'premium' | 'budget' | null {
  const s = Number((row as { s?: unknown }).s);
  return s === 1 || s === 2 ? 'premium' : s === 3 || s === 4 ? 'budget' : null;
}
const newSessionId = () => randomBytes(6).toString('hex');

async function countryCode(client: Proxy302Client, c: Area): Promise<string | null> {
  const code = c.code ?? (await client.areas('country')).data.find(row => row.id === c.id)?.code;
  return code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;
}

type Connection = { username?: string | undefined; password?: string | undefined; host?: string | undefined; port?: number | string | null | undefined; connection_url?: string | undefined };
/** Username parameters (proxy302.com docs): -country-<cc> without a session = a new IP on every new connection;
 *  -session-<id> keeps one IP, -sessTime-<minutes> sets how long on the budget line. Sticky without minutes keeps the
 *  proxy's own session (plain username). */
function withSession<T extends Connection>(proxy: T, protocol: string, code: string | null, mode: 'sticky' | 'rotate', minutes: number | undefined) {
  let tail = '';
  if (mode === 'rotate') {
    if (!code) throw new Proxy302Error('Rotating needs the country code of this proxy; pass the country as a two-letter code.');
    tail = `-country-${code}`;
  } else if (minutes) tail = `-session-${newSessionId()}-sessTime-${minutes}`;
  const how_to_rotate = mode === 'rotate' ? 'Every new connection already gets a new IP.'
    : 'For a new IP now, change the value after -session- in the username (any letters and digits), or call rotate_ip.';
  if (!tail || !proxy.username || !proxy.password || !proxy.host || !proxy.port) return { ...proxy, session_mode: mode, how_to_rotate };
  const username = proxy.username + tail;
  return { ...proxy, username, connection_url: proxyUrl(protocol, username, proxy.password, proxy.host, Number(proxy.port)), session_mode: mode, how_to_rotate };
}
const usable = (row: TokenRow) => row.status === 1 || row.status === 5;
/** The API's texts for "no traffic package on this line" (proxy302-backend generation-failure.ts, no_traffic_package). */
const NO_TRAFFIC_PACKAGE = new Set([
  'A matching prepaid traffic package is required for the bridge',
  'No matching traffic package for this line; purchase a same-config traffic package or enable auto-refill',
  'No unexpired traffic pool matches the selected provider configuration',
]);

export function registerTools(server: McpServer, client: Proxy302Client): void {
  server.registerTool('get_account_usage', {
    title: 'Account, traffic balance and usage',
    description: 'Show the account tied to the API key, wallet balance (PTC), remaining prepaid traffic, and traffic used per day for the last N days. Read-only.',
    inputSchema: { days: z.number().int().min(1).max(90).default(7).describe('How many past days of usage to include') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ days }) => {
    const end = Math.floor(Date.now() / 1000);
    const [me, pool, usage, wallet] = await Promise.all([client.me(), client.trafficPool(), client.consumeSummary(end - days * 86400, end),
      // Older servers do not have the wallet endpoint yet: degrade gracefully instead of failing the whole call.
      client.wallet().catch(() => null)]);
    return ok({
      account: { name: me.name, email: me.email, uid: me.uid, active: me.is_use === 1 },
      wallet_balance_ptc: wallet ? wallet.balance : 'unavailable',
      traffic_remaining: formatBytes(pool.remaining_traffic),
      traffic_pools: pool.traffic_pools.map(p => ({
        id: p.id, name: p.en_name ?? p.name, used: formatBytes(p.current_cost_traffic as string), total: formatBytes(p.total_traffic as string),
        expires_at: p.expired_on ? new Date(Number(p.expired_on) * 1000).toISOString() : 'never',
      })),
      usage_last_days: { days, by_category_total: Object.fromEntries(Object.entries(usage.summary).map(([k, v]) => [k, formatBytes(v)])), day_keys: usage.keys },
    });
  }));

  server.registerTool('list_countries', {
    title: 'List countries',
    description: 'List countries Proxy302 can target. Optional name filter (substring). Returns ids usable in other tools. Read-only.',
    inputSchema: { name: z.string().max(100).optional().describe('Filter, e.g. "ger"') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ name }) => {
    const rows = (await client.areas('country', undefined, name)).data;
    return ok({ count: rows.length, countries: rows.map(r => ({ id: r.id, name: r.name, code: r.code })) });
  }));

  server.registerTool('list_regions', {
    title: 'List states or cities',
    description: 'List states of a country, or cities of a state. Pass either country (name/code/id) or state_id. Read-only.',
    inputSchema: {
      country: z.string().optional().describe('Country name, ISO code or id; lists its states'),
      state_id: z.number().int().positive().optional().describe('State id; lists its cities'),
      name: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ country, state_id, name }) => {
    if (state_id) return ok((await client.areas('city', String(state_id), name)).data);
    if (!country) throw new Proxy302Error('Pass country (to list states) or state_id (to list cities).');
    const c = await resolveArea(client, 'country', country);
    return ok({ country: c, states: (await client.areas('state', String(c.id), name)).data });
  }));

  server.registerTool('list_products', {
    title: 'List products and plans',
    description: 'Describe the proxy products and list the static IP plans (data center and residential) with their plan ids. Read-only; prices are shown on proxy302.com.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async () => {
    const [dc, res] = await Promise.all([client.payways('static_data_center'), client.payways('static_residential')]);
    return ok({
      dynamic_residential: { billing: 'per GB of traffic', lines: { premium: 'higher-quality line: country, state, city and ISP', budget: 'lower-cost line: country' }, rotation: 'new IP on every new connection, or sticky sessions', concurrency: 'no limit on concurrent connections', tools: ['get_dynamic_proxy', 'rotate_ip', 'list_isps'] },
      static_data_center_plans: dc.data.map(p => ({ id: p.id, name: p.en_name || p.name })),
      static_residential_plans: res.data.map(p => ({ id: p.id, name: p.en_name || p.name })),
      note: 'This MCP server does not buy, renew or top up. Do that in the Proxy302 console.',
    });
  }));

  server.registerTool('get_dynamic_proxy', {
    title: 'Get a dynamic residential proxy connection string',
    description: 'Return a ready-to-use residential proxy URL for a country (optionally state and city, and on the premium line an ISP). '
      + 'session_mode="rotate": every new connection exits through a new IP. session_mode="sticky" (default): one IP across connections '
      + '(premium: usually 5-10 minutes, not adjustable; budget: 10 minutes, or session_minutes up to 120). '
      + 'Reuses a matching proxy of the same line you already have; with create_if_missing=true it creates one if none exists. '
      + 'Creating is free; traffic is billed per GB when used, from a traffic package for that line if you have one, otherwise from the wallet. '
      + 'No limit on concurrent connections.',
    inputSchema: {
      country: z.string().describe('Country name, ISO code or id, e.g. "United States" or "US"'),
      state: z.string().optional(), city: z.string().optional(),
      isp: z.string().max(32).optional().describe('Premium line only: ISP key from list_isps, e.g. "comcast"'),
      protocol: z.enum(['http', 'socks5']).default('http'),
      line: z.enum(['budget', 'premium']).default('budget').describe('budget = lower price per GB, country only; premium = higher-quality line with state, city and ISP'),
      session_mode: z.enum(['sticky', 'rotate']).default('sticky').describe('rotate = new IP on every new connection; sticky = keep one IP'),
      session_minutes: z.union([z.literal(10), z.literal(30), z.literal(60), z.literal(120)]).optional().describe('Budget line, sticky only: minutes to keep one IP'),
      create_if_missing: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async ({ country, state, city, isp, protocol, line, session_mode, session_minutes, create_if_missing }) => {
    if (isp && line !== 'premium') throw new Proxy302Error('ISP targeting is on the premium line only: pass line="premium".');
    if (session_minutes && session_mode === 'rotate') throw new Proxy302Error('session_minutes applies to sticky sessions only.');
    if (session_minutes && line === 'premium') throw new Proxy302Error('A premium sticky IP usually holds 5-10 minutes and the length is not adjustable; session_minutes is for the budget line.');
    const c = await resolveArea(client, 'country', country);
    let ispOption: { key: string; label: string } | undefined;
    if (isp) {
      const options = (await client.ispCatalog(c.id)).data;
      ispOption = options.find(option => option.key === isp.trim().toLowerCase());
      if (!ispOption) throw new Proxy302Error(options.length ? `"${isp}" is not an ISP we can target in ${c.name}. Choose one of: ${options.map(o => o.key).join(', ')}.` : `ISP targeting is not available in ${c.name}.`);
    }
    const s = state ? await resolveArea(client, 'state', state, String(c.id)) : undefined;
    const ci = city ? await resolveArea(client, 'city', city, String(s?.id ?? '')) : undefined;
    if (ci && !s) throw new Proxy302Error('Give the state as well when targeting a city.');
    const label = [c.name, s?.name, ci?.name].filter(Boolean).join(' - ');
    // Only a proxy of the requested line and exactly this place; an ISP proxy is found again by its idempotency key.
    if (!ispOption) {
      const rows = (await client.tokens('dynamic', 'traffic', { page_size: 200 })).data;
      const hit = rows.find(r => usable(r) && lineOf(r) === line && sameArea(r, label) && (r.network ?? 'http') === protocol && toEndpoint(r));
      if (hit) return ok({ reused: true, ...withSession(describeToken(hit, true), hit.network ?? 'http', await countryCode(client, c), session_mode, session_minutes) });
    }
    if (!create_if_missing) {
      throw new Proxy302Error(`No existing ${protocol} ${line} dynamic proxy for ${label}${ispOption ? ` on ${ispOption.label}` : ''}. Call again with create_if_missing=true to create one (free to create; billed per GB on use).`);
    }
    const key = `mcp-${c.id}-${s?.id ?? 0}-${ci?.id ?? 0}-${protocol}-${line}${ispOption ? `-${ispOption.key}` : ''}`;
    const body = { s: line === 'premium' ? 1 : 3, protocol, country_id: c.id, state_id: s?.id ?? 0, city_id: ci?.id ?? 0, ...(ispOption ? { isp: ispOption.key } : {}) };
    // Like the Proxy302 console: with no traffic package for this line the wallet pays per GB (the API refuses a wallet
    // that cannot cover the pay-as-you-go hold). A wallet-only account could never create a proxy here before.
    let billedFrom: 'traffic_package' | 'wallet' = 'traffic_package';
    const out = await client.generateDynamic({ ...body, idempotency_key: key }).catch((e: unknown) => {
      if (!(e instanceof Proxy302Error && NO_TRAFFIC_PACKAGE.has(e.message))) throw e;
      billedFrom = 'wallet';
      return client.generateDynamic({ ...body, billing_mode: 'payg_wallet', idempotency_key: `${key}-payg` });
    });
    return ok(withSession({
      reused: false, token_id: out.token_id, billed_from: billedFrom, line, area: [label, ispOption?.label].filter(Boolean).join(' - '), protocol: out.protocol,
      host: out.host, port: out.port, username: out.username, password: out.password,
      connection_url: proxyUrl(out.protocol, out.username, out.password, out.host, out.port),
    }, out.protocol, await countryCode(client, c), session_mode, session_minutes));
  }));

  server.registerTool('list_isps', {
    title: 'List ISPs for premium targeting',
    description: 'ISPs (carriers) the premium line can target in a country, for get_dynamic_proxy isp=. Read-only.',
    inputSchema: { country: z.string().describe('Country name, ISO code or id') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ country }) => {
    const c = await resolveArea(client, 'country', country);
    const isps = (await client.ispCatalog(c.id)).data.map(option => ({ isp: option.key, name: option.label }));
    return ok({ country: c.name, isps, ...(isps.length ? {} : { note: `ISP targeting is not available in ${c.name}; choose by country, state or city instead.` }) });
  }));

  server.registerTool('rotate_ip', {
    title: 'Rotate sticky proxies to a new IP',
    description: 'Get a new IP for sticky dynamic proxies. Each proxy comes back with a connection_url carrying a fresh session: use it and the next '
      + 'connection exits through a new IP right away. The plain username, password and billing stay the same; its own sticky IP also changes '
      + 'within about 2.5 minutes. Free. Token ids come from list_my_proxies or get_dynamic_proxy.',
    inputSchema: { token_ids: z.array(z.number().int().positive()).min(1).max(100).describe('Token ids of your sticky dynamic proxies') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, safe(async ({ token_ids }) => {
    const ids = [...new Set(token_ids)];
    const rows = (await client.tokens('dynamic', 'traffic', { page_size: 200 })).data;
    const new_ip_now = ids.map(id => rows.find(row => Number(row.token_id ?? row.id) === id)).filter((row): row is TokenRow => !!row && !!toEndpoint(row))
      .map(row => {
        const e = toEndpoint(row)!;
        const username = `${e.username}-session-${newSessionId()}`;
        return { token_id: Number(row.token_id ?? row.id), username, connection_url: proxyUrl(row.network ?? 'http', username, e.password, e.host, e.port) };
      });
    const out = await client.resetSessions(ids);
    return ok({ new_ip_now, rotated: out.results, apply_within_seconds: out.apply_within_seconds });
  }));

  server.registerTool('list_my_proxies', {
    title: 'List my proxies and static IPs',
    description: 'List proxies on the account: dynamic or static, billed by traffic or by IP. Passwords are masked unless include_credentials=true. Read-only.',
    inputSchema: {
      kind: z.enum(['dynamic', 'static']).default('static'),
      billing: z.enum(['ip', 'traffic']).optional().describe('Defaults to traffic for dynamic proxies and ip for static ones'),
      page_size: z.number().int().min(1).max(100).default(20),
      page: z.number().int().min(1).default(1),
      active_only: z.boolean().default(true),
      include_credentials: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ kind, billing: chosen, page_size, page, active_only, include_credentials }) => {
    const billing = chosen ?? (kind === 'dynamic' ? 'traffic' : 'ip');
    // The API's active state is 5 for traffic-billed proxies and 1 for IP-billed ones.
    const r = await client.tokens(kind, billing, { page, page_size, ...(active_only ? { status: billing === 'traffic' ? 5 : 1 } : {}) });
    return ok({ total: r.total, page: r.page, has_more: r.has_more, proxies: r.data.map(row => describeToken(row, include_credentials)) });
  }));

  server.registerTool('fetch_url', {
    title: 'Fetch a web page through a Proxy302 proxy',
    description: 'Request a URL from your machine through one of your Proxy302 proxies (optionally exiting in a given country) and return the page as Markdown, plain text or raw. No JavaScript rendering: for JS-heavy sites use a browser with the proxy URL from get_dynamic_proxy. Uses your proxy traffic.',
    inputSchema: {
      url: z.string().url(),
      country: z.string().optional().describe('Exit country; picks one of your dynamic proxies for it'),
      token_id: z.union([z.number(), z.string()]).optional().describe('Use a specific proxy from list_my_proxies'),
      format: z.enum(['markdown', 'text', 'raw']).default('markdown'),
      max_chars: z.number().int().min(500).max(200000).default(20000),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ url, country, token_id, format, max_chars }) => {
    const rows = (await client.tokens('dynamic', 'traffic', { page_size: 200 })).data.filter(r => usable(r) && (r.network ?? 'http') !== 'socks5' && toEndpoint(r));
    let row: TokenRow | undefined;
    if (token_id !== undefined) {
      row = rows.find(r => String(r.token_id ?? r.id) === String(token_id));
      if (!row) {
        const statics = (await client.tokens('static', 'ip', { page_size: 200 })).data.filter(r => usable(r) && toEndpoint(r));
        row = statics.find(r => String(r.token_id ?? r.id) === String(token_id));
      }
      if (!row) throw new Proxy302Error(`Proxy ${token_id} not found, inactive or not an HTTP proxy.`);
    } else if (country) {
      const c = await resolveArea(client, 'country', country);
      row = rows.find(r => matchesCountry(r, c.name));
      if (!row) throw new Proxy302Error(`You have no active HTTP dynamic proxy for ${c.name}. Run get_dynamic_proxy with create_if_missing=true first.`);
    } else {
      row = rows[0];
      if (!row) throw new Proxy302Error('You have no active dynamic proxy yet. Run get_dynamic_proxy with create_if_missing=true first.');
    }
    const result = await fetchThroughProxy(url, toEndpoint(row)!, { format, maxChars: max_chars });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ via: { token_id: row.token_id ?? row.id, area: row.proxy_area || 'any' }, status: result.status, final_url: result.finalUrl, content_type: result.contentType, truncated: result.truncated }) },
        { type: 'text' as const, text: result.content },
      ],
    };
  }));
}
