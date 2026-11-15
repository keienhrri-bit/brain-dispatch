import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CONTEXT_LIMIT, FALLBACK_HINT, PROMPT_INLINE_LIMIT, getRepoRoot, toSlash } from '../scripts/lib/core.mjs';

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
    for (const f of ['prompt.md', 'settings.json', 'events.jsonl', 'err.log', 'report.md', 'report.json', 'meta.json']) {
      assert.ok(fs.existsSync(path.join(jobDir, f)), `missing ${f}`);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
    assert.equal(meta.exit, 0);
    assert.equal(meta.ok, true);
    assert.equal(meta.created.length, 1);
    assert.deepEqual(meta.written_outside, []);
    assert.equal(meta.written_by_tools.length, 1);
    assert.equal(meta.command_dir, toSlash(workDir));
    assert.equal(meta.context_file, null);
    assert.equal(meta.context_changed, false);

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
    assert.ok(res.stdout.includes(FALLBACK_HINT));
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
    assert.ok(res.stdout.includes(FALLBACK_HINT));
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
    assert.ok(res.stderr.includes(FALLBACK_HINT));
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
    assert.equal(noBackend.code, 0);
    assert.ok(noBackend.stdout.includes('WARN  backend:'));
    assert.ok(noBackend.stdout.includes('backup-worker (Sonnet) takes its jobs'));
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

test('worker rejects a job that wrote outside the writable directories', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const elsewhere = path.join(root, 'elsewhere');
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'outside', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'outside', FAKE_BACKEND_OUTSIDE_DIR: elsewhere })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('REJECTED: Wrote 1 file(s) outside the writable directories'));
    assert.ok(res.stdout.includes(`!! written outside writable dirs: ${path.join(elsewhere, 'stray.txt')}`));
  });
});

test('worker accepts writes to an extra --write-dir', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const extra = path.join(root, 'extra');
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'extra', '--task', taskFile, '--workdir', workDir, '--write-dir', extra],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'outside', FAKE_BACKEND_OUTSIDE_DIR: extra })
    );
    assert.equal(res.code, 0, res.stdout);
    assert.ok(!res.stdout.includes('!!'));
  });
});

test('worker full access runs in the workdir and lists commands and denied steps', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    // A read-only directory whose name sorts before the workdir: agy would make
    // it the command directory if it were passed with --add-dir.
    const roDir = path.join(root, 'aaa-data');
    fs.mkdirSync(roDir, { recursive: true });
    const captureFile = path.join(root, 'capture-full.json');
    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'cmds', '--task', taskFile, '--workdir', workDir, '--read-dir', roDir, '--access', 'full'],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'commands', FAKE_BACKEND_CAPTURE_FILE: captureFile })
    );
    assert.equal(res.code, 0, res.stdout);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.equal(path.resolve(captured.cwd), path.resolve(workDir));
    assert.ok(!captured.argv.includes('--add-dir'));
    assert.ok(res.stdout.includes('Commands run (not audited for file writes):'));
    assert.ok(res.stdout.includes('$ node build.mjs'));
    assert.ok(res.stdout.includes('x Remove-Item old.txt'));
    assert.ok(res.stdout.includes('Denied by the permission rules:'));
    assert.ok(res.stdout.includes('Permission denied for unsandboxed(Remove-Item old.txt)'));
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

test('worker --context prepends shared context to prompt.md, updates meta, and prints Context in dry-run', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const contextFile = path.join(root, 'shared.md');
    fs.writeFileSync(contextFile, '  Settled background fact.  \n', 'utf8');

    const dryRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'dryctx', '--task', taskFile, '--workdir', workDir, '--context', contextFile, '--dry-run'],
      makeEnv(stateHome)
    );
    assert.equal(dryRes.code, 0, dryRes.stderr);
    const dryLines = dryRes.stdout.split(/\r?\n/);
    const ctxIdx = dryLines.findIndex((l) => l.startsWith('Context: '));
    const promptIdx = dryLines.findIndex((l) => l.startsWith('Prompt: '));
    assert.ok(ctxIdx >= 0 && promptIdx === ctxIdx + 1);
    // Length is counted after trimming, as the worker sees it.
    assert.equal(dryLines[ctxIdx], `Context: ${contextFile} (24 chars)`);
    // The context file sits in a deny rule of its own.
    assert.ok(dryRes.stdout.includes(`"write_file(${toSlash(contextFile)})"`));

    const runRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'runctx', '--task', taskFile, '--workdir', workDir, '--context', contextFile],
      makeEnv(stateHome, { FAKE_BACKEND_MODE: 'ok' })
    );
    assert.equal(runRes.code, 0, runRes.stderr);

    const jobFolders = fs
      .readdirSync(path.join(stateHome, 'jobs'))
      .filter((name) => name.endsWith('_runctx'));
    assert.equal(jobFolders.length, 1);
    const jobDir = path.join(stateHome, 'jobs', jobFolders[0]);
    const promptText = fs.readFileSync(path.join(jobDir, 'prompt.md'), 'utf8');
    assert.ok(promptText.includes('# Shared context'));
    assert.ok(promptText.includes(`(source: \`${toSlash(contextFile)}\`)`));
    assert.ok(promptText.includes('\nSettled background fact.\n\n---'));

    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
    assert.equal(meta.context_file, contextFile);
    assert.equal(meta.context_changed, false);
  });
});

