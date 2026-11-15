import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { getRepoRoot } from '../scripts/lib/core.mjs';
import { USAGE_NOTE, formatStats, loadStats, parseStatsArgs } from '../scripts/lib/stats.mjs';

const execFileAsync = promisify(execFile);

const REPO_ROOT = getRepoRoot();
const STATS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'stats.mjs');
const REQUIRED_CAVEAT =
  'backend-reported tokens, not price or subscription quota; conversation usage may be cumulative and must not be interpreted as billed per-call tokens';

async function runStats(args, env = process.env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [STATS_SCRIPT, ...args], {
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

function withTempState(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-stats-'));
  const stateHome = path.join(root, 'state');
  return Promise.resolve()
    .then(() => fn({ root, stateHome }))
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
}

function writeJobMeta(stateHome, dirName, metaOrRaw) {
  const jobDir = path.join(stateHome, 'jobs', dirName);
  fs.mkdirSync(jobDir, { recursive: true });
  const content =
    typeof metaOrRaw === 'string' ? metaOrRaw : `${JSON.stringify(metaOrRaw, null, 2)}\n`;
  fs.writeFileSync(path.join(jobDir, 'meta.json'), content, 'utf8');
  return jobDir;
}

test('loadStats returns empty report for missing jobs dir without creating stateHome', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const missingHome = path.join(root, 'never-created');
    const stats = loadStats({ stateHome: missingHome });

    assert.equal(fs.existsSync(missingHome), false);
    assert.deepEqual(stats, {
      jobs: 0,
      accepted: 0,
      rejected: 0,
      partial: 0,
      followUps: 0,
      seconds: 0,
      reportedTokens: 0,
      jobsWithUsage: 0,
      jobsWithoutUsage: 0,
      byModel: [],
      warnings: [],
      note: USAGE_NOTE,
    });
    assert.ok(stats.note.includes(REQUIRED_CAVEAT));
    assert.match(stats.note, /captured jobs only, not main-brain tokens/i);

    fs.mkdirSync(stateHome, { recursive: true });
    const noJobsStats = loadStats({ stateHome });
    assert.equal(fs.existsSync(path.join(stateHome, 'jobs')), false);
    assert.equal(noJobsStats.jobs, 0);
    assert.deepEqual(noJobsStats.warnings, []);
  });
});

test('loadStats aggregates mixed accepted, failed, partial, follow-up, zero-usage, and unknown-usage jobs', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const workA = path.join(root, 'repo-a');

    // 1. Accepted job with reported tokens
    writeJobMeta(stateHome, '20261115-100000_alpha', {
      name: 'alpha',
      model: 'model-z',
      work_dir: workA,
      ok: true,
      report_status: 'done',
      follow_up_of: null,
      seconds: 12,
      usage: { total_tokens: 1500 },
    });

    // 2. Failed job with reported tokens (must be included) and partial report_status
    writeJobMeta(stateHome, '20261115-100100_beta', {
      name: 'beta',
      model: 'model-a',
      work_dir: workA,
      ok: false,
      report_status: 'partial',
      follow_up_of: '20261115-100000_alpha',
      seconds: 8,
      usage: { total_tokens: 400 },
    });

    // 3. Accepted partial job with explicit zero usage (known zero, not unknown)
    writeJobMeta(stateHome, '20261115-100200_gamma', {
      name: 'gamma',
      model: 'model-a',
      work_dir: workA,
      ok: true,
      report_status: 'partial',
      follow_up_of: '   ',
      seconds: 0,
      usage: { total_tokens: 0 },
    });

    // 4. Old-format job missing optional fields (unknown usage)
    writeJobMeta(stateHome, '20261115-100300_old', {
      name: 'old',
      model: 'model-m',
      work_dir: workA,
      ok: true,
    });

    // 5. Job with malformed usage (string token count must not be coerced, negative seconds ignored)
    writeJobMeta(stateHome, '20261115-100400_badusage', {
      name: 'badusage',
      model: 'model-z',
      work_dir: workA,
      ok: false,
      seconds: -5,
      usage: { total_tokens: '999' },
    });

    // 6. Job with BOM and huge/broken sibling files that stats must not read
    const bomDir = writeJobMeta(
      stateHome,
      '20261115-100500_bom',
      `\uFEFF${JSON.stringify({
        name: 'bom',
        model: 'model-a',
        work_dir: workA,
        ok: true,
        follow_up_of: '20261115-100200_gamma',
        seconds: 5,
        usage: { total_tokens: -1 },
      })}`
    );
    fs.mkdirSync(path.join(bomDir, 'events.jsonl'));
    fs.writeFileSync(path.join(bomDir, 'prompt.md'), 'not-json{{{', 'utf8');

    const stats = loadStats({ stateHome });
    assert.equal(stats.jobs, 6);
    assert.equal(stats.accepted, 4);
    assert.equal(stats.rejected, 2);
    assert.equal(stats.partial, 2);
    assert.equal(stats.followUps, 2);
    assert.equal(stats.seconds, 25);
    assert.equal(stats.reportedTokens, 1900);
    assert.equal(stats.jobsWithUsage, 3);
    assert.equal(stats.jobsWithoutUsage, 3);
    assert.deepEqual(stats.warnings, []);
    assert.deepEqual(stats.byModel, [
      {
        model: 'model-a',
        jobs: 3,
        reportedTokens: 400,
        jobsWithUsage: 2,
        jobsWithoutUsage: 1,
      },
      {
        model: 'model-m',
        jobs: 1,
        reportedTokens: 0,
        jobsWithUsage: 0,
        jobsWithoutUsage: 1,
      },
      {
        model: 'model-z',
        jobs: 2,
        reportedTokens: 1500,
        jobsWithUsage: 1,
        jobsWithoutUsage: 1,
      },
    ]);
  });
});

