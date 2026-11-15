import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CMD_DENY_PATTERNS,
  CONTEXT_LIMIT,
  DEFAULT_CONFIG,
  FALLBACK_HINT,
  PROMPT_INLINE_LIMIT,
  ValidationError,
  buildBackendArgs,
  buildSettings,
  commandDenyBodies,
  computeRoles,
  diffReadOnly,
  diffSnapshots,
  findBackend,
  formatReport,
  getRepoRoot,
  getStateHome,
  isInside,
  judgeRun,
  loadConfig,
  mergeConfig,
  parseBackendOutput,
  parseWorkerArgs,
  reconcileReport,
  renderPrompt,
  resolveFollowUp,
  selectPromptArg,
  takeSnapshot,
  toSlash,
  validateDirectories,
  writesOutside,
} from '../scripts/lib/core.mjs';
import {
  applyProxyEnv,
  isLoopbackHost,
  parseRegistryProxy,
  resolveBackendProxy,
} from '../scripts/lib/proxy.mjs';

test('mergeConfig and loadConfig apply defaults for missing file or fields', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cfg-'));
  try {
    const missing = loadConfig(tmp);
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.config, DEFAULT_CONFIG);

    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ worker: { effort: 'xhigh' }, proxy: 'http://127.0.0.1:8888' }),
      'utf8'
    );
    const partial = loadConfig(tmp);
    assert.equal(partial.exists, true);
    assert.equal(partial.config.worker.model, 'gemini-4-hydrogen');
    assert.equal(partial.config.worker.effort, 'xhigh');
    assert.equal(partial.config.worker.timeoutMin, 20);
    assert.equal(partial.config.proxy, 'http://127.0.0.1:8888');
    assert.equal(partial.config.policyHook, true);
    assert.deepEqual(partial.config.protect, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getStateHome uses BRAIN_DISPATCH_HOME or falls back to home/.brain-dispatch', () => {
  const home = '/home/alice';
  assert.equal(
    toSlash(getStateHome({}, home, 'linux')),
    '/home/alice/.brain-dispatch'
  );
  assert.equal(
    toSlash(getStateHome({ BRAIN_DISPATCH_HOME: '/tmp/custom-bd' }, home, 'linux')),
    '/tmp/custom-bd'
  );
});

test('parseWorkerArgs validates name, options, model resolution, and lists', () => {
  const cfg = mergeConfig({ worker: { model: 'gemini-4-hydrogen', effort: 'high', timeoutMin: 15 } });
  const parsed = parseWorkerArgs(
    [
      '--name',
      'job_01-αβ',
      '--task',
      'task.md',
      '--workdir',
      'work',
      '--read-dir',
      'a,b',
      '--read-dir',
      'c',
      '--write-dir=d,e',
      '--protect',
      'p1',
      '--web',
    ],
    cfg
  );
  assert.equal(parsed.name, 'job_01-αβ');
  assert.deepEqual(parsed.readDirs, ['a', 'b', 'c']);
  assert.deepEqual(parsed.writeDirs, ['d', 'e']);
  assert.deepEqual(parsed.protect, ['p1']);
  assert.equal(parsed.access, 'write');
  assert.equal(parsed.effort, 'high');
  assert.equal(parsed.timeoutMin, 15);
  assert.equal(parsed.resolvedModel, 'gemini-4-hydrogen-high');
  assert.equal(parsed.web, true);

  const customModel = parseWorkerArgs(
    ['--name', 'x', '--task', 't.md', '--workdir', 'w', '--model', 'custom-raw-model'],
    cfg
  );
  assert.equal(customModel.resolvedModel, 'custom-raw-model');

  assert.throws(
    () => parseWorkerArgs(['--name', '../bad', '--task', 't.md', '--workdir', 'w'], cfg),
    ValidationError
  );
  assert.throws(
    () => parseWorkerArgs(['--name', 'bad.name', '--task', 't.md', '--workdir', 'w'], cfg),
    ValidationError
  );
  assert.throws(
    () => parseWorkerArgs(['--name', 'ok', '--task', 't.md', '--workdir', 'w', '--timeout-min', '0'], cfg),
    ValidationError
  );
});

test('isInside respects platform case sensitivity and path boundaries', () => {
  assert.equal(isInside('C:\\Users\\Alice\\.SSH\\keys', 'c:/users/alice/.ssh', 'win32'), true);
  assert.equal(isInside('C:\\Users\\Alice\\.ssh2', 'C:\\Users\\Alice\\.ssh', 'win32'), false);
  assert.equal(isInside('/Users/Alice/.SSH/id', '/users/alice/.ssh', 'darwin'), true);
  assert.equal(isInside('/home/alice/.SSH/id', '/home/alice/.ssh', 'linux'), false);
  assert.equal(isInside('/home/alice/.ssh/id', '/home/alice/.ssh', 'linux'), true);
  assert.equal(isInside('/home/alice/.ssh2/id', '/home/alice/.ssh', 'linux'), false);
});