test('worker --context rejects missing, non-file, empty, and over-limit files with exit code 2', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const missingCtx = path.join(root, 'missing.md');
    const missingRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxmiss', '--task', taskFile, '--workdir', workDir, '--context', missingCtx],
      makeEnv(stateHome)
    );
    assert.equal(missingRes.code, 2);
    assert.ok(missingRes.stderr.includes(`Context file not found: ${missingCtx}`));

    const dirCtx = path.join(root, 'ctx-dir');
    fs.mkdirSync(dirCtx, { recursive: true });
    const dirRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxdir', '--task', taskFile, '--workdir', workDir, '--context', dirCtx],
      makeEnv(stateHome)
    );
    assert.equal(dirRes.code, 2);
    assert.ok(dirRes.stderr.includes(`Context file not found: ${dirCtx}`));

    const emptyCtx = path.join(root, 'empty.md');
    fs.writeFileSync(emptyCtx, '\uFEFF  \r\n\t ', 'utf8');
    const emptyRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxempty', '--task', taskFile, '--workdir', workDir, '--context', emptyCtx],
      makeEnv(stateHome)
    );
    assert.equal(emptyRes.code, 2);
    assert.ok(emptyRes.stderr.includes(`Context file is empty: ${emptyCtx}`));

    const bigCtx = path.join(root, 'big.md');
    fs.writeFileSync(bigCtx, 'X'.repeat(CONTEXT_LIMIT + 1), 'utf8');
    const bigRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxbig', '--task', taskFile, '--workdir', workDir, '--context', bigCtx],
      makeEnv(stateHome)
    );
    assert.equal(bigRes.code, 2);
    assert.ok(
      bigRes.stderr.includes(
        `Context file is ${CONTEXT_LIMIT + 1} characters; the limit is 8000. Trim it to what every job needs.`
      )
    );

    // Surrounding whitespace does not count toward the limit.
    const edgeCtx = path.join(root, 'edge.md');
    fs.writeFileSync(edgeCtx, `\n${'X'.repeat(CONTEXT_LIMIT)}\n\n`, 'utf8');
    const edgeRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxedge', '--task', taskFile, '--workdir', workDir, '--context', edgeCtx, '--dry-run'],
      makeEnv(stateHome)
    );
    assert.equal(edgeRes.code, 0, edgeRes.stderr);
  });
});

test('worker detects modified shared context file during run as exit 3', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const contextFile = path.join(root, 'shared.md');
    fs.writeFileSync(contextFile, 'Original shared context.\n', 'utf8');

    const res = await runNode(
      WORKER_SCRIPT,
      ['--name', 'ctxtamper', '--task', taskFile, '--workdir', workDir, '--context', contextFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'modify-context',
        FAKE_BACKEND_CONTEXT_FILE: contextFile,
      })
    );
    assert.equal(res.code, 3);
    assert.ok(res.stdout.includes('REJECTED: Shared context file was modified during the run'));
    assert.ok(res.stdout.includes(`!! shared context modified: ${contextFile}`));

    const jobFolders = fs.readdirSync(path.join(stateHome, 'jobs'));
    assert.equal(jobFolders.length, 1);
    const meta = JSON.parse(fs.readFileSync(path.join(stateHome, 'jobs', jobFolders[0], 'meta.json'), 'utf8'));
    assert.equal(meta.context_file, contextFile);
    assert.equal(meta.context_changed, true);
  });
});

