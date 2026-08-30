import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { closeWarmProviderTransports, createCoalescer, dataDir, executeRun, fenceStateAt, listTokenRecords, withReasoningEconomy } from "@musterhq/core";
import type {
  KanbanStatus,
  MusterConfig,
  SelectionScoreBreakdown,
  WorkspaceChangeKind,
  WorkspacePatchEvent,
} from "@musterhq/core";
import {
  SqliteFrappeRunEventStore,
  type AcceptedFrappeRunCommand,
  type FrappeRunCommandRequest,
  type FrappeRunEvent,
  type FrappeRunEventPermissionFilter,
  type FrappeRunEventScope,
  type FrappeRunEventStore,
} from "./frappe-run-events.js";

/**
 * Muster gateway RPC — ONE newline-delimited JSON-RPC 2.0 protocol consumed
 * identically over stdio (CLI/TUI), HTTP (request/response), and an NDJSON
 * event stream (desktop/web). The shape follows the proven desktop-gateway
 * pattern: explicit integer contract version handshake, single-use
 * short-TTL stream tickets minted over the authenticated channel, and a
 * ledger.tick event after every run so every UI shows live cost.
 */

export const RPC_CONTRACT_VERSION = 1;

export interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

export type RpcEvent =
  /**
   * Live parent-model narration (docs/PRODUCT_MODES.md "Parent-model streaming").
   * ADDITIVE UX ONLY — never authoritative. `message.stop` remains the sole
   * carrier of the full final text, mirroring the stream.ts invariant "FINAL IS
   * AN EVENT": a surface that drops every delta still renders a correct turn.
   *
   * Frames are coalesced blocks (~200 char minimum), not tokens, and a frame
   * boundary never lands inside an open code fence. Concatenating the `text` of
   * one run's `message.delta` frames in `seq` order reproduces the streamed
   * narration exactly — the gateway always slices the true accumulated text, so
   * the coalescer's draft-oriented fence repair never reaches the wire.
   *
   * `runId` is the gateway's stream-turn identity, minted before the run because
   * the core run id does not exist until executeRun resolves; `message.stop`
   * echoes it as `streamRunId` so a client can join partials to the final.
   * `seq` is ONE monotonic counter per stream turn shared with `reasoning.delta`,
   * so a client can replay both channels in true emission order.
   */
  | { readonly type: "message.delta"; readonly sessionId: string; readonly runId: string; readonly seq: number; readonly text: string }
  /**
   * Provider-approved reasoning SUMMARY deltas on their own channel. Raw hidden
   * chain-of-thought is never forwarded — the text can only originate from
   * `onReasoningDelta`, which codex-app-server.ts:34 pins to
   * `item/reasoning/summaryTextDelta`. Same coalescing and seq space as
   * `message.delta`; a surface may render or discard it independently.
   */
  | { readonly type: "reasoning.delta"; readonly sessionId: string; readonly runId: string; readonly seq: number; readonly text: string }
  /** Authoritative turn end. `runId` is the core run id (matches ledger.tick and the RPC result); `streamRunId` ties it to this turn's delta frames. */
  | { readonly type: "message.stop"; readonly sessionId: string; readonly text: string; readonly runId: string; readonly streamRunId?: string }
  | { readonly type: "ledger.tick"; readonly sessionId: string; readonly runId: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number }
  | { readonly type: "session.created"; readonly sessionId: string }
  /**
   * Observed workspace edit. `source` is pinned to the observer literal because the
   * audit trail is only trustworthy when it watches the workspace — Codex's app-server
   * emits zero item/fileChange/patchUpdated events in practice (STRATEGY_V2 §2.2), so a
   * backend self-report can never be the provenance of this variant. `diff` may be null
   * when it was omitted (binary, oversized, redacted path, budget); the hashes never are.
   */
  | {
      readonly type: "workspace.patch";
      readonly path: string;
      readonly changeKind: WorkspaceChangeKind;
      readonly diff: string | null;
      readonly beforeHash: string | null;
      readonly afterHash: string | null;
      readonly sequence: number;
      readonly source: WorkspacePatchEvent["source"];
    }
  | {
      readonly type: "task.transition";
      readonly taskId: string;
      readonly from: KanbanStatus;
      readonly to: KanbanStatus;
      readonly rationale?: string;
    }
  | {
      readonly type: "task.assigned";
      readonly taskId: string;
      readonly modelId: string;
      readonly scoreBreakdown: readonly SelectionScoreBreakdown[];
      readonly contextTokens: number;
    };

