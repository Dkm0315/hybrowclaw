/**
 * Adversarial verification for the scoped runtime: containment under escape
 * fuzzing, manifest tamper fail-closed, the exhaustive precedence matrix,
 * concurrent ensureRuntime, and orphan auditing.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_SCOPED_RUNTIME_LIMITS,
  SCOPED_RUNTIME_MANIFEST_FILE,
  SCOPE_SPECIFICITY_ORDER,
  ScopedRuntimeError,
  auditRuntime,
  effectiveToolAuthority,
  ensureRuntime,
  resolveRuntimeEnv,
  resolveScopedRuntime,
  scopedRuntimeSlug,
  type ScopedRuntimeConfig,
  type ScopedRuntimeGrant,
  type ScopedRuntimeManifest,
} from "../src/scoped-runtime.js";
import type { MemoryScope, MemoryScopeKind } from "../src/types.js";

async function makeRoot(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "muster-runtime-stress-")));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "runtimes");
}

/* ---------- escape fuzzing: containment + no collisions ---------- */

const HOSTILE_IDS: readonly string[] = [
  "../..",
  "../../etc/passwd",
  "..",
  ".",
  "...",
  "-",
  "a/b/../../../../root",
  "..\\..\\windows\\system32",
  "id\u0000withnull",
  "\u0000\u0000\u0000",
  "a".repeat(1000),
  ("../".repeat(300)) + "etc",
  "%2e%2e%2fescape",
  "~/.ssh/id_rsa",
  "/etc/passwd",
  "C:\\Windows",
  "id with spaces and\ttabs",
  "🔥🔥🔥",
  "\u202eevil", // RTL override
  "аdmin", // Cyrillic а homoglyph
  "admin",
  "ﬁle", // ffi-free ligature; NFKC-folds to "file"
  "file",
  "Alice",
  "alice", // case-only sibling on a case-insensitive filesystem
  "a:b",
  "a/b",
  "a-b",
  ".hidden",
  "-leading-dash",
  "trailing-dot.",
];

test("hostile scope ids stay contained under the runtimes root and never collide", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = { rootDir: root };
  const realRoot = async (): Promise<string> => `${await realpath(root)}${sep}`;

  const workDirs = new Map<string, string>();
  for (const id of HOSTILE_IDS) {
    const descriptor = resolveScopedRuntime([{ kind: "session", id }], config);
    // Containment is provable before any I/O.
    assert.ok(descriptor.workDir.startsWith(`${root}${sep}`), `${JSON.stringify(id)} resolved outside the root: ${descriptor.workDir}`);
    const segments = descriptor.workDir.slice(root.length).split(sep).filter(Boolean);
    assert.ok(segments.every((segment) => segment !== ".." && segment !== "."), `${JSON.stringify(id)} kept a traversal segment`);

    const result = await ensureRuntime(descriptor);
    assert.equal(result.state, "created");
    const real = await realpath(descriptor.workDir);
    assert.ok(real.startsWith(await realRoot()), `${JSON.stringify(id)} realpath escaped: ${real}`);

    const clash = workDirs.get(real.toLowerCase());
    assert.equal(clash, undefined, `${JSON.stringify(id)} collides with ${JSON.stringify(clash)} at ${real} (case-insensitive)`);
    workDirs.set(real.toLowerCase(), id);
  }

  // Determinism: resolving again yields byte-identical paths and reuses.
  for (const id of HOSTILE_IDS) {
    const descriptor = resolveScopedRuntime([{ kind: "session", id }], config);
    assert.equal((await ensureRuntime(descriptor)).state, "reused", `${JSON.stringify(id)} was not stable across resolves`);
  }
  assert.equal(workDirs.size, HOSTILE_IDS.length);

  // Nothing was created outside root/session.
  const kinds = await readdir(root);
  assert.deepEqual(kinds.sort(), ["session"]);
});

test("slug identity is carried by the digest, not the sanitized prefix", () => {
  const pairs: readonly [string, string][] = [
    ["a/b", "a:b"],
    ["../../etc", "etc"],
    ["аdmin", "admin"],
    ["ﬁle", "file"],
    ["Alice", "alice"],
    ["a".repeat(1000), "a".repeat(999)],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(scopedRuntimeSlug(left), scopedRuntimeSlug(right), `slug collision for ${JSON.stringify(left)} / ${JSON.stringify(right)}`);
  }
  assert.equal(scopedRuntimeSlug("x"), scopedRuntimeSlug("x"));
  for (const id of HOSTILE_IDS) {
    const slug = scopedRuntimeSlug(id);
    assert.ok(!/[/\\\u0000]/.test(slug), `slug for ${JSON.stringify(id)} contains a path or null character`);
    assert.ok(slug.length > 0);
  }
});

