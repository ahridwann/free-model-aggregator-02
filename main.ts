// free-model-aggregator-02: one server, two client wires, a real free model behind
// every answer.
//
// It reads the brief at $MAKEFUN_PROMPT_FILE (the fourteen free OpenRouter models with
// the house's ratings, and the six prompts' manifest), registers its catalog with the
// env at $MAKEFUN_ENV_URL, and answers the client's six requests — OpenAI Chat
// Completions and Anthropic Messages, JSON and server-sent events — each with a real
// completion dialled through the grader's gateway on the trial's key, and exits 0 when
// the env says the workload is done. `node main.ts --list` prints the same catalog
// JSON and exits 0.
//
// ROUTING (quality, 60% of the score)
//   Every free candidate meeting a request's requirements is ranked by the brief's
//   rating_milli (descending), with a deterministic tie-break on model id. The best
//   JSON-capable model is Nemotron 3.5 Super VL (1303); the best model overall is
//   Inkling 2 Small (1475), which cannot do JSON mode, so the two JSON prompts go to
//   Super VL and the other four to Inkling when both are healthy. Requirements come
//   from the manifest row for each arriving request (arrival order); the body is read
//   only when the manifest has no row.
//
// FAILOVER (served 15%, failover 10%)
//   On a gateway 4xx/5xx (or an unreachable gateway, or an answer that is not JSON),
//   the request is retried on the next-best candidate, sequentially, until one
//   serves it or the list is exhausted. A model that has refused is demoted for later
//   prompts — a rate-limited model must not take every later prompt down with it —
//   but it is never called twice for one request. Every real HTTP refusal behind a
//   served answer is reported in the x-makefun-upstream-failures header (at most 8
//   rows, in call order), because that header is the only way the failover column
//   sees a refusal the server recovered from. Network errors (no HTTP status) fail
//   over the same way but carry no trail row, since there is no refusal to report.
//
//   A circuit breaker guards the 60-call trial cap against a systemic outage: three
//   consecutive refusals with the same status and code, on different models, mean the
//   failure is not one model's — failover stops for that prompt, and later prompts
//   try only the single best candidate until one succeeds and clears the breaker.
//   Every step of it is a function of the gateway's answers alone, so a replay
//   reproduces it exactly; it never spends a call on a model that is cooling down,
//   and a trial-wide outage costs ~8 calls instead of all 60, leaving budget for the
//   prompts after the outage clears.
//
// WIRES
//   client openai    + gateway chat completions: pass the body through (model set,
//     stream_options include_usage added for streams, max_tokens always named and
//     capped at 8192), JSON or SSE straight back with the dialled id on every chunk.
//   client anthropic + gateway chat completions: translate the request with
//     anthropicToOpenAI, the answer back with openAIToAnthropic (JSON) or
//     anthropicEventsFromOpenAI (SSE), with the dialled id named back.
//   The provider's own answer spells the model without the gateway's `openrouter/`
//   prefix; every answer and every streamed chunk carries the id this entry dialled,
//   because the house scores the model its own record shows answered.
//
// DETERMINISM: no Math.random, no Date/wall-clock in anything sent or registered;
// every routing decision derives from the brief, the requests and the gateway's
// answers, so a replay leaves the same state export byte for byte.
//
// FILES
//   main.ts            this server: the brief, the catalog, the routes, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the free model list, the catalog.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.
//   LICENSE            MIT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The gateway's output cap: a request naming more, or none, is refused. */
const MAX_OUTPUT_TOKENS = 8192;
/** The output cap named when a request carries none. */
const DEFAULT_OUTPUT_TOKENS = 1024;
/** The most upstream-failure rows the trail header may carry. */
const MAX_TRAIL_ROWS = 8;
/** Consecutive identical refusals that trip the circuit breaker: a systemic outage, not one model. */
const BREAKER_TRIPS_AT = 3;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Models that have refused a gateway call so far in this trial: demoted for later prompts. */
const failedModels = new Set<string>();
/** The run of consecutive identical refusals so far: its status, its code, and its length. */
let breaker: { status: number; code: string; count: number } | null = null;

/** Whether the breaker is tripped: the last refusals were identical, so the outage is systemic. */
function breakerTripped(): boolean {
  return breaker !== null && breaker.count >= BREAKER_TRIPS_AT;
}

/** Fold one failure into the breaker run: identical to the last, or the start of a new run. */
function noteBreaker(status: number, code: string): void {
  if (breaker !== null && breaker.status === status && breaker.code === code) {
    breaker = { status, code, count: breaker.count + 1 };
  } else {
    breaker = { status, code, count: 1 };
  }
}

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The candidate order: models that have not refused sort first, then rating_milli
 * descending, then model id. Deterministic, and a function only of the brief and the
 * refusals observed so far.
 */
function compareCandidates(a: ModelRow, b: ModelRow): number {
  const af = failedModels.has(a.id) ? 1 : 0;
  const bf = failedModels.has(b.id) ? 1 : 0;
  if (af !== bf) return af - bf;
  if (a.rating_milli !== b.rating_milli) return b.rating_milli - a.rating_milli;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every free candidate meeting the request's requirements, in candidate order. */
function candidatesFor(requires: Requirement): ModelRow[] {
  const out = freeModels(brief).filter((model) => meetsRequirements(requires, capabilitiesOf(model)));
  out.sort(compareCandidates);
  return out;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this
  // fallback is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The trail header's value for this request's refusals so far, or null when there are none. */
function trailHeader(failures: TrailRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, MAX_TRAIL_ROWS)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** One refusal the trail header may report: a real HTTP status, a string code, the dialled id. */
interface TrailRow {
  status: number;
  code: string;
  model: string | null;
}

/** The error code of a gateway refusal body: the provider's code, else its type, else a fixed word. */
function errorCodeOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      const code = value.error.code;
      if (typeof code === 'string' && code !== '') return code.slice(0, 64);
      if (typeof code === 'number' && Number.isFinite(code)) return String(code);
      const type = value.error.type;
      if (typeof type === 'string' && type !== '') return type.slice(0, 64);
    }
  } catch {
    // Not JSON: the fixed word below.
  }
  return 'upstream_error';
}

