import type {
  QaSuiteValidator,
  QaUseCaseFamily,
  QaUseCaseSelection,
  QaValidationCoverage,
  QaValidationEvidence,
  QaValidationObservation,
  QaValidationResult,
} from "./types.js";
import { asRecord, isoTimestamp, jsonValue, optionalString, requiredString, shortDigest, stableStringify, uniqueSorted } from "./utils.js";

const FORBIDDEN_ATTESTATION_FIELDS = ["passed", "verdict", "terminal", "reason", "expected"] as const;
const USE_CASE_FAMILIES = new Set<QaUseCaseFamily>([
  "baseline", "configuration", "deployment", "health_status", "diagnostics", "backup_restore", "recovery",
  "high_availability", "disaster_recovery", "migration", "security", "scale_upgrade", "integrations",
  "observability", "destructive_dry_run",
]);

export function evaluateValidator(
  validator: QaSuiteValidator,
  value: unknown,
): QaValidationResult {
  const metadata = normalizeValidator(validator);
  const observation = normalizeValidationObservation(value);
  if (observation.validatorId !== metadata.id) {
    throw new Error(`Observation validator ${observation.validatorId} does not match catalog validator ${metadata.id}.`);
  }

  const missingEvidence = metadata.evidenceRequired.filter((requirement) => !(observation.evidence[requirement]?.length));
  let verdict: QaValidationResult["verdict"];
  let reason: string;
  if (observation.blockedReason) {
    verdict = "BLOCKED";
    reason = observation.blockedReason;
  } else if (missingEvidence.length) {
    verdict = "INCONCLUSIVE";
    reason = `Missing required validation evidence: ${missingEvidence.join(", ")}.`;
  } else if (metadata.deployment.required && !observation.deployment) {
    verdict = "BLOCKED";
    reason = "Mutation-gated validation requires independently timestamped deployment evidence.";
  } else if (observation.deployment && Date.parse(observation.deployment.observedAt) >= Date.parse(observation.observedAt)) {
    verdict = "INCONCLUSIVE";
    reason = "Validation evidence must be observed after deployment evidence.";
  } else if (stableStringify(observation.observed) !== stableStringify(metadata.expected)) {
    verdict = "FAIL";
    reason = "Observed value does not equal the feature-owned expected value.";
  } else {
    verdict = "PASS";
    reason = "Observed value equals the feature-owned expected value with complete evidence.";
  }

  const evidenceIds = uniqueSorted(Object.values(observation.evidence).flat());
  const body = {
    selectionId: observation.selectionId,
    validatorId: metadata.id,
    owner: metadata.owner,
    verdict,
    terminal: true as const,
    expected: metadata.expected,
    observed: observation.observed,
    reason,
    evidence: observation.evidence,
    evidenceIds,
    observedAt: observation.observedAt,
    deploymentEvidenceId: observation.deployment?.evidenceId,
    deploymentObservedAt: observation.deployment?.observedAt,
  };
  return { id: `validation-${shortDigest(body)}`, ...body };
}

function normalizeValidator(value: unknown): QaSuiteValidator {
  const validator = asRecord(value, "validator");
  const owner = asRecord(validator.owner, "validator.owner");
  const feature = requiredString(owner.feature, "validator.owner.feature") as QaUseCaseFamily;
  if (!USE_CASE_FAMILIES.has(feature)) throw new Error(`validator.owner.feature is unsupported: ${feature}.`);
  const suiteContractId = requiredString(owner.suiteContractId, "validator.owner.suiteContractId");
  const id = requiredString(validator.id, "validator.id");
  if (id !== `validator:${suiteContractId}`) throw new Error("validator.id must be owned by validator.owner.suiteContractId.");
  if (owner.kind !== "feature_suite") throw new Error("validator.owner.kind must be feature_suite.");
  if (validator.operator !== "deep_equal") throw new Error("validator.operator must be deep_equal.");
  if (validator.terminal !== true) throw new Error("validator.terminal must be true.");
  if (!Array.isArray(validator.evidenceRequired)
    || !validator.evidenceRequired.length
    || !validator.evidenceRequired.every((requirement) => typeof requirement === "string" && requirement.trim())) {
    throw new Error("validator.evidenceRequired must contain requirement IDs.");
  }
  const deployment = asRecord(validator.deployment, "validator.deployment");
  if (typeof deployment.required !== "boolean") throw new Error("validator.deployment.required must be boolean.");
  if (!Array.isArray(deployment.postDeploymentFamilies)
    || !deployment.postDeploymentFamilies.every((family) => typeof family === "string" && USE_CASE_FAMILIES.has(family as QaUseCaseFamily))) {
    throw new Error("validator.deployment.postDeploymentFamilies contains an unsupported family.");
  }
  return {
    id,
    owner: { kind: "feature_suite", feature, suiteContractId },
    operator: "deep_equal",
    expected: jsonValue(validator.expected, "validator.expected"),
    evidenceRequired: uniqueSorted(validator.evidenceRequired.map((requirement) => String(requirement).trim())),
    terminal: true,
    deployment: {
      required: deployment.required,
      postDeploymentFamilies: uniqueSorted(deployment.postDeploymentFamilies as string[]) as QaUseCaseFamily[],
    },
  };
}