test("malformed scopes, grants, and limits fail closed with typed errors, never TypeErrors", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = { rootDir: root };
  const session: MemoryScope = { kind: "session", id: "s-1" };

  const expectError = (code: string, run: () => unknown, label: string): void => {
    assert.throws(
      run,
      (error: unknown) => {
        assert.ok(error instanceof ScopedRuntimeError, `${label}: threw ${String(error)} instead of ScopedRuntimeError`);
        assert.equal(error.code, code, `${label}: code ${error.code}`);
        return true;
      },
      label,
    );
  };

  expectError("no_scope", () => resolveScopedRuntime([], config), "empty scope set");
  expectError("no_scope", () => resolveScopedRuntime(undefined as never, config), "undefined scope set");
  expectError("no_scope", () => resolveScopedRuntime("user:x" as never, config), "string scope set");
  expectError("invalid_scope_kind", () => resolveScopedRuntime([null as never], config), "null scope entry");
  expectError("invalid_scope_kind", () => resolveScopedRuntime([{ kind: "galaxy", id: "x" } as never], config), "unknown kind");
  expectError("invalid_scope_id", () => resolveScopedRuntime([{ kind: "session", id: "   " }], config), "blank id");
  expectError("invalid_scope_id", () => resolveScopedRuntime([{ kind: "session", id: 42 as never }], config), "numeric id");
  expectError(
    "duplicate_scope_kind",
    () => resolveScopedRuntime([{ kind: "session", id: "a" }, { kind: "session", id: "b" }], config),
    "two sessions",
  );
  expectError(
    "duplicate_grant",
    () => resolveScopedRuntime([session], { ...config, grants: [{ scope: session }, { scope: { kind: "session", id: " s-1 " } }] }),
    "duplicate grants after normalization",
  );
  expectError(
    "invalid_scope_kind",
    () => resolveScopedRuntime([session], { ...config, grants: [null as never] }),
    "null grant entry",
  );
  for (const envAllowlist of [["PATH; rm -rf /"], ["1BAD"], [""], ["A B"], [42 as never], "PATH" as never, null as never]) {
    expectError(
      "invalid_env_name",
      () => resolveScopedRuntime([session], { ...config, grants: [{ scope: session, envAllowlist: envAllowlist as never }] }),
      `env allowlist ${JSON.stringify(envAllowlist)}`,
    );
  }
  for (const toolPolicy of [["*"], ["../fs.read"], ["fs read"], [""], [42 as never], "fs.read" as never]) {
    expectError(
      "invalid_tool_id",
      () => resolveScopedRuntime([session], { ...config, grants: [{ scope: session, toolPolicy: toolPolicy as never }] }),
      `tool policy ${JSON.stringify(toolPolicy)}`,
    );
  }
  for (const limits of [{ maxProcesses: 0 }, { maxProcesses: -1 }, { maxProcesses: 1.5 }, { maxProcesses: "3" }, { maxDiskMb: NaN }, { networkAccess: "all" }]) {
    expectError(
      "invalid_limit",
      () => resolveScopedRuntime([session], { ...config, grants: [{ scope: session, limits: limits as never }] }),
      `limits ${JSON.stringify(limits)}`,
    );
  }
  // A malformed value in a LOSING grant is still rejected.
  expectError(
    "invalid_env_name",
    () =>
      resolveScopedRuntime([session, { kind: "tenant", id: "t-1" }], {
        ...config,
        grants: [
          { scope: session, envAllowlist: ["GOOD"] },
          { scope: { kind: "tenant", id: "t-1" }, envAllowlist: ["not valid"] },
        ],
      }),
    "typo in losing grant",
  );

  // Hand-edited descriptors are rejected before any I/O.
  const descriptor = resolveScopedRuntime([session], config);
  await assert.rejects(
    ensureRuntime({ ...descriptor, workDir: join(root, "session", "elsewhere") }),
    (error: unknown) => error instanceof ScopedRuntimeError && error.code === "descriptor_mismatch",
  );
  await assert.rejects(
    ensureRuntime({ ...descriptor, workDir: join(root, "..", "outside"), manifestPath: join(root, "..", "outside", SCOPED_RUNTIME_MANIFEST_FILE) }),
    (error: unknown) => error instanceof ScopedRuntimeError && error.code === "path_escape",
  );
});

/* ---------- manifest tamper: fail closed ---------- */

