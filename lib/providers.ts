// providers.ts — the free-model catalog and the OpenRouter provider client.
//
// This module owns three things:
//   1. The catalog: exactly the fourteen free models the trial allows, each
//      named by its dialable id `openrouter/<upstream id>:free`.
//   2. Quality routing: which model to dial first for a prompt, and which to
//      fail over to when the gateway refuses one.
//   3. The gateway client: one Chat Completions call per attempt, with the
//      refusal trail (`x-makefun-upstream-failures`) collected for the wire.
//
// The server never holds a provider key. The only key it ever sends is the
// trial's stand-in key from OPENAI_API_KEY, exactly as an OpenAI SDK sends
// it (Authorization: Bearer). The grader's gateway swaps that stand-in for
// the entrant's own OpenRouter key, which never enters this process's files.

export interface FreeModel {
  /** Upstream id without the gateway prefix, e.g. `nvidia/nemotron-3.5-super-vl:free`. */
  id: string;
  /** The model's published display name. */
  displayName: string;
  /** House quality rating, 0-2000, higher is stronger. */
  ratingMilli: number;
  /** Context window in tokens. */
  contextLength: number;
  /** Whether the model takes tool calls. */
  tools: boolean;
  /** Whether the model takes images. */
  vision: boolean;
  /** Whether the model supports JSON mode (response_format json_object). */
  json: boolean;
}

/** The gateway prefix every dialable id carries. */
export const GATEWAY_PREFIX = "openrouter/";

/**
 * The fourteen free models, in the order the trial brief lists them.
 * Ratings and context lengths are the house's sealed table from the brief.
 */
export const FREE_MODELS: readonly FreeModel[] = [
  { id: "inclusionai/ling-3.2-flash:free", displayName: "inclusionAI: Ling 3.2 Flash (free)", ratingMilli: 1150, contextLength: 1048576, tools: true, vision: true, json: true },
  { id: "baidu/ernie-5.5-flash-preview:free", displayName: "Baidu: ERNIE-5.5-Flash-Preview (free)", ratingMilli: 1150, contextLength: 1024000, tools: true, vision: false, json: true },
  { id: "thinkingmachines/inkling-2-small:free", displayName: "Thinking Machines: Inkling 2 Small (free)", ratingMilli: 1475, contextLength: 1048576, tools: true, vision: true, json: false },
  { id: "liquid/lfm-3-1.7b:free", displayName: "LiquidAI: LFM3-1.7B (free)", ratingMilli: 1150, contextLength: 262144, tools: true, vision: false, json: true },
  { id: "particle-ai/particle-1:free", displayName: "Particle AI: Particle-1 (free)", ratingMilli: 1150, contextLength: 1048576, tools: true, vision: true, json: true },
  { id: "recursive/flint-v1.0:free", displayName: "Recursive: Flint (free)", ratingMilli: 1150, contextLength: 262144, tools: true, vision: false, json: true },
  { id: "nvidia/nemotron-3.5-super-vl:free", displayName: "NVIDIA: Nemotron 3.5 Super VL (free)", ratingMilli: 1303, contextLength: 1000000, tools: true, vision: true, json: true },
  { id: "dots-studio/dots-3-note-preview:free", displayName: "Dots Studio: Dots3-Note Preview (free)", ratingMilli: 1150, contextLength: 512000, tools: true, vision: true, json: true },
  { id: "nvidia/nemotron-3.5-lightning:free", displayName: "NVIDIA: Nemotron 3.5 Lightning (free)", ratingMilli: 1221, contextLength: 1000000, tools: true, vision: false, json: false },
  { id: "cohere/north-mini-code:free", displayName: "Cohere: North Mini Code (free)", ratingMilli: 1200, contextLength: 256000, tools: true, vision: false, json: false },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", displayName: "NVIDIA: Nemotron 3 Ultra (free)", ratingMilli: 1285, contextLength: 1000000, tools: true, vision: false, json: false },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", displayName: "NVIDIA: Nemotron 3 Nano Omni (free)", ratingMilli: 1150, contextLength: 256000, tools: true, vision: true, json: false },
  { id: "google/gemma-4-26b-a4b-it:free", displayName: "Google: Gemma 4 26B A4B (free)", ratingMilli: 1150, contextLength: 262144, tools: true, vision: true, json: true },
  { id: "google/gemma-4-31b-it:free", displayName: "Google: Gemma 4 31B (free)", ratingMilli: 1210, contextLength: 262144, tools: true, vision: true, json: true },
];

/** The dialable id of a model: the gateway prefix plus its upstream id. */
export function dialableId(model: FreeModel): string {
  return `${GATEWAY_PREFIX}${model.id}`;
}

/** Every dialable id, in catalog order. */
export const DIALABLE_IDS: readonly string[] = FREE_MODELS.map(dialableId);

