---
name: dispatch
description: Division of labor for this session. The main session is the brain (analysis, planning, review). Legwork goes to a Gemini worker on the Antigravity CLI through a dispatcher script that enforces permissions and measures file changes, or to the backup-worker subagent (Sonnet) when that worker is unavailable; long drafts go to the writer subagent (Sonnet); read-only lookups go to the finder subagent (Haiku). Load before handing work off, and whenever you are about to open a search or general-purpose subagent, crawl many files yourself, write and run a script, or generate files in bulk. Also load when the user says "dispatch this", "send it to the worker", "let Gemini do it" or "delegate".
---

# Brain Dispatch

You are the brain. You think the job through, write a brief, hand the legwork to a cheaper model, and check what comes back. What comes back is material for you, never text for the user.

## Who does what

| Work | Who | Cost to the user's Claude plan |
|---|---|---|
| Analysis, planning, decisions, review, short final writing, anything that needs new reasoning | You, the main session | Full |
| Bulk legwork: searching or extracting across many files, turning material into tables or notes, data processing, writing and running scripts, batch file generation, independent recomputation | **Worker**: a Gemini model on the Antigravity CLI (`agy`), through `worker.mjs` | None. It runs on the user's Antigravity plan |
| The same legwork when the worker is unavailable (`agy` not installed, or exit code 5) | **`brain-dispatch:backup-worker`** subagent (Sonnet) | Lower |
| Read-only lookups across more than a few files: locate files and passages, count items | **`brain-dispatch:finder`** subagent (Haiku) | Lowest |
| Long drafts (about 3000 words or more) that need no new reasoning | **`brain-dispatch:writer`** subagent (Sonnet) | Lower |
| One search or one file read | You | |

- Pick the cheapest role that can do the job. Judgment never goes down a tier: if the job needs a decision, it is yours.
- Built-in subagents such as Explore and general-purpose inherit your model unless you pass a cheaper one. Do not use them for legwork.
- Do not send the same job to two roles. Do not wrap the dispatcher in a subagent: the saving is spent on the extra context.

## When to hand off, and when not to

Hand off when the job is bulk, mechanical or parallel: more than a handful of files to read, a table to build from raw material, a script to write and run, a result to recompute independently.

Keep it yourself when:

- one grep or one read settles it;
- it needs the user's taste or a judgment call (choosing an approach, grading, deciding what matters, writing what the user will read);
- the pieces depend on each other so tightly that the brief would retell the whole conversation;
- it touches secrets, credentials or the user's configuration.

Every hand-off has a fixed cost: you write a brief, wait, and check the result. Small jobs cost more to hand off than to do, and the saving only appears on large chunks. So hand off whole chunks, not steps, and put related legwork into one brief instead of a string of small ones.

## Size the job before you write the brief

- **One brief, one kind of deliverable.** A job that must read a dozen sources *and* cross-compare them row by row is two jobs.
- **Cross-comparison:** first hand off an *index* job (what is in each source, one line per item). Do the comparison yourself from the index, or split it by source.
- **Large files** (a big CSV, a long log) get a job of their own.
- Independent jobs can run in parallel, each with its own working directory. Two jobs never write to the same files.
- If you expect a job to run longer than about 15 minutes, split it.

## Shared context

When one piece of work needs more than one hand-off, write what every job must know into one context file, once, instead of retelling it in each brief.

- Start from `${CLAUDE_PLUGIN_ROOT}/templates/context-template.md`: the goal, settled decisions, conventions, where things are, what is not yet decided. Keep it to one screen. The dispatcher refuses a context file over 8,000 characters.
- Give it to every worker job with `--context <file>`, and name its path in every subagent prompt.
- You are its only editor. Update it when a decision changes, but not while a job that was given it is still running: the dispatcher compares the file before and after the run and cannot tell your edit from the worker's. Workers and subagents never write to it: they report problems with it under `open`, and the dispatcher rejects a job that modified it.
- Move results between roles as file paths, not pasted text. The worker writes files; the writer or the next job reads them. Nothing has to pass through your context twice.

## Write the brief

Write the brief to a file. Whoever takes the job sees nothing of this conversation, so the brief, together with the context file if there is one, must stand on its own. Use these six sections and drop any that would be empty:

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
- If the user has not attempted a problem yet and wants to, do not hand it off for an answer.
- The same brief file works for every role. If the worker fails, the backup worker or the finder takes the file unchanged, so a failed dispatch costs no rewrite.

## Dispatch to the worker

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worker.mjs" --name <job-name> --task <brief.md> --workdir <dir> \
  [--context <context.md>] [--read-dir <dir>]... [--write-dir <dir>]... [--protect <dir>]... \
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