test("tampered, truncated, or foreign manifests fail closed and stay untouched", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = { rootDir: root };
  const descriptor = resolveScopedRuntime([{ kind: "user", id: "u-1" }], config);
  await ensureRuntime(descriptor);

  const original = await readFile(descriptor.manifestPath, "utf8");

  const cases: readonly [string, (manifest: ScopedRuntimeManifest) => string][] = [
    ["field edit without re-signing", (m) => JSON.stringify({ ...m, policyDigest: "sha256:0000" })],
    ["scope edit without re-signing", (m) => JSON.stringify({ ...m, scopes: [{ kind: "user", id: "attacker" }] })],
    ["digest replaced", (m) => JSON.stringify({ ...m, digest: "sha256:" + "a".repeat(64) })],
    ["extra smuggled field", (m) => JSON.stringify({ ...m, envAllowlist: ["AWS_SECRET_ACCESS_KEY"] })],
    ["truncated json", () => original.slice(0, Math.floor(original.length / 2))],
    ["empty file", () => ""],
    ["wrong schema version", (m) => JSON.stringify({ ...m, schemaVersion: 99 })],
    ["not an object", () => JSON.stringify(["not", "a", "manifest"])],
  ];
  for (const [label, mutate] of cases) {
    const manifest = JSON.parse(original) as ScopedRuntimeManifest;
    await writeFile(descriptor.manifestPath, mutate(manifest), "utf8");
    await assert.rejects(
      ensureRuntime(descriptor),
      (error: unknown) => {
        assert.ok(error instanceof ScopedRuntimeError, `${label}: ${String(error)}`);
        assert.equal(error.code, "manifest_integrity", label);
        return true;
      },
      label,
    );
    const audit = await auditRuntime(descriptor, { includeOrphans: false });
    assert.equal(audit.manifestState, "corrupt", `${label}: audit should report corrupt`);
    assert.equal(audit.healthy, false, label);
  }

  // A VALID manifest for a different scope chain is not corrupt, but reuse is
  // still refused and the manifest is left byte-identical. The extended chain
  // resolves to the SAME workDir (owner unchanged), so this exercises the
  // scope-mismatch guard on a healthy manifest.
  await writeFile(descriptor.manifestPath, original, "utf8");
  const extendedChain = resolveScopedRuntime([{ kind: "user", id: "u-1" }, { kind: "tenant", id: "t-9" }], config);
  assert.equal(extendedChain.workDir, descriptor.workDir);
  await assert.rejects(
    ensureRuntime(extendedChain),
    (error: unknown) => error instanceof ScopedRuntimeError && error.code === "scope_mismatch",
    "extended scope chain must not reuse the narrower runtime",
  );
  assert.equal(await readFile(descriptor.manifestPath, "utf8"), original, "failed reuse mutated the existing manifest");
});

/* ---------- precedence: exhaustive matrix ---------- */

const CONTRACT_CHAIN: readonly MemoryScope[] = [
  { kind: "session", id: "s" },
  { kind: "user", id: "u" },
  { kind: "workspace", id: "w" },
  { kind: "tenant", id: "t" },
  { kind: "global", id: "global" },
];

const NETWORK_BY_KIND: Record<string, "none" | "allowlist" | "unrestricted"> = {
  session: "unrestricted",
  user: "allowlist",
  workspace: "none",
  tenant: "unrestricted",
  global: "allowlist",
};

