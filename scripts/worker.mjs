#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BackendUnavailableError,
  DEFAULT_KILL_GRACE_SEC,
  ValidationError,
  buildBackendArgs,
  buildSettings,
  diffReadOnly,
  diffSnapshots,
  expandHome,
  findBackend,
  formatJobStamp,
  formatLocalIso,
  formatReport,
  formatShortOutput,
  getRepoRoot,
  getStateHome,
  judgeRun,
  loadConfig,
  normalizePath,
  parseBackendOutput,
  parseWorkerArgs,
  reconcileReport,
  renderPrompt,
  selectPromptArg,
  stripBom,
  takeSnapshot,
  uniquePaths,
  validateDirectories,
  writesOutside,
} from './lib/core.mjs';
import { applyProxyEnv, resolveBackendProxy } from './lib/proxy.mjs';

const USAGE = `Usage: node scripts/worker.mjs --name <name> --task <task.md> --workdir <dir> [options]

Options:
  --name <name>                  Job name (letters, digits, '_', '-') [required]
  --task <file>                  Path to task brief markdown file [required]
  --workdir <dir>                Working directory (created if missing) [required]
  --read-dir <dir>               Read-only directory (repeatable or comma-separated)
  --write-dir <dir>              Extra writable directory (repeatable or comma-separated)
  --protect <dir>                Extra write-protected directory (repeatable or comma-separated)
  --access read|write|full       Permission tier (default: write)
  --effort low|medium|high|xhigh Effort suffix for default model (default: from config)
  --model <model>                Full model ID override
  --web                          Allow web search and read_url
  --timeout-min <minutes>        Timeout in minutes (default: from config)
  --dry-run                      Print resolved settings/args without creating workdir or calling backend
  --help, -h                     Show this help message
`;

function killProcessTree(child, platform) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already exited
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore already exited
    }
  }
}

function runBackend({ command, args, cwd, env, timeoutMs, platform }) {
  return new Promise((resolve, reject) => {
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let settled = false;
    let closeGraceTimer = null;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    });

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(closeGraceTimer);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, platform);
      closeGraceTimer = setTimeout(() => finish(124), 3000);
      closeGraceTimer.unref();
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(closeGraceTimer);
      reject(err);
    });

    child.on('close', (code) => finish(code));
  });
}

