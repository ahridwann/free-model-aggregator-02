// main.ts — entrypoint: one Node server serving the OpenAI Chat
// Completions API and the Anthropic Messages API behind one port,
// dialling the best free models through the grader's gateway.
//
// Run with --list to print the registration catalog and exit 0, before
// any server starts. Otherwise the server listens, registers with the
// env at $MAKEFUN_ENV_URL, serves the env's prompts, and exits 0 when
// GET /work answers done true.
//
// Environment:
//   MAKEFUN_ENV_URL     the env origin, e.g. http://127.0.0.1:8080
//   OPENAI_BASE_URL     the gateway, e.g. http://127.0.0.1:18080/v1
//   OPENAI_API_KEY      the trial's stand-in key (the gateway swaps it
//                       for the entrant's own OpenRouter key)
//   MAKEFUN_TRIAL_SEED  the trial seed (no randomness is used here, so
//                       it is read and unused)
//   PORT                the port to listen on (default: an ephemeral one)

import { catalogDocument, createWireServer } from "./lib/wire.ts";

const PROTOCOL_VERSION = 1;
const REGISTER_PATH = "/register";
const WORK_PATH = "/work";
const POLL_MS = 500;
const REGISTER_RETRY_MS = 500;
const REGISTER_BUDGET_MS = 120_000;

function log(message: string): void {
  process.stderr.write(`free-model-aggregator-02: ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (typeof raw === "string" && raw !== "") return raw.replace(/\/$/, "");
  return "";
}

async function register(env: string, port: number): Promise<boolean> {
  const catalog = catalogDocument();
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${env}${REGISTER_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const text = await response.text();
        log(`registered with the env (port ${port}): ${text.trim()}`);
        return true;
      }
      log(`register answered HTTP ${response.status}; retrying`);
    } catch (err) {
      log(`register failed (${err instanceof Error ? err.message : "unreachable"}); retrying`);
    }
    if (Date.now() - started > REGISTER_BUDGET_MS) return false;
    await sleep(REGISTER_RETRY_MS);
  }
}

async function pollWork(env: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${env}${WORK_PATH}`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const value: unknown = await response.json();
        if (
          value !== null &&
          typeof value === "object" &&
          (value as Record<string, unknown>).done === true
        ) {
          log("the env answered work done; exiting 0");
          return;
        }
      }
    } catch {
      // The env may restart or lag; keep polling until it answers done.
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    process.stdout.write(`${JSON.stringify(catalogDocument(), null, 2)}\n`);
    return 0;
  }

  // MAKEFUN_TRIAL_SEED seeds any randomness a trial needs. This server
  // uses none: routing is a fixed order and answers are functions of
  // the request and the gateway's answers alone.
  void process.env.MAKEFUN_TRIAL_SEED;

  const calls = { count: 0 };
  const host = "127.0.0.1";
  const portText = process.env.PORT;
  const port = portText !== undefined && /^\d{1,5}$/.test(portText) ? Number(portText) : 0;

  const server = createWireServer({ host, port, calls });
  const bound = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  log(`listening on ${host}:${bound}`);

  const env = envUrl();
  if (env === "") {
    log("MAKEFUN_ENV_URL is not set; serving without an env (no exit)");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
    });
    server.close();
    return 0;
  }

  const registered = await register(env, bound);
  if (!registered) {
    log("could not register with the env; exiting 1");
    server.close();
    return 1;
  }
  await pollWork(env);
  server.close();
  return 0;
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`free-model-aggregator-02: ${err instanceof Error ? err.message : "failed"}\n`);
    process.exit(1);
  });