test('worker --follow-up continues by job name and job directory with inherited settings and prompt', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const extraDir = path.join(root, 'extra');
    const protectDir = path.join(root, 'protected');
    const contextFile = path.join(root, 'shared.md');
    fs.writeFileSync(contextFile, 'Settled follow-up context.\n', 'utf8');
    const followTaskFile = path.join(root, 'followup-task.md');
    fs.writeFileSync(followTaskFile, 'Do the second step only.\n', 'utf8');

    const firstRes = await runNode(
      WORKER_SCRIPT,
      [
        '--name',
        'stepone',
        '--task',
        taskFile,
        '--workdir',
        workDir,
        '--write-dir',
        extraDir,
        '--protect',
        protectDir,
        '--context',
        contextFile,
      ],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-fixed-1',
      })
    );
    assert.equal(firstRes.code, 0, firstRes.stderr);

    const jobsRoot = path.join(stateHome, 'jobs');
    const stepOneFolder = fs.readdirSync(jobsRoot).find((n) => n.endsWith('_stepone'));
    assert.ok(stepOneFolder);
    const stepOneDir = path.join(jobsRoot, stepOneFolder);
    const stepOneMeta = JSON.parse(fs.readFileSync(path.join(stepOneDir, 'meta.json'), 'utf8'));
    const stepOneSettings = JSON.parse(fs.readFileSync(path.join(stepOneDir, 'settings.json'), 'utf8'));
    assert.equal(stepOneMeta.follow_up_of, null);
    assert.deepEqual(stepOneMeta.protect, [path.normalize(protectDir)]);

    const captureByName = path.join(root, 'capture-name.json');
    const byNameRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'steptwo', '--follow-up', 'stepone', '--task', followTaskFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-fixed-1',
        FAKE_BACKEND_CAPTURE_FILE: captureByName,
      })
    );
    assert.equal(byNameRes.code, 0, byNameRes.stderr);

    const capturedName = JSON.parse(fs.readFileSync(captureByName, 'utf8'));
    const convIdx = capturedName.argv.indexOf('--conversation');
    assert.ok(convIdx >= 0);
    assert.equal(capturedName.argv[convIdx + 1], 'conv-fixed-1');

    const stepTwoFolder = fs.readdirSync(jobsRoot).find((n) => n.endsWith('_steptwo'));
    assert.ok(stepTwoFolder);
    const stepTwoDir = path.join(jobsRoot, stepTwoFolder);
    const stepTwoPrompt = fs.readFileSync(path.join(stepTwoDir, 'prompt.md'), 'utf8');
    assert.ok(stepTwoPrompt.startsWith('# Follow-up'));
    assert.ok(stepTwoPrompt.includes('Do the second step only.'));
    assert.ok(stepTwoPrompt.includes('# Shared context'));
    assert.ok(!stepTwoPrompt.includes('# Protocol for this job (prepended to the brief by the dispatcher)'));

    const stepTwoMeta = JSON.parse(fs.readFileSync(path.join(stepTwoDir, 'meta.json'), 'utf8'));
    const stepTwoSettings = JSON.parse(fs.readFileSync(path.join(stepTwoDir, 'settings.json'), 'utf8'));
    assert.equal(stepTwoMeta.follow_up_of, path.normalize(stepOneDir));
    assert.equal(stepTwoMeta.work_dir, stepOneMeta.work_dir);
    assert.deepEqual(stepTwoMeta.write_dir, stepOneMeta.write_dir);
    assert.equal(stepTwoMeta.access, stepOneMeta.access);
    assert.equal(stepTwoMeta.context_file, stepOneMeta.context_file);
    assert.deepEqual(stepTwoMeta.protect, stepOneMeta.protect);
    assert.deepEqual(stepTwoSettings, stepOneSettings);

    // Follow-up by explicit job directory path also succeeds.
    const captureByDir = path.join(root, 'capture-dir.json');
    const byDirRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'stepthree', '--follow-up', stepOneDir, '--task', followTaskFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-fixed-1',
        FAKE_BACKEND_CAPTURE_FILE: captureByDir,
      })
    );
    assert.equal(byDirRes.code, 0, byDirRes.stderr);
    const capturedDir = JSON.parse(fs.readFileSync(captureByDir, 'utf8'));
    const dirConvIdx = capturedDir.argv.indexOf('--conversation');
    assert.ok(dirConvIdx >= 0);
    assert.equal(capturedDir.argv[dirConvIdx + 1], 'conv-fixed-1');
  });
});

