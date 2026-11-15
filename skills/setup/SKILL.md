---
name: setup
description: Set up Brain Dispatch on this machine. Checks Node.js and the Antigravity CLI (agy), shows which roles are available, writes the default config, and runs one small read-only job to prove the worker answers. Use when the user runs /brain-dispatch:setup, asks to install, configure or troubleshoot Brain Dispatch, or when a dispatch failed because the backend is missing or not signed in.
---

# Set up Brain Dispatch

Work through the steps in order. Stop at the first one that needs the user and tell them exactly what to do.

The plugin works at two levels, and both are valid:

- **Claude only.** Nothing to install. Legwork goes to the `backup-worker` (Sonnet) and `finder` (Haiku) subagents, long drafts to `writer` (Sonnet). Cheaper than doing everything on the main model, but it still draws on the Claude plan.
- **Claude plus a Gemini worker.** With the Antigravity CLI installed and signed in, bulk legwork runs on the user's Antigravity plan and costs no Claude usage. This is what the plugin is for.

## 1. Run the doctor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --init
```

`--init` writes `~/.brain-dispatch/config.json` with the defaults if it does not exist yet. Read each `OK` / `WARN` / `FAIL` line, then the `Roles on this machine` table and the `Next:` line under it.

## 2. Fix what the doctor reports

| Doctor says | What to do |
|---|---|
| Node.js missing or older than 18 | Ask the user to install a current Node.js LTS release. Do not install it for them unless they ask |
| `agy` not found (worker `not available`) | Tell the user the Claude-only roles already work, and ask whether they want the Gemini worker as well. If yes, show the official install command for their system (below) and let them decide who runs it. After installing, they run `agy` once in a terminal and sign in. Signing in is theirs to do; never handle their credentials. If `agy` is installed somewhere unusual, put its full path in `"agy"` in the config |
| Configured model not listed by `agy models` | Show the user the models that are listed and ask which one to use. Write their choice to `worker.model` in the config: the id without the effort suffix, for example `gemini-4-hydrogen` |

Official Antigravity CLI installers, from https://antigravity.google/docs/getting-started:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash        # macOS, Linux
```

```powershell
irm https://antigravity.google/cli/install.ps1 | iex               # Windows PowerShell
```

These download and run a script from Google. Run one only when the user has said yes to that exact command; otherwise leave it to them. `agy --version` confirms the install.

After a fix, run the doctor again. If the user chooses to stay Claude-only, skip step 3.

## 3. Smoke test

When the doctor shows the worker as `ready`, prove the whole loop with one cheap read-only job. Write this brief to a scratch file:

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

- which roles are available, taken from the doctor's table, and the worker model and effort if there is a worker;
- that the main session will now hand bulk legwork to the worker (or to the backup worker when there is none), long drafts to the writer and lookups to the finder, and that they can also ask for it in words ("dispatch this to the worker");
- that the brain is whichever model the main session runs: they pick it with `/model`, and the subagents stay on Sonnet and Haiku whatever they pick;
- that `full` access lets the worker run commands without an OS sandbox, so it is used only when a script must run;
- that setting `"policyHook": false` in the config turns off the note printed at session start.

Do not change any other setting, and do not edit the user's `CLAUDE.md`.
