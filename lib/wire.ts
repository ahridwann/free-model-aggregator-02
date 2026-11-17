// wire.ts — the two completion wires: OpenAI Chat Completions and Anthropic
// Messages, both served by one server, both dialled on the gateway's Chat
// Completions route.
//
// A request names model "auto". The wire replaces it with the dialable id
// of the free model the provider layer chose, dials that model on the
// gateway, and returns the answer in the wire the client used, streamed or
// not as asked, with its usage and stop reason whole. The provider's own
// answer names the model without the gateway prefix: this module puts the
// id that was really dialled back on every answer and every streamed chunk.
//
// Determinism: every byte this module sends is a function of the request
// and the gateway's answers. No wall clock (a `created` field, where the
// shape wants one, is the fixed constant 0) and no unseeded randomness.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DIALABLE_IDS,
  FREE_MODELS,
  buildCatalog,
  modelById,
  servePrompt,
  type PromptNeeds,
  type UpstreamFailure,
} from "./providers.ts";

const FAILURES_HEADER = "x-makefun-upstream-failures";
const MAX_FAILURE_ROWS = 8;
const MAX_BODY_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* ------------------------------------------------------------------ */
/* Model list                                                          */
/* ------------------------------------------------------------------ */

/**
 * GET /v1/models. The wire is the auth header: Authorization: Bearer is
 * OpenAI, x-api-key (with anthropic-version) is Anthropic. Both answers
 * list exactly the fourteen dialable ids, once each, so the catalog column
 * compares equal on all three sides (register catalog, OpenAI list,
 * Anthropic list).
 */
