# free-model-aggregator-02

One server (Node 22, `main.ts`, stdlib only) that aggregates OpenRouter's fourteen
free models behind one OpenAI-compatible (`POST /v1/chat/completions`) and one
Anthropic-compatible (`POST /v1/messages`) API, JSON and server-sent events, and
answers every prompt with a real completion dialled through the grader's gateway.

- **Routing:** every free model meeting a prompt's requirements is ranked by the
  brief's `rating_milli` (descending, tie-break on model id). The best model
  overall is Inkling 2 Small (1475); the best JSON-capable model is Nemotron 3.5
  Super VL (1303), which serves the two JSON-mode prompts.
- **Failover:** on a gateway 4xx/5xx, an unreachable gateway, or an unparseable
  answer, the prompt is retried on the next-best candidate. A model that refused
  is demoted for later prompts. Recovered refusals are reported in the
  `x-makefun-upstream-failures` header.
- **Catalog:** exactly the fourteen free models the brief lists, once each, as
  `openrouter/<vendor>/<model>:free`. `node main.ts --list` prints that same
  document; with no brief it prints `{"providers":[]}`.

Run: `node main.ts` with `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE`,
`OPENAI_BASE_URL` and `OPENAI_API_KEY` set. The server registers with the env,
serves the six prompts, and exits 0 when the env says the work is done.

MIT licensed.
