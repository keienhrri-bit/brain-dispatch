# Measuring whether delegation pays

This is an evaluation protocol, not a benchmark result. Fake-backend tests and a successful smoke test do not establish savings.

Compare three configurations on the same frozen inputs: (A) the host alone, (B) one whole-task worker dispatch with host review, and (C) the same dispatch with at most one accepted-result follow-up. Keep model versions, effort, tooling, acceptance criteria and external dependencies fixed. Randomize run order; use at least five runs per task/configuration where the quota permits. Never count only successful attempts.

Use a small task (one file lookup), a large independent extraction, a deterministic data transformation, and a code change with independently prepared acceptance tests. Separate tasks with tight sequential dependencies from independent work. Check correctness against golden outputs or independent tests, then inspect a blinded sample for maintainability and unsupported claims. A passing test suite alone is not sufficient for open-ended quality.

Record:

| Measure | Source | Missing value policy |
|---|---|---|
| Host input/output/cache usage | Host's documented usage export | Unknown; do not infer from worker tokens |
| Worker usage and model | Raw job metadata | Preserve provider counter scope; identify per-call vs cumulative |
| Rejected, partial and interrupted attempts | Dispatcher metadata and attempt records | Keep in totals; report orphaned attempts separately |
| Time | Start-to-accepted-delivery wall clock | Include review, repair and coordination |
| Quality | Independent acceptance tests + blinded review | Failed or missing work remains failed |
| Price / subscription quota | Actual provider billing or observed quota deltas, when available | Unknown; no conversion from unverified token rates |

Report cost **per accepted task**, failure rates and elapsed-time distributions. Distinguish a transfer from expensive host tokens to worker tokens from a reduction in total cost. Do not subtract cumulative counters unless the provider defines their scope and reset behavior. Publish the fixture version, all repetitions, model/CLI versions, criteria and limitations; redact private paths, prompts and credentials.

Adopt a routing rule only when it beats the solo baseline at comparable quality for that task class. A sensible result can be "delegate large independent extraction, keep small edits local." Do not extrapolate one successful run to arbitrary workloads or subscription plans.
