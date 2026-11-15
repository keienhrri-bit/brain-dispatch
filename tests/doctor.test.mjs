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
const DOCTOR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'doctor.mjs');
const FAKE_BACKEND = path.join(REPO_ROOT, 'tests', 'fake-backend.mjs');

async function runDoctor(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DOCTOR_SCRIPT, ...args], {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-doctor-'));
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

  const makeAgyEnv = (extra = {}) => ({
    ...process.env,
    BRAIN_DISPATCH_HOME: stateHome,
    BRAIN_DISPATCH_AGY_CMD: JSON.stringify([process.execPath, FAKE_BACKEND]),
    ...extra,
  });

  return Promise.resolve()
    .then(() => fn({ stateHome, makeNoAgyEnv, makeAgyEnv }))
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test('doctor exits 0 and prints Claude-only role table when agy is missing', async () => {
  await withTempEnv(async ({ makeNoAgyEnv }) => {
    const res = await runDoctor([], makeNoAgyEnv());
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes('WARN  backend:'));
    assert.ok(
      res.stdout.includes(
        [
          '',
          'Roles on this machine:',
          '  brain          main session (the model you chose with /model)',
          '  worker         Gemini on agy: not available; backup-worker (Sonnet) takes its jobs',
          '  backup-worker  Sonnet subagent, always available',
          '  writer         Sonnet subagent, always available',
          '  finder         Haiku subagent, always available',
          'Next: install the Antigravity CLI (see /brain-dispatch:setup), or carry on with the Claude-only roles.',
        ].join('\n')
      )
    );

    const jsonRes = await runDoctor(['--json'], makeNoAgyEnv());
    assert.equal(jsonRes.code, 0, jsonRes.stderr);
    const data = JSON.parse(jsonRes.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.checks.find((c) => c.name === 'backend').status, 'WARN');
    assert.deepEqual(data.roles, {
      worker: {
        status: 'unavailable',
        detail: 'not available; backup-worker (Sonnet) takes its jobs',
      },
    });
    assert.equal(
      data.next,
      'install the Antigravity CLI (see /brain-dispatch:setup), or carry on with the Claude-only roles.'
    );
  });
});

test('doctor reports ready and check-model roles when agy is available', async () => {
  await withTempEnv(async ({ makeAgyEnv }) => {
    const readyRes = await runDoctor([], makeAgyEnv());
    assert.equal(readyRes.code, 0, readyRes.stderr);
    assert.ok(readyRes.stdout.includes('  worker         Gemini on agy: ready (gemini-4-hydrogen-high)'));
    assert.ok(
      readyRes.stdout.includes(
        'Next: run the smoke test in /brain-dispatch:setup to confirm agy is signed in.'
      )
    );

    const readyJson = JSON.parse((await runDoctor(['--json'], makeAgyEnv())).stdout);
    assert.deepEqual(readyJson.roles, {
      worker: {
        status: 'ready',
        detail: 'ready (gemini-4-hydrogen-high)',
      },
    });
    assert.equal(
      readyJson.next,
      'run the smoke test in /brain-dispatch:setup to confirm agy is signed in.'
    );

    const checkModelJsonRes = await runDoctor(
      ['--json'],
      makeAgyEnv({ FAKE_BACKEND_MODELS: 'unrelated-model\n' })
    );
    assert.equal(checkModelJsonRes.code, 0, checkModelJsonRes.stderr);
    const checkModelJson = JSON.parse(checkModelJsonRes.stdout);
    assert.deepEqual(checkModelJson.roles, {
      worker: {
        status: 'check-model',
        detail: 'agy found, but gemini-4-hydrogen-high is not in "agy models"',
      },
    });
    assert.equal(
      checkModelJson.next,
      'pick a model from "agy models" and set worker.model in the config.'
    );
  });
});

test('doctor exits 1 with FAIL when agy is found but --version fails', async () => {
  await withTempEnv(async ({ makeAgyEnv }) => {
    const res = await runDoctor([], makeAgyEnv({ FAKE_BACKEND_VERSION_FAIL: '1' }));
    assert.equal(res.code, 1);
    assert.ok(res.stdout.includes('FAIL  backend:'));
    assert.ok(
      res.stdout.includes(
        '  worker         Gemini on agy: not available; backup-worker (Sonnet) takes its jobs'
      )
    );
  });
});