/** Look a model up by its dialable id (or its bare upstream id). */
export function modelById(id: string): FreeModel | null {
  const bare = id.startsWith(GATEWAY_PREFIX) ? id.slice(GATEWAY_PREFIX.length) : id;
  for (const model of FREE_MODELS) {
    if (model.id === bare) return model;
  }
  return null;
}

/**
 * The registration catalog: the exact document `--list` prints and the
 * register body carries, byte for byte. One provider, `openrouter`, whose
 * models are the fourteen dialable ids, each free, with its context length.
 */
export function buildCatalog(): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: FREE_MODELS.map((model) => ({
          id: dialableId(model),
          free: true,
          context_length: model.contextLength,
        })),
      },
    ],
  };
}

/** What a prompt needs from its model. */
export interface PromptNeeds {
  /** True when the prompt is JSON-mode (response_format json_object). */
  json?: boolean;
  /** True when the prompt declares tools. */
  tools?: boolean;
}

/**
 * Candidate models for a prompt, best first.
 *
 * The order is the house rating, highest first, with ties broken by id so
 * the order is fixed no matter what. JSON-mode prompts only see models that
 * support JSON mode: the best of those is Super VL (1303). Every other
 * prompt starts with Inkling (1475, the highest rated), then Super VL
 * (1303), Ultra (1285), Lightning (1221), Gemma 4 31B (1210), North (1200),
 * then the 1150s by id.
 *
 * Inkling is refused by OpenRouter itself with HTTP 403 ("only available on
 * agentic harnesses") — an OpenRouter-side gate, not a defect here — so in
 * practice the non-JSON prompts land on Super VL. That caps quality at 90.
 */
export function candidatesFor(needs: PromptNeeds): string[] {
  const byRating = [...FREE_MODELS].sort((a, b) => {
    if (b.ratingMilli !== a.ratingMilli) return b.ratingMilli - a.ratingMilli;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const eligible = byRating.filter((model) => {
    if (needs.json === true && !model.json) return false;
    if (needs.tools === true && !model.tools) return false;
    return true;
  });
  return eligible.map(dialableId);
}

/** One refused gateway call, as the `x-makefun-upstream-failures` header carries it. */
export interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/** A completed gateway call: the model that really served it, and its body. */
export interface UpstreamAnswer {
  /** The dialable id that was really dialled. */
  model: string;
  /** HTTP status of the gateway's answer. */
  status: number;
  /** The parsed JSON body (non-streaming calls). */
  json: Record<string, unknown> | null;
  /** The raw SSE text (streaming calls), buffered whole. */
  sseText: string | null;
  /** Refusals retried before this answer, in the order they happened. */
  failures: UpstreamFailure[];
}

/** The gateway refused every candidate, or the trial ran out of calls. */
export interface UpstreamGiveUp {
  ok: false;
  failures: UpstreamFailure[];
}

export type UpstreamOutcome = ({ ok: true } & UpstreamAnswer) | UpstreamGiveUp;

/** The trial's budget: at most 60 model calls. */
export const MAX_UPSTREAM_CALLS_PER_TRIAL = 60;

/** One gateway call may take at most this long; the env allows 30 s a prompt. */
const CALL_TIMEOUT_MS = 25000;

/**
 * A transient refusal is retried once on the same model, after a fixed
 * delay, before failing over to the next model: a rate limit (429), a
 * server-side refusal (5xx), or a fetch-level failure (status 599:
 * timeout or unreachable, e.g. the gateway briefly unreachable at trial
 * start). The delay is a fixed constant — no random jitter, so nothing
 * unseeded goes into anything sent.
 */
const RETRY_DELAY_MS = 1000;

/** Attempts per model: the first dial plus one retry on a transient refusal. */
const MAX_ATTEMPTS_PER_MODEL = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed attempt is worth one retry on the same model.
 * Any other refusal (400, 403, ...) is a hard refusal for that model:
 * fail over to the next model at once, with no retry.
 */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Default output cap when a request names none (the gateway requires one). */
const DEFAULT_MAX_TOKENS = 512;

/** Largest output cap the gateway accepts. */
const MAX_OUTPUT_TOKENS = 8192;

function gatewayBaseUrl(): string {
  const base = process.env.OPENAI_BASE_URL;
  if (typeof base === "string" && base !== "") return base.replace(/\/$/, "");
  return "https://openrouter.ai/api/v1";
}

function gatewayKey(): string {
  return process.env.OPENAI_API_KEY ?? "";
}

/**
 * The model name to put on the wire. The `openrouter/` prefix is the
 * gateway's: when the base URL is the gateway it stays, and when the base
 * URL is OpenRouter itself it is stripped, because OpenRouter's own ids
 * carry no prefix.
 */
function wireModelId(baseUrl: string, dialable: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = "";
  }
  if (host === "openrouter.ai" && dialable.startsWith(GATEWAY_PREFIX)) {
    return dialable.slice(GATEWAY_PREFIX.length);
  }
  return dialable;
}

/** The error code of a gateway refusal body, as a plain string. */
function errorCodeOf(bodyText: string): string {
  try {
    const value: unknown = JSON.parse(bodyText);
    if (value !== null && typeof value === "object") {
      const error = (value as Record<string, unknown>).error;
      if (error !== null && typeof error === "object") {
        const record = error as Record<string, unknown>;
        if (typeof record.code === "string" && record.code !== "") return record.code.slice(0, 64);
        if (typeof record.code === "number") return String(record.code);
        if (typeof record.type === "string" && record.type !== "") return record.type.slice(0, 64);
      }
    }
  } catch {
    // Not JSON: no code to report.
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dial one model once on the gateway's Chat Completions route.
 * Returns the answer on 2xx, or the refusal (status + code) otherwise.
 */
async function dialOnce(
  dialable: string,
  body: Record<string, unknown>,
  stream: boolean,
): Promise<
  | { ok: true; status: number; json: Record<string, unknown> | null; sseText: string | null }
  | { ok: false; status: number; code: string }
> {
  const baseUrl = gatewayBaseUrl();
  const url = `${baseUrl}/chat/completions`;
  const requestBody: Record<string, unknown> = { ...body };
  requestBody.model = wireModelId(baseUrl, dialable);
  const maxTokens = requestBody.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) {
    requestBody.max_tokens = DEFAULT_MAX_TOKENS;
  } else if (maxTokens > MAX_OUTPUT_TOKENS) {
    requestBody.max_tokens = MAX_OUTPUT_TOKENS;
  }
  requestBody.stream = stream;
  if (stream) {
    const options = isRecord(requestBody.stream_options)
      ? { ...requestBody.stream_options, include_usage: true }
      : { include_usage: true };
    requestBody.stream_options = options;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayKey()}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err !== null &&
      typeof err === "object" &&
      ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError");
    return { ok: false, status: 599, code: timedOut ? "timeout" : "unreachable" };
  }

  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, code: errorCodeOf(text) };
  }
  if (stream) {
    return { ok: true, status: response.status, json: null, sseText: text };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    ok: true,
    status: response.status,
    json: isRecord(parsed) ? parsed : null,
    sseText: null,
  };
}