test("precedence matrix: every field is won by the most specific declaring scope, exhaustively", () => {
  const kinds = CONTRACT_CHAIN.map((scope) => scope.kind);
  // All 32 subsets of declaring scopes, for each of the five policy fields.
  for (let mask = 0; mask < 1 << kinds.length; mask += 1) {
    const declaring = kinds.filter((_, index) => mask & (1 << index));
    const winner = declaring[0]; // kinds is already most-specific-first
    const grants: ScopedRuntimeGrant[] = CONTRACT_CHAIN.filter((scope) => declaring.includes(scope.kind)).map((scope) => ({
      scope,
      envAllowlist: [`ENV_${scope.kind.toUpperCase()}`],
      toolPolicy: [`tool.${scope.kind}`],
      limits: {
        maxProcesses: (SCOPE_SPECIFICITY_ORDER.indexOf(scope.kind) + 1) * 10,
        maxDiskMb: (SCOPE_SPECIFICITY_ORDER.indexOf(scope.kind) + 1) * 100,
        networkAccess: NETWORK_BY_KIND[scope.kind],
      },
    }));
    const descriptor = resolveScopedRuntime(CONTRACT_CHAIN, { rootDir: "/tmp/unused-precedence", grants });

    if (winner === undefined) {
      assert.deepEqual(descriptor.envAllowlist, [], `mask ${mask}: env should be deny-by-default`);
      assert.deepEqual(descriptor.toolPolicy, [], `mask ${mask}: tools should be deny-by-default`);
      assert.equal(descriptor.limits.maxProcesses, undefined, `mask ${mask}`);
      assert.equal(descriptor.limits.maxDiskMb, undefined, `mask ${mask}`);
      assert.equal(descriptor.limits.networkAccess, DEFAULT_SCOPED_RUNTIME_LIMITS.networkAccess, `mask ${mask}`);
    } else {
      assert.deepEqual(descriptor.envAllowlist, [`ENV_${winner.toUpperCase()}`], `mask ${mask}: env winner should be ${winner}`);
      assert.deepEqual(descriptor.toolPolicy, [`tool.${winner}`], `mask ${mask}: tool winner should be ${winner}`);
      assert.equal(descriptor.limits.maxProcesses, (SCOPE_SPECIFICITY_ORDER.indexOf(winner) + 1) * 10, `mask ${mask}`);
      assert.equal(descriptor.limits.maxDiskMb, (SCOPE_SPECIFICITY_ORDER.indexOf(winner) + 1) * 100, `mask ${mask}`);
      assert.equal(descriptor.limits.networkAccess, NETWORK_BY_KIND[winner], `mask ${mask}: network winner should be ${winner}`);
    }
    // The owner and path never depend on which grants exist.
    assert.equal(descriptor.owner.kind, "session", `mask ${mask}`);
  }
});

test("fields resolve independently: a session can narrow tools while inheriting tenant env", () => {
  const grants: ScopedRuntimeGrant[] = [
    { scope: CONTRACT_CHAIN[0]!, toolPolicy: ["fs.read"] },
    { scope: CONTRACT_CHAIN[3]!, envAllowlist: ["TENANT_TOKEN", "HOME"], toolPolicy: ["fs.read", "fs.write", "net.fetch"], limits: { networkAccess: "allowlist" } },
  ];
  const descriptor = resolveScopedRuntime(CONTRACT_CHAIN, { rootDir: "/tmp/unused-precedence", grants });
  assert.deepEqual(descriptor.toolPolicy, ["fs.read"], "session must override, not union, the tenant tool policy");
  assert.deepEqual(descriptor.envAllowlist, ["HOME", "TENANT_TOKEN"], "env must fall through to the tenant declaration");
  assert.equal(descriptor.limits.networkAccess, "allowlist");
  assert.equal(descriptor.limits.maxProcesses, undefined);

  // The authority helpers enforce the resolved policy.
  assert.deepEqual([...effectiveToolAuthority(descriptor, ["fs.read", "net.fetch"])].sort(), ["fs.read"]);
  assert.deepEqual([...effectiveToolAuthority(descriptor, undefined)], [], "an undefined term must collapse authority to nothing");
  const env = resolveRuntimeEnv(descriptor, { HOME: "/home/u", TENANT_TOKEN: "tok", AWS_SECRET_ACCESS_KEY: "leak" } as NodeJS.ProcessEnv);
  assert.deepEqual(env, { HOME: "/home/u", TENANT_TOKEN: "tok" });
});

test("the full eight-kind chain ranks session most specific and owns the directory", () => {
  assert.deepEqual(SCOPE_SPECIFICITY_ORDER, ["session", "pairing", "user", "persona", "role", "workspace", "tenant", "global"]);
  const allKinds: MemoryScope[] = SCOPE_SPECIFICITY_ORDER.map((kind) => ({ kind, id: kind === "global" ? "global" : `${kind}-id` }));
  // Shuffle to prove order-independence.
  const shuffled = [...allKinds].reverse();
  const descriptor = resolveScopedRuntime(shuffled, { rootDir: "/tmp/unused-precedence" });
  assert.equal(descriptor.owner.kind, "session");
  assert.deepEqual(descriptor.scopes.map((scope) => scope.kind), SCOPE_SPECIFICITY_ORDER);
});

/* ---------- concurrency ---------- */