test('validateDirectories rejects protected and read-only enclosed writable dirs', () => {
  const home = '/home/tester';
  const stateHome = '/home/tester/.brain-dispatch';
  const baseArgs = {
    homeDir: home,
    stateHome,
    platform: 'linux',
    cwd: '/home/tester',
  };

  for (const rel of [
    '.claude',
    '.codex',
    '.gemini',
    '.grok',
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.config/gh',
  ]) {
    assert.throws(
      () =>
        validateDirectories({
          ...baseArgs,
          workDir: `/home/tester/${rel}/sub`,
          access: 'write',
        }),
      ValidationError,
      `Expected ${rel} to be write-protected`
    );
  }

  assert.throws(
    () => validateDirectories({ ...baseArgs, workDir: `${stateHome}/jobs`, access: 'write' }),
    ValidationError
  );
  assert.throws(
    () =>
      validateDirectories({
        ...baseArgs,
        workDir: '/tmp/proj/sub',
        configProtect: ['/tmp/proj'],
        access: 'full',
      }),
    ValidationError
  );
  assert.throws(
    () =>
      validateDirectories({
        ...baseArgs,
        workDir: '/tmp/work',
        writeDirs: ['/tmp/extra/sub'],
        cliProtect: ['/tmp/extra'],
        access: 'write',
      }),
    ValidationError
  );
  assert.throws(
    () =>
      validateDirectories({
        ...baseArgs,
        workDir: '/tmp/ro/sub',
        readDirs: ['/tmp/ro'],
        access: 'write',
      }),
    ValidationError
  );

  const readOnlyMode = validateDirectories({
    ...baseArgs,
    workDir: '/home/tester/.ssh',
    access: 'read',
  });
  assert.deepEqual(readOnlyMode.writable, []);
});

test('buildSettings produces expected allow and deny rules for read, write, and full', () => {
  const writeDeny = ['C:/Users/test/.ssh', 'C:/Users/test/ro'];

  const writable = ['C:/Users/test/work', 'C:/Users/test/extra'];

  const readOff = buildSettings({ access: 'read', web: false, writeDeny, writable: [] });
  assert.deepEqual(Object.keys(readOff), ['permissions']);
  assert.deepEqual(readOff.permissions.allow, ['read_file(*)']);
  assert.deepEqual(readOff.permissions.deny, [
    'execute_url(*)',
    'mcp(*)',
    'read_url(*)',
    'write_file(*)',
    'command(*)',
    'unsandboxed(*)',
  ]);

  const writeWeb = buildSettings({ access: 'write', web: true, writeDeny, writable });
  assert.deepEqual(writeWeb.permissions.allow, [
    'read_file(*)',
    'read_url(*)',
    'write_file(C:/Users/test/work)',
    'write_file(C:/Users/test/extra)',
  ]);
  assert.ok(writeWeb.permissions.deny.includes('execute_url(*)'));
  assert.ok(writeWeb.permissions.deny.includes('mcp(*)'));
  assert.ok(!writeWeb.permissions.deny.includes('read_url(*)'));
  assert.ok(writeWeb.permissions.deny.includes('command(*)'));
  assert.ok(writeWeb.permissions.deny.includes('unsandboxed(*)'));
  assert.ok(writeWeb.permissions.deny.includes('write_file(C:/Users/test/.ssh)'));
  assert.ok(writeWeb.permissions.deny.includes('write_file(C:/Users/test/ro)'));

  const fullNoWeb = buildSettings({ access: 'full', web: false, writeDeny, writable });
  assert.deepEqual(fullNoWeb.permissions.allow, [
    'read_file(*)',
    'write_file(C:/Users/test/work)',
    'write_file(C:/Users/test/extra)',
    'command(*)',
    'unsandboxed(*)',
  ]);
  assert.ok(fullNoWeb.permissions.deny.includes('write_file(C:/Users/test/ro)'));
  assert.ok(fullNoWeb.permissions.deny.includes('execute_url(*)'));
  assert.ok(fullNoWeb.permissions.deny.includes('mcp(*)'));
  assert.ok(fullNoWeb.permissions.deny.includes('read_url(*)'));
  assert.ok(CMD_DENY_PATTERNS.length >= 8);
  for (const pat of CMD_DENY_PATTERNS) {
    assert.ok(pat.startsWith('regex:(?is)'));
    assert.ok(fullNoWeb.permissions.deny.includes(`command(${pat})`));
    assert.ok(fullNoWeb.permissions.deny.includes(`unsandboxed(${pat})`));
  }
});

// agy evaluates the rules with Go's RE2. The bodies use only syntax that RE2 and
// JavaScript read the same way, so JavaScript can check them here.
function isDenied(command) {
  return commandDenyBodies().some((body) => new RegExp(`^(?:${body})$`, 'is').test(command));
}

