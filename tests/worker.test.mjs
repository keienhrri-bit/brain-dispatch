import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { PROMPT_INLINE_LIMIT, getRepoRoot, toSlash } from '../scripts/lib/core.mjs';

const execFileAsync = promisify(execFile);

const REPO_ROOT = getRepoRoot();
const WORKER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'worker.mjs');
const DOCTOR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'doctor.mjs');
const FAKE_BACKEND = path.join(REPO_ROOT, 'tests', 'fake-backend.mjs');

function makeEnv(stateHome, extra = {}) {
  return {
    ...process.env,
    BRAIN_DISPATCH_HOME: stateHome,
    BRAIN_DISPATCH_AGY_CMD: JSON.stringify([process.execPath, FAKE_BACKEND]),
    ...extra,
  };
}

async function runNode(scriptPath, args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
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

function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-'));
  const stateHome = path.join(root, 'state');
  const workDir = path.join(root, 'work');
  const taskFile = path.join(root, 'task.md');
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(taskFile, 'Perform the requested test task.\n', 'utf8');
  return Promise.resolve()
    .then(() => fn({ root, stateHome, workDir, taskFile }))
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test('worker --dry-run prints settings and args without creating workdir or invoking backend', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const captureFile = path.join(root, 'captured.json');
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'dry', '--task', taskFile, '--workdir', workDir, '--access', 'full', '--web', '--dry-run'],
      makeEnv(stateHome, { FAKE_BACKEND_CAPTURE_FILE: captureFile })
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.existsSync(workDir), false, 'workDir should not be created in dry-run');
    assert.equal(fs.existsSync(captureFile), false, 'backend should not run in dry-run');
    assert.ok(res.stdout.includes('DRYRUN dry | gemini-4-hydrogen-high | full'));
    assert.ok(res.stdout.includes('"read_url(*)"'));
    assert.ok(res.stdout.includes('Args: --model'));
    assert.ok(!res.stdout.includes('Perform the requested test task.'));
    assert.ok(res.stdout.includes('Prompt:'));
  });
});

test('worker rejects protected directory and enclosing read-dir with exit code 2', async () => {
  await withTempWorkspace(async ({ root, stateHome, taskFile }) => {
    const protectedRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'prot', '--task', taskFile, '--workdir', path.join(os.homedir(), '.ssh', 'bad')],
      makeEnv(stateHome)
    );
    assert.equal(protectedRes.code, 2);

    const roDir = path.join(root, 'ro');
    fs.mkdirSync(path.join(roDir, 'nested'), { recursive: true });
    const roRes = await runNode(
      WORKER_SCRIPT,
      [
        '--name',
        'rofail',
        '--task',
        taskFile,
        '--workdir',
        path.join(roDir, 'nested'),
        '--read-dir',
        roDir,
      ],
      makeEnv(stateHome)
    );
    assert.equal(roRes.code, 2);
  });
});

test('worker mode ok returns 0, lists + file, and writes job artifacts and ledger', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobok', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'ok' })
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes('WORKER jobok | done | gemini-4-hydrogen-high | write |'));
    assert.ok(res.stdout.includes('tokens 1,234'));
    assert.ok(res.stdout.includes(`+ ${path.join(workDir, 'output.txt')}`));

    const jobsRoot = path.join(stateHome, 'jobs');
    const jobFolders = fs.readdirSync(jobsRoot);
    assert.equal(jobFolders.length, 1);
    const jobDir = path.join(jobsRoot, jobFolders[0]);
    for (const f of ['prompt.md', 'settings.json', 'raw.json', 'err.log', 'report.md', 'report.json', 'meta.json']) {
      assert.ok(fs.existsSync(path.join(jobDir, f)), `missing ${f}`);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
    assert.equal(meta.exit, 0);
    assert.equal(meta.ok, true);
    assert.equal(meta.created.length, 1);

    const ledgerLines = fs.readFileSync(path.join(stateHome, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledgerLines.length, 1);
    assert.equal(JSON.parse(ledgerLines[0]).ok, true);
  });
});

test('worker mode missing returns exit 3 and flags missing reported file', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobmissing', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'missing' })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('REJECTED:'));
    assert.ok(res.stdout.includes('! reported but missing:'));
  });
});

test('worker mode noreport returns exit 3 with no-report', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobnoreport', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'noreport' })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('WORKER jobnoreport | no-report |'));
    assert.ok(res.stdout.includes('REJECTED: No structured report returned'));
  });
});

test('worker mode denied returns exit 3 and explains denied action', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobdenied', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'denied' })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('REJECTED: Aborted due to denied action'));
    assert.ok(res.stdout.includes('write_file(/protected/secret.txt)'));
  });
});

test('worker mode auth returns exit 5', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobauth', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'auth' })
    );
    assert.equal(res.code, 5);
    assert.ok(res.stdout.includes('REJECTED:'));
  });
});

test('worker mode quota returns exit 5', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobquota', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'quota' })
    );
    assert.equal(res.code, 5);
    assert.ok(res.stdout.includes('REJECTED: Worker quota exhausted'));
  });
});