test('loadStats skips invalid/corrupt metadata with warnings and skips missing meta.json quietly', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const work = path.join(root, 'work');

    writeJobMeta(stateHome, '20261115-110000_good', {
      name: 'good',
      model: 'gemini-4-hydrogen-high',
      work_dir: work,
      ok: true,
      seconds: 3,
      usage: { total_tokens: 100 },
    });

    // Corrupt JSON
    writeJobMeta(stateHome, '20261115-110100_corrupt', '{not valid json');
    // JSON array instead of object
    writeJobMeta(stateHome, '20261115-110200_array', '[1, 2, 3]');
    // Missing boolean ok
    writeJobMeta(stateHome, '20261115-110300_badok', {
      name: 'badok',
      model: 'gemini-4-hydrogen-high',
      work_dir: work,
      ok: 'true',
    });
    // Empty name
    writeJobMeta(stateHome, '20261115-110400_badname', {
      name: '   ',
      model: 'gemini-4-hydrogen-high',
      work_dir: work,
      ok: true,
    });

    // Dry-run / incomplete job dir without meta.json (ENOENT) -> skipped without warning
    fs.mkdirSync(path.join(stateHome, 'jobs', '20261115-110500_dryrun'), { recursive: true });
    // Stray file in jobs dir -> skipped without warning
    fs.writeFileSync(path.join(stateHome, 'jobs', 'README.txt'), 'note\n', 'utf8');

    const stats = loadStats({ stateHome });
    assert.equal(stats.jobs, 1);
    assert.equal(stats.reportedTokens, 100);
    assert.equal(stats.warnings.length, 4);
    assert.ok(stats.warnings.some((w) => w.includes('20261115-110100_corrupt') && w.includes('Invalid JSON')));
    assert.ok(stats.warnings.some((w) => w.includes('20261115-110200_array') && w.includes('JSON object')));
    assert.ok(stats.warnings.some((w) => w.includes('20261115-110300_badok') && w.includes('"ok"')));
    assert.ok(stats.warnings.some((w) => w.includes('20261115-110400_badname') && w.includes('"name"')));
  });
});

test('loadStats handles ENOENT and permission/read failures distinctly', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const work = path.join(root, 'work');
    writeJobMeta(stateHome, '20261115-120000_ok', {
      name: 'ok',
      model: 'm1',
      work_dir: work,
      ok: true,
      usage: { total_tokens: 50 },
    });

    // meta.json as a directory triggers non-file / EISDIR warning on all platforms
    fs.mkdirSync(path.join(stateHome, 'jobs', '20261115-120100_dirmeta', 'meta.json'), {
      recursive: true,
    });

    // Simulated EACCES on a specific meta.json vs ENOENT on another
    fs.mkdirSync(path.join(stateHome, 'jobs', '20261115-120200_eacces'), { recursive: true });
    fs.writeFileSync(path.join(stateHome, 'jobs', '20261115-120200_eacces', 'meta.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(stateHome, 'jobs', '20261115-120300_enoent'), { recursive: true });

    const stats = loadStats({
      stateHome,
      fsOps: {
        readFileSync(p, enc) {
          if (p.includes('20261115-120200_eacces')) {
            const err = new Error('permission denied');
            err.code = 'EACCES';
            throw err;
          }
          return fs.readFileSync(p, enc);
        },
      },
    });

    assert.equal(stats.jobs, 1);
    assert.equal(stats.reportedTokens, 50);
    assert.equal(stats.warnings.length, 2);
    assert.ok(stats.warnings.some((w) => w.includes('20261115-120100_dirmeta')));
    assert.ok(stats.warnings.some((w) => w.includes('20261115-120200_eacces') && w.includes('EACCES')));
    assert.equal(
      stats.warnings.some((w) => w.includes('20261115-120300_enoent')),
      false
    );

    // EACCES on jobs directory itself produces a warning (distinct from missing jobs dir)
    const jobsEaccesStats = loadStats({
      stateHome,
      fsOps: {
        readdirSync() {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        },
      },
    });
    assert.equal(jobsEaccesStats.jobs, 0);
    assert.equal(jobsEaccesStats.warnings.length, 1);
    assert.match(jobsEaccesStats.warnings[0], /EACCES/);
  });
});

