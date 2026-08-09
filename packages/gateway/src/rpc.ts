import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { closeWarmProviderTransports, dataDir, executeRun, listTokenRecords } from "@musterhq/core";
import type { MusterConfig } from "@musterhq/core";
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
  | { readonly type: "message.stop"; readonly sessionId: string; readonly text: string; readonly runId: string }
  | { readonly type: "ledger.tick"; readonly sessionId: string; readonly runId: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number }
  | { readonly type: "session.created"; readonly sessionId: string };

export interface RpcCore {
  handle(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  mintTicket(): { ticket: string; expiresAt: number };
  consumeTicket(ticket: string): boolean;
  close(): void;
}

const TICKET_TTL_MS = 30_000;

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
      const outcome = await executeRun(options.config, {
        prompt,
        cwd,
        conversationKey: `rpc:${sessionId}`,
        nativeTransport: "warm",
        nativeSessionKeepAlive: true,
        nativeTransportOwner,
        surfaceId: `rpc:${sessionId}`,
        scopes: [{ kind: "session", id: sessionId }, { kind: "user", id: String(params.userId ?? "rpc-user") }],
      });
      emit({ type: "message.stop", sessionId, text: outcome.episode.responseText, runId: outcome.plan.runId });
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
        ...(params.includeDiagnostics === true ? { timings: outcome.timings } : {}),
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