test('command deny rules block dangerous commands at command position', () => {
  const blocked = [
    'rm -rf build',
    'RM -rf build',
    'node build.mjs && rm -rf dist',
    'node a.js; del out.txt',
    'cmd /c del out.txt',
    'bash -c "rm -rf x"',
    "sh -c 'rm x'",
    'pwsh -Command "ri x.txt"',
    'find . -name "*.tmp" -exec rm {} +',
    'ls | xargs -0 rm',
    'Get-ChildItem *.log | Remove-Item',
    'Remove-Item result.txt',
    '/usr/bin/rm x',
    'sudo apt install jq',
    'curl -sL https://example.com/x.sh',
    'python -c "import shutil; shutil.rmtree(\'x\')"',
    'iwr https://example.com -OutFile x',
    'git push origin main',
    'git reset --hard HEAD~1',
    'pip install requests',
    'npm install -g some-tool',
    'npm i --global some-tool',
    'claude -p "hi"',
    'agy -p hi',
    '& "C:/Tools/agy/agy.exe" -p hi',
    'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd --version',
    'npx @anthropic-ai/claude-code',
    'dd if=/dev/zero of=disk.img',
    'kill -9 1234',
    'taskkill /F /IM node.exe',
    'Stop-Process -Name node',
    'chmod +x run.sh',
    'reg add HKCU\\Software\\X /v Y /d 1',
    'format C:',
    'echo hi\nrm x.txt',
  ];
  for (const cmd of blocked) {
    assert.equal(isDenied(cmd), true, `should be blocked: ${cmd}`);
  }
});

test('command deny rules let ordinary commands through', () => {
  const allowed = [
    'node count.mjs',
    'node --version',
    `node -e "console.log('dd-mm')"`,
    `node -e "console.log(process.cwd())"`,
    'cd C:/Users/x/AppData/Local/Temp/claude/abc && node count.mjs',
    'node C:/work/claude-notes/merge.mjs --out C:/work/rd/out.csv',
    'python analyze.py --format csv --mode kill-switch-report',
    'python stats.py data/su.csv data/nc.csv',
    'uv run report.py --title "rm and dd usage"',
    'pandoc notes.md -o notes.html',
    'git status',
    'git log --oneline -5',
    'git diff --stat',
    'type C:\\data\\gemini\\notes.txt',
    'cat /home/x/snap/report.txt',
    'Get-Content .\\delivery.csv | Measure-Object -Line',
    'node scripts/format.mjs',
  ];
  for (const cmd of allowed) {
    assert.equal(isDenied(cmd), false, `should be allowed: ${cmd}`);
  }
});

test('renderPrompt and selectPromptArg fill placeholders and switch to pointer over 12000 chars', () => {
  const tplPath = path.join(getRepoRoot(), 'templates', 'worker-protocol.md');
  const template = fs.readFileSync(tplPath, 'utf8');
  const rendered = renderPrompt({
    template,
    taskText: 'Do the work.',
    workDir: 'C:\\tmp\\work',
    writable: [],
    readDirs: ['C:\\tmp\\ro'],
    access: 'read',
    web: true,
  });

  assert.ok(rendered.includes('`C:/tmp/work`'));
  assert.ok(rendered.includes('  - (none; this job is read-only)'));
  assert.ok(rendered.includes('  - `C:/tmp/ro`'));
  assert.ok(rendered.includes('You cannot run any command.'));
  assert.ok(rendered.includes('You may search the web and read URLs.'));
  assert.ok(rendered.endsWith('Do the work.'));

  const exactLimit = 'x'.repeat(PROMPT_INLINE_LIMIT);
  assert.equal(selectPromptArg(exactLimit, 'C:\\jobs\\prompt.md'), exactLimit);

  const overLimit = 'x'.repeat(PROMPT_INLINE_LIMIT + 1);
  const pointer = selectPromptArg(overLimit, 'C:\\jobs\\prompt.md');
  assert.equal(
    pointer,
    'First read the full brief with your file-read tool at C:/jobs/prompt.md, then follow its protocol and task exactly. If you cannot read it, report blocked.'
  );
});

test('buildBackendArgs asks for stream-json, sets the mode, and adds no workspace dirs', () => {
  const args = buildBackendArgs({
    promptArg: 'hello',
    model: 'gemini-4-hydrogen-high',
    settingsFile: '/tmp/settings.json',
    schemaFile: '/tmp/schema.json',
    timeoutMin: 5,
    access: 'write',
  });
  assert.deepEqual(args, [
    '-p',
    'hello',
    '--model',
    'gemini-4-hydrogen-high',
    '--settings',
    '/tmp/settings.json',
    '--output-format',
    'stream-json',
    '--json-schema',
    '/tmp/schema.json',
    '--print-timeout',
    '300s',
    '--disable-slash-commands',
    '--mode',
    'accept-edits',
  ]);
  // agy sorts --add-dir workspaces and runs commands in the first one, so the
  // dispatcher passes none and the command directory stays the workdir.
  assert.ok(!args.includes('--add-dir'));

  const readArgs = buildBackendArgs({
    promptArg: 'hello',
    model: 'gemini-4-hydrogen-high',
    settingsFile: '/tmp/settings.json',
    schemaFile: '/tmp/schema.json',
    timeoutMin: 5,
    access: 'read',
  });
  assert.ok(!readArgs.includes('--mode'));
});

