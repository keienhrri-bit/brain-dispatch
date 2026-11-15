# Validation record — 0.4.0

Review started 2026-11-15 against `f7000ce` (0.3.0). No third-party cost benchmark was reproduced. The tests below establish specific behaviors, not general savings or answer quality.

## Baseline and regression suite

- Baseline: 55 tests passed on Windows 11, Node v24.19.0. A loopback TCP probe test failed in the restricted execution sandbox and passed when run with normal host network access; it was not changed to hide the environment restriction.
- Independent baseline probes reproduced success for unreported edits, deleted files, and a nonzero backend exit paired with a valid JSON report.
- Updated suite: 83 tests cover the original behaviors plus directory/conversation leases, simultaneous registration, symlink aliases, orphan handling, same-second job identity, sibling follow-up counts, failed/incomplete history, known/unknown reported usage, context provenance, strict file acceptance and the read-only statistics CLI.
- CI matrix: Windows and Linux, Node 18 and 24, fake backend only. See the repository's [Actions runs](https://github.com/keienhrri-bit/brain-dispatch/actions) for the result of the exact commit being reviewed.

Run from the repository root:

```bash
node --test
```

## Real worker implementation

The existing 0.3.0 dispatcher was used once to assign a bounded implementation task to `gemini-4-hydrogen-high` on `agy` 1.5.9. It created the statistics library, command and tests, returning after 226 seconds with 143,723 backend-reported tokens. Its eight focused tests passed. The primary agent reviewed the source and integration, fixed a CLI missing-value edge case, and ran the full suite. There was no matched solo implementation, so this observation does not measure savings.

## Real 0.4.0 continuation check

On Windows, using `agy` 1.5.9 and `gemini-4-hydrogen-high`, read-only access and an isolated fixture:

| Observation | Fresh job | Follow-up |
|---|---:|---:|
| Data | CSV values 2, 3, 5 | Same values, retained in conversation |
| Independent expected answer | 3 rows, sum 10 | Sum of squares 38 |
| Context label | orchard-v1 | orchard-v2 |
| Dispatcher elapsed seconds | 18 | 23 |
| Prompt characters | 4,947 | 1,521 |
| Backend-reported total tokens | 21,940 | 26,711 |
| Tool calls in captured stream | One `read_file` | Zero |
| File changes / shell commands | 0 / 0 | 0 / 0 |
| Accepted | Yes | Yes |

The primary agent checked the captured events and metadata, not just the worker's summary: the conversation IDs matched; the injected context hashes differed; the new label and correct arithmetic were returned; there were no follow-up file reads or writes. With `maxFollowUps: 1`, another continuation of the original parent exited 2 before another backend attempt. Normal completion left no active lease.

This example is also a warning against equating a shorter brief with lower usage: the follow-up prompt was shorter and made no tool calls, yet the reported token counter was larger. The counter may include repeated/cumulative history; it is not a provider invoice or a subscription quota measurement. Two tiny, different arithmetic turns do not form an A/B efficiency benchmark.

## Boundaries

Real backend execution on Linux/macOS remains unverified. No OS sandbox was added; `full` commands still have the permissions of the process. Snapshot exclusions and size/mtime comparison remain as described in the research review. Local leases cannot coordinate separate state homes, editors or remote machines. Captured metadata excludes host-side tokens and attempts that never wrote final metadata. Orphaned leases are deliberately not stolen automatically.

Grok's separate public-literature search timed out after 482 seconds with no usable result and was not retried. Research claims in this release were checked against the primary sources linked in the [review](coordination-review.zh-CN.md).
