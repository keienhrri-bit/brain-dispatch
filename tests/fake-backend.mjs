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

function emitOk() {
  if (process.env.FAKE_BACKEND_TOUCH_FILE) {
    fs.writeFileSync(process.env.FAKE_BACKEND_TOUCH_FILE, 'touched by backend\n', 'utf8');
  }
  const outFile = path.join(process.cwd(), 'output.txt');
  fs.writeFileSync(outFile, 'fake backend output\n', 'utf8');
  const payload = {
    status: 'SUCCESS',
    conversation_id: 'fake-conv-ok',
    usage: { total_tokens: 1234 },
    response: '',
    structured_output: {
      status: 'done',
      summary: 'Completed fake job and wrote output.txt.',
      files: [{ path: outFile, what: 'Created fake output file' }],
      findings: ['Wrote output.txt (fake-backend.mjs:emitOk)'],
      verified: ['Verified output.txt was written'],
      unverified: [],
      open: [],
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

const mode = process.env.FAKE_BACKEND_MODE || 'ok';

switch (mode) {
  case 'ok':
    emitOk();
    break;

  case 'missing': {
    const missingFile = path.join(process.cwd(), 'ghost.txt');
    const payload = {
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
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
    break;
  }

  case 'noreport': {
    const payload = {
      status: 'SUCCESS',
      conversation_id: 'fake-conv-noreport',
      usage: { total_tokens: 300 },
      response: 'Here is a plain text response with no structured report.',
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
    break;
  }

  case 'denied': {
    const payload = {
      status: 'DENIED',
      conversation_id: 'fake-conv-denied',
      denied_actions: [{ action: 'write_file(/protected/secret.txt)' }],
      response: '',
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(1);
    break;
  }

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