test('parseBackendOutput reads the event stream: report, cwd, writes, commands, denials', () => {
  const lines = [
    { event: 'init', init: { cwd: 'C:/work', model: 'm', tools: [] } },
    { event: 'step_update', step_update: { state: 'ACTIVE', tool_name: 'write_file', tool_info: { parameters: { Path: 'C:/work/a.txt' } } } },
    { event: 'step_update', step_update: { state: 'DONE', tool_name: 'write_file', tool_info: { parameters: { Path: 'C:/work/a.txt' } } } },
    { event: 'step_update', step_update: { state: 'DONE', tool_name: 'edit_file', tool_info: { parameters: { Path: 'C:/other/b.txt' } } } },
    { event: 'step_update', step_update: { state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { Path: 'C:/data/c.txt' } } } },
    { event: 'step_update', step_update: { state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'node x.mjs' } } } },
    {
      event: 'step_update',
      step_update: {
        state: 'ERROR',
        tool_name: 'write_file',
        tool_info: {
          parameters: { Path: 'C:/ro/d.txt' },
          error: { type: 'TOOL_ERROR', message: 'permission check failed for write_file "C:/ro/d.txt": Permission denied for write_file(C:/ro/d.txt). Matches user-configured deny rule.' },
        },
      },
    },
    { event: 'step_update', step_update: { state: 'DONE', step_type: 'PLANNER_RESPONSE' } },
    {
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'c1',
        usage: { total_tokens: 10 },
        response: '',
        structured_output: { status: 'done', summary: 's', files: [], findings: [], verified: [], unverified: [], open: [] },
      },
    },
  ];
  const parsed = parseBackendOutput(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(parsed.streamed, true);
  assert.equal(parsed.status, 'SUCCESS');
  assert.equal(parsed.rep.status, 'done');
  assert.equal(parsed.repError, null);
  assert.equal(parsed.commandDir, 'C:/work');
  assert.deepEqual(parsed.written, ['C:/work/a.txt', 'C:/other/b.txt']);
  assert.deepEqual(parsed.commands, [{ command: 'node x.mjs', ok: true }]);
  assert.equal(parsed.deniedSteps.length, 1);
  assert.ok(parsed.deniedSteps[0].startsWith('Permission denied for write_file(C:/ro/d.txt)'));

  assert.deepEqual(
    writesOutside({
      written: parsed.written,
      writable: ['C:/work'],
      workDir: 'C:/work',
      platform: 'win32',
    }),
    [path.win32.normalize('C:/other/b.txt')]
  );
  assert.deepEqual(
    writesOutside({ written: ['a.txt', './sub/b.txt'], writable: ['/w'], workDir: '/w', platform: 'linux' }),
    []
  );

  // A stream cut off before the result event has no report.
  const cut = parseBackendOutput(lines.slice(0, 3).map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(cut.streamed, true);
  assert.equal(cut.rawObj, null);
  assert.equal(cut.rep, null);
});

test('takeSnapshot skips .git and node_modules and diffSnapshots detects changes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-snap-'));
  try {
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'v1');
    fs.writeFileSync(path.join(tmp, 'remove.txt'), 'bye');

    const before = takeSnapshot([tmp]);
    assert.equal(before.size, 2);

    fs.writeFileSync(path.join(tmp, '.git', 'index'), 'ignored');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'extra.js'), 'ignored');
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'v2-longer');
    fs.writeFileSync(path.join(tmp, 'added.txt'), 'new');
    fs.rmSync(path.join(tmp, 'remove.txt'));

    const after = takeSnapshot([tmp]);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.created.map((p) => path.basename(p)), ['added.txt']);
    assert.deepEqual(diff.modified.map((p) => path.basename(p)), ['keep.txt']);
    assert.deepEqual(diff.deleted.map((p) => path.basename(p)), ['remove.txt']);

    const roDiff = diffReadOnly(before, after);
    assert.equal(roDiff.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseBackendOutput, reconcileReport, judgeRun, and formatReport handle edge cases', () => {
  const embedded = parseBackendOutput(
    JSON.stringify({
      status: 'SUCCESS',
      usage: { total_tokens: 42 },
      response:
        'Done:\n{"status":"partial","summary":"Half done","files":[{"path":"sub/a.txt","what":"out"}],"findings":["f1"],"verified":["v1"],"unverified":[],"open":["o1"]}',
    })
  );
  assert.equal(embedded.repError, null);
  assert.equal(embedded.rep.status, 'partial');

  const workDir = '/tmp/work';
  const rec = reconcileReport({
    report: embedded.rep,
    created: ['/tmp/work/sub/a.txt', '/tmp/work/extra.txt'],
    modified: [],
    workDir,
    platform: 'linux',
    existsSync: (p) => p === '/tmp/work/sub/a.txt',
  });
  assert.deepEqual(rec.missing, []);
  assert.deepEqual(rec.unreported, ['/tmp/work/extra.txt']);

  const okJudge = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: embedded,
    missing: rec.missing,
    roTouched: [],
  });
  assert.equal(okJudge.exit, 0);

  const formatted = formatReport({
    name: 'demo',
    model: 'gemini-4-hydrogen-high',
    access: 'write',
    secs: 2,
    reason: null,
    parsed: embedded,
    created: ['/tmp/work/sub/a.txt', '/tmp/work/extra.txt'],
    modified: [],
    deleted: [],
    missing: [],
    unreported: rec.unreported,
    roTouched: [],
    claimed: rec.claimed,
    platform: 'linux',
    statSync: () => ({ size: 512 }),
  });
  assert.ok(formatted.reportText.startsWith('WORKER demo | partial | gemini-4-hydrogen-high | write | 2s | tokens 42'));
  assert.ok(formatted.reportText.includes('  + /tmp/work/sub/a.txt  512 B  -- out'));
  assert.ok(formatted.reportText.includes('  ? changed but not reported: /tmp/work/extra.txt'));
  assert.ok(formatted.reportText.includes('Unverified: none'));
});