test('loadStats does not follow symlink job directories or meta files', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const outsideDir = path.join(root, 'outside-job');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideMeta = path.join(outsideDir, 'meta.json');
    fs.writeFileSync(
      outsideMeta,
      JSON.stringify({
        name: 'secret',
        model: 'm1',
        work_dir: root,
        ok: true,
        usage: { total_tokens: 9999 },
      }),
      'utf8'
    );

    fs.mkdirSync(path.join(stateHome, 'jobs'), { recursive: true });
    const symlinkJobDir = path.join(stateHome, 'jobs', '20261115-130000_linkdir');
    fs.symlinkSync(outsideDir, symlinkJobDir, process.platform === 'win32' ? 'junction' : 'dir');

    // Also test symlink meta.json (real symlink if permitted on host, plus mocked symlink via fsOps)
    const realJobWithLinkMeta = path.join(stateHome, 'jobs', '20261115-130100_linkmeta');
    fs.mkdirSync(realJobWithLinkMeta, { recursive: true });
    let createdFileSymlink = false;
    try {
      fs.symlinkSync(outsideMeta, path.join(realJobWithLinkMeta, 'meta.json'), 'file');
      createdFileSymlink = true;
    } catch {
      fs.writeFileSync(
        path.join(realJobWithLinkMeta, 'meta.json'),
        JSON.stringify({
          name: 'fallback',
          model: 'm1',
          work_dir: root,
          ok: true,
          usage: { total_tokens: 8888 },
        }),
        'utf8'
      );
    }

    const stats = loadStats({
      stateHome,
      fsOps: createdFileSymlink
        ? {}
        : {
            lstatSync(p) {
              const st = fs.lstatSync(p);
              if (p.endsWith(path.join('20261115-130100_linkmeta', 'meta.json'))) {
                return {
                  isSymbolicLink: () => true,
                  isDirectory: () => false,
                  isFile: () => false,
                };
              }
              return st;
            },
          },
    });

    assert.equal(stats.jobs, 0);
    assert.equal(stats.reportedTokens, 0);
    assert.equal(stats.warnings.length, 2);
    assert.ok(stats.warnings.some((w) => w.includes('20261115-130000_linkdir') && w.includes('symbolic link')));
    assert.ok(stats.warnings.some((w) => w.includes('20261115-130100_linkmeta') && w.includes('symbolic link')));
  });
});

test('loadStats filters workdir with normalized exact path and platform case semantics', async () => {
  await withTempState(async ({ stateHome }) => {
    writeJobMeta(stateHome, '20261115-140000_win_upper', {
      name: 'w1',
      model: 'm1',
      work_dir: 'C:\\Work\\Proj',
      ok: true,
      usage: { total_tokens: 100 },
    });
    writeJobMeta(stateHome, '20261115-140100_win_prefix', {
      name: 'w2',
      model: 'm1',
      work_dir: 'C:\\Work\\Proj-Extra',
      ok: true,
      usage: { total_tokens: 200 },
    });
    writeJobMeta(stateHome, '20261115-140200_win_sub', {
      name: 'w3',
      model: 'm1',
      work_dir: 'C:\\Work\\Proj\\sub',
      ok: true,
      usage: { total_tokens: 300 },
    });

    const winFiltered = loadStats({
      stateHome,
      workDir: 'c:/work/proj/',
      platform: 'win32',
    });
    assert.equal(winFiltered.jobs, 1);
    assert.equal(winFiltered.reportedTokens, 100);

    writeJobMeta(stateHome, '20261115-140300_posix_upper', {
      name: 'p1',
      model: 'm1',
      work_dir: '/Home/Alice/App',
      ok: true,
      usage: { total_tokens: 400 },
    });
    writeJobMeta(stateHome, '20261115-140400_posix_lower', {
      name: 'p2',
      model: 'm1',
      work_dir: '/home/alice/app',
      ok: true,
      usage: { total_tokens: 500 },
    });

    const linuxFiltered = loadStats({
      stateHome,
      workDir: '/home/alice/app/',
      platform: 'linux',
      cwd: '/',
    });
    assert.equal(linuxFiltered.jobs, 1);
    assert.equal(linuxFiltered.reportedTokens, 500);

    const darwinFiltered = loadStats({
      stateHome,
      workDir: '/home/alice/app/',
      platform: 'darwin',
      cwd: '/',
    });
    assert.equal(darwinFiltered.jobs, 2);
    assert.equal(darwinFiltered.reportedTokens, 900);
  });
});

