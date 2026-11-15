#!/usr/bin/env node
// SessionStart hook: prints a short division-of-labor note that Claude Code adds
// to the session context. Turn it off with "policyHook": false in config.json.
// It must never fail a session start, so every error is swallowed.
import { homedir } from 'node:os';

try {
  let hasAgy = true;
  let configExists = false;

  try {
    const {
      BackendUnavailableError,
      findBackend,
      getStateHome,
      loadConfig,
    } = await import('./lib/core.mjs');
    const stateHome = getStateHome(process.env, homedir(), process.platform);
    const loaded = loadConfig(stateHome);
    configExists = loaded.exists;
    if (loaded.config.policyHook === false) process.exit(0);

    try {
      findBackend(loaded.config, process.env, process.platform);
    } catch (err) {
      if (err instanceof BackendUnavailableError) {
        hasAgy = false;
      }
    }
  } catch {
    // Any failure loading core or config falls back to assuming agy is available.
  }

  const lines = [
    '[brain-dispatch] Division of labor in this session:',
    '- You, the main session, are the brain: analysis, planning, decisions, review, and short final writing.',
  ];

  if (hasAgy) {
    lines.push(
      '- Legwork goes to the worker (a Gemini model on the Antigravity CLI; it uses no Claude quota): searching or extracting across many files, turning a pile of material into tables or notes, data processing, writing and running scripts, batch file generation, independent recomputation. Load the `brain-dispatch:dispatch` skill before the first dispatch and follow it.',
      '- If the worker fails with exit code 5 (signed out or out of quota), hand the same brief to the `brain-dispatch:backup-worker` subagent (Sonnet), or to `brain-dispatch:finder` (Haiku) when the job only reads.'
    );
  } else {
    lines.push(
      "- The Gemini worker is not installed on this machine, so legwork goes to Claude's cheaper models: the `brain-dispatch:backup-worker` subagent (Sonnet) for jobs that write files or run scripts, and `brain-dispatch:finder` (Haiku) for jobs that only read. Load the `brain-dispatch:dispatch` skill before the first hand-off and follow it. `/brain-dispatch:setup` connects a Gemini worker that uses no Claude quota; mention it once, the first time a hand-off would help."
    );
  }

  lines.push(
    '- Long drafts that need no new reasoning go to the `brain-dispatch:writer` subagent (Sonnet), from an outline and facts you prepared.',
    "- Built-in subagents such as Explore and general-purpose inherit this session's model by default, so prefer the roles above for legwork.",
    '- Anything one search or one file read settles, do yourself: a hand-off that small costs more than it saves. Output from any of these roles is material, not a conclusion. Spot-check it before you rely on it.'
  );

  if (hasAgy && !configExists) {
    lines.push(
      '- Setup has not been run on this machine. Suggest `/brain-dispatch:setup` once, before the first dispatch.'
    );
  }

  process.stdout.write(lines.join('\n') + '\n');
} catch {
  // stay silent
}
process.exit(0);