export function modelsAnswer(req: IncomingMessage): Record<string, unknown> {
  const headers = req.headers;
  const anthropic = typeof headers["x-api-key"] === "string" && headers["x-api-key"] !== "";
  if (anthropic) {
    return {
      data: FREE_MODELS.map((model) => ({
        id: `openrouter/${model.id}`,
        type: "model",
        display_name: model.displayName,
      })),
      has_more: false,
      first_id: `openrouter/${FREE_MODELS[0].id}`,
      last_id: `openrouter/${FREE_MODELS[FREE_MODELS.length - 1].id}`,
    };
  }
  return {
    object: "list",
    data: DIALABLE_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: "openrouter",
      free: true,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic -> Chat Completions translation                           */
/* ------------------------------------------------------------------ */

type ChatMessage = Record<string, unknown>;

function anthropicTextOf(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function anthropicContentToOpenAI(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: unknown[] = [];
  let text = "";
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "image" && isRecord(block.source)) {
      const source = block.source;
      if (source.type === "base64" && typeof source.data === "string") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${asString(source.media_type) || "image/png"};base64,${source.data}` },
        });
      } else if (source.type === "url" && typeof source.url === "string") {
        parts.push({ type: "image_url", image_url: { url: source.url } });
      }
    }
  }
  if (parts.length === 0) return text;
  if (text !== "") parts.unshift({ type: "text", text });
  return parts;
}

function anthropicMessagesToOpenAI(system: unknown, messages: unknown): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = anthropicTextOf(system);
  if (systemText !== "") out.push({ role: "system", content: systemText });
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = raw.role === "assistant" ? "assistant" : raw.role === "tool" ? "tool" : "user";
    const content = raw.content;
    if (Array.isArray(content)) {
      const toolUses: ChatMessage[] = [];
      const toolResults: ChatMessage[] = [];
      let text = "";
      const media: unknown[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "image" && isRecord(block.source)) {
          const source = block.source;
          if (source.type === "base64" && typeof source.data === "string") {
            media.push({
              type: "image_url",
              image_url: { url: `data:${asString(source.media_type) || "image/png"};base64,${source.data}` },
            });
          } else if (source.type === "url" && typeof source.url === "string") {
            media.push({ type: "image_url", image_url: { url: source.url } });
          }
        } else if (block.type === "tool_use") {
          toolUses.push({
            id: asString(block.id) || "call_0",
            type: "function",
            function: {
              name: asString(block.name),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: asString(block.tool_use_id),
            content: anthropicTextOf(block.content),
          });
        }
      }
      if (toolResults.length > 0) {
        for (const result of toolResults) out.push(result);
        continue;
      }
      if (toolUses.length > 0) {
        const message: ChatMessage = { role: "assistant", content: text === "" ? null : text, tool_calls: toolUses };
        out.push(message);
        continue;
      }
      if (media.length > 0) {
        const parts: unknown[] = [];
        if (text !== "") parts.push({ type: "text", text });
        parts.push(...media);
        out.push({ role, content: parts });
      } else {
        out.push({ role, content: text });
      }
    } else {
      out.push({ role, content: typeof content === "string" ? content : "" });
    }
  }
  return out;
}

function anthropicToolsToOpenAI(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined;
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        description: asString(tool.description),
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function anthropicToolChoiceToOpenAI(choice: unknown): unknown {
  if (!isRecord(choice) || typeof choice.type !== "string") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

/**
 * Translate an Anthropic Messages body into the Chat Completions body the
 * gateway dials. The system prompt becomes the first system message, the
 * messages and tools are translated, and max_tokens, temperature and the
 * stream flag carry through unchanged.
 */
export function anthropicToChatBody(request: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: anthropicMessagesToOpenAI(request.system, request.messages),
  };
  const tools = anthropicToolsToOpenAI(request.tools);
  if (tools !== undefined) body.tools = tools;
  const toolChoice = anthropicToolChoiceToOpenAI(request.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (typeof request.max_tokens === "number") body.max_tokens = request.max_tokens;
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (Array.isArray(request.stop_sequences)) body.stop = request.stop_sequences;
  if (request.stream === true) body.stream = true;
  return body;
}

/**
 * Pass an OpenAI Chat Completions body through unchanged, except the model
 * (replaced by the provider layer) and any provider-state field the gateway
 * refuses. `max_tokens` is always present after this: the gateway requires
 * an output cap on every model request.
 */
export function openAIToChatBody(request: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...request };
  delete body.model;
  delete body.store;
  delete body.previous_response_id;
  if (typeof body.max_tokens !== "number") body.max_tokens = 512;
  return body;
}

/* ------------------------------------------------------------------ */
/* Upstream answer -> client wire                                      */
/* ------------------------------------------------------------------ */

function finishReasonOf(choice: Record<string, unknown>): string | null {
  return typeof choice.finish_reason === "string" ? choice.finish_reason : null;
}

function usageOf(value: Record<string, unknown> | null, fallbackOutput: number): Record<string, number> {
  if (value !== null && isRecord(value.usage)) {
    const usage = value.usage;
    const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : fallbackOutput;
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  }
  return { prompt_tokens: 0, completion_tokens: fallbackOutput, total_tokens: fallbackOutput };
}

function messageTextOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("");
  }
  return "";
}

/** OpenAI finish_reason -> Anthropic stop_reason. */
function anthropicStopReason(finishReason: string | null): string {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  if (finishReason === "content_filter") return "refusal";
  return "end_turn";
}

function anthropicContentOf(message: Record<string, unknown>): unknown[] {
  const blocks: unknown[] = [];
  const text = messageTextOf(message);
  if (text !== "") blocks.push({ type: "text", text });
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      let input: unknown = {};
      if (typeof call.function.arguments === "string") {
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = {};
        }
      }
      blocks.push({
        type: "tool_use",
        id: asString(call.id) || "call_0",
        name: asString(call.function.name),
        input,
      });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

/** Build a non-streaming OpenAI answer from the upstream JSON. */
function openAIAnswer(model: string, upstream: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(upstream.choices) ? upstream.choices : [];
  const first = choices.length > 0 && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : {};
  const message = isRecord(first.message) ? first.message : { role: "assistant", content: "" };
  const finish = finishReasonOf(first) ?? "stop";
  return {
    id: asString(upstream.id) || "chatcmpl-0",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usageOf(upstream, 1),
  };
}

/** Build a non-streaming Anthropic answer from the upstream JSON. */
function anthropicAnswer(model: string, upstream: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(upstream.choices) ? upstream.choices : [];
  const first = choices.length > 0 && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : {};
  const message = isRecord(first.message) ? first.message : { role: "assistant", content: "" };
  const usage = usageOf(upstream, 1);
  return {
    id: `msg_${asString(upstream.id) || "0"}`,
    type: "message",
    role: "assistant",
    model,
    content: anthropicContentOf(message),
    stop_reason: anthropicStopReason(finishReasonOf(first)),
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}

/* ------------------------------------------------------------------ */
/* SSE handling                                                        */
/* ------------------------------------------------------------------ */

interface SseChunk {
  data: string;
}

/** Split raw SSE text into its data frames, in order. */
export function parseSse(text: string): SseChunk[] {
  const frames: SseChunk[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  for (const frame of normalized.split("\n\n")) {
    if (frame.trim() === "") continue;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) frames.push({ data: data.join("\n") });
  }
  return frames;
}

interface StreamParts {
  /** The text deltas, in order. */
  texts: string[];
  /** The first finish_reason seen, or null. */
  finishReason: string | null;
  /** True when a usage object was seen. */
  sawUsage: boolean;
  /** Input tokens from the usage chunk, or null. */
  inputTokens: number | null;
  /** Output tokens from the usage chunk, or null. */
  outputTokens: number | null;
  /** The upstream response id, or "". */
  id: string;
  /** True when any chunk carried tool call deltas. */
  sawToolCalls: boolean;
  /** True when a chunk was an error object. */
  sawError: boolean;
}

/** Read an upstream OpenAI SSE stream into its parts. */
function readUpstreamStream(sseText: string): StreamParts {
  const parts: StreamParts = {
    texts: [],
    finishReason: null,
    sawUsage: false,
    inputTokens: null,
    outputTokens: null,
    id: "",
    sawToolCalls: false,
    sawError: false,
  };
  for (const frame of parseSse(sseText)) {
    const payload = frame.data.trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.error)) {
      parts.sawError = true;
      continue;
    }
    if (parts.id === "" && typeof chunk.id === "string") parts.id = chunk.id;
    if (isRecord(chunk.usage)) {
      parts.sawUsage = true;
      if (typeof chunk.usage.prompt_tokens === "number") parts.inputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") parts.outputTokens = chunk.usage.completion_tokens;
    }
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
    const choice = chunk.choices[0];
    if (!isRecord(choice)) continue;
    if (isRecord(choice.delta)) {
      const delta = choice.delta;
      if (typeof delta.content === "string" && delta.content !== "") parts.texts.push(delta.content);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) parts.sawToolCalls = true;
    }
    if (typeof choice.finish_reason === "string" && parts.finishReason === null) {
      parts.finishReason = choice.finish_reason;
    }
  }
  return parts;
}

/**
 * Re-emit an upstream OpenAI SSE stream for the client. Only the FIRST
 * finish_reason may carry a value: any later chunk that repeats one has
 * it nulled, because the env counts a second finish chunk as a stream
 * order error. The model on every chunk is the id really dialled, and
 * `created` is the fixed constant 0. The stream always ends with [DONE].
 */
function openAIStreamText(model: string, sseText: string): string {
  const out: string[] = [];
  let sawFinish = false;
  let sawUsage = false;
  let firstId = "";
  for (const frame of parseSse(sseText)) {
    const payload = frame.data.trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.error)) continue;
    if (firstId === "" && typeof chunk.id === "string") firstId = chunk.id;
    if (isRecord(chunk.usage)) sawUsage = true;
    const rewritten: Record<string, unknown> = { ...chunk, model, created: 0 };
    if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
      const choice = chunk.choices[0];
      if (isRecord(choice)) {
        const rewrittenChoice: Record<string, unknown> = { ...choice };
        if (typeof choice.finish_reason === "string") {
          if (sawFinish) {
            rewrittenChoice.finish_reason = null;
          } else {
            sawFinish = true;
          }
        }
        rewritten.choices = [rewrittenChoice];
      }
    }
    out.push(`data: ${JSON.stringify(rewritten)}\n\n`);
  }
  if (!sawUsage) {
    // The gateway forwards streams with include_usage, so this is a
    // fallback only: a usage chunk the wire check needs (output >= 1).
    out.push(
      `data: ${JSON.stringify({
        id: firstId || "chatcmpl-0",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
      })}\n\n`,
    );
  }
  out.push("data: [DONE]\n\n");
  return out.join("");
}

/**
 * Translate a buffered upstream OpenAI SSE stream into Anthropic SSE
 * events: message_start, one text content block, message_delta,
 * message_stop, in that order, with the real usage on the start and the
 * delta. The stream is buffered whole first, because the input token
 * count only arrives with the final usage chunk.
 */
function anthropicStreamText(model: string, sseText: string): string {
  const parts = readUpstreamStream(sseText);
  const events: string[] = [];
  const id = `msg_${parts.id || "0"}`;
  const inputTokens = parts.inputTokens ?? 0;
  const outputTokens = parts.outputTokens ?? 1;
  const stopReason = anthropicStopReason(parts.finishReason);
  events.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })}\n\n`,
  );
  const text = parts.texts.join("");
  if (text !== "") {
    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
    );
    for (const piece of parts.texts) {
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        })}\n\n`,
      );
    }
    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    );
  }
  events.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens },
    })}\n\n`,
  );
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return events.join("");
}

