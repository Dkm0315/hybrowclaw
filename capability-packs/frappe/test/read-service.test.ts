import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFrappePermissionEpoch,
  FrappeReadService,
  FrappeReadServiceError,
  hydrateFrappeEffectiveDocTypeMetadata,
  requiredFieldsFromEffectiveMetadata,
  SqliteFrappeReadModel,
} from "../src/index.js";

const SITE = "https://erp.example.test";

function permissionEpoch(principal: string, revision = "one") {
  return computeFrappePermissionEpoch({
    site: SITE,
    principal,
    roles: ["Employee", revision],
    userPermissions: [{ allow: "Company", for_value: `Company-${revision}` }],
  });
}

test("permission-scoped reads isolate users and reject integration-user superset results", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  const service = new FrappeReadService({ store });
  try {
    let liveCalls = 0;
    const read = (principal: string, count: number) => service.read({
      site: SITE,
      principal,
      querySignature: "private dashboard",
      resolveIdentity: async () => permissionEpoch(principal),
      live: async () => {
        liveCalls += 1;
        return { site: SITE, principal, value: { count }, objectRefs: [`Dashboard:${principal}`] };
      },
    });

    assert.deepEqual((await read("alice@example.test", 7)).value, { count: 7 });
    assert.deepEqual((await read("bob@example.test", 0)).value, { count: 0 });
    assert.deepEqual((await read("alice@example.test", 99)).value, { count: 7 });
    assert.equal(liveCalls, 2, "Alice and Bob get separate cache rows; Alice's second read is a hit");

    await assert.rejects(
      service.read({
        site: SITE,
        principal: "carol@example.test",
        querySignature: "salary summary",
        resolveIdentity: async () => permissionEpoch("carol@example.test"),
        live: async () => ({
          site: SITE,
          principal: "integration@example.test",
          value: { total: 1_000_000 },
          objectRefs: ["Salary Slip:ALL"],
        }),
      }),
      (error: unknown) => error instanceof FrappeReadServiceError && error.kind === "identity_mismatch",
    );
    assert.equal(store.getCache({
      site: SITE,
      principal: "carol@example.test",
      permissionEpoch: permissionEpoch("carol@example.test").epoch,
      schemaRevision: "live",
      dataRevision: "live",
    }, "salary summary"), undefined, "mismatched integration-user data is never cached");
  } finally {
    service.close();
    store.close();
  }
});

test("identity and query expiry are enforced independently", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  let now = Date.parse("2026-07-10T08:00:00.000Z");
  const service = new FrappeReadService({
    store,
    now: () => now,
    identityTtlMs: 500,
    queryTtlMs: 1_000,
  });
  let identityCalls = 0;
  let liveCalls = 0;
  const request = () => service.read({
    site: SITE,
    principal: "worker@example.test",
    querySignature: "my queue",
    resolveIdentity: async () => {
      identityCalls += 1;
      return permissionEpoch("worker@example.test");
    },
    live: async () => ({
      site: SITE,
      principal: "worker@example.test",
      value: { revision: ++liveCalls },
      objectRefs: ["ToDo:TODO-1"],
    }),
  });
  try {
    assert.deepEqual((await request()).value, { revision: 1 });
    now += 600;
    assert.deepEqual((await request()).value, { revision: 1 }, "fresh query survives only after identity revalidation");
    assert.equal(identityCalls, 2);
    assert.equal(liveCalls, 1);

    now += 500;
    const refreshed = await request();
    assert.deepEqual(refreshed.value, { revision: 2 });
    assert.equal(refreshed.receipt.cacheState, "stale");
    assert.equal(liveCalls, 2, "expired query result is not served as a fresh hit");
  } finally {
    service.close();
    store.close();
  }
});