async function main() {
  const platform = process.platform;
  const homeDir = os.homedir();
  const repoRoot = getRepoRoot();
  const stateHome = getStateHome(process.env, homeDir, platform);
  const loaded = loadConfig(stateHome);
  const opts = parseWorkerArgs(process.argv.slice(2), loaded.config);

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const taskFile = normalizePath(expandHome(opts.task, homeDir), platform);
  let taskStat;
  try {
    taskStat = fs.statSync(taskFile);
  } catch {
    throw new ValidationError(`Task file not found: ${taskFile}`);
  }
  if (!taskStat.isFile()) {
    throw new ValidationError(`Task path is not a file: ${taskFile}`);
  }

  const expandedReadDirs = opts.readDirs.map((d) => normalizePath(expandHome(d, homeDir), platform));
  for (const r of expandedReadDirs) {
    let st;
    try {
      st = fs.statSync(r);
    } catch {
      throw new ValidationError(`Read-only directory not found: ${r}`);
    }
    if (!st.isDirectory()) {
      throw new ValidationError(`Read-only path is not a directory: ${r}`);
    }
  }

  const dirs = validateDirectories({
    workDir: opts.workdir,
    writeDirs: opts.writeDirs,
    readDirs: expandedReadDirs,
    configProtect: loaded.config.protect,
    cliProtect: opts.protect,
    access: opts.access,
    homeDir,
    stateHome,
    platform,
  });

  const templatePath = path.join(repoRoot, 'templates', 'worker-protocol.md');
  const schemaFile = path.join(repoRoot, 'schemas', 'report.schema.json');
  if (!fs.existsSync(templatePath)) {
    throw new ValidationError(`Protocol template not found: ${templatePath}`);
  }
  if (!fs.existsSync(schemaFile)) {
    throw new ValidationError(`Report schema not found: ${schemaFile}`);
  }

  let backend = null;
  if (!opts.dryRun) {
    backend = findBackend(loaded.config, process.env, platform);
  }

  if (!opts.dryRun) {
    for (const d of uniquePaths([dirs.workDir, ...dirs.writeDirs], platform)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  const settings = buildSettings({
    access: opts.access,
    web: opts.web,
    writeDeny: dirs.writeDeny,
    writable: dirs.writable,
  });

  const stamp = formatJobStamp();
  const jobDir = path.join(stateHome, 'jobs', `${stamp}_${opts.name}`);
  fs.mkdirSync(jobDir, { recursive: true });

  const settingsFile = path.join(jobDir, 'settings.json');
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const template = stripBom(fs.readFileSync(templatePath, 'utf8'));
  const taskText = stripBom(fs.readFileSync(taskFile, 'utf8'));
  const prompt = renderPrompt({
    template,
    taskText,
    workDir: dirs.workDir,
    writable: dirs.writable,
    readDirs: dirs.readDirs,
    access: opts.access,
    web: opts.web,
  });

  const promptFile = path.join(jobDir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const promptArg = selectPromptArg(prompt, promptFile);
  const argv = buildBackendArgs({
    promptArg,
    model: opts.resolvedModel,
    settingsFile,
    schemaFile,
    timeoutMin: opts.timeoutMin,
    access: opts.access,
  });

  if (opts.dryRun) {
    const out = [
      `DRYRUN ${opts.name} | ${opts.resolvedModel} | ${opts.access}`,
      `Job dir: ${jobDir}`,
      'Settings:',
      JSON.stringify(settings, null, 2),
      `Args: ${argv.slice(2).join(' ')}`,
      `Prompt: ${prompt.length} chars (${promptFile})`,
    ].join('\n');
    process.stdout.write(`${out}\n`);
    process.exit(0);
  }

  const watchRW = uniquePaths([dirs.workDir, ...dirs.writeDirs], platform);
  const watchRO = opts.access === 'full' ? dirs.readDirs : [];
  const beforeRW = takeSnapshot(watchRW, platform);
  const beforeRO = takeSnapshot(watchRO, platform);

  const proxyUrl = await resolveBackendProxy({
    configProxy: loaded.config.proxy,
    env: process.env,
    platform,
  });
  const childEnv = applyProxyEnv(process.env, proxyUrl);

  const graceRaw = process.env.BRAIN_DISPATCH_KILL_GRACE_SEC;
  const graceParsed =
    graceRaw != null && graceRaw.trim() !== '' ? Number(graceRaw) : DEFAULT_KILL_GRACE_SEC;
  const graceSec =
    Number.isFinite(graceParsed) && graceParsed >= 0 ? graceParsed : DEFAULT_KILL_GRACE_SEC;
  const timeoutMs = Math.max(1, Math.round((opts.timeoutMin * 60 + graceSec) * 1000));

  const startMs = Date.now();
  let runResult;
  try {
    runResult = await runBackend({
      command: backend.command,
      args: [...backend.argsPrefix, ...argv],
      cwd: dirs.workDir,
      env: childEnv,
      timeoutMs,
      platform,
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new BackendUnavailableError(
        `Failed to start backend "${backend.command}": executable not found`
      );
    }
    throw err;
  }

  const elapsedSec = (Date.now() - startMs) / 1000;
  const secs = Math.floor(elapsedSec);
  fs.writeFileSync(path.join(jobDir, 'events.jsonl'), runResult.stdout, 'utf8');
  fs.writeFileSync(path.join(jobDir, 'err.log'), runResult.stderr, 'utf8');

  const afterRW = takeSnapshot(watchRW, platform);
  const afterRO = takeSnapshot(watchRO, platform);
  const { created, modified, deleted } = diffSnapshots(beforeRW, afterRW);
  const roTouched = diffReadOnly(beforeRO, afterRO);

  const parsed = parseBackendOutput(runResult.stdout);
  const validRep = parsed.rep && !parsed.repError ? parsed.rep : null;
  const { claimed, missing, unreported } = reconcileReport({
    report: validRep,
    created,
    modified,
    workDir: dirs.workDir,
    platform,
  });
  const outside = writesOutside({
    written: parsed.written,
    writable: dirs.writable,
    workDir: dirs.workDir,
    platform,
  });

  const { exit, reason } = judgeRun({
    timedOut: runResult.timedOut,
    timeoutMin: opts.timeoutMin,
    code: runResult.code,
    stderr: runResult.stderr,
    stdout: runResult.stdout,
    parsed,
    missing,
    roTouched,
    outside,
    elapsedSec,
  });

  const { lines, reportText } = formatReport({
    name: opts.name,
    model: opts.resolvedModel,
    access: opts.access,
    secs,
    reason,
    parsed,
    created,
    modified,
    deleted,
    missing,
    unreported,
    roTouched,
    outside,
    claimed,
    platform,
  });

  const reportMdPath = path.join(jobDir, 'report.md');
  fs.writeFileSync(reportMdPath, reportText, 'utf8');
  if (validRep) {
    fs.writeFileSync(
      path.join(jobDir, 'report.json'),
      `${JSON.stringify(validRep, null, 2)}\n`,
      'utf8'
    );
  }

  const meta = {
    name: opts.name,
    agent: 'worker',
    backend: 'agy',
    model: opts.resolvedModel,
    access: opts.access,
    web: Boolean(opts.web),
    ok: !reason,
    reason,
    exit,
    seconds: secs,
    agy_status: parsed.status,
    denied: parsed.denied,
    report_status: validRep ? String(validRep.status) : null,
    work_dir: dirs.workDir,
    write_dir: dirs.writeDirs,
    read_dir: dirs.readDirs,
    task_file: taskFile,
    created,
    modified,
    deleted,
    missing,
    unreported,
    readonly_touched: roTouched,
    written_outside: outside,
    written_by_tools: parsed.written,
    denied_steps: parsed.deniedSteps,
    commands: parsed.commands,
    command_dir: parsed.commandDir,
    conversation_id: parsed.conversationId,
    usage: parsed.usage,
  };
  fs.writeFileSync(path.join(jobDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  const ledgerEntry = {
    time: formatLocalIso(),
    name: opts.name,
    agent: 'worker',
    tried: ['worker'],
    model: opts.resolvedModel,
    mode: opts.access,
    ok: !reason,
    seconds: secs,
    attempts: 1,
    failures: reason ? [{ agent: 'worker', reason }] : [],
    usage: parsed.usage,
    dir: jobDir,
  };
  fs.mkdirSync(stateHome, { recursive: true });
  fs.appendFileSync(
    path.join(stateHome, 'ledger.jsonl'),
    `${JSON.stringify(ledgerEntry)}\n`,
    'utf8'
  );

  process.stdout.write(formatShortOutput(lines, reportMdPath));
  process.exit(exit);
}

main().catch((err) => {
  if (err instanceof ValidationError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof BackendUnavailableError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(5);
  }
  process.stderr.write(`Error: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
