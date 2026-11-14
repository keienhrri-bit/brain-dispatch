import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (process.env.FAKE_BACKEND_CAPTURE_FILE) {
  fs.writeFileSync(
    process.env.FAKE_BACKEND_CAPTURE_FILE,
    JSON.stringify(
      {
        argv: args,
        cwd: process.cwd(),
        proxy: {
          HTTP_PROXY: process.env.HTTP_PROXY ?? null,
          HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
          ALL_PROXY: process.env.ALL_PROXY ?? null,
        },
      },
      null,
      2
    ),
    'utf8'
  );
}

if (args.includes('--version')) {
  process.stdout.write('agy-fake 1.0.0\n');
  process.exit(0);
}

if (args[0] === 'models') {
  const models =
    process.env.FAKE_BACKEND_MODELS ??
    [
      'gemini-4-hydrogen-low',
      'gemini-4-hydrogen-medium',
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-xhigh',
    ].join('\n') + '\n';
  process.stdout.write(models);
  process.exit(0);
}

// Like agy, answer with an event stream when asked for stream-json, and with a
// single JSON object otherwise.
const formatIdx = args.indexOf('--output-format');
const streamMode = formatIdx >= 0 && args[formatIdx + 1] === 'stream-json';
const steps = [];

function toSlash(p) {
  return p.split(path.sep).join('/');
}

// Writes a file for real and records the matching write_file step.
function writeWithTool(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  steps.push({ tool: 'write_file', state: 'DONE', parameters: { Path: toSlash(filePath) } });
}

function emit(result, code = 0) {
  if (streamMode) {
    const lines = [
      { event: 'init', init: { cwd: toSlash(process.cwd()), model: 'fake', tools: [] } },
      ...steps.map((s) => ({
        event: 'step_update',
        step_update: {
          state: s.state,
          step_type: 'TOOL',
          tool_name: s.tool,
          tool_info: {
            name: s.tool,
            parameters: s.parameters,
            ...(s.error ? { error: { type: 'TOOL_ERROR', message: s.error } } : {}),
          },
        },
      })),
      { event: 'result', result },
    ];
    process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.exit(code);
}

function okResult(files, summary = 'Completed fake job and wrote output.txt.') {
  return {
    status: 'SUCCESS',
    conversation_id: 'fake-conv-ok',
    usage: { total_tokens: 1234 },
    response: '',
    structured_output: {
      status: 'done',
      summary,
      files,
      findings: ['Wrote output.txt (fake-backend.mjs:emitOk)'],
      verified: ['Verified output.txt was written'],
      unverified: [],
      open: [],
    },
  };
}

function emitOk() {
  if (process.env.FAKE_BACKEND_TOUCH_FILE) {
    // A write the tool events do not show, like one made by a script.
    fs.writeFileSync(process.env.FAKE_BACKEND_TOUCH_FILE, 'touched by backend\n', 'utf8');
  }
  const outFile = path.join(process.cwd(), 'output.txt');
  writeWithTool(outFile, 'fake backend output\n');
  emit(okResult([{ path: outFile, what: 'Created fake output file' }]));
}

const mode = process.env.FAKE_BACKEND_MODE || 'ok';

switch (mode) {
  case 'ok':
    emitOk();
    break;

  case 'outside': {
    const outFile = path.join(process.cwd(), 'output.txt');
    writeWithTool(outFile, 'fake backend output\n');
    const stray = path.join(process.env.FAKE_BACKEND_OUTSIDE_DIR, 'stray.txt');
    writeWithTool(stray, 'written outside the writable directories\n');
    emit(okResult([{ path: outFile, what: 'Created fake output file' }]));
    break;
  }

  case 'commands': {
    const outFile = path.join(process.cwd(), 'output.txt');
    writeWithTool(outFile, 'fake backend output\n');
    steps.push({ tool: 'run_command', state: 'DONE', parameters: { CommandLine: 'node build.mjs' } });
    steps.push({
      tool: 'run_command',
      state: 'ERROR',
      parameters: { CommandLine: 'Remove-Item old.txt' },
      error:
        'permission check failed for unsandboxed "Remove-Item old.txt": Permission denied for unsandboxed(Remove-Item old.txt). Matches user-configured deny rule.',
    });
    emit(okResult([{ path: outFile, what: 'Created fake output file' }]));
    break;
  }

  case 'missing': {
    const missingFile = path.join(process.cwd(), 'ghost.txt');
    emit({
      status: 'SUCCESS',
      conversation_id: 'fake-conv-missing',
      usage: { total_tokens: 200 },
      response: '',
      structured_output: {
        status: 'done',
        summary: 'Claimed ghost.txt without writing it.',
        files: [{ path: missingFile, what: 'Non-existent file' }],
        findings: [],
        verified: [],
        unverified: [],
        open: [],
      },
    });
    break;
  }

  case 'noreport':
    emit({
      status: 'SUCCESS',
      conversation_id: 'fake-conv-noreport',
      usage: { total_tokens: 300 },
      response: 'Here is a plain text response with no structured report.',
    });
    break;

  case 'denied':
    emit(
      {
        status: 'DENIED',
        conversation_id: 'fake-conv-denied',
        denied_actions: [{ action: 'write_file(/protected/secret.txt)' }],
        response: '',
      },
      1
    );
    break;

  case 'auth':
    process.stderr.write('Error: authentication required. Run agy to sign in.\n');
    process.exit(1);
    break;

  case 'quota':
    process.stderr.write('Error: RESOURCE_EXHAUSTED (429) quota exceeded.\n');
    process.exit(1);
    break;

  case 'hang':
    setInterval(() => {}, 1000);
    break;

  case 'stdin':
    process.stdin.resume();
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      emitOk();
    });
    break;

  default:
    process.stderr.write(`Unknown FAKE_BACKEND_MODE: ${mode}\n`);
    process.exit(2);
}