## Hand off to a subagent

For `brain-dispatch:backup-worker` and `brain-dispatch:finder` the prompt is three lines: the path of the brief, the directory to write in (backup worker only), and the path of the context file if there is one. Do not restate the brief in the prompt. Run the subagent in the background when you have other work, and do not poll.

The dispatcher's permission rules and file audit do not apply to subagents. They run under the session's own permission settings, so check what a backup worker changed with `git status` or a directory listing before you rely on it.

## Read the report

The dispatcher prints a short report. The full text and the raw files are in the job directory it names.

```
WORKER <name> | done/partial/blocked/no-report | <model> | <access> | <secs>s | tokens <n>
REJECTED: <reason>                 (only when the exit code is not 0)
Summary: ...
Files (measured by the dispatcher):
  + created   ~ modified   - deleted   ! reported but missing   ? changed but not reported
  !! read-only dir touched   !! written outside writable dirs   !! shared context modified
Denied by the permission rules:    (only when a tool call was refused)
  x Permission denied for ...
Commands run (not audited for file writes):    (full access only)
  $ succeeded   x failed or denied
Findings: ...      Verified: ...      Unverified: ...      Open: ...
```

- The **Files** block is measured by comparing the directories before and after the run, plus the writes recorded in the worker's event stream. It is not the worker's claim. If you see `!`, `-` or `!!`, find out what happened before using anything.
- Exit codes: `0` valid report (done or partial); `2` bad arguments, a directory rule violated, a context file missing, empty or too long, or a follow-up whose earlier job cannot be found; `3` rejected (no structured report, aborted on a denied action, blocked, files do not reconcile, a read-only directory touched, a file written outside the writable directories, the shared context modified, a follow-up that did not resume its conversation); `4` timeout, including a run that used up its time limit without a report; `5` backend missing, not signed in or out of quota.

**Your part is not optional, whichever role did the work:**

1. Spot-check two or three numbers or citations against the source with your own search.
2. Recompute any statistic you can recompute independently.
3. Go through **Unverified** and **Open** item by item.
4. Write the user-facing text yourself, or hand the checked material to the writer. Do not paste a worker's prose into the deliverable.

## Follow up instead of starting over

When a job came back and needs one more step, continue it in the same conversation. The worker still has everything it read, so your note is a few lines and nothing is read twice.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worker.mjs" --follow-up <earlier-job-name> --name <new-name> --task <note.md> [--timeout-min 20]
```

- Use it for a `partial` report whose remaining part is clear, a mistake your spot check found, a reported file that is missing, or one more pass over the same material.
- The follow-up takes its directories, access level, model and context file from the earlier job. To change any of them, dispatch a fresh job.
- The note says what to fix or add and nothing else: no protocol, no background the worker already has. The shared context file is sent again as it is now, so a decision you changed since then reaches the worker.
- The same permission rules and the same file audit apply. The report covers the follow-up only.
- A follow-up saves you a brief and saves the worker a second reading pass. It does not make the worker's run cheaper: the earlier conversation is sent to the model again each time. Use it to fix or finish a job, not to start a new one.
- Stop after two follow-ups on one job. If the result is still wrong, the brief was the problem: rewrite it and dispatch fresh, or do the job yourself.
- Not for a job that timed out or returned no report (start fresh and narrower), and not for a new task on other material.
- If the backend cannot find the conversation it silently starts a new one. The dispatcher rejects that run with exit code 3; dispatch a fresh job.

## When it fails

- **Exit 5:** the worker is not available. Hand the same brief to `brain-dispatch:backup-worker`, or to `brain-dispatch:finder` if the job only reads, and carry on. Tell the user once: not installed means `/brain-dispatch:setup`; signed out means running `agy` in a terminal; out of quota means waiting for the reset. Do not dispatch to the worker again in this session until the user says it is back.
- **Partial, or wrong in one place:** send a follow-up (above) rather than a new brief.
- **Timeout or no report:** look at the Files block. The protocol tells the worker to write as it goes, so finished parts are usually on disk. Narrow the job and hand off the rest, or finish it yourself.
- **Aborted on a denied action:** the brief asked for something the access level does not allow, such as a command at `write` or a write to a protected or read-only directory. Fix the brief or raise `--access`.
- **`!! written outside writable dirs`:** the file is already there. Look at it and remove or move it if it should not stay, then fix the brief (use paths relative to the working directory) or add the directory with `--write-dir`.
- **The same job failed twice, on any role:** stop handing it off. Do it yourself. Retrying a failing hand-off costs more than the job.

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