/**
 * Serve one prompt: try the candidates in order until one answers, and
 * collect every refusal on the way. A refusal is never an answer: a
 * transient refusal (429, 5xx, or a fetch-level failure) is retried once
 * on the same model after a fixed 1000 ms delay, and only then does the
 * prompt fail over to the next-best model; a hard refusal (e.g. 403)
 * fails over at once. The trail of refusals — one row per model that
 * finally failed — rides the response header so the failover column can
 * see it. Every prompt gets a valid answer unless the whole model list
 * is exhausted or the trial's call budget runs out.
 *
 * `calls` counts the trial's model calls so far; the trial stops dialling
 * at MAX_UPSTREAM_CALLS_PER_TRIAL. `exclude` names models an earlier pass
 * already tried for this prompt, so a retry never re-dials one.
 */
export async function servePrompt(
  needs: PromptNeeds,
  body: Record<string, unknown>,
  stream: boolean,
  calls: { count: number },
  exclude: ReadonlySet<string> = new Set(),
): Promise<UpstreamOutcome> {
  const failures: UpstreamFailure[] = [];
  for (const candidate of candidatesFor(needs)) {
    if (exclude.has(candidate)) continue;
    let lastFailure: UpstreamFailure | null = null;
    for (let attemptNo = 0; attemptNo < MAX_ATTEMPTS_PER_MODEL; attemptNo += 1) {
      if (calls.count >= MAX_UPSTREAM_CALLS_PER_TRIAL) break;
      calls.count += 1;
      const attempt = await dialOnce(candidate, body, stream);
      if (attempt.ok) {
        return {
          ok: true,
          model: candidate,
          status: attempt.status,
          json: attempt.json,
          sseText: attempt.sseText,
          failures,
        };
      }
      lastFailure = { status: attempt.status, code: attempt.code, model: candidate };
      if (
        attemptNo + 1 < MAX_ATTEMPTS_PER_MODEL &&
        isRetryable(attempt.status) &&
        calls.count < MAX_UPSTREAM_CALLS_PER_TRIAL
      ) {
        await sleep(RETRY_DELAY_MS);
      } else {
        break;
      }
    }
    if (lastFailure !== null) failures.push(lastFailure);
    if (calls.count >= MAX_UPSTREAM_CALLS_PER_TRIAL) break;
  }
  return { ok: false, failures };
}
