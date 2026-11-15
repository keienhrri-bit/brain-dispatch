#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BackendUnavailableError,
  DEFAULT_CONFIG,
  computeRoles,
  findBackend,
  getStateHome,
  limitText,
  loadConfig,
  mergeConfig,
} from './lib/core.mjs';
import { applyProxyEnv, resolveBackendProxy } from './lib/proxy.mjs';

const USAGE = `Usage: node scripts/doctor.mjs [--init] [--json] [--help]

Options:
  --init   Create default config.json in state home if missing
  --json   Output machine-readable JSON report
  --help   Show this help message
`;

function parseDoctorArgs(argv) {
  let init = false;
  let json = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--init') {
      init = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { init, json, help };
}

function runCommand(command, args, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => outChunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));

    const finish = (code, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(errChunks).toString('utf8') || extraErr;
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
      finish(124, `Timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on('error', (err) => finish(1, err.message));
    child.on('close', (code) => finish(code));
  });
}

async function main() {
  let opts;
  try {
    opts = parseDoctorArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const platform = process.platform;
  const homeDir = os.homedir();
  const stateHome = getStateHome(process.env, homeDir, platform);
  const configPath = path.join(stateHome, 'config.json');
  const checks = [];

  // 1. Node version >= 18
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    checks.push({
      name: 'node',
      status: 'OK',
      detail: `Node v${process.versions.node} (>= 18)`,
    });
  } else {
    checks.push({
      name: 'node',
      status: 'FAIL',
      detail: `Node v${process.versions.node} found; requires >= 18`,
    });
  }

  // 2. Config presence and --init
  let config = mergeConfig({});
  if (!fs.existsSync(configPath)) {
    if (opts.init) {
      fs.mkdirSync(stateHome, { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
      checks.push({
        name: 'config',
        status: 'OK',
        detail: `Initialized default config at ${configPath}`,
      });
    } else {
      checks.push({
        name: 'config',
        status: 'WARN',
        detail: `Config not found at ${configPath}; using defaults (pass --init to create)`,
      });
    }
  } else {
    try {
      const loaded = loadConfig(stateHome);
      config = loaded.config;
      checks.push({
        name: 'config',
        status: 'OK',
        detail: `Loaded config from ${configPath}`,
      });
    } catch (err) {
      checks.push({
        name: 'config',
        status: 'FAIL',
        detail: err.message,
      });
    }
  }

  // 3. Backend lookup and --version
  let backend = null;
  let childEnv = process.env;
  let backendCheck;
  try {
    backend = findBackend(config, process.env, platform);
    const proxyUrl = await resolveBackendProxy({
      configProxy: config.proxy,
      env: process.env,
      platform,
    });
    childEnv = applyProxyEnv(process.env, proxyUrl);

    const ver = await runCommand(
      backend.command,
      [...backend.argsPrefix, '--version'],
      childEnv
    );
    if (ver.code === 0) {
      const firstLine =
        ver.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean) || 'ok';
      backendCheck = {
        name: 'backend',
        status: 'OK',
        detail: `${backend.command} (${firstLine})`,
      };
    } else {
      const cmdLabel = backend.command;
      backend = null;
      backendCheck = {
        name: 'backend',
        status: 'FAIL',
        detail: `${cmdLabel} --version exited ${ver.code}: ${limitText(ver.stderr || ver.stdout, 120)}`,
      };
    }
  } catch (err) {
    backend = null;
    backendCheck = {
      name: 'backend',
      status: err instanceof BackendUnavailableError ? 'WARN' : 'FAIL',
      detail: err.message,
    };
  }
  checks.push(backendCheck);

  // 4. Configured model in backend models output
  const configuredModel = `${config.worker.model}-${config.worker.effort}`;
  let modelCheck;
  if (!backend) {
    modelCheck = {
      name: 'model',
      status: 'WARN',
      detail: `Skipped model check for ${configuredModel} (backend unavailable)`,
    };
  } else {
    const modelsRes = await runCommand(
      backend.command,
      [...backend.argsPrefix, 'models'],
      childEnv
    );
    if (modelsRes.code !== 0) {
      modelCheck = {
        name: 'model',
        status: 'WARN',
        detail: `Backend 'models' exited ${modelsRes.code}; could not verify ${configuredModel}`,
      };
    } else if (modelsRes.stdout.includes(configuredModel)) {
      modelCheck = {
        name: 'model',
        status: 'OK',
        detail: `Model ${configuredModel} found in backend models output`,
      };
    } else {
      modelCheck = {
        name: 'model',
        status: 'WARN',
        detail: `Configured model "${configuredModel}" not found in backend models output`,
      };
    }
  }
  checks.push(modelCheck);

  const hasFail = checks.some((c) => c.status === 'FAIL');
  const exitCode = hasFail ? 1 : 0;
  const roleSummary = computeRoles({
    backendStatus: backendCheck.status,
    modelStatus: modelCheck.status,
    configuredModel,
  });

  if (opts.json) {
    const payload = {
      ok: !hasFail,
      stateHome,
      configPath,
      configuredModel,
      checks,
      roles: {
        worker: roleSummary.worker,
      },
      next: roleSummary.next,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const check of checks) {
      process.stdout.write(`${check.status.padEnd(5)} ${check.name}: ${check.detail}\n`);
    }
    const roleRows = [
      ['brain', 'main session (the model you chose with /model)'],
      ['worker', `Gemini on agy: ${roleSummary.worker.detail}`],
      ['backup-worker', 'Sonnet subagent, always available'],
      ['writer', 'Sonnet subagent, always available'],
      ['finder', 'Haiku subagent, always available'],
    ];
    process.stdout.write('\nRoles on this machine:\n');
    for (const [role, desc] of roleRows) {
      process.stdout.write(`  ${role.padEnd(14)} ${desc}\n`);
    }
    process.stdout.write(`Next: ${roleSummary.next}\n`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
