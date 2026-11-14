# Changelog

## 0.1.0

First public version.

- `dispatch` skill: when to hand work off, how to write a brief, how to read and check a report.
- `setup` skill: environment check, default config, smoke test.
- `worker.mjs`: headless dispatcher for the Antigravity CLI with per-run permission profiles, before/after file measurement, a schema-checked report and distinct exit codes.
- `doctor.mjs`: environment check.
- `writer` (Sonnet) and `finder` (Haiku) subagents.
- Session-start note describing the division of labor, switchable in the config.
