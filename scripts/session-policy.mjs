#!/usr/bin/env node
// SessionStart hook: prints a short division-of-labor note that Claude Code adds
// to the session context. Turn it off with "policyHook": false in config.json.
// It must never fail a session start, so every error is swallowed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  const home = process.env.BRAIN_DISPATCH_HOME || join(homedir(), '.brain-dispatch');
  const configFile = join(home, 'config.json');
  let config = null;
  if (existsSync(configFile)) {
    try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { config = {}; }
  }
  if (config && config.policyHook === false) process.exit(0);

  const lines = [
    '[brain-dispatch] Division of labor in this session:',
    '- You, the main session, are the brain: analysis, planning, decisions, review, and short final writing.',
    '- Legwork goes to the worker (a Gemini model on the Antigravity CLI): searching or extracting across many files, turning a pile of material into tables or notes, data processing, writing and running scripts, batch file generation, independent recomputation. Load the `brain-dispatch:dispatch` skill before the first dispatch and follow it.',
    '- Long drafts that need no new reasoning go to the `brain-dispatch:writer` subagent (Sonnet), from an outline and facts you prepared.',
    '- If the worker is unavailable, use the `brain-dispatch:finder` subagent (Haiku) to locate files and passages.',
    '- Anything one search or one file read settles, do yourself. Worker output is material, not a conclusion: spot-check it before you rely on it.',
  ];
  if (!config) {
    lines.push('- The worker is not set up on this machine yet. Suggest `/brain-dispatch:setup` once, the first time a dispatch would help.');
  }
  process.stdout.write(lines.join('\n') + '\n');
} catch {
  // stay silent
}
process.exit(0);