test('judgeRun treats a run that used up its time limit without a report as a timeout', () => {
  const noReport = parseBackendOutput(
    JSON.stringify({ status: 'SUCCESS', response: 'partial text, cut off by the print timeout' })
  );
  const base = {
    timedOut: false,
    timeoutMin: 20,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: noReport,
  };

  const atLimit = judgeRun({ ...base, elapsedSec: 1199.4 });
  assert.equal(atLimit.exit, 4);
  assert.match(atLimit.reason, /Time limit reached \(20 min\)/);

  const early = judgeRun({ ...base, elapsedSec: 40 });
  assert.equal(early.exit, 3);
  assert.match(early.reason, /No structured report/);

  // A tiny limit must not turn every quick failure into a timeout.
  const tiny = judgeRun({ ...base, timeoutMin: 0.001, elapsedSec: 0.01 });
  assert.equal(tiny.exit, 3);

  // A valid report that arrives right at the limit is still accepted.
  const withReport = parseBackendOutput(
    JSON.stringify({
      status: 'SUCCESS',
      structured_output: {
        status: 'done', summary: 'ok', files: [], findings: [], verified: [], unverified: [], open: [],
      },
    })
  );
  assert.equal(judgeRun({ ...base, parsed: withReport, elapsedSec: 1199.9 }).exit, 0);
});

