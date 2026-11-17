# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/ahridwann/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/ahridwann/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One Node server that aggregates the best free models behind a single
endpoint. It serves both the OpenAI Chat Completions API and the Anthropic
Messages API, and dials every prompt on the grader's gateway Chat
Completions route, using only free (`:free`) OpenRouter models — at $0.

## Run

```sh
node main.ts --list   # print the registration catalog and exit 0
node main.ts          # listen, register with the env, serve, exit on done
```

Node 22 or later, nothing to install. The entrypoint is `main.ts`
(`lib/wire.ts` serves the two wires, `lib/providers.ts` holds the catalog,
the routing and the gateway client).

Environment the trial sets:

- `MAKEFUN_ENV_URL` — the env origin (`POST /register`, `GET /work`).
- `OPENAI_BASE_URL` — the gateway (`POST $OPENAI_BASE_URL/chat/completions`).
- `OPENAI_API_KEY` — the trial's stand-in key, sent as
  `Authorization: Bearer …`. The gateway swaps it for the entrant's own
  OpenRouter key, which never enters this repository or this process's
  files. No provider key lives anywhere in this repo.

## Catalog

Exactly fourteen free models, each dialled as
`openrouter/<upstream id>:free`, byte-identical between `--list` output,
the register body, and both `GET /v1/models` answers:

| Model | Rating |
| --- | --- |
| inclusionai/ling-3.2-flash | 1150 |
| baidu/ernie-5.5-flash-preview | 1150 |
| thinkingmachines/inkling-2-small | 1475 |
| liquid/lfm-3-1.7b | 1150 |
| particle-ai/particle-1 | 1150 |
| recursive/flint-v1.0 | 1150 |
| nvidia/nemotron-3.5-super-vl | 1303 |
| dots-studio/dots-3-note-preview | 1150 |
| nvidia/nemotron-3.5-lightning | 1221 |
| cohere/north-mini-code | 1200 |
| nvidia/nemotron-3-ultra-550b-a55b | 1285 |
| nvidia/nemotron-3-nano-omni-30b-a3b-reasoning | 1150 |
| google/gemma-4-26b-a4b-it | 1150 |
| google/gemma-4-31b-it | 1210 |

## Routing

Candidates are ordered by the house rating, highest first. A request
naming model `auto` is served by the best model that meets its needs:

- JSON-mode prompts (`response_format`) only see models that support JSON
  mode — best is Super VL (1303).
- Every other prompt starts with Inkling (1475, the highest rated), then
  Super VL (1303), Ultra (1285), Lightning (1221), Gemma 4 31B (1210),
  North (1200), then the 1150s.

OpenRouter itself refuses Inkling with HTTP 403 ("only available on
agentic harnesses") — an OpenRouter-side gate, not a defect in this code —
so in practice the non-JSON prompts land on Super VL, which caps quality
at 90. A refusal is never an answer: it is retried on the next model, and
the trail of refusals rides the `x-makefun-upstream-failures` response
header (at most 8 rows) so the failover column can see it. A transient
refusal — HTTP 429, any 5xx, or a fetch-level failure (timeout or
unreachable) — is first retried once on the same model after a fixed
1000 ms delay (no jitter), and only then fails over to the next model;
a hard refusal (e.g. 403) fails over at once with no retry. At most 60
model calls per trial, and every model request names `max_tokens`.

## Wires

- `POST /v1/chat/completions` — OpenAI. The body carries its messages,
  system prompt, tools, `max_tokens` and temperature through unchanged.
  `stream: true` asks for server-sent events.
- `POST /v1/messages` — Anthropic. The body is translated into Chat
  Completions first (system prompt becomes the first system message,
  tools become OpenAI function tools), and the gateway's answer is
  translated back into the Messages wire.
- `GET /v1/models` — the OpenAI shape for `Authorization: Bearer`, the
  Anthropic shape for `x-api-key`.

The provider's answer names the model without the gateway prefix; this
server puts the id it really dialled back on every answer and every
streamed chunk. In an OpenAI SSE stream only the first `finish_reason`
may carry a value — any later chunk that repeats one has it nulled.

Anthropic streams are buffered whole before being re-emitted as
`message_start` / `content_block_*` / `message_delta` / `message_stop`,
because the input token count only arrives with the final usage chunk.

## Determinism

Every byte the server sends is a function of the request and the gateway's
answers: no wall clock (a `created` field, where the shape wants one, is
the fixed constant 0) and no unseeded randomness. The usage and stop
reason of each answer are passed through whole; where the provider sends
no usage at all, a minimal usage object is synthesised so the wire check
still sees a whole count (the gateway forwards streams with
`include_usage`, so this fallback should never fire).

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kc98nxwf&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