test('worker --follow-up rejects conversation id mismatch with exit 3 and handles error cases with exit 2', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const firstRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'seed', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-seed',
      })
    );
    assert.equal(firstRes.code, 0, firstRes.stderr);

    const mismatchRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'badconv', '--follow-up', 'seed', '--task', taskFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-new-unexpected',
      })
    );
    assert.equal(mismatchRes.code, 3);
    assert.ok(
      mismatchRes.stdout.includes(
        'Follow-up did not resume the earlier conversation (the backend started a new one, without the protocol); dispatch a fresh job'
      )
    );

    const missingRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'miss', '--follow-up', 'nonexistent', '--task', taskFile],
      makeEnv(stateHome)
    );
    assert.equal(missingRes.code, 2);
    assert.ok(missingRes.stderr.includes('No earlier job found for "nonexistent"'));

    const noConvDir = path.join(stateHome, 'jobs', '20261115-000000_noconv');
    fs.mkdirSync(noConvDir, { recursive: true });
    fs.writeFileSync(
      path.join(noConvDir, 'meta.json'),
      JSON.stringify({ work_dir: workDir, access: 'write' }),
      'utf8'
    );
    const noConvRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'retry', '--follow-up', 'noconv', '--task', taskFile],
      makeEnv(stateHome)
    );
    assert.equal(noConvRes.code, 2);
    assert.ok(
      noConvRes.stderr.includes('Job "noconv" has no conversation to continue; dispatch a fresh job instead')
    );

    const extraFlagRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'conflict', '--follow-up', 'seed', '--task', taskFile, '--workdir', workDir],
      makeEnv(stateHome)
    );
    assert.equal(extraFlagRes.code, 2);
    assert.ok(
      extraFlagRes.stderr.includes(
        '--follow-up takes its directories, access level, model and context file from the earlier job; remove --workdir'
      )
    );

    // Dry-run prints Follow-up of line right after Job dir and skips backend.
    const dryCapture = path.join(root, 'dry-capture.json');
    const seedDir = path.join(
      stateHome,
      'jobs',
      fs.readdirSync(path.join(stateHome, 'jobs')).find((n) => n.endsWith('_seed'))
    );
    const dryRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'dryfu', '--follow-up', 'seed', '--task', taskFile, '--dry-run'],
      makeEnv(stateHome, { FAKE_BACKEND_CAPTURE_FILE: dryCapture })
    );
    assert.equal(dryRes.code, 0, dryRes.stderr);
    assert.equal(fs.existsSync(dryCapture), false);
    const dryLines = dryRes.stdout.split(/\r?\n/);
    const jobDirIdx = dryLines.findIndex((l) => l.startsWith('Job dir: '));
    assert.ok(jobDirIdx >= 0);
    assert.equal(
      dryLines[jobDirIdx + 1],
      `Follow-up of: ${path.normalize(seedDir)} (conversation conv-seed)`
    );
  });
});

test('worker --follow-up drops deleted context file silently and rejects missing workdir', async () => {
  await withTempWorkspace(async ({ root, stateHome, workDir, taskFile }) => {
    const contextFile = path.join(root, 'ephemeral.md');
    fs.writeFileSync(contextFile, 'Temporary context.\n', 'utf8');

    const firstRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'withctx', '--task', taskFile, '--workdir', workDir, '--context', contextFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-ctx-1',
      })
    );
    assert.equal(firstRes.code, 0, firstRes.stderr);

    fs.rmSync(contextFile);
    const noCtxFollow = await runNode(
      WORKER_SCRIPT,
      ['--name', 'afterdelctx', '--follow-up', 'withctx', '--task', taskFile],
      makeEnv(stateHome, {
        FAKE_BACKEND_MODE: 'ok',
        FAKE_BACKEND_CONVERSATION_ID: 'conv-ctx-1',
      })
    );
    assert.equal(noCtxFollow.code, 0, noCtxFollow.stderr);
    const followFolder = fs
      .readdirSync(path.join(stateHome, 'jobs'))
      .find((n) => n.endsWith('_afterdelctx'));
    const followPrompt = fs.readFileSync(
      path.join(stateHome, 'jobs', followFolder, 'prompt.md'),
      'utf8'
    );
    const followMeta = JSON.parse(
      fs.readFileSync(path.join(stateHome, 'jobs', followFolder, 'meta.json'), 'utf8')
    );
    assert.ok(!followPrompt.includes('# Shared context'));
    assert.equal(followMeta.context_file, null);

    fs.rmSync(workDir, { recursive: true, force: true });
    const missingWorkRes = await runNode(
      WORKER_SCRIPT,
      ['--name', 'nowork', '--follow-up', 'withctx', '--task', taskFile],
      makeEnv(stateHome)
    );
    assert.equal(missingWorkRes.code, 2);
    assert.ok(
      missingWorkRes.stderr.includes(
        `Working directory of the earlier job no longer exists: ${path.normalize(workDir)}`
      )
    );
  });
});