test('findBackend resolves env, config, PATH, and localappdata in priority order', () => {
  const fromEnv = findBackend(
    mergeConfig({ agy: '/cfg/agy' }),
    { BRAIN_DISPATCH_AGY_CMD: '["node","fake.mjs"]' },
    'linux',
    { isExecutable: () => false }
  );
  assert.deepEqual(fromEnv, { command: 'node', argsPrefix: ['fake.mjs'], source: 'env' });

  const fromCfg = findBackend(
    mergeConfig({ agy: '/cfg/agy' }),
    {},
    'linux',
    { isExecutable: (p) => p === '/cfg/agy' }
  );
  assert.equal(fromCfg.source, 'config');

  const fromLocalAppData = findBackend(
    mergeConfig({}),
    { PATH: '', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    'win32',
    { isExecutable: (p) => p === 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe' }
  );
  assert.equal(fromLocalAppData.source, 'localappdata');
});

test('parseRegistryProxy parses Windows reg query output safely', () => {
  assert.equal(
    parseRegistryProxy(
      [
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    127.0.0.1:7890',
      ].join('\r\n')
    ),
    'http://127.0.0.1:7890'
  );

  assert.equal(
    parseRegistryProxy(
      [
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    ftp=127.0.0.1:21;https=https://localhost:8443;http=127.0.0.1:7890',
      ].join('\n')
    ),
    'https://localhost:8443'
  );

  assert.equal(
    parseRegistryProxy('    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890'),
    null
  );
  assert.equal(
    parseRegistryProxy('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    10.0.0.5:8080'),
    null
  );
  assert.equal(
    parseRegistryProxy('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080'),
    null
  );
  assert.equal(
    parseRegistryProxy('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http://user:pass@127.0.0.1:7890'),
    null
  );
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
});

test('resolveBackendProxy handles config proxy, inherited proxy, and registry probing', async () => {
  assert.equal(
    await resolveBackendProxy({
      configProxy: 'http://127.0.0.1:9000',
      env: { HTTP_PROXY: 'http://127.0.0.1:1111' },
      platform: 'linux',
    }),
    'http://127.0.0.1:9000'
  );

  assert.equal(
    await resolveBackendProxy({
      configProxy: null,
      env: { HTTPS_PROXY: 'http://proxy.corp.example:8080' },
      platform: 'win32',
      queryRegistry: async () => {
        throw new Error('should not query registry');
      },
    }),
    null
  );

  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const resolved = await resolveBackendProxy({
      configProxy: null,
      env: { HTTP_PROXY: 'http://127.0.0.1:1' }, // dead inherited loopback falls through
      platform: 'win32',
      queryRegistry: async () =>
        `    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:${port}`,
    });
    assert.equal(resolved, `http://127.0.0.1:${port}`);

    const applied = applyProxyEnv({ PATH: 'x' }, resolved);
    assert.equal(applied.HTTP_PROXY, `http://127.0.0.1:${port}`);
    assert.equal(applied.HTTPS_PROXY, `http://127.0.0.1:${port}`);
    assert.equal(applied.ALL_PROXY, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('parseWorkerArgs parses optional --context and rejects empty value', () => {
  const cfg = mergeConfig({});
  const withoutCtx = parseWorkerArgs(['--name', 'a', '--task', 't.md', '--workdir', 'w'], cfg);
  assert.equal(withoutCtx.context, null);

  const withCtx = parseWorkerArgs(
    ['--name', 'a', '--task', 't.md', '--workdir', 'w', '--context', 'shared.md'],
    cfg
  );
  assert.equal(withCtx.context, 'shared.md');

  const withEqCtx = parseWorkerArgs(
    ['--name', 'a', '--task', 't.md', '--workdir', 'w', '--context=ctx.md'],
    cfg
  );
  assert.equal(withEqCtx.context, 'ctx.md');

  assert.throws(
    () => parseWorkerArgs(['--name', 'a', '--task', 't.md', '--workdir', 'w', '--context', '   '], cfg),
    ValidationError
  );
});

test('renderPrompt handles shared context with, without, and missing placeholder', () => {
  const tplPath = path.join(getRepoRoot(), 'templates', 'worker-protocol.md');
  const template = fs.readFileSync(tplPath, 'utf8');

  const withContext = renderPrompt({
    template,
    taskText: 'Do task.',
    workDir: 'C:\\work',
    writable: ['C:\\work'],
    readDirs: [],
    access: 'write',
    web: false,
    contextText: '\n  Shared fact 1.\n  Shared fact 2.  \n',
    contextFile: 'C:\\proj\\shared.md',
  });
  assert.ok(!withContext.includes('{{CONTEXT}}'));
  assert.ok(withContext.includes('# Shared context\n\nBackground the brain gives to every job in this piece of work (source: `C:/proj/shared.md`). Treat it as settled. You cannot change this file: if something in it looks wrong or out of date, say so in `open`.\n\nShared fact 1.\n  Shared fact 2.\n\n---'));
  assert.ok(withContext.endsWith('Do task.'));

  const withoutContext = renderPrompt({
    template,
    taskText: 'Do task.',
    workDir: 'C:\\work',
    writable: ['C:\\work'],
    readDirs: [],
    access: 'write',
    web: false,
  });
  assert.ok(!withoutContext.includes('{{CONTEXT}}'));
  assert.ok(!withoutContext.includes('# Shared context'));
  assert.ok(withoutContext.endsWith('Do task.'));

  const legacyTemplate = 'Workdir: {{WORKDIR}}\n---\n# Brief\n';
  const legacyRendered = renderPrompt({
    template: legacyTemplate,
    taskText: 'Legacy task.',
    workDir: '/tmp/w',
    writable: ['/tmp/w'],
    readDirs: [],
    access: 'write',
    web: false,
    contextText: 'Ignored without placeholder',
    contextFile: '/tmp/ctx.md',
  });
  assert.equal(legacyRendered, 'Workdir: /tmp/w\n---\n# Brief\nLegacy task.');
});

test('judgeRun and formatReport handle contextChanged and respect precedence', () => {
  const validParsed = parseBackendOutput(
    JSON.stringify({
      status: 'SUCCESS',
      usage: { total_tokens: 10 },
      structured_output: {
        status: 'done',
        summary: 'done',
        files: [],
        findings: [],
        verified: [],
        unverified: [],
        open: [],
      },
    })
  );

  const ctxModified = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: validParsed,
    contextChanged: true,
    outside: ['/outside/a.txt'],
  });
  assert.equal(ctxModified.exit, 3);
  assert.equal(ctxModified.reason, 'Shared context file was modified during the run');

  const roBeatsCtx = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: validParsed,
    roTouched: ['/ro/file.txt'],
    contextChanged: true,
  });
  assert.equal(roBeatsCtx.exit, 3);
  assert.match(roBeatsCtx.reason, /^Read-only directory modified:/);

  const formatted = formatReport({
    name: 'ctxjob',
    model: 'gemini-4-hydrogen-high',
    access: 'write',
    secs: 1,
    reason: ctxModified.reason,
    parsed: validParsed,
    created: [],
    modified: [],
    deleted: [],
    missing: [],
    unreported: [],
    roTouched: [],
    contextChanged: true,
    contextFile: '/tmp/shared.md',
    claimed: new Map(),
  });
  assert.ok(!formatted.reportText.includes('Files (measured by the dispatcher): no changes'));
  assert.ok(formatted.reportText.includes('  !! shared context modified: /tmp/shared.md'));
  assert.equal(CONTEXT_LIMIT, 8000);
  assert.ok(FALLBACK_HINT.startsWith('Fallback: hand the same brief'));
});

test('computeRoles returns ready, check-model, and unavailable states', () => {
  assert.deepEqual(
    computeRoles({
      backendStatus: 'WARN',
      modelStatus: 'WARN',
      configuredModel: 'gemini-4-hydrogen-high',
    }),
    {
      worker: {
        status: 'unavailable',
        detail: 'not available; backup-worker (Sonnet) takes its jobs',
      },
      next: 'install the Antigravity CLI (see /brain-dispatch:setup), or carry on with the Claude-only roles.',
    }
  );

  assert.deepEqual(
    computeRoles({
      backendStatus: 'FAIL',
      modelStatus: 'WARN',
      configuredModel: 'gemini-4-hydrogen-high',
    }).worker.status,
    'unavailable'
  );

  assert.deepEqual(
    computeRoles({
      backendStatus: 'OK',
      modelStatus: 'WARN',
      configuredModel: 'gemini-4-hydrogen-high',
    }),
    {
      worker: {
        status: 'check-model',
        detail: 'agy found, but gemini-4-hydrogen-high is not in "agy models"',
      },
      next: 'pick a model from "agy models" and set worker.model in the config.',
    }
  );

  assert.deepEqual(
    computeRoles({
      backendStatus: 'OK',
      modelStatus: 'OK',
      configuredModel: 'gemini-4-hydrogen-high',
    }),
    {
      worker: {
        status: 'ready',
        detail: 'ready (gemini-4-hydrogen-high)',
      },
      next: 'run the smoke test in /brain-dispatch:setup to confirm agy is signed in.',
    }
  );
});

test('parseWorkerArgs handles --follow-up, missing --task, and disallowed flags', () => {
  const cfg = mergeConfig({});
  const normal = parseWorkerArgs(['--name', 'a', '--task', 't.md', '--workdir', 'w'], cfg);
  assert.equal(normal.followUp, null);

  const follow = parseWorkerArgs(
    ['--name', 'step2', '--task', 'next.md', '--follow-up', 'prev', '--timeout-min', '7', '--dry-run'],
    cfg
  );
  assert.equal(follow.followUp, 'prev');
  assert.equal(follow.name, 'step2');
  assert.equal(follow.task, 'next.md');
  assert.equal(follow.timeoutMin, 7);
  assert.equal(follow.dryRun, true);
  assert.equal(follow.workdir, null);

  assert.throws(
    () => parseWorkerArgs(['--name', 'step2', '--follow-up', 'prev'], cfg),
    (err) => err instanceof ValidationError && err.message === 'Missing required argument: --task'
  );

  assert.throws(
    () => parseWorkerArgs(['--name', 'step2', '--task', 'next.md', '--follow-up', '   '], cfg),
    ValidationError
  );

  for (const [flag, extra] of [
    ['--workdir', ['--workdir', 'w']],
    ['--access', ['--access', 'full']],
    ['--context', ['--context', 'ctx.md']],
    ['--write-dir', ['--write-dir', 'out']],
    ['--read-dir', ['--read-dir', 'ro']],
    ['--protect', ['--protect', 'prot']],
    ['--web', ['--web']],
    ['--model', ['--model', 'custom']],
    ['--effort', ['--effort', 'low']],
  ]) {
    assert.throws(
      () =>
        parseWorkerArgs(
          ['--name', 'step2', '--task', 'next.md', '--follow-up', 'prev', ...extra],
          cfg
        ),
      (err) =>
        err instanceof ValidationError &&
        err.message ===
          `--follow-up takes its directories, access level, model and context file from the earlier job; remove ${flag}`
    );
  }

  // Flag appearing before --follow-up is still reported as the first offending flag.
  assert.throws(
    () =>
      parseWorkerArgs(
        ['--name', 'step2', '--workdir', 'w', '--task', 'next.md', '--follow-up=prev', '--access=read'],
        cfg
      ),
    (err) =>
      err instanceof ValidationError &&
      err.message.endsWith('remove --workdir')
  );
});

test('buildBackendArgs includes --conversation only when conversationId is given', () => {
  const withoutConv = buildBackendArgs({
    promptArg: 'hello',
    model: 'gemini-4-hydrogen-high',
    settingsFile: '/tmp/settings.json',
    schemaFile: '/tmp/schema.json',
    timeoutMin: 5,
    access: 'write',
  });
  assert.ok(!withoutConv.includes('--conversation'));

  const withConv = buildBackendArgs({
    promptArg: 'hello',
    model: 'gemini-4-hydrogen-high',
    settingsFile: '/tmp/settings.json',
    schemaFile: '/tmp/schema.json',
    timeoutMin: 5,
    access: 'write',
    conversationId: 'conv-abc',
  });
  const convIdx = withConv.indexOf('--conversation');
  assert.ok(convIdx >= 0);
  assert.equal(withConv[convIdx + 1], 'conv-abc');
});

test('judgeRun rejects mismatched conversationId in follow-up mode and ignores matching id', () => {
  const mkParsed = (extra = {}) =>
    parseBackendOutput(
      JSON.stringify({
        status: 'SUCCESS',
        conversation_id: 'conv-1',
        structured_output: {
          status: 'done',
          summary: 'ok',
          files: [],
          findings: [],
          verified: [],
          unverified: [],
          open: [],
        },
        ...extra,
      })
    );

  const match = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: mkParsed({ conversation_id: 'conv-1' }),
    expectedConversationId: 'conv-1',
  });
  assert.equal(match.exit, 0);

  const mismatch = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: mkParsed({ conversation_id: 'conv-new' }),
    expectedConversationId: 'conv-1',
  });
  assert.equal(mismatch.exit, 3);
  assert.equal(
    mismatch.reason,
    'Follow-up did not resume the earlier conversation (the backend started a new one, without the protocol); dispatch a fresh job'
  );

  const missingId = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 0,
    stderr: '',
    stdout: '',
    parsed: mkParsed({ conversation_id: null }),
    expectedConversationId: 'conv-1',
  });
  assert.equal(missingId.exit, 3);
  assert.equal(missingId.reason, mismatch.reason);

  // Precedence: after rawObj check, before denied check.
  const noJson = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 1,
    stderr: 'crash',
    stdout: '',
    parsed: parseBackendOutput('not json'),
    expectedConversationId: 'conv-1',
  });
  assert.equal(noJson.exit, 3);
  assert.match(noJson.reason, /^Backend did not return JSON/);

  const deniedWrongConv = judgeRun({
    timedOut: false,
    timeoutMin: 5,
    code: 1,
    stderr: '',
    stdout: '',
    parsed: parseBackendOutput(
      JSON.stringify({
        status: 'DENIED',
        conversation_id: 'conv-other',
        denied_actions: [{ action: 'write_file(/x)' }],
      })
    ),
    expectedConversationId: 'conv-1',
  });
  assert.equal(deniedWrongConv.exit, 3);
  assert.equal(deniedWrongConv.reason, mismatch.reason);
});

