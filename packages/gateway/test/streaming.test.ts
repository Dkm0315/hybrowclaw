import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, runDraftLoop } from "@musterhq/core";
import type { MusterConfig, StreamEvent } from "@musterhq/core";
import {
  approvePairing,
  classifySlackError,
  classifyTelegramError,
  createOutboundQueue,
  createSlackDraftSink,
  createTelegramDraftSink,
  gatewayConfigPath,
  loadGatewayConfig,
  OutboundHttpError,
  parseSurfaceMessage,
  requestPairing,
  slackDraftPostPayload,
  slackDraftUpdatePayload,
  startGatewayServer,
  TELEGRAM_SURFACE_ID,
  telegramDraftEditPayload,
  telegramDraftSendPayload,
} from "../src/index.js";

// --- fixtures & helpers (no live network anywhere) ---

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly auth?: string;
}

/** Scripted fetcher: each call pops the next fixture response. */
function makeFetcher(responses: Array<{ status?: number; payload: unknown }>): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers.authorization });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return new Response(JSON.stringify(next.payload), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function makeClock(): { now: () => number; advance: (ms: number) => void; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let at = 0;
  const sleeps: number[] = [];
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
    sleeps,
  };
}

/** Event script for runDraftLoop: numbers advance the fake clock between events. */
function script(clock: { advance: (ms: number) => void }, steps: Array<StreamEvent | number>): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const step of steps) {
        if (typeof step === "number") clock.advance(step);
        else yield step;
      }
    },
  };
}

function methodOf(call: RecordedCall): string {
  return call.url.split("/").pop()!;
}

const TELEGRAM_OK = { payload: { ok: true, result: { message_id: 77 } } };

// --- pure payload builders ---

test("telegram and slack draft payload builders are pure and shaped per the channel APIs", () => {
  assert.deepEqual(telegramDraftSendPayload("-100", "hi"), { chat_id: "-100", text: "hi" });
  assert.deepEqual(telegramDraftEditPayload("-100", 77, "hi again"), { chat_id: "-100", message_id: 77, text: "hi again" });
  assert.deepEqual(slackDraftPostPayload("C1", "hi", "171.001"), { channel: "C1", text: "hi", thread_ts: "171.001" });
  assert.deepEqual(slackDraftUpdatePayload("C1", "171.002", "hi again"), { channel: "C1", ts: "171.002", text: "hi again" });
});

// --- telegram draft sink through the core draft loop ---

test("telegram draft flow: sendMessage draft, throttled editMessageText updates, final edit", async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher([TELEGRAM_OK]);
  const sink = createTelegramDraftSink({
    botToken: "123:ABC",
    chatId: "-100",
    fetcher,
    queue: createOutboundQueue({ now: clock.now, sleep: clock.sleep }),
  });
  const events = script(clock, [
    { type: "delta", text: "Part one." },
    1000, // edit throttle window elapses
    { type: "delta", text: " Part two." },
    { type: "final", messageId: "m1", text: "Part one. Part two. Done." },
  ]);
  const result = await runDraftLoop(events, sink, { now: clock.now, sleep: clock.sleep });
  assert.equal(result.status, "finalized");
  assert.deepEqual(calls.map(methodOf), ["sendMessage", "editMessageText", "editMessageText"]);
  assert.deepEqual(calls[0].body, { chat_id: "-100", text: "Part one." });
  assert.deepEqual(calls[1].body, { chat_id: "-100", message_id: 77, text: "Part one. Part two." });
  assert.deepEqual(calls[2].body, { chat_id: "-100", message_id: 77, text: "Part one. Part two. Done." });
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot123:ABC\/sendMessage$/);
});

test("edit throttle is respected: edits inside the 1000ms window wait; final supersedes them", async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher([TELEGRAM_OK]);
  const sink = createTelegramDraftSink({
    botToken: "123:ABC",
    chatId: "-100",
    fetcher,
    queue: createOutboundQueue({ now: clock.now, sleep: clock.sleep }),
  });
  const events = script(clock, [
    { type: "delta", text: "first " },
    { type: "delta", text: "second " }, // 0ms later: throttled, stays pending
    { type: "delta", text: "third" },
    { type: "final", messageId: "m1", text: "first second third" },
  ]);
  await runDraftLoop(events, sink, { now: clock.now, sleep: clock.sleep });
  assert.deepEqual(calls.map(methodOf), ["sendMessage", "editMessageText"], "throttled middle edits collapse into the final");
  assert.equal(calls[1].body.text, "first second third");
});