test('CLI supports --help, --json, --workdir, plain summary, and exits 2 on invalid args', async () => {
  await withTempState(async ({ root, stateHome }) => {
    const workA = path.join(root, 'app-a');
    const workB = path.join(root, 'app-b');

    writeJobMeta(stateHome, '20261115-150000_one', {
      name: 'one',
      model: 'gemini-4-hydrogen-high',
      work_dir: workA,
      ok: true,
      report_status: 'partial',
      follow_up_of: '20261115-140000_zero',
      seconds: 10,
      usage: { total_tokens: 1234 },
    });
    writeJobMeta(stateHome, '20261115-150100_two', {
      name: 'two',
      model: 'gemini-4-hydrogen-low',
      work_dir: workA,
      ok: false,
      seconds: 4,
      usage: null,
    });
    writeJobMeta(stateHome, '20261115-150200_other', {
      name: 'other',
      model: 'gemini-4-hydrogen-high',
      work_dir: workB,
      ok: true,
      seconds: 7,
      usage: { total_tokens: 9000 },
    });
    writeJobMeta(stateHome, '20261115-150300_bad', '{broken');

    const env = { ...process.env, BRAIN_DISPATCH_HOME: stateHome };

    // --help exits 0
    const helpRes = await runStats(['--help'], env);
    assert.equal(helpRes.code, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /Usage: node scripts\/stats\.mjs/);

    // Unknown flag, unexpected positional arg, missing --workdir value, empty --workdir all exit 2
    for (const badArgs of [['--bogus'], ['positional'], ['--workdir'], ['--workdir', '   '], ['--workdir=']]) {
      const badRes = await runStats(badArgs, env);
      assert.equal(badRes.code, 2, `expected exit 2 for ${JSON.stringify(badArgs)}`);
      assert.match(badRes.stderr, /^Error:/);
    }

    // --json with --workdir emits only JSON and retains warnings
    const jsonRes = await runStats(['--json', '--workdir', workA], env);
    assert.equal(jsonRes.code, 0, jsonRes.stderr);
    assert.equal(jsonRes.stderr, '');
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.jobs, 2);
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.rejected, 1);
    assert.equal(parsed.partial, 1);
    assert.equal(parsed.followUps, 1);
    assert.equal(parsed.seconds, 14);
    assert.equal(parsed.reportedTokens, 1234);
    assert.equal(parsed.jobsWithUsage, 1);
    assert.equal(parsed.jobsWithoutUsage, 1);
    assert.equal(parsed.byModel.length, 2);
    assert.equal(parsed.warnings.length, 1);
    assert.ok(parsed.note.includes(REQUIRED_CAVEAT));

    // Plain output is concise and includes required breakdowns + caveat
    const plainRes = await runStats([`--workdir=${workA}`], env);
    assert.equal(plainRes.code, 0, plainRes.stderr);
    assert.ok(plainRes.stdout.includes('Jobs: 2 (accepted 1, failed 1, partial 1, follow-ups 1, time 14s)'));
    assert.ok(plainRes.stdout.includes('Reported tokens: 1,234 (1 with usage, 1 unknown usage)'));
    assert.ok(plainRes.stdout.includes('gemini-4-hydrogen-high'));
    assert.ok(plainRes.stdout.includes('gemini-4-hydrogen-low'));
    assert.ok(plainRes.stdout.includes(REQUIRED_CAVEAT));
    assert.ok(plainRes.stdout.includes('Warnings (1):'));
  });
});

test('parseStatsArgs and formatStats handle edge cases cleanly', () => {
  assert.deepEqual(parseStatsArgs(['--json', '--workdir=/tmp/x']), {
    json: true,
    workdir: '/tmp/x',
    help: false,
  });
  assert.throws(() => parseStatsArgs(['--nope']), /Unknown or unexpected argument/);
  assert.throws(() => parseStatsArgs(['--workdir', '--json']), /Missing value for --workdir/);

  const formatted = formatStats({
    jobs: 0,
    accepted: 0,
    rejected: 0,
    partial: 0,
    followUps: 0,
    seconds: 0,
    reportedTokens: 0,
    jobsWithUsage: 0,
    jobsWithoutUsage: 0,
    byModel: [],
    warnings: [],
    note: USAGE_NOTE,
  });
  assert.ok(formatted.includes('By model: none'));
  assert.ok(formatted.includes(REQUIRED_CAVEAT));
});