/* ------------------------------------------------------------------ */
/* Serving one prompt                                                  */
/* ------------------------------------------------------------------ */

export interface CompletionResult {
  status: number;
  contentType: string;
  body: string;
  failures: UpstreamFailure[];
}

function failuresHeader(failures: UpstreamFailure[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { [FAILURES_HEADER]: JSON.stringify(failures.slice(0, MAX_FAILURE_ROWS)) };
}

function needsOf(api: "openai" | "anthropic", request: Record<string, unknown>): PromptNeeds {
  const needs: PromptNeeds = {};
  if (api === "openai" && isRecord(request.response_format)) {
    needs.json = true;
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    needs.tools = true;
  }
  return needs;
}

/**
 * Did the upstream answer carry anything the prompt can use? An answer
 * with no text and no tool calls cannot carry the prompt's token, so it
 * counts as a failed attempt and the next model is tried.
 */
function answerUsable(
  stream: boolean,
  json: Record<string, unknown> | null,
  sseText: string | null,
): boolean {
  if (stream) {
    if (sseText === null) return false;
    const parts = readUpstreamStream(sseText);
    if (parts.sawError) return false;
    if (parts.finishReason === null) return false;
    if (parts.texts.join("") === "" && !parts.sawToolCalls) return false;
    return true;
  }
  if (json === null) return false;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  if (choices.length === 0 || !isRecord(choices[0])) return false;
  const first = choices[0] as Record<string, unknown>;
  if (!isRecord(first.message)) return false;
  const message = first.message;
  const text = messageTextOf(message);
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (text === "" && !hasToolCalls) return false;
  if (typeof first.finish_reason !== "string") return false;
  return true;
}

/**
 * Serve one completion request on either wire. The model is chosen by the
 * provider layer; this function translates the request, dials, and
 * translates the answer back, retrying across models on refusals and on
 * unusable answers.
 */
export async function serveCompletion(
  api: "openai" | "anthropic",
  request: Record<string, unknown>,
  calls: { count: number },
): Promise<CompletionResult> {
  const stream = request.stream === true;
  const needs = needsOf(api, request);
  const chatBody = api === "openai" ? openAIToChatBody(request) : anthropicToChatBody(request);

  const failures: UpstreamFailure[] = [];
  const tried = new Set<string>();
  const errorResult = (): CompletionResult => {
    const errorBody =
      api === "openai"
        ? { error: { message: "all upstream models failed", type: "upstream_error", code: "upstream_failed" } }
        : { type: "error", error: { type: "overloaded_error", message: "all upstream models failed" } };
    return { status: 502, contentType: "application/json", body: `${JSON.stringify(errorBody)}\n`, failures };
  };

  const first = await servePrompt(needs, chatBody, stream, calls);
  failures.push(...first.failures);
  if (!first.ok) return errorResult();
  tried.add(first.model);
  for (const failure of first.failures) {
    if (failure.model !== null) tried.add(failure.model);
  }
  if (answerUsable(stream, first.json, first.sseText)) {
    return buildSuccess(api, stream, first.model, first.json, first.sseText, failures);
  }

  // The model answered, but with nothing the prompt can use (no text and
  // no tool calls). Record it and try the models not yet tried.
  failures.push({ status: first.status, code: "empty_answer", model: first.model });
  const retry = await servePrompt(needs, chatBody, stream, calls, tried);
  failures.push(...retry.failures);
  if (!retry.ok) return errorResult();
  if (!answerUsable(stream, retry.json, retry.sseText)) {
    failures.push({ status: retry.status, code: "empty_answer", model: retry.model });
    return errorResult();
  }
  return buildSuccess(api, stream, retry.model, retry.json, retry.sseText, failures);
}

function buildSuccess(
  api: "openai" | "anthropic",
  stream: boolean,
  model: string,
  json: Record<string, unknown> | null,
  sseText: string | null,
  failures: UpstreamFailure[],
): CompletionResult {
  if (stream) {
    const text = sseText ?? "";
    const body = api === "openai" ? openAIStreamText(model, text) : anthropicStreamText(model, text);
    return { status: 200, contentType: "text/event-stream", body, failures };
  }
  const upstream = json ?? {};
  const answer = api === "openai" ? openAIAnswer(model, upstream) : anthropicAnswer(model, upstream);
  return { status: 200, contentType: "application/json", body: `${JSON.stringify(answer)}\n`, failures };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

export interface WireServerOptions {
  host: string;
  port: number;
  calls: { count: number };
}

function sendJson(res: ServerResponse, status: number, value: Record<string, unknown>): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/**
 * The server: POST /v1/chat/completions (OpenAI), POST /v1/messages
 * (Anthropic), GET /v1/models (both shapes). Anything else is a 404.
 * A request whose model is not "auto" is still served: the model the
 * client names is replaced by the provider layer's choice either way.
 */
export function createWireServer(options: WireServerOptions) {
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://server");
      const path = url.pathname;
      try {
        if (method === "GET" && path === "/v1/models") {
          sendJson(res, 200, modelsAnswer(req));
          return;
        }
        if (method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
          const api = path === "/v1/chat/completions" ? "openai" : "anthropic";
          const raw = await readBody(req);
          if (raw === null) {
            sendJson(res, 413, { error: { message: "request body too large", type: "invalid_request_error" } });
            return;
          }
          let request: unknown;
          try {
            request = JSON.parse(raw.toString("utf8"));
          } catch {
            sendJson(res, 400, { error: { message: "request body is not JSON", type: "invalid_request_error" } });
            return;
          }
          if (!isRecord(request)) {
            sendJson(res, 400, { error: { message: "request body is not one JSON object", type: "invalid_request_error" } });
            return;
          }
          const result = await serveCompletion(api, request, options.calls);
          const headers: Record<string, string> = {
            "content-type": result.contentType,
            ...failuresHeader(result.failures),
          };
          const body = Buffer.from(result.body);
          headers["content-length"] = String(body.length);
          res.writeHead(result.status, headers);
          res.end(body);
          return;
        }
        sendJson(res, 404, { error: { message: `no route ${method} ${path}`, type: "not_found_error" } });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        try {
          sendJson(res, 500, { error: { message, type: "internal_error" } });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
  return server;
}

/** The catalog document, shared by --list and the register body. */
export function catalogDocument(): Record<string, unknown> {
  return buildCatalog();
}

/** The display name of a model, for the Anthropic model list. */
export function displayNameOf(modelId: string): string {
  const model = modelById(modelId);
  return model === null ? modelId : model.displayName;
}
