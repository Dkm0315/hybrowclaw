# Governed Jenkins capability

This pack connects Muster to Jenkins through the remote API without exposing an unrestricted URL or arbitrary job path to the model.

The deployment config supplies an allowlist such as:

```json
{
  "allowedRoots": "ossmgr-builds,ossmgr-e2e,ossmgr-reports,ossmgr-docker-capability-probe",
  "allowMutation": "true"
}
```

Credentials are read only from `JENKINS_URL`, `JENKINS_USER`, and `JENKINS_PASSWORD`. Prefer a scoped Jenkins API token over an account password.

Pipeline changes are two-stage. `jenkins_pipeline_plan` reads the current configuration and returns source/proposal hashes. `jenkins_pipeline_apply` requires those exact hashes plus `APPLY <job>`, re-reads the current configuration to detect races, writes through Jenkins CSRF protection, and verifies the resulting configuration. Build triggers similarly require `RUN <job>`.

Console evidence is bounded and redacted. Build history is returned newest-first with Jenkins timestamps so the caller can render a chronological view without provider interpretation.
