---
name: setup
description: Set up Brain Dispatch on this machine. Checks Node.js and the Antigravity CLI (agy), writes the default config, and runs one small read-only job to prove the worker answers. Use when the user runs /brain-dispatch:setup, asks to install, configure or troubleshoot Brain Dispatch, or when a dispatch failed because the backend is missing or not logged in.
---

# Set up Brain Dispatch

Work through the steps in order. Stop at the first one that needs the user and tell them exactly what to do.

## 1. Run the doctor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --init
```

`--init` writes `~/.brain-dispatch/config.json` with the defaults if it does not exist yet. Read each `OK` / `WARN` / `FAIL` line.

## 2. Fix what failed

| Doctor says | What to do |
|---|---|
| Node.js missing or older than 18 | Ask the user to install a current Node.js LTS release. Do not install it for them unless they ask |
| `agy` not found | The worker runs on Google's Antigravity CLI. Ask the user to install it from the Antigravity documentation (https://antigravity.google/docs), then run `agy` once in a terminal and sign in. Signing in is theirs to do; never handle their credentials. If `agy` is installed somewhere unusual, put its full path in `"agy"` in the config |
| Configured model not listed by `agy models` | Show the user the models that are listed and ask which one to use. Write their choice to `worker.model` in the config: the id without the effort suffix, for example `gemini-4-hydrogen` |

After a fix, run the doctor again.

## 3. Smoke test

When the doctor shows no `FAIL`, prove the whole loop with one cheap read-only job. Write this brief to a scratch file:

```markdown
## Goal
Connectivity check. Report `done` with the summary "worker ready".

## Boundaries
Read nothing, write nothing.
```

Then dispatch it, using a scratch directory as the working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worker.mjs" --name smoke --task <brief.md> --workdir <scratch-dir> --access read --timeout-min 3
```

Exit code 0 and a line starting with `WORKER smoke | done` mean the worker is ready. Otherwise read the `REJECTED:` line:

- **Exit 5, not signed in:** the doctor cannot see sign-in state, so this is where it shows. Ask the user to run `agy` once in a terminal and sign in, then repeat this step.
- **Exit 5, quota or rate limit:** the message says when the quota resets. Tell the user that time. Setup is otherwise complete; repeat this step after the reset.
- **Anything else:** go back to step 2.

## 4. Tell the user what they have

Keep it to a few lines:

- the worker model and effort now in use, and where the config file is;
- that the main session will now hand legwork to the worker, long drafts to the writer subagent and lookups to the finder subagent, and that they can also ask for it in words ("dispatch this to the worker");
- that `full` access lets the worker run commands without an OS sandbox, so it is used only when a script must run;
- that setting `"policyHook": false` in the config turns off the note printed at session start.

Do not change any other setting, and do not edit the user's `CLAUDE.md`.