/**
 * A Chat Completions body the gateway accepts: the dialled model, an output cap always
 * named and at most 8192, and stream_options include_usage on streams so the usage
 * chunk arrives.
 */
function gatewayBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const cap = (key: string): void => {
    const value = out[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > MAX_OUTPUT_TOKENS) out[key] = MAX_OUTPUT_TOKENS;
    }
  };
  cap('max_tokens');
  cap('max_completion_tokens');
  if (typeof out.max_tokens !== 'number' && typeof out.max_completion_tokens !== 'number') {
    out.max_tokens = DEFAULT_OUTPUT_TOKENS;
  }
  if (out.stream === true) {
    const options = isRecord(out.stream_options) ? { ...out.stream_options } : {};
    options.include_usage = true;
    out.stream_options = options;
  }
  return out;
}

/** One gateway call's outcome: a live answer, or a refusal with its trail row when it has one. */
interface DialResult {
  ok: boolean;
  response: Response | null;
  /** A trail row when the gateway answered with a real HTTP refusal; null otherwise. */
  trail: TrailRow | null;
  /** The HTTP status when the gateway answered; 0 when it could not be reached. */
  status: number;
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<DialResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  let upstream: Response;
  try {
    upstream = await fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify(gatewayBody(body, model)) });
  } catch {
    return { ok: false, response: null, trail: null, status: 0 };
  }
  if (!upstream.ok) {
    let text = '';
    try {
      text = await upstream.text();
    } catch {
      // The error body could not be read: the status is the refusal either way.
    }
    return { ok: false, response: null, trail: { status: upstream.status, code: errorCodeOf(text), model }, status: upstream.status };
  }
  if (upstream.body === null) {
    return { ok: false, response: null, trail: null, status: upstream.status };
  }
  return { ok: true, response: upstream, trail: null, status: upstream.status };
}

/** A refused gateway call's model, demoted for later prompts. */
function noteFailure(model: string): void {
  failedModels.add(model);
}

/**
 * One client request: try the candidates in order, one at a time, until one serves it.
 * The same candidate is never called twice for one request. On success the answer is
 * written in the client's wire, carrying the refusals' trail when there were any.
 */
async function serve(req: IncomingMessage, res: ServerResponse, clientWire: 'openai' | 'anthropic', body: Json): Promise<void> {
  const requires = requirementsFor(body);
  // While the breaker is tripped the outage is systemic: spend one call, on the best
  // candidate, and let its answer decide whether the outage has cleared.
  const allCandidates = candidatesFor(requires);
  const candidates = breakerTripped() ? allCandidates.slice(0, 1) : allCandidates;
  if (candidates.length === 0) {
    return sendError(res, clientWire, 503, clientWire === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model in the brief meets this request');
  }
  const failures: TrailRow[] = [];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate.id)) continue;
    tried.add(candidate.id);
    const upstreamBody: Json = clientWire === 'anthropic' ? anthropicToOpenAI(body, candidate.id) : { ...body };
    const result = await dial(candidate.id, upstreamBody);
    if (!result.ok || result.response === null) {
      noteFailure(candidate.id);
      noteBreaker(result.status, result.trail === null ? 'unreachable' : result.trail.code);
      if (result.trail !== null) failures.push(result.trail);
      log(`request ${manifestIndex} (${clientWire}): ${candidate.id} refused (HTTP ${result.status})`);
      if (breakerTripped()) {
        log(`request ${manifestIndex}: circuit breaker tripped (${breaker?.count} identical refusals); failover stops for this prompt`);
        break;
      }
      continue;
    }
    const upstream = result.response;
    const extra = trailHeader(failures);
    if (body.stream === true) {
      breaker = null;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
      try {
        if (clientWire === 'anthropic') {
          for await (const event of anthropicEventsFromOpenAI(upstream.body, candidate.id)) res.write(event);
        } else {
          for await (const frame of openAIStreamWithModel(upstream.body, candidate.id)) res.write(frame);
        }
      } finally {
        res.end();
      }
      return;
    }
    let answer: unknown;
    try {
      answer = await upstream.json();
    } catch {
      noteFailure(candidate.id);
      noteBreaker(result.status, 'unparseable_body');
      log(`request ${manifestIndex} (${clientWire}): ${candidate.id} answered unparseable JSON`);
      if (breakerTripped()) break;
      continue;
    }
    if (!isRecord(answer)) {
      noteFailure(candidate.id);
      noteBreaker(result.status, 'unparseable_body');
      if (breakerTripped()) break;
      continue;
    }
    breaker = null;
    if (clientWire === 'anthropic') sendJson(res, 200, openAIToAnthropic(answer, candidate.id), extra);
    else sendJson(res, 200, openAIJsonWithModel(answer, candidate.id), extra);
    return;
  }
  sendError(res, clientWire, 502, clientWire === 'anthropic' ? 'api_error' : 'upstream_error', 'every free model meeting this request refused the gateway call');
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by a real free model. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve(req, res, 'openai', body);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve(req, res, 'anthropic', body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