export function normalizeValidationObservation(value: unknown): QaValidationObservation {
  const observation = asRecord(value, "validation observation");
  for (const field of FORBIDDEN_ATTESTATION_FIELDS) {
    if (field in observation) throw new Error(`validation observation.${field} is evaluator-owned and cannot be supplied by callers.`);
  }
  const blockedReason = optionalString(observation.blockedReason);
  const rawEvidence = asRecord(observation.evidence ?? {}, "validation observation.evidence");
  const evidence: Record<string, readonly string[]> = {};
  for (const [requirement, valueIds] of Object.entries(rawEvidence)) {
    if (!requirement.trim()) throw new Error("validation observation.evidence keys must be non-empty.");
    if (!Array.isArray(valueIds) || !valueIds.every((id) => typeof id === "string" && id.trim())) {
      throw new Error(`validation observation.evidence.${requirement} must contain evidence IDs.`);
    }
    evidence[requirement] = uniqueSorted(valueIds.map((id) => String(id).trim()));
  }
  const deployment = observation.deployment === undefined
    ? undefined
    : normalizeDeploymentObservation(observation.deployment);
  return {
    selectionId: requiredString(observation.selectionId, "validation observation.selectionId"),
    validatorId: requiredString(observation.validatorId, "validation observation.validatorId"),
    observed: observation.observed === undefined && blockedReason
      ? null
      : jsonValue(observation.observed, "validation observation.observed"),
    evidence: evidence as QaValidationEvidence,
    observedAt: isoTimestamp(observation.observedAt, "validation observation.observedAt"),
    blockedReason,
    deployment,
  };
}