test("outbound queue honors telegram retry_after backoff and retries the send", async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher([
    { status: 429, payload: { ok: false, description: "Too Many Requests: retry later", parameters: { retry_after: 2 } } },
    { payload: { ok: true, result: { message_id: 9 } } },
  ]);
  const sink = createTelegramDraftSink({
    botToken: "123:ABC",
    chatId: "-100",
    fetcher,
    queue: createOutboundQueue({ now: clock.now, sleep: clock.sleep }),
  });
  await sink.upsert("hello");
  assert.equal(calls.length, 2, "429 send is retried after the backoff");
  assert.ok(clock.sleeps.includes(2000), `retry_after must be honored in ms, slept: ${JSON.stringify(clock.sleeps)}`);
});

test("telegram edit failure degrades to send and never silently kills the draft (OpenClaw #92004)", async () => {
  const clock = makeClock();
  const responses = [
    { payload: { ok: true, result: { message_id: 5 } } }, // draft sendMessage
    { status: 400, payload: { ok: false, description: "Bad Request: message can't be edited" } }, // draft edit fails
    { status: 400, payload: { ok: false, description: "Bad Request: message can't be edited" } }, // final edit fails
    { payload: { ok: true, result: { message_id: 6 } } }, // degrade: final sent as a NEW message
  ];
  const { fetcher, calls } = makeFetcher(responses);
  const sink = createTelegramDraftSink({
    botToken: "123:ABC",
    chatId: "-100",
    fetcher,
    queue: createOutboundQueue({ now: clock.now, sleep: clock.sleep }),
  });
  const events = script(clock, [
    { type: "delta", text: "draft text" },
    1000,
    { type: "delta", text: " grows" },
    { type: "final", messageId: "m1", text: "draft text grows. Final." },
  ]);
  const result = await runDraftLoop(events, sink, { now: clock.now, sleep: clock.sleep });
  assert.equal(result.status, "degraded");
  const last = calls[calls.length - 1];
  assert.equal(methodOf(last), "sendMessage", "failed final edit must fall back to a fresh send");
  assert.equal(last.body.text, "draft text grows. Final.", "the final text is delivered, not dropped");
});

test("generation counter: a late sendMessage response never becomes the draft id of a newer generation", async () => {
  const pending: Array<(response: Response) => void> = [];
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolveResponse) => pending.push(resolveResponse));
  }) as typeof fetch;
  // Pass-through queue: lets requests overlap so a response can arrive late.
  const sink = createTelegramDraftSink({
    botToken: "123:ABC",
    chatId: "-100",
    fetcher,
    queue: { enqueue: (_key, task) => task() },
  });
  const slowUpsert = sink.upsert("draft v1"); // send #1, response delayed
  const fastFinal = sink.finalize("final text"); // bumps the generation, send #2
  pending[1](new Response(JSON.stringify({ ok: true, result: { message_id: 200 } }), { status: 200 }));
  await fastFinal;
  pending[0](new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { status: 200 })); // late!
  await slowUpsert;
  // Next draft must start fresh with sendMessage, never edit the stale id 100.
  const nextUpsert = sink.upsert("next conversation draft");
  pending[2](new Response(JSON.stringify({ ok: true, result: { message_id: 300 } }), { status: 200 }));
  await nextUpsert;
  assert.deepEqual(calls.map(methodOf), ["sendMessage", "sendMessage", "sendMessage"]);
});

// --- slack draft sink ---

