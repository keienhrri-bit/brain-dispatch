import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { getRepoRoot } from '../scripts/lib/core.mjs';

const execFileAsync = promisify(execFile);

const REPO_ROOT = getRepoRoot();
const POLICY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'session-policy.mjs');
const FAKE_BACKEND = path.join(REPO_ROOT, 'tests', 'fake-backend.mjs');

async function runPolicy(env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [POLICY_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function withTempEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-policy-'));
  const stateHome = path.join(root, 'state');
  const emptyPathDir = path.join(root, 'empty-path');
  const emptyLocalAppData = path.join(root, 'empty-localappdata');
  fs.mkdirSync(stateHome, { recursive: true });
  fs.mkdirSync(emptyPathDir, { recursive: true });
  fs.mkdirSync(emptyLocalAppData, { recursive: true });

  const makeNoAgyEnv = () => {
    const env = {
      ...process.env,
      PATH: emptyPathDir,
      Path: emptyPathDir,
      LOCALAPPDATA: emptyLocalAppData,
      BRAIN_DISPATCH_HOME: stateHome,
    };
    delete env.BRAIN_DISPATCH_AGY_CMD;
    return env;
  };

  const makeAgyEnv = () => ({
    ...process.env,
    BRAIN_DISPATCH_HOME: stateHome,
    BRAIN_DISPATCH_AGY_CMD: JSON.stringify([process.execPath, FAKE_BACKEND]),
  });

  return Promise.resolve()
    .then(() => fn({ stateHome, makeNoAgyEnv, makeAgyEnv }))
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test('session-policy prints worker guidance and setup reminder when agy is available without config', async () => {
  await withTempEnv(async ({ stateHome, makeAgyEnv }) => {
    const withoutCfg = await runPolicy(makeAgyEnv());
    assert.equal(withoutCfg.code, 0, withoutCfg.stderr);
    const expectedBase = [
      '[brain-dispatch] Division of labor in this session:',
      '- You, the main session, are the brain: analysis, planning, decisions, review, and short final writing.',
      '- Legwork goes to the worker (a Gemini model on the Antigravity CLI; it uses no Claude quota): searching or extracting across many files, turning a pile of material into tables or notes, data processing, writing and running scripts, batch file generation, independent recomputation. Load the `brain-dispatch:dispatch` skill before the first dispatch and follow it.',
      '- If the worker fails with exit code 5 (signed out or out of quota), hand the same brief to the `brain-dispatch:backup-worker` subagent (Sonnet), or to `brain-dispatch:finder` (Haiku) when the job only reads.',
      '- Long drafts that need no new reasoning go to the `brain-dispatch:writer` subagent (Sonnet), from an outline and facts you prepared.',
      "- Built-in subagents such as Explore and general-purpose inherit this session's model by default, so prefer the roles above for legwork.",
      '- Anything one search or one file read settles, do yourself: a hand-off that small costs more than it saves. Output from any of these roles is material, not a conclusion. Spot-check it before you rely on it.',
    ];
    assert.equal(
      withoutCfg.stdout,
      [
        ...expectedBase,
        '- Setup has not been run on this machine. Suggest `/brain-dispatch:setup` once, before the first dispatch.',
      ].join('\n') + '\n'
    );

    fs.writeFileSync(path.join(stateHome, 'config.json'), JSON.stringify({}), 'utf8');
    const withCfg = await runPolicy(makeAgyEnv());
    assert.equal(withCfg.code, 0, withCfg.stderr);
    assert.equal(withCfg.stdout, expectedBase.join('\n') + '\n');
  });
});

test('session-policy prints Claude-only guidance when agy is not installed', async () => {
  await withTempEnv(async ({ stateHome, makeNoAgyEnv }) => {
    const expected = [
      '[brain-dispatch] Division of labor in this session:',
      '- You, the main session, are the brain: analysis, planning, decisions, review, and short final writing.',
      "- The Gemini worker is not installed on this machine, so legwork goes to Claude's cheaper models: the `brain-dispatch:backup-worker` subagent (Sonnet) for jobs that write files or run scripts, and `brain-dispatch:finder` (Haiku) for jobs that only read. Load the `brain-dispatch:dispatch` skill before the first hand-off and follow it. `/brain-dispatch:setup` connects a Gemini worker that uses no Claude quota; mention it once, the first time a hand-off would help.",
      '- Long drafts that need no new reasoning go to the `brain-dispatch:writer` subagent (Sonnet), from an outline and facts you prepared.',
      "- Built-in subagents such as Explore and general-purpose inherit this session's model by default, so prefer the roles above for legwork.",
      '- Anything one search or one file read settles, do yourself: a hand-off that small costs more than it saves. Output from any of these roles is material, not a conclusion. Spot-check it before you rely on it.',
    ].join('\n') + '\n';

    const noCfg = await runPolicy(makeNoAgyEnv());
    assert.equal(noCfg.code, 0, noCfg.stderr);
    assert.equal(noCfg.stdout, expected);

    fs.writeFileSync(path.join(stateHome, 'config.json'), JSON.stringify({}), 'utf8');
    const withCfg = await runPolicy(makeNoAgyEnv());
    assert.equal(withCfg.code, 0, withCfg.stderr);
    assert.equal(withCfg.stdout, expected);
  });
});

test('session-policy stays silent when policyHook is false and survives broken config', async () => {
  await withTempEnv(async ({ stateHome, makeNoAgyEnv, makeAgyEnv }) => {
    fs.writeFileSync(path.join(stateHome, 'config.json'), JSON.stringify({ policyHook: false }), 'utf8');

    const disabledWithAgy = await runPolicy(makeAgyEnv());
    assert.equal(disabledWithAgy.code, 0, disabledWithAgy.stderr);
    assert.equal(disabledWithAgy.stdout, '');

    const disabledNoAgy = await runPolicy(makeNoAgyEnv());
    assert.equal(disabledNoAgy.code, 0, disabledNoAgy.stderr);
    assert.equal(disabledNoAgy.stdout, '');

    fs.writeFileSync(path.join(stateHome, 'config.json'), '{not-json', 'utf8');
    const brokenCfg = await runPolicy(makeNoAgyEnv());
    assert.equal(brokenCfg.code, 0, brokenCfg.stderr);
    assert.ok(brokenCfg.stdout.includes('- Legwork goes to the worker'));
  });
});