export function evaluateValidationCoverage(
  selected: readonly QaUseCaseSelection[],
  results: readonly QaValidationResult[],
): QaValidationCoverage {
  const selectedById = new Map(selected.map((selection) => [selection.selectionId, selection]));
  const resultGroups = new Map<string, QaValidationResult[]>();
  for (const result of results) {
    const group = resultGroups.get(result.selectionId) ?? [];
    group.push(result);
    resultGroups.set(result.selectionId, group);
  }
  const duplicateSelectionIds = uniqueSorted([...resultGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([selectionId]) => selectionId));
  const unexpectedSelectionIds = uniqueSorted([...resultGroups.keys()].filter((selectionId) => !selectedById.has(selectionId)));
  const validResultBySelection = new Map<string, QaValidationResult>();
  for (const selection of selected) {
    const group = resultGroups.get(selection.selectionId) ?? [];
    if (group.length === 1 && isDeterministicResult(selection, group[0])) {
      validResultBySelection.set(selection.selectionId, group[0]);
    }
  }

  const invalidSelectionIds = uniqueSorted(selected
    .filter((selection) => {
      const group = resultGroups.get(selection.selectionId) ?? [];
      return group.length === 1 && !validResultBySelection.has(selection.selectionId);
    })
    .map((selection) => selection.selectionId));
  const missingSelectionIds = uniqueSorted(selected
    .filter((selection) => !validResultBySelection.has(selection.selectionId))
    .map((selection) => selection.selectionId));
  const failedSelectionIds = idsForVerdict(selected, validResultBySelection, "FAIL");
  const inconclusiveSelectionIds = idsForVerdict(selected, validResultBySelection, "INCONCLUSIVE");
  const blockedSelectionIds = uniqueSorted([
    ...idsForVerdict(selected, validResultBySelection, "BLOCKED"),
    ...selected.filter((selection) => selection.blockedReason).map((selection) => selection.selectionId),
  ]);
  const deploymentOrderFailures: string[] = [];

  for (const deployment of selected.filter((selection) => selection.validator.deployment.required)) {
    const deploymentResult = validResultBySelection.get(deployment.selectionId);
    const deploymentObservedAt = deploymentResult?.deploymentObservedAt;
    if (!deploymentObservedAt) {
      deploymentOrderFailures.push(`${deployment.selectionId}:missing_deployment_evidence`);
      continue;
    }
    for (const family of deployment.validator.deployment.postDeploymentFamilies) {
      const validators = selected.filter((selection) => selection.selectionId !== deployment.selectionId
        && selection.targetEngine === deployment.targetEngine
        && selection.family === family);
      if (!validators.length) {
        deploymentOrderFailures.push(`${deployment.selectionId}:missing_post_deployment_${family}_selection`);
        continue;
      }
      for (const validator of validators) {
        const result = validResultBySelection.get(validator.selectionId);
        if (!result || result.verdict !== "PASS" || Date.parse(result.observedAt) <= Date.parse(deploymentObservedAt)) {
          deploymentOrderFailures.push(`${deployment.selectionId}:requires_${validator.selectionId}_after_deployment`);
        }
      }
    }
  }

  const terminalCount = validResultBySelection.size;
  const passedCount = [...validResultBySelection.values()].filter((result) => result.verdict === "PASS").length;
  const complete = missingSelectionIds.length === 0
    && duplicateSelectionIds.length === 0
    && invalidSelectionIds.length === 0
    && unexpectedSelectionIds.length === 0;
  const passable = complete
    && passedCount === selected.length
    && blockedSelectionIds.length === 0
    && deploymentOrderFailures.length === 0;
  return {
    expectedCount: selected.length,
    terminalCount,
    passedCount,
    complete,
    passable,
    missingSelectionIds,
    failedSelectionIds,
    inconclusiveSelectionIds,
    blockedSelectionIds,
    duplicateSelectionIds,
    invalidSelectionIds,
    unexpectedSelectionIds,
    deploymentOrderFailures: uniqueSorted(deploymentOrderFailures),
  };
}

function isDeterministicResult(selection: QaUseCaseSelection, value: unknown): value is QaValidationResult {
  try {
    const result = asRecord(value, "validation result");
    const deploymentEvidenceId = optionalString(result.deploymentEvidenceId);
    const deploymentObservedAt = optionalString(result.deploymentObservedAt);
    if (Boolean(deploymentEvidenceId) !== Boolean(deploymentObservedAt)) return false;
    const evaluated = evaluateValidator(selection.validator, {
      selectionId: result.selectionId,
      validatorId: result.validatorId,
      observed: result.observed,
      evidence: result.evidence,
      observedAt: result.observedAt,
      blockedReason: result.verdict === "BLOCKED" ? result.reason : undefined,
      deployment: deploymentEvidenceId && deploymentObservedAt
        ? { evidenceId: deploymentEvidenceId, observedAt: deploymentObservedAt }
        : undefined,
    });
    return stableStringify(evaluated) === stableStringify(result);
  } catch {
    return false;
  }
}

function normalizeDeploymentObservation(value: unknown): NonNullable<QaValidationObservation["deployment"]> {
  const deployment = asRecord(value, "validation observation.deployment");
  return {
    evidenceId: requiredString(deployment.evidenceId, "validation observation.deployment.evidenceId"),
    observedAt: isoTimestamp(deployment.observedAt, "validation observation.deployment.observedAt"),
  };
}

function idsForVerdict(
  selected: readonly QaUseCaseSelection[],
  results: ReadonlyMap<string, QaValidationResult>,
  verdict: QaValidationResult["verdict"],
): string[] {
  return uniqueSorted(selected
    .filter((selection) => results.get(selection.selectionId)?.verdict === verdict)
    .map((selection) => selection.selectionId));
}
