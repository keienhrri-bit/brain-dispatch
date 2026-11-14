---
name: dispatch
description: Division of labor for this session. The main session is the brain (analysis, planning, review); legwork goes to a Gemini worker on the Antigravity CLI through a dispatcher script that enforces permissions and measures file changes; long drafts go to the writer subagent (Sonnet); file lookups go to the finder subagent (Haiku). Load before dispatching work, and whenever you are about to open a search or general-purpose subagent, crawl many files yourself, write and run a script, or generate files in bulk. Also load when the user says "dispatch this", "send it to the worker", "let Gemini do it" or "delegate".
---

# Brain Dispatch

You are the brain. You think the job through, write a brief, hand the legwork to a cheaper model, and check what comes back. The worker's output is material for you, never text for the user.

## Who does what

| Work | Who | How |
|---|---|---|
| Analysis, planning, decisions, review, short final writing, anything that needs new reasoning | You, the main session | Directly |
| Searching or extracting across many files, turning material into tables or notes, data processing and statistics, writing and running scripts, batch file generation, format conversion, independent recomputation | **Worker**: a Gemini model on the Antigravity CLI (`agy`) | `worker.mjs`, see below |
| Long drafts (about 3000 words or more) that need no new reasoning | **`brain-dispatch:writer`** subagent (Sonnet) | You prepare the outline, facts and checked numbers. It writes the file and returns only the path and a summary |
| Locating files and passages when the worker is unavailable | **`brain-dispatch:finder`** subagent (Haiku, read-only) | Fallback only |
| One search or one file read | You | A dispatch costs at least half a minute plus a brief. Not worth it |

Do not send the same job to both the worker and a subagent. Do not wrap the dispatcher in a subagent: the saving is spent on the extra context.

## When to dispatch, and when not to

Dispatch when the job is bulk, mechanical or parallel: more than a handful of files to read, a table to build from raw material, a script to write and run, a result to recompute independently.

Keep it yourself when:

- one grep or one read settles it;
- it needs the user's taste or a judgment call (choosing an approach, grading, deciding what matters, writing what the user will read);
- the pieces depend on each other so tightly that the brief would retell the whole conversation;
- it touches secrets, credentials or the user's configuration.

Delegation trades your tokens for wall-clock time. Small jobs cost more to delegate than to do.

## Size the job before you write the brief

- **One brief, one kind of deliverable.** A job that must read a dozen sources *and* cross-compare them row by row is two jobs.
- **Cross-comparison:** first dispatch an *index* job (what is in each source, one line per item). Do the comparison yourself from the index, or split it by source.
- **Large files** (a big CSV, a long log) get a job of their own.
- Independent jobs can run in parallel, each with its own `--workdir`. Two jobs never write to the same files.
- If you expect a job to run longer than about 15 minutes, split it.

## Write the brief

Write the brief to a file. The worker sees nothing of this conversation, so the brief must stand on its own. Use these six sections and drop any that would be empty:

```markdown
## Goal
One or two sentences: what is needed, and what you will use it for.

## Background
Facts and conventions already settled. Paths you have already ruled out. No conversation history.

## Input
Which files or directories to read. Say so if a file is too large to read whole.

## Output
Which file to write in the working directory, in what format, with which columns, how long.

## Done when
What counts as finished, and how the worker should check itself
(go back to the source for line numbers, assert totals in the script, and so on).

## Boundaries
What not to do. Anything uncertain goes into `open`, not into a guess.
```

- Copy the user's own constraints and prohibitions into **Boundaries** word for word. Do not paraphrase them.
- Keep settled decisions and open questions apart.
- Prefer short paths, relative to the working directory or a read-only directory. Long absolute paths get mistyped by one character.
- The protocol, the permissions and the report format are prepended by the dispatcher. Do not repeat them.
- If the user has not attempted a problem yet and wants to, do not dispatch it for an answer.

## Dispatch

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worker.mjs" --name <job-name> --task <brief.md> --workdir <dir> \
  [--read-dir <dir>]... [--write-dir <dir>]... [--protect <dir>]... \
  [--access read|write|full] [--effort low|medium|high|xhigh] [--web] [--timeout-min 20] [--dry-run]
