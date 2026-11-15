# Changelog

## 0.3.0

The plugin now adapts to the machine it is installed on, and a failed dispatch no longer costs a rewrite.

- **Works without the Antigravity CLI.** New `backup-worker` subagent (Sonnet) takes the same brief file the Gemini worker would get. The session-start note checks whether `agy` is present and describes the roles that actually exist: with `agy`, bulk legwork goes to the Gemini worker; without it, to `backup-worker` and `finder`. The note also tells the main session that built-in subagents inherit its model, so legwork should not go to them.
- **Exit code 5 names the fallback.** When the backend is missing, signed out or out of quota, the dispatcher prints which subagent takes the same brief.
- **Shared context file.** `--context <file>` puts one brain-maintained file of settled decisions, conventions and paths in front of every brief, so background is written once per piece of work instead of once per job. The limit is 8,000 characters. The file is read-only for the worker: its file tools are denied writes to it, also when it sits inside a writable directory, and a run during which it changed anyway is rejected with exit code 3 and a `!! shared context modified` line. `templates/context-template.md` is a starting point.
- **Follow-ups.** `--follow-up <job>` continues an earlier job in the same `agy` conversation, so a result that is incomplete or wrong in one place takes a short note instead of a new brief, and the worker still has what it read. It is meant for fixing or finishing a job, not as a way to spend fewer worker tokens. Directories, access level, model and context file come from the earlier job; the permission rules and the file audit are the same. `agy` starts a new conversation without failing when it cannot find the one it was given, so the dispatcher compares conversation ids and rejects that run with exit code 3. `meta.json` gains `follow_up_of` and `protect`.
- **`doctor.mjs` prints a role table** (`brain`, `worker`, `backup-worker`, `writer`, `finder`) and the next step. A missing `agy` is now a warning, not a failure, because the Claude-only roles still work. `--json` carries `roles` and `next`.
- **`setup` skill** explains the two levels (Claude only, Claude plus a Gemini worker) and carries the official Antigravity CLI install commands, to be run only on the user's say-so.
- **`dispatch` skill**: one table of roles with what each costs the Claude plan, a rule to hand off whole chunks rather than small steps, and a section on shared context and passing results between roles as file paths.
- The worker protocol no longer claims that a write outside the writable directories aborts the run. It is detected afterwards and the job is rejected, which is what 0.2.0 implemented.

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