test("Promise.all x20 concurrent ensureRuntime for one scope yields one directory and a valid manifest", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = {
    rootDir: root,
    grants: [{ scope: { kind: "session", id: "burst" }, envAllowlist: ["HOME"], toolPolicy: ["fs.read"], limits: { maxDiskMb: 10, networkAccess: "none" } }],
  };
  const descriptor = resolveScopedRuntime([{ kind: "session", id: "burst" }], config);

  const results = await Promise.allSettled(Array.from({ length: 20 }, () => ensureRuntime(descriptor)));
  const failures = results.filter((result) => result.status === "rejected");
  assert.deepEqual(failures.map((failure) => String((failure as PromiseRejectedResult).reason)), [], "concurrent ensure must not fail");
  const states = new Set(results.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof ensureRuntime>>>).value.state));
  assert.ok([...states].every((state) => state === "created" || state === "reused"), `unexpected states: ${[...states].join(",")}`);

  // Exactly one runtime directory exists for the kind.
  const sessionDirs = await readdir(join(root, "session"));
  assert.equal(sessionDirs.length, 1);

  // No leftover atomic-write temp files, and the surviving manifest verifies.
  const files = await readdir(descriptor.workDir);
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), []);
  const audit = await auditRuntime(descriptor);
  assert.equal(audit.manifestState, "ok");
  assert.equal(audit.healthy, true);
  assert.deepEqual(audit.orphans, []);
  assert.equal(audit.manifest?.policyDigest, descriptor.policyDigest);

  // A later sequential ensure reuses without rewriting.
  const before = await readFile(descriptor.manifestPath, "utf8");
  assert.equal((await ensureRuntime(descriptor)).state, "reused");
  assert.equal(await readFile(descriptor.manifestPath, "utf8"), before);
});

test("concurrent ensureRuntime across twenty DIFFERENT scopes keeps every runtime isolated", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = { rootDir: root };
  const descriptors = Array.from({ length: 20 }, (_, index) => resolveScopedRuntime([{ kind: "session", id: `s-${index}` }], config));
  const results = await Promise.all(descriptors.map((descriptor) => ensureRuntime(descriptor)));
  assert.ok(results.every((result) => result.state === "created"));
  const dirs = await readdir(join(root, "session"));
  assert.equal(dirs.length, 20);
  for (const descriptor of descriptors) {
    const audit = await auditRuntime(descriptor, { includeOrphans: false });
    assert.equal(audit.manifestState, "ok", descriptor.workDir);
    assert.equal(audit.healthy, true);
  }
});

/* ---------- audit: orphans ---------- */

test("auditRuntime flags orphaned directories: missing manifest, corrupt manifest, foreign path, unknown kind", async (t) => {
  const root = await makeRoot(t);
  const config: ScopedRuntimeConfig = { rootDir: root };
  const descriptor = resolveScopedRuntime([{ kind: "user", id: "keeper" }], config);
  await ensureRuntime(descriptor);

  // 1. Directory with no manifest at all.
  const bare = join(root, "user", "abandoned-first-run");
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, "scratch.txt"), "data", "utf8");
  // 2. Directory with a corrupt manifest.
  const corrupt = join(root, "session", "corrupted-copy");
  await mkdir(corrupt, { recursive: true });
  await writeFile(join(corrupt, SCOPED_RUNTIME_MANIFEST_FILE), "{ not json", "utf8");
  // 3. Valid manifest manually copied under a path it does not hash to.
  const moved = join(root, "user", "renamed-by-hand");
  await mkdir(moved, { recursive: true });
  await writeFile(join(moved, SCOPED_RUNTIME_MANIFEST_FILE), await readFile(descriptor.manifestPath, "utf8"), "utf8");
  // 4. A directory for a scope kind that does not exist.
  const alien = join(root, "galaxy");
  await mkdir(join(alien, "whatever"), { recursive: true });

  const audit = await auditRuntime(descriptor);
  assert.equal(audit.manifestState, "ok");
  assert.equal(audit.healthy, true, "orphans elsewhere must not mark this runtime unhealthy");
  const byPath = new Map(audit.orphans.map((orphan) => [orphan.path, orphan.reason]));
  assert.equal(byPath.get(bare), "no_manifest");
  assert.equal(byPath.get(corrupt), "corrupt_manifest");
  assert.equal(byPath.get(moved), "path_scope_mismatch");
  assert.equal(byPath.get(alien), "unknown_scope_kind");
  assert.equal(audit.orphans.length, 4);
  assert.ok(audit.issues.some((issue) => issue.code === "orphaned_runtimes"));

  // Audit reports; it never deletes.
  assert.equal((await readFile(join(bare, "scratch.txt"), "utf8")), "data");
  assert.ok((await readdir(corrupt)).includes(SCOPED_RUNTIME_MANIFEST_FILE));

  // Opting out of the scan keeps the runtime-local verdict identical.
  const local = await auditRuntime(descriptor, { includeOrphans: false });
  assert.deepEqual(local.orphans, []);
  assert.equal(local.healthy, true);
});