test('worker mode hang times out and kills process tree with exit 4', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobhang', '--task', taskFile, '--workdir', workDir, '--timeout-min', '0.01'],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'hang',
        BRAIN_DISPATCH_KILL_GRACE_SEC: '0.2',
      })
    );
    assert.equal(res.code, 4);
    assert.ok(res.stdout.includes('REJECTED: Timed out'));
  });
});

test('worker mode stdin passes because backend stdin is closed (ignore)', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'jobstdin', '--task', taskFile, '--workdir', workDir, '--timeout-min', '0.1'],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'stdin',
        BRAIN_DISPATCH_KILL_GRACE_SEC: '0.2',
      })
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes('WORKER jobstdin | done |'));
  });
});

test('worker passes pointer sentence instead of full brief when prompt exceeds 12000 chars', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    fs.writeFileSync(taskFile, 'A'.repeat(PROMPT_INLINE_LIMIT + 500), 'utf8');
    const captureFile = path.join(root, 'capture-long.json');
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'joblong', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CAPTURE_FILE: captureFile,
      })
    );
    assert.equal(res.code, 0, res.stderr);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    const pIndex = captured.argv.indexOf('-p');
    assert.ok(pIndex >= 0);
    const sentPrompt = captured.argv[pIndex + 1];
    assert.ok(sentPrompt.startsWith('First read the full brief with your file-read tool at '));
    assert.ok(sentPrompt.includes(`${toSlash(path.join(stateHome, 'jobs'))}/`));
    assert.ok(sentPrompt.endsWith('If you cannot read it, report blocked.'));
  });
});

test('worker returns exit 5 when backend is missing', async () => {
  await withTempWorkspace(async ({ stateHome, workDir, taskFile }) => {
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'nobackend', '--task', taskFile, '--workdir', workDir],
      {
        PATH: '',
        Path: '',
        LOCALAPPDATA: '',
        BRAIN_DISPATCH_HOME: stateHome,
      }
    );
    assert.equal(res.code, 5);
    assert.ok(res.stderr.includes('Antigravity CLI (agy) not found'));
  });
});

test('doctor passes with fake backend, supports --init and --json, and flags missing backend', async () => {
  await withTempWorkspace(async ({ stateHome }) => {
    const preInit = await runNode(
      DOCTOR_SCRIPT,
      ['--json'],
      makeEnv(stateHome)
    );
    assert.equal(preInit.code, 0, preInit.stderr);
    const preJson = JSON.parse(preInit.stdout);
    assert.equal(preJson.ok, true);
    assert.equal(preJson.checks.find((c) => c.name === 'config').status, 'WARN');
    assert.equal(preJson.checks.find((c) => c.name === 'backend').status, 'OK');
    assert.equal(preJson.checks.find((c) => c.name === 'model').status, 'OK');

    const withInit = await runNode(
      DOCTOR_SCRIPT,
      ['--init', '--json'],
      makeEnv(stateHome)
    );
    assert.equal(withInit.code, 0, withInit.stderr);
    assert.ok(fs.existsSync(path.join(stateHome, 'config.json')));
    const initJson = JSON.parse(withInit.stdout);
    assert.equal(initJson.checks.find((c) => c.name === 'config').status, 'OK');

    const missingModel = await runNode(
      DOCTOR_SCRIPT,
      ['--json'],
      makeEnv(stateHome, { FAKE_BACKEND_MODELS: 'other-model\n' })
    );
    assert.equal(missingModel.code, 0);
    assert.equal(JSON.parse(missingModel.stdout).checks.find((c) => c.name === 'model').status, 'WARN');

    const noBackend = await runNode(
      DOCTOR_SCRIPT,
      [],
      {
        PATH: '',
        Path: '',
        LOCALAPPDATA: '',
        BRAIN_DISPATCH_HOME: stateHome,
      }
    );
    assert.equal(noBackend.code, 1);
    assert.ok(noBackend.stdout.includes('FAIL'));
  });
});

test('worker full access detects modified read-only dir as exit 3', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const roDir = path.join(root, 'readonly');
    fs.mkdirSync(roDir, { recursive: true });
    const touchedPath = path.join(roDir, 'tampered.txt');

    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'rotouch', '--task', taskFile, '--workdir', workDir, '--read-dir', roDir, '--access', 'full'],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_TOUCH_FILE: touchedPath,
      })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('REJECTED: Read-only directory modified'));
    assert.ok(res.stdout.includes('!! read-only dir touched:'));
  });
});

test('worker forwards config.proxy to child process and honors --model override', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    fs.writeFileSync(
      path.join(stateHome, 'config.json'),
      JSON.stringify({ proxy: 'http://127.0.0.1:7890' }),
      'utf8'
    );
    const captureFile = path.join(root, 'capture-proxy.json');

    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'proxytest', '--task', taskFile, '--workdir', workDir, '--model', 'explicit-model-id'],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CAPTURE_FILE: captureFile,
      })
    );
    assert.equal(res.code, 0, res.stderr);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.equal(captured.proxy.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(captured.proxy.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(captured.proxy.ALL_PROXY, 'http://127.0.0.1:7890');
    const modelIdx = captured.argv.indexOf('--model');
    assert.equal(captured.argv[modelIdx + 1], 'explicit-model-id');
  });
});