test("permission-epoch rotation removes only the affected principal's cached reads", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  let now = Date.parse("2026-07-10T08:00:00.000Z");
  const service = new FrappeReadService({ store, now: () => now, identityTtlMs: 100, queryTtlMs: 10_000 });
  let aliceRevision = "one";
  let aliceLiveCalls = 0;
  let bobLiveCalls = 0;
  const aliceRead = () => service.read({
    site: SITE,
    principal: "alice@example.test",
    querySignature: "shared label",
    resolveIdentity: async () => permissionEpoch("alice@example.test", aliceRevision),
    live: async () => ({ site: SITE, principal: "alice@example.test", value: ++aliceLiveCalls, objectRefs: ["ToDo:ALICE"] }),
  });
  const bobRead = () => service.read({
    site: SITE,
    principal: "bob@example.test",
    querySignature: "shared label",
    resolveIdentity: async () => permissionEpoch("bob@example.test"),
    live: async () => ({ site: SITE, principal: "bob@example.test", value: ++bobLiveCalls, objectRefs: ["ToDo:BOB"] }),
  });
  try {
    assert.equal((await aliceRead()).value, 1);
    assert.equal((await bobRead()).value, 1);
    const oldAliceIdentity = {
      site: SITE,
      principal: "alice@example.test",
      permissionEpoch: permissionEpoch("alice@example.test", "one").epoch,
      schemaRevision: "live",
      dataRevision: "live",
    };

    now += 101;
    aliceRevision = "two";
    assert.equal((await aliceRead()).value, 2, "Alice's changed epoch forces a live refresh");
    assert.equal(store.getCache(oldAliceIdentity, "shared label"), undefined, "Alice's superseded epoch row is removed");
    assert.equal((await bobRead()).value, 1, "Bob's independent cache survives Alice's epoch rotation");
    assert.equal(bobLiveCalls, 1);
  } finally {
    service.close();
    store.close();
  }
});

test("explicit stale fallback is unavailable-only and cannot survive targeted invalidation", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  let now = Date.parse("2026-07-10T08:00:00.000Z");
  const principal = "worker@example.test";
  const service = new FrappeReadService({
    store,
    now: () => now,
    queryTtlMs: 100,
    maxStaleMs: 2_000,
  });
  const base = {
    site: SITE,
    principal,
    querySignature: "my open request",
    resolveIdentity: async () => permissionEpoch(principal),
    fallback: { mode: "stale_if_unavailable" as const, maxStaleMs: 1_000 },
  };
  try {
    await service.read({
      ...base,
      live: async () => ({ site: SITE, principal, value: { status: "Open" }, objectRefs: ["Service Request:REQ-1"] }),
    });
    now += 150;
    const stale = await service.read({
      ...base,
      live: async () => { throw new FrappeReadServiceError("unavailable", "temporary outage"); },
    });
    assert.equal(stale.presentation.status, "temporarily_stale");
    assert.equal(stale.receipt.fallback, "stale_if_unavailable");

    await assert.rejects(
      service.read({
        ...base,
        live: async () => {
          now += 1_001;
          throw new FrappeReadServiceError("unavailable", "slow outage exceeded stale window");
        },
      }),
      /exceeded stale window/,
      "stale age is checked when the live attempt fails, not when it starts",
    );
    now -= 1_001;

    const invalidation = service.invalidate({ site: SITE, principal, objectRefs: ["Service Request:REQ-1"] });
    assert.equal(invalidation.invalidatedCacheEntries, 1);
    await assert.rejects(
      service.read({
        ...base,
        live: async () => { throw new FrappeReadServiceError("unavailable", "still unavailable"); },
      }),
      /still unavailable/,
      "an explicitly invalidated stale value is not a fallback candidate",
    );

    await service.read({
      ...base,
      live: async () => ({ site: SITE, principal, value: { status: "Open" }, objectRefs: ["Service Request:REQ-1"] }),
    });
    now += 150;
    await assert.rejects(
      service.read({
        ...base,
        live: async () => { throw new FrappeReadServiceError("permission_denied", "permission revoked"); },
      }),
      (error: unknown) => error instanceof FrappeReadServiceError && error.kind === "permission_denied",
      "permission failures never fall back to stale data",
    );
  } finally {
    service.close();
    store.close();
  }
});

test("single-flight coalesces identical reads and the live work queue stays bounded", async () => {
  const store = new SqliteFrappeReadModel(":memory:");
  const principal = "worker@example.test";
  const service = new FrappeReadService({ store, maxConcurrency: 2, maxQueue: 20 });
  let identityCalls = 0;
  let liveCalls = 0;
  try {
    const concurrent = Array.from({ length: 12 }, () => service.read({
      site: SITE,
      principal,
      querySignature: "same query",
      resolveIdentity: async () => {
        identityCalls += 1;
        await delay(5);
        return permissionEpoch(principal);
      },
      live: async () => {
        liveCalls += 1;
        await delay(10);
        return { site: SITE, principal, value: ["one"], objectRefs: ["ToDo:TODO-1"] };
      },
    }));
    assert.deepEqual((await Promise.all(concurrent)).map((result) => result.value), Array.from({ length: 12 }, () => ["one"]));
    assert.equal(identityCalls, 1);
    assert.equal(liveCalls, 1);

    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, (_, index) => service.read({
      site: SITE,
      principal,
      querySignature: `distinct query ${index}`,
      resolveIdentity: async () => permissionEpoch(principal),
      live: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
        active -= 1;
        return { site: SITE, principal, value: index, objectRefs: [`ToDo:TODO-${index}`] };
      },
    })));
    assert.equal(peak, 2);
  } finally {
    service.close();
    store.close();
  }
});