export interface RpcCore {
  handle(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  mintTicket(): { ticket: string; expiresAt: number };
  consumeTicket(ticket: string): boolean;
  close(): void;
}

const TICKET_TTL_MS = 30_000;

/** One network frame should be a readable block, not a token. */
const DELTA_MIN_CHARS = 200;
/** Above this the coalescer looks for a forced boundary; the fence guard still vetoes unsafe ones. */
const DELTA_MAX_CHARS = 600;
/** A stalled model must not strand narration in the buffer. */
const DELTA_IDLE_MS = 150;
const DELTA_IDLE_TICK_MS = 50;

interface DeltaEmitter {
  push(text: string): void;
  idleFlush(): void;
  /** Final flush, then inert forever — no delta may follow message.stop. */
  close(): void;
}

/**
 * Coalesce provider deltas into network frames using the core Coalescer.
 *
 * The Coalescer is draft-oriented and therefore LOSSY: it drops the paragraph
 * separator it splits on, and a forced split inside a code fence closes and
 * reopens that fence. Neither is acceptable on a wire format that clients
 * reassemble. So the coalescer is used only as a boundary ORACLE — "a block is
 * ready, and it ends this many chars in" — while the bytes actually emitted are
 * always an exact slice of the accumulated text. That keeps reassembly lossless
 * and keeps the injected "```" repair off the wire.
 */
function createDeltaEmitter(input: {
  readonly type: "message.delta" | "reasoning.delta";
  readonly sessionId: string;
  readonly runId: string;
  readonly nextSeq: () => number;
  readonly emit: (event: RpcEvent) => void;
  readonly now?: () => number;
}): DeltaEmitter {
  const coalescer = createCoalescer({
    minChars: DELTA_MIN_CHARS,
    maxChars: DELTA_MAX_CHARS,
    idleMs: DELTA_IDLE_MS,
    ...(input.now ? { now: input.now } : {}),
  });
  let accumulated = "";
  let emitted = 0;
  let closed = false;

  const frame = (upTo: number): void => {
    if (upTo <= emitted) return;
    const text = accumulated.slice(emitted, upTo);
    emitted = upTo;
    input.emit({ type: input.type, sessionId: input.sessionId, runId: input.runId, seq: input.nextSeq(), text });
  };

  /** Hold the frame rather than cut a code fence in half; close() always drains. */
  const frameIfFenceSafe = (upTo: number): void => {
    if (upTo <= emitted || fenceStateAt(accumulated, upTo).open) return;
    frame(upTo);
  };

  /** Chars the coalescer considers settled. Safe even after a fence repair inflated `pending`. */
  const settled = (): number => Math.max(emitted, accumulated.length - coalescer.pending.length);

  return {
    push(text) {
      if (closed || !text) return;
      accumulated += text;
      if (coalescer.push(text).length === 0) return;
      frameIfFenceSafe(settled());
    },
    idleFlush() {
      if (closed || coalescer.idleFlush().length === 0) return;
      frameIfFenceSafe(settled());
    },
    close() {
      if (closed) return;
      coalescer.flush("message_end");
      frame(accumulated.length); // unconditional: the last frame may close an open fence
      closed = true;
    },
  };
}

export interface RpcCoreOptions {
  readonly config: MusterConfig;
  readonly cwd?: string;
  readonly nativeTransportOwner?: string;
  /** Host-verified authority for Frappe RPC methods; never accepted from params. */
  readonly frappeRunEventScope?: FrappeRunEventScope;
  readonly frappeRunEventStore?: FrappeRunEventStore;
  readonly frappeRunEventCanRead?: FrappeRunEventPermissionFilter;
  readonly frappeRunCommandCsrfToken?: string;
  readonly onFrappeRunCommand?: (command: AcceptedFrappeRunCommand) => void | Promise<void>;
}

export function createRpcCore(options: RpcCoreOptions): RpcCore {
  const cwd = options.cwd ?? process.cwd();
  const nativeTransportOwner = options.nativeTransportOwner ?? `rpc:${randomUUID()}`;
  const listeners = new Set<(event: RpcEvent) => void>();
  const tickets = new Map<string, number>();
  const sessions = new Set<string>();
  const ownsFrappeRunEventStore = options.frappeRunEventStore === undefined && options.frappeRunEventScope !== undefined;
  const frappeRunEventStore = options.frappeRunEventStore
    ?? (options.frappeRunEventScope ? new SqliteFrappeRunEventStore(join(dataDir(cwd), "frappe-run-events.db")) : undefined);

  const frappeAuthority = (): { scope: FrappeRunEventScope; store: FrappeRunEventStore } => {
    if (!options.frappeRunEventScope || !frappeRunEventStore) throw new Error("Frappe run event RPC authority is unavailable.");
    return { scope: options.frappeRunEventScope, store: frappeRunEventStore };
  };

  const emit = (event: RpcEvent) => {
    for (const listener of listeners) listener(event);
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    "contract.version": async () => ({ contract: RPC_CONTRACT_VERSION, name: "muster-gateway" }),

    "session.create": async () => {
      const sessionId = `rpc_${randomUUID().slice(0, 12)}`;
      sessions.add(sessionId);
      emit({ type: "session.created", sessionId });
      return { sessionId };
    },

    "prompt.submit": async (params) => {
      const sessionId = String(params.sessionId ?? "");
      const prompt = String(params.prompt ?? "");
      if (!sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}. Call session.create first.`);
      if (!prompt.trim()) throw new Error("prompt is required");
      // Minted up front: deltas must carry a run identity while the run is still
      // in flight, and the core run id is not known until executeRun resolves.
      const streamRunId = `srun_${randomUUID()}`;
      let seq = 0;
      const nextSeq = () => (seq += 1);
      // Narration and reasoning are separate channels over ONE seq space.
      // Both texts come only from the provider's assistant-message and
      // approved-summary streams — never from workspace patches — so no diff or
      // file content can reach a delta while the redaction layer is pending.
      const messageDeltas = createDeltaEmitter({ type: "message.delta", sessionId, runId: streamRunId, nextSeq, emit });
      const reasoningDeltas = createDeltaEmitter({ type: "reasoning.delta", sessionId, runId: streamRunId, nextSeq, emit });
      const idleTicker = setInterval(() => {
        messageDeltas.idleFlush();
        reasoningDeltas.idleFlush();
      }, DELTA_IDLE_TICK_MS);
      idleTicker.unref?.();
      let outcome: Awaited<ReturnType<typeof executeRun>>;
      // Reasoning economy (core/src/reasoning-economy.ts): a two-line question
      // over RPC must not spend a deep-reasoning budget just because the seeded
      // runtime declares no route for its task kind. `executeRun` takes the
      // config by value, so this is a per-turn copy — nothing is persisted, and
      // `auto` may only LOWER the tier below what the config would have spent.
      const reasoning = withReasoningEconomy(options.config, { prompt });
      try {
        outcome = await executeRun(reasoning.config, {
          prompt,
          cwd,
          conversationKey: `rpc:${sessionId}`,
          nativeTransport: "warm",
          nativeSessionKeepAlive: true,
          nativeTransportOwner,
          surfaceId: `rpc:${sessionId}`,
          scopes: [{ kind: "session", id: sessionId }, { kind: "user", id: String(params.userId ?? "rpc-user") }],
          onDelta: (text) => messageDeltas.push(text),
          onReasoningDelta: (text) => reasoningDeltas.push(text),
        });
      } finally {
        clearInterval(idleTicker);
        // Close before any terminal event so a late provider callback cannot
        // emit a delta after message.stop.
        messageDeltas.close();
        reasoningDeltas.close();
      }
      emit({ type: "message.stop", sessionId, text: outcome.episode.responseText, runId: outcome.plan.runId, streamRunId });
      emit({
        type: "ledger.tick",
        sessionId,
        runId: outcome.plan.runId,
        inputTokens: outcome.tokens.inputTokens,
        outputTokens: outcome.tokens.outputTokens,
        costUsd: outcome.tokens.costUsd,
      });
      if (outcome.episode.outcome?.kind !== "completed") {
        throw new Error(outcome.episode.outcome?.detail ?? "Run failed");
      }
      return {
        runId: outcome.plan.runId,
        text: outcome.episode.responseText,
        ...(params.includeDiagnostics === true ? { timings: outcome.timings, reasoning: reasoning.decision } : {}),
      };
    },

    "ledger.recent": async (params) => {
      const limit = Number(params.limit ?? 20);
      const records = await listTokenRecords(cwd);
      return { records: records.slice(-limit) };
    },

    "frappe.runEvents.append": async (params) => {
      const { scope, store } = frappeAuthority();
      const event = params.event as FrappeRunEvent | undefined;
      if (!event || typeof event !== "object") throw new Error("Frappe run event is required.");
      if (params.idempotencyKey !== event.id) throw new Error("RPC idempotencyKey must match the run event id.");
      return store.append({ scope, event });
    },

    "frappe.runEvents.replay": async (params) => {
      const { scope, store } = frappeAuthority();
      return store.replay({
        scope,
        ...(typeof params.missionId === "string" ? { missionId: params.missionId } : {}),
        ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: Number(params.limit) } : {}),
        ...(options.frappeRunEventCanRead ? { canRead: options.frappeRunEventCanRead } : {}),
      });
    },

    "frappe.runCommands.submit": async (params) => {
      const { scope, store } = frappeAuthority();
      if (!options.frappeRunCommandCsrfToken) throw new Error("Frappe run command RPC CSRF authority is unavailable.");
      if (!options.onFrappeRunCommand) throw new Error("Frappe run command RPC dispatch is unavailable.");
      const request = params.command as FrappeRunCommandRequest | undefined;
      if (!request || typeof request !== "object") throw new Error("Frappe run command is required.");
      if (params.idempotencyKey !== request.idempotencyKey) throw new Error("RPC idempotencyKey must match the run command envelope.");
      const claimed = await store.claimCommand(request, {
        method: "POST",
        authenticatedScope: scope,
        expectedCsrfToken: options.frappeRunCommandCsrfToken,
      });
      if (claimed.status === "conflict") throw new Error("Run command idempotency conflict.");
      await options.onFrappeRunCommand(claimed.command);
      return { ...claimed, dispatched: true };
    },
  };

  return {
    async handle(request) {
      const id = request.id ?? null;
      if (request.jsonrpc !== "2.0") {
        return { jsonrpc: "2.0", id, error: { code: -32600, message: "jsonrpc must be \"2.0\"" } };
      }
      const minContract = Number(request.params?.minContract ?? RPC_CONTRACT_VERSION);
      if (request.method !== "contract.version" && minContract > RPC_CONTRACT_VERSION) {
        return { jsonrpc: "2.0", id, error: { code: -32001, message: `Contract mismatch: client requires >=${minContract}, gateway speaks ${RPC_CONTRACT_VERSION}. Halting (never silently downgrade).` } };
      }
      const method = methods[request.method];
      if (!method) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${request.method}` } };
      }
      try {
        return { jsonrpc: "2.0", id, result: await method(request.params ?? {}) };
      } catch (error) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mintTicket() {
      const ticket = `tk_${randomUUID()}`;
      const expiresAt = Date.now() + TICKET_TTL_MS;
      tickets.set(ticket, expiresAt);
      return { ticket, expiresAt };
    },
    consumeTicket(ticket) {
      const expiresAt = tickets.get(ticket);
      tickets.delete(ticket); // single-use: gone whether valid or expired
      return expiresAt !== undefined && expiresAt >= Date.now();
    },
    close() {
      closeWarmProviderTransports(nativeTransportOwner);
      if (ownsFrappeRunEventStore) void frappeRunEventStore?.close?.();
      sessions.clear();
      tickets.clear();
      listeners.clear();
    },
  };
}

/**
 * stdio transport: newline-delimited JSON-RPC over any duplex pair.
 * The CLI exposes this as `muster rpc-serve` for TUIs and desktop sidecars.
 */
export function attachStdioTransport(core: RpcCore, input: Readable, output: Writable): () => void {
  const unsubscribe = core.subscribe((event) => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })}\n`);
  });
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        void (async () => {
          let request: RpcRequest;
          try {
            request = JSON.parse(line);
          } catch {
            output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
            return;
          }
          output.write(`${JSON.stringify(await core.handle(request))}\n`);
        })();
      }
      newline = buffer.indexOf("\n");
    }
  };
  input.on("data", onData);
  return () => {
    input.off("data", onData);
    unsubscribe();
  };
}
