import {
  ENGINE_DESCRIPTORS,
  GENERIC_OSS_QA_PROFILE,
  HYBROWLABS_OSS_MANAGER_PROFILE,
  POLICY_ROLES,
} from "./catalog.js";
import {
  classifyDiffFromArgs,
  compilePlanFromArgs,
  resolveProfile,
  sourceLockFromArgs,
  validateTypedOperation,
} from "./planner.js";
import {
  buildReportFromArgs,
  createRunFromArgs,
  evidenceDigest,
  nextDispatchFromArgs,
  recordMutationFromArgs,
  recordStateFromArgs,
  recoverRunFromArgs,
  registerCompensationFromArgs,
  renderProgressFromArgs,
} from "./runtime.js";
import { QA_STATES } from "./types.js";
import type { TypedOperation } from "./types.js";
import {
  HYBROWLABS_SUITE_CATALOG,
  OSS_MANAGER_SUITE_CATALOG_VERSION,
  suiteCatalogReport,
  validateSuiteManifestFromArgs,
} from "./use-cases.js";
import { asRecord, optionalString } from "./utils.js";

export * from "./types.js";
export { ENGINE_DESCRIPTORS, GENERIC_OSS_QA_PROFILE, HYBROWLABS_OSS_MANAGER_PROFILE, POLICY_ROLES } from "./catalog.js";
export { HYBROWLABS_SUITE_CATALOG, OSS_MANAGER_SUITE_CATALOG_VERSION } from "./use-cases.js";

/** Locks a repository/branch/base/head identity. The digest excludes time and is deterministic. */
export async function oss_qa_source_lock(args: Record<string, unknown>) {
  return sourceLockFromArgs(args);
}

/** Classifies changed paths without provider calls or free-form interpretation. */
export async function oss_qa_diff_classify(args: Record<string, unknown>) {
  return classifyDiffFromArgs(args);
}

/** Compiles direct and adjacent scenarios into allowlisted typed operations. */
export async function oss_qa_scenario_compile(args: Record<string, unknown>) {
  return compilePlanFromArgs(args);
}

/** Selects source-locked direct and adjacent suite contracts without provider calls. */
export async function oss_qa_use_case_select(args: Record<string, unknown>) {
  return compilePlanFromArgs(args).useCases;
}

/** Returns the sanitized suite contract catalog. It intentionally contains no shell. */
export async function oss_qa_suite_catalog(args: Record<string, unknown> = {}) {
  return suiteCatalogReport(optionalString(args.profileId));
}

/** Compares source-adapter metadata with the bundled catalog; drift is INCONCLUSIVE. */
export async function oss_qa_suite_manifest_validate(args: Record<string, unknown>) {
  return validateSuiteManifestFromArgs(args);
}

/** Starts the evidence-gated state contract at SOURCE_LOCK. */
export async function oss_qa_run_create(args: Record<string, unknown>) {
  return createRunFromArgs(args);
}

/** Registers the exact recovery operation before a planned mutation may execute. */
export async function oss_qa_compensation_register(args: Record<string, unknown>) {
  return registerCompensationFromArgs(args);
}

/** Records mutation application or recovery using a locked-SHA evidence receipt. */
export async function oss_qa_mutation_record(args: Record<string, unknown>) {
  return recordMutationFromArgs(args);
}

/** Evaluates one state. Exit code alone never passes: semantic evidence is mandatory. */
export async function oss_qa_state_record(args: Record<string, unknown>) {
  return recordStateFromArgs(args);
}

/** Claims the finally path after a killed/stale run and emits compensations in LIFO order. */
export async function oss_qa_run_recover(args: Record<string, unknown>) {
  return recoverRunFromArgs(args);
}

/** Renders one short, human progress line without exposing hidden chain-of-thought. */
export async function oss_qa_progress_render(args: Record<string, unknown>) {
  return renderProgressFromArgs(args);
}

/** Selects the next registry operation; mutations stay blocked until compensation registration. */
export async function oss_qa_executor_next(args: Record<string, unknown>) {
  return nextDispatchFromArgs(args);
}

/** Builds the human summary and raw receipt index. It cannot change a run verdict. */
export async function oss_qa_report_build(args: Record<string, unknown>) {
  return buildReportFromArgs(args);
}

/** Verifies that an executor request is a catalog operation, never arbitrary shell. */
export async function oss_qa_operation_validate(args: Record<string, unknown>) {
  const operation = asRecord(args.operation, "operation") as unknown as TypedOperation;
  validateTypedOperation(operation);
  return { valid: true, operationId: operation.id, operationType: operation.operationType };
}

/** Returns generic descriptors and separation-of-duties policy for UI/agent discovery. */
export async function oss_qa_catalog() {
  return {
    states: QA_STATES,
    roles: POLICY_ROLES,
    engines: Object.values(ENGINE_DESCRIPTORS),
    suiteCatalog: {
      version: OSS_MANAGER_SUITE_CATALOG_VERSION,
      count: HYBROWLABS_SUITE_CATALOG.length,
      containsCommands: false,
    },
    guarantees: [
      "source_sha_locked",
      "typed_operations_only",
      "compensation_before_mutation",
      "semantic_assertion_plus_independent_probe",
      "restore_finally",
      "raw_evidence_receipts",
      "no_model_generated_shell",
    ],
  };
}

/** Resolves the generic profile, sanitized reference profile, or a runtime customer profile. */
export async function oss_qa_profile_describe(args: Record<string, unknown>) {
  return resolveProfile(args.profile, optionalString(args.profileId));
}

/** Produces the canonical receipt digest expected by the evidence contract. */
export async function oss_qa_evidence_digest(args: Record<string, unknown>) {
  return { digest: evidenceDigest(args.value) };
}

export const tools = {
  oss_qa_source_lock,
  oss_qa_diff_classify,
  oss_qa_scenario_compile,
  oss_qa_use_case_select,
  oss_qa_suite_catalog,
  oss_qa_suite_manifest_validate,
  oss_qa_run_create,
  oss_qa_compensation_register,
  oss_qa_mutation_record,
  oss_qa_state_record,
  oss_qa_run_recover,
  oss_qa_progress_render,
  oss_qa_executor_next,
  oss_qa_report_build,
  oss_qa_operation_validate,
  oss_qa_catalog,
  oss_qa_profile_describe,
  oss_qa_evidence_digest,
};