test("effective metadata honors custom mandatory overlays and requirement removal", () => {
  const metadata = hydrateFrappeEffectiveDocTypeMetadata({
    docs: [{
      name: "Service Request",
      fields: [
        { fieldname: "legacy_code", label: "Legacy Code", fieldtype: "Data", reqd: 0 },
        { fieldname: "custom_region", label: "Region", fieldtype: "Link", options: "Region", reqd: 1 },
        { fieldname: "priority", label: "Priority", fieldtype: "Select", options: "Low\nHigh", reqd: 1 },
        { fieldname: "internal_key", label: "Internal Key", fieldtype: "Data", reqd: 1, hidden: 1 },
      ],
      permissions: [{ role: "Employee", create: 1 }],
    }],
  }, "Service Request");
  const required = requiredFieldsFromEffectiveMetadata(metadata);
  assert.deepEqual(required.map((field) => field.fieldname), ["custom_region", "priority"]);
  assert.deepEqual(required[1]?.options, ["Low", "High"]);
  assert.equal(required.some((field) => field.fieldname === "legacy_code"), false, "effective reqd=0 removes an old requirement");
  assert.match(required[0]?.reason ?? "", /required before this request can be saved/i);
});

test("effective metadata activates only safely provable conditional mandatory fields", () => {
  const metadata = hydrateFrappeEffectiveDocTypeMetadata({
    docs: [{
      name: "Service Request",
      fields: [
        { fieldname: "category", label: "Category", fieldtype: "Data" },
        { fieldname: "subcategory", label: "Subcategory", fieldtype: "Data", mandatory_depends_on: "eval:doc.category == 'Access'" },
        { fieldname: "unsafe", label: "Unsafe", fieldtype: "Data", mandatory_depends_on: "eval:frappe.call('x')" },
      ],
      permissions: [],
    }],
  }, "Service Request");

  assert.deepEqual(requiredFieldsFromEffectiveMetadata(metadata, { category: "General" }), []);
  assert.deepEqual(
    requiredFieldsFromEffectiveMetadata(metadata, { category: "Access" }).map((field) => field.label),
    ["Subcategory"],
  );
});

test("effective metadata supports Frappe membership and compound mandatory rules without evaluating scripts", () => {
  const metadata = hydrateFrappeEffectiveDocTypeMetadata({
    docs: [{
      name: "Attendance Request",
      fields: [
        { fieldname: "status", label: "Status", fieldtype: "Select" },
        { fieldname: "half_day", label: "Half Day", fieldtype: "Check" },
        { fieldname: "half_day_date", label: "Half Day Date", fieldtype: "Date", mandatory_depends_on: "eval:doc.half_day == 1" },
        { fieldname: "leave_type", label: "Leave Type", fieldtype: "Link", options: "Leave Type", mandatory_depends_on: "eval:in_list([\"On Leave\", \"Half Day\"], doc.status)" },
        { fieldname: "work_summary", label: "Work Summary", fieldtype: "Small Text", mandatory_depends_on: "eval:doc.status == 'Work From Home' && !doc.half_day" },
        { fieldname: "unsafe", label: "Unsafe", fieldtype: "Data", mandatory_depends_on: "eval:frappe.call('private.method') || doc.status == 'Present'" },
      ],
      permissions: [],
    }],
  }, "Attendance Request");

  assert.deepEqual(
    requiredFieldsFromEffectiveMetadata(metadata, { status: "Half Day", half_day: 1 }).map((field) => field.fieldname),
    ["half_day_date", "leave_type"],
  );
  assert.deepEqual(
    requiredFieldsFromEffectiveMetadata(metadata, { status: "Work From Home", half_day: 0 }).map((field) => field.fieldname),
    ["work_summary"],
  );
  assert.equal(
    requiredFieldsFromEffectiveMetadata(metadata, { status: "Present" }).some((field) => field.fieldname === "unsafe"),
    false,
    "unsupported script calls never become trusted client-side rules",
  );
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