```

Run it in the background and wait for the completion notice. Do not poll.

| `--access` | The worker can | Use it for |
|---|---|---|
| `read` | Read any file. No writes, no commands | Lookups, extraction, counting, independent solving. The result is in the report |
| `write` (default) | Write to `--workdir` and `--write-dir`. Protected and read-only directories are denied; a write anywhere else is caught after the run and rejects the job. No commands | Jobs that end in files: extract tables, notes, lists, conversions |
| `full` | `write`, plus run commands | Only when a script must actually run |

- All three levels can read the whole machine. MCP servers and the browser are always off. `--web` allows web search and reading URLs.
- Some directories are never writable: agent and credential directories under the home directory, the dispatcher's own state directory, anything listed in `protect` in the config or passed with `--protect`, and every `--read-dir`.
- Give the worker a working directory of its own (a scratch folder or a subfolder), not the user's project root, unless the job is to change that project and the user agreed.
- Writes outside the writable directories are caught afterwards, not prevented: `agy` cannot limit writes to a list of directories, so the dispatcher audits what the worker's file tools wrote. By the time you see `!!`, the file is on disk.
- **`full` has no OS sandbox.** The audit sees the file tools, not what a command writes, and a command can write wherever the process can. The report lists every command that ran, and read-only directories are still compared before and after. The dispatcher also blocks command patterns for deleting, downloading, `git push`/`reset`/`clean`/`restore`, system settings, package installs and starting other agents. Commands run in `--workdir`, so a script that writes with relative paths writes there. Use `full` only when needed, and say in **Boundaries** where the script may read and write.
- Never pass `--dangerously-skip-permissions` to the backend, and never edit the dispatcher to do so.

Effort: `high` (the default) for search, extraction and tidying. `xhigh` for independent solving, recomputation and code that must be right. `low` or `medium` for trivial bulk work.

## Read the report

The dispatcher prints a short report. The full text and the raw files are in the job directory it names.

```
WORKER <name> | done/partial/blocked/no-report | <model> | <access> | <secs>s | tokens <n>
REJECTED: <reason>                 (only when the exit code is not 0)
Summary: ...
Files (measured by the dispatcher):
  + created   ~ modified   - deleted   ! reported but missing   ? changed but not reported
  !! read-only dir touched   !! written outside writable dirs
Denied by the permission rules:    (only when a tool call was refused)
  x Permission denied for ...
Commands run (not audited for file writes):    (full access only)
  $ succeeded   x failed or denied
Findings: ...      Verified: ...      Unverified: ...      Open: ...
```

- The **Files** block is measured by comparing the directories before and after the run, plus the writes recorded in the worker's event stream. It is not the worker's claim. If you see `!`, `-` or `!!`, find out what happened before using anything.
- Exit codes: `0` valid report (done or partial); `2` bad arguments or a directory rule violated; `3` rejected (no structured report, aborted on a denied action, blocked, files do not reconcile, a read-only directory touched, a file written outside the writable directories); `4` timeout, including a run that used up its time limit without a report; `5` backend missing, not logged in or out of quota.

**Your part is not optional:**

1. Spot-check two or three numbers or citations against the source with your own search.
2. Recompute any statistic you can recompute independently.
3. Go through **Unverified** and **Open** item by item.
4. Write the user-facing text yourself, or hand the checked material to the writer. Do not paste the worker's prose into the deliverable.

## When it fails

- **Timeout or no report:** look at the Files block. The protocol tells the worker to write as it goes, so finished parts are usually on disk. Narrow the job and dispatch the rest, or finish it yourself.
- **Aborted on a denied action:** the brief asked for something the access level does not allow, such as a command at `write` or a write to a protected or read-only directory. Fix the brief or raise `--access`.
- **`!! written outside writable dirs`:** the file is already there. Look at it and remove or move it if it should not stay, then fix the brief (use paths relative to the working directory) or add the directory with `--write-dir`.
- **Exit 5:** ask the user to run `agy` once in a terminal to log in, or wait for quota. Meanwhile use `brain-dispatch:finder` for lookups and do the rest yourself.
- **The same job failed twice:** stop dispatching it. Do it yourself.

## Long drafts: the writer

When a deliverable is long and needs no new reasoning:

1. Prepare the outline, the facts and every number, checked.
2. Launch `brain-dispatch:writer` with the output path, the format to follow and the list of fact files.
3. It returns the path, a short summary and a list of `[CHECK: ...]` markers. Do not read the whole draft back. Search it for `[CHECK` and for the key numbers from your notes, and fix only what is wrong.

Anything with new derivations or judgment calls you write yourself.

## Configuration

`~/.brain-dispatch/config.json` (created by `/brain-dispatch:setup`):

```json
{
  "worker": { "model": "gemini-4-hydrogen", "effort": "high", "timeoutMin": 20 },
  "protect": [],
  "proxy": null,
  "agy": null,
  "policyHook": true
}
```

`worker.model` plus the effort gives the model id passed to `agy` (for example `gemini-4-hydrogen-high`); `--model <full id>` overrides it for one job. `protect` lists extra directories no job may write to. `proxy` sets a proxy for the backend process. `agy` is the path of the `agy` executable when it is not on `PATH`. Set `policyHook` to `false` to stop the note printed at session start.
