# Changelog

## 0.2.0

Fixes found by running the dispatcher against `agy` 1.5.9.

- **Command deny rules no longer misfire.** The old rules matched `\bname\b` anywhere in a command, so `node -e "console.log('dd-mm')"` or any path containing `claude` was blocked, while `@anthropic-ai/claude-code` slipped through because `\b` cannot match before `@`. Short or common names (`rm`, `dd`, `kill`, agent CLIs, ...) now count only at command position: the start of the command, after a shell separator, after `-c`, `/c`, `-Command`, `-exec` or `xargs`, with an optional path prefix, executable suffix or `sudo`/`env`-style prefix. Distinctive names (`Remove-Item`, `curl`, `taskkill`, ...) still match anywhere. Agent CLI package names, `git push`/`reset`/`clean`/`restore` and global installs (`npm`, `pnpm`, `yarn`, `pip`) have their own rules.
- **Commands run in the working directory.** `agy` sorts `--add-dir` directories alphabetically and runs commands in the first one, so a read-only directory with an earlier name could receive files that a script wrote with relative paths. The dispatcher no longer passes `--add-dir`. Reads outside the working directory go through `read_file(*)`, and extra writable directories get their own `write_file` allows.
- **Writes outside the writable directories are audited.** `agy` cannot restrict writes to a list of directories, and in headless mode a directory no rule mentions is writable. The backend now runs with `--output-format stream-json`. Every file written by the worker's tools is checked against the writable directories; a write elsewhere is listed with `!!` and rejects the job with exit code 3. The report also lists tool calls the permission rules denied and, at `full` access, every command that ran. Removed the `allowNonWorkspaceAccess` setting, which `agy` does not have.
- The raw backend output in the job directory is now `events.jsonl` (was `raw.json`). `meta.json` gains `written_outside`, `written_by_tools`, `denied_steps`, `commands` and `command_dir`.

## 0.1.0

First public version.

- `dispatch` skill: when to hand work off, how to write a brief, how to read and check a report.
- `setup` skill: environment check, default config, smoke test.
- `worker.mjs`: headless dispatcher for the Antigravity CLI with per-run permission profiles, before/after file measurement, a schema-checked report and distinct exit codes.
- `doctor.mjs`: environment check.
- `writer` (Sonnet) and `finder` (Haiku) subagents.
- Session-start note describing the division of labor, switchable in the config.