test('resolveFollowUp resolves by directory and latest job name, and validates meta.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-followup-'));
  try {
    const stateHome = path.join(tmp, 'state');
    const jobsDir = path.join(stateHome, 'jobs');
    const olderDir = path.join(jobsDir, '20261115-090000_alpha');
    const newerDir = path.join(jobsDir, '20261115-100000_alpha');
    const minimalDir = path.join(jobsDir, '20261115-110000_minimal');
    const badJsonDir = path.join(jobsDir, '20261115-120000_badjson');
    const noConvDir = path.join(jobsDir, '20261115-130000_noconv');
    const badAccessDir = path.join(jobsDir, '20261115-140000_badacc');

    for (const d of [olderDir, newerDir, minimalDir, badJsonDir, noConvDir, badAccessDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    fs.writeFileSync(
      path.join(olderDir, 'meta.json'),
      JSON.stringify({
        conversation_id: 'conv-old',
        work_dir: path.join(tmp, 'w-old'),
        access: 'read',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(newerDir, 'meta.json'),
      JSON.stringify({
        conversation_id: 'conv-new',
        work_dir: path.join(tmp, 'w-new'),
        write_dir: [path.join(tmp, 'extra')],
        read_dir: [path.join(tmp, 'ro')],
        protect: [path.join(tmp, 'prot')],
        access: 'full',
        web: 1,
        model: 'gemini-4-hydrogen-high',
        context_file: path.join(tmp, 'ctx.md'),
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(minimalDir, 'meta.json'),
      JSON.stringify({
        conversation_id: 'conv-min',
        work_dir: path.join(tmp, 'w-min'),
        access: 'write',
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(badJsonDir, 'meta.json'), '{not-valid-json', 'utf8');
    fs.writeFileSync(
      path.join(noConvDir, 'meta.json'),
      JSON.stringify({ conversation_id: '', work_dir: path.join(tmp, 'w'), access: 'write' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(badAccessDir, 'meta.json'),
      JSON.stringify({ conversation_id: 'conv-x', work_dir: path.join(tmp, 'w'), access: 'admin' }),
      'utf8'
    );

    // A later job whose name only ends with the same word is a different job.
    const otherDir = path.join(jobsDir, '20261115-150000_pre_alpha');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, 'meta.json'),
      JSON.stringify({ conversation_id: 'conv-other', work_dir: tmp, access: 'write' }),
      'utf8'
    );
    assert.equal(
      resolveFollowUp({ ref: 'pre_alpha', stateHome, platform: process.platform }).conversationId,
      'conv-other'
    );

    const byName = resolveFollowUp({ ref: 'alpha', stateHome, platform: process.platform });
    assert.equal(byName.jobDir, path.normalize(newerDir));
    assert.equal(byName.conversationId, 'conv-new');
    assert.equal(byName.workDir, path.join(tmp, 'w-new'));
    assert.deepEqual(byName.writeDirs, [path.join(tmp, 'extra')]);
    assert.deepEqual(byName.readDirs, [path.join(tmp, 'ro')]);
    assert.deepEqual(byName.protect, [path.join(tmp, 'prot')]);
    assert.equal(byName.access, 'full');
    assert.equal(byName.web, true);
    assert.equal(byName.model, 'gemini-4-hydrogen-high');
    assert.equal(byName.contextFile, path.join(tmp, 'ctx.md'));

    const byDir = resolveFollowUp({ ref: olderDir, stateHome, platform: process.platform });
    assert.equal(byDir.jobDir, path.normalize(olderDir));
    assert.equal(byDir.conversationId, 'conv-old');

    const minRes = resolveFollowUp({ ref: 'minimal', stateHome, platform: process.platform });
    assert.deepEqual(minRes.writeDirs, []);
    assert.deepEqual(minRes.readDirs, []);
    assert.deepEqual(minRes.protect, []);
    assert.equal(minRes.web, false);
    assert.equal(minRes.contextFile, null);

    assert.throws(
      () => resolveFollowUp({ ref: 'unknown-job', stateHome, platform: process.platform }),
      (err) =>
        err instanceof ValidationError &&
        err.message ===
          `No earlier job found for "unknown-job" (looked for a job directory, then for a job of that name under ${path.normalize(jobsDir)})`
    );

    for (const ref of ['badjson', 'noconv', 'badacc']) {
      assert.throws(
        () => resolveFollowUp({ ref, stateHome, platform: process.platform }),
        (err) =>
          err instanceof ValidationError &&
          err.message === `Job "${ref}" has no conversation to continue; dispatch a fresh job instead`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
