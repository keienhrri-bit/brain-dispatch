import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WIN_INET_REG_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function getUrlPort(urlObj) {
  if (urlObj.port) {
    const port = Number(urlObj.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  }
  if (urlObj.protocol === 'http:') return 80;
  if (urlObj.protocol === 'https:') return 443;
  if (urlObj.protocol.startsWith('socks')) return 1080;
  return null;
}

export async function testLocalProxy(proxyUrl, timeoutMs = 600) {
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return false;
  }

  if (!isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) {
    return false;
  }

  const port = getUrlPort(parsed);
  if (!port) {
    return false;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function parseRegistryProxy(regOutput) {
  if (typeof regOutput !== 'string' || !regOutput.trim()) {
    return null;
  }

  const enableMatch = regOutput.match(
    /^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/mi
  );
  if (!enableMatch) {
    return null;
  }

  const enableRaw = enableMatch[1];
  const enabled = enableRaw.toLowerCase().startsWith('0x')
    ? Number.parseInt(enableRaw, 16)
    : Number.parseInt(enableRaw, 10);
  if (enabled !== 1) {
    return null;
  }

  const serverMatch = regOutput.match(
    /^\s*ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/mi
  );
  if (!serverMatch) {
    return null;
  }

  let endpoint = serverMatch[1].trim();
  if (!endpoint) {
    return null;
  }

  if (endpoint.includes('=')) {
    const protoMatch = endpoint.match(/(?:^|;)\s*https?=([^;]+)/i);
    if (!protoMatch) {
      return null;
    }
    endpoint = protoMatch[1].trim();
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)) {
    endpoint = `http://${endpoint}`;
  }

  let candidate;
  try {
    candidate = new URL(endpoint);
  } catch {
    return null;
  }

  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
    return null;
  }
  if (!isLoopbackHost(candidate.hostname) || candidate.username || candidate.password) {
    return null;
  }

  return `${candidate.protocol}//${candidate.host}`;
}

export async function queryWindowsRegistryProxy() {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', WIN_INET_REG_KEY],
      { windowsHide: true, timeout: 3000, encoding: 'utf8' }
    );
    return stdout ?? '';
  } catch {
    return '';
  }
}

export async function resolveBackendProxy({
  configProxy = null,
  env = process.env,
  platform = process.platform,
  queryRegistry = queryWindowsRegistryProxy,
  probeProxy = testLocalProxy,
} = {}) {
  if (typeof configProxy === 'string' && configProxy.trim()) {
    return configProxy.trim();
  }

  const inherited =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy;

  if (inherited) {
    try {
      const parsed = new URL(inherited);
      if (!isLoopbackHost(parsed.hostname)) {
        return null;
      }
      if (await probeProxy(parsed.href)) {
        return null;
      }
    } catch {
      return null;
    }
  }

  if (platform !== 'win32') {
    return null;
  }

  const regOutput = await queryRegistry();
  const candidate = parseRegistryProxy(regOutput);
  if (!candidate) {
    return null;
  }

  if (await probeProxy(candidate)) {
    return candidate;
  }

  return null;
}

export function applyProxyEnv(baseEnv, proxyUrl) {
  const nextEnv = { ...baseEnv };
  if (!proxyUrl) {
    return nextEnv;
  }
  nextEnv.HTTP_PROXY = proxyUrl;
  nextEnv.HTTPS_PROXY = proxyUrl;
  nextEnv.ALL_PROXY = proxyUrl;
  for (const lowerKey of ['http_proxy', 'https_proxy', 'all_proxy']) {
    if (lowerKey in nextEnv) {
      nextEnv[lowerKey] = proxyUrl;
    }
  }
  return nextEnv;
}