test("slack draft flow: chat.postMessage draft then chat.update edits and final", async () => {
  const clock = makeClock();
  const { fetcher, calls } = makeFetcher([{ payload: { ok: true, ts: "171.500" } }]);
  const sink = createSlackDraftSink({
    botToken: "xoxb-test",
    channel: "C1",
    threadTs: "171.001",
    fetcher,
    queue: createOutboundQueue({ now: clock.now, sleep: clock.sleep }),
  });
  const events = script(clock, [
    { type: "delta", text: "Working on it." },
    1000,
    { type: "delta", text: " Almost there." },
    { type: "final", messageId: "m1", text: "Working on it. Almost there. Done." },
  ]);
  const result = await runDraftLoop(events, sink, { now: clock.now, sleep: clock.sleep });
  assert.equal(result.status, "finalized");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://slack.com/api/chat.postMessage",
    "https://slack.com/api/chat.update",
    "https://slack.com/api/chat.update",
  ]);
  assert.deepEqual(calls[0].body, { channel: "C1", text: "Working on it.", thread_ts: "171.001" });
  assert.deepEqual(calls[1].body, { channel: "C1", ts: "171.500", text: "Working on it. Almost there." });
  assert.deepEqual(calls[2].body, { channel: "C1", ts: "171.500", text: "Working on it. Almost there. Done." });
  assert.equal(calls[0].auth, "Bearer xoxb-test");
});

// --- error classification ---

test("error classification maps channel failures to retry / degrade-to-send / stop", () => {
  assert.equal(classifyTelegramError(new OutboundHttpError("429", 429, 1000)), "retry");
  assert.equal(classifyTelegramError(new OutboundHttpError("502", 502)), "retry");
  assert.equal(classifyTelegramError(new OutboundHttpError("message is not modified", 400)), "retry");
  assert.equal(classifyTelegramError(new OutboundHttpError("message can't be edited", 400)), "degrade-to-send");
  assert.equal(classifyTelegramError(new OutboundHttpError("unauthorized", 401)), "stop");
  assert.equal(classifyTelegramError(new Error("socket hang up")), "retry");

  assert.equal(classifySlackError(new OutboundHttpError("ratelimited", 429, 3000, "ratelimited")), "retry");
  assert.equal(classifySlackError(new OutboundHttpError("cant_update_message", 200, undefined, "cant_update_message")), "degrade-to-send");
  assert.equal(classifySlackError(new OutboundHttpError("invalid_auth", 200, undefined, "invalid_auth")), "stop");
  assert.equal(classifySlackError(new Error("ECONNRESET")), "retry");
});

// --- envelope ---

test('the /v1/messages envelope accepts stream "off" | "draft" and rejects anything else', () => {
  const base = { surfaceId: "web:demo", conversationId: "c1", senderId: "s1", text: "hi" };
  assert.equal(parseSurfaceMessage(base).stream, undefined);
  assert.equal(parseSurfaceMessage({ ...base, stream: "draft" }).stream, "draft");
  assert.equal(parseSurfaceMessage({ ...base, stream: "off" }).stream, "off");
  assert.throws(() => parseSurfaceMessage({ ...base, stream: "firehose" }), /"stream" must be "off" or "draft"/);
});

// --- telegram webhook end-to-end in draft mode (stub LLM, injected fetcher) ---

function stubConfig(baseUrl: string): MusterConfig {
  const config = defaultConfig();
  return {
    ...config,
    providers: { stub: { id: "stub", kind: "openai-compatible", baseUrl, defaultModel: "stub-model", timeoutMs: 5000 } },
    runtimes: { native: { id: "native", enabled: true, provider: "stub", routes: {} } },
    routing: { ...config.routing, defaultRuntime: "native" },
  };
}

function startStubLlm(content: string): Promise<{ url: string; close: () => void }> {
  return import("node:http").then(({ createServer }) => new Promise((resolvePromise) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  }));
}

test('telegram webhook with telegram.stream="draft" streams the reply as a live-edited draft', async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gw-tg-draft-"));
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({
    token: "test-token",
    telegram: { botToken: "123:ABC", stream: "draft" },
  }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, "5599220011", cwd).then((pendingPairing) => approvePairing(pendingPairing.code, cwd));

  const llm = await startStubLlm("deploy is green");
  const { fetcher, calls } = makeFetcher([TELEGRAM_OK]);
  const running = await startGatewayServer({ config: stubConfig(llm.url), gateway, cwd, fetcher }, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 10, from: { id: 5599220011 }, chat: { id: -100200300 }, text: "deploy status?" },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true });
    await running.waitForIdle();
    assert.deepEqual(calls.map(methodOf), ["sendMessage", "editMessageText"], "draft send then final edit");
    assert.equal(calls[0].body.text, "deploy is green");
    assert.deepEqual(calls[1].body, { chat_id: "-100200300", message_id: 77, text: "deploy is green" });
  } finally {
    await running.close();
    llm.close();
  }
});
