/**
 * Hardened zero-dependency static server for the Vidyouth web pages.
 *
 * Serves the repo root so the API's emailed links resolve
 * (http://localhost:3000/reset-password?token=... -> reset-password/index.html)
 * WITHOUT exposing the backend .env / secrets / .git that live in the repo.
 *
 * Launched by scripts\start-frontend.ps1. Run directly with:
 *   node scripts\serve-frontend.mjs
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, sep, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 3000;
// Repo root = two levels up from this script (scripts -> backend -> root).
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Anything whose path contains one of these segments is never served.
const DENY_SEGMENTS = new Set([
  'vidyouth-login-backend', // .env, secrets/, app/node_modules
  '.git',
  'node_modules',
  'secrets',
]);

// Clean routes the API emails (no .html, folder-style).
const ROUTES = {
  '/': '/login.html',
  '/reset-password': '/reset-password/index.html',
  '/verify-email': '/verify-email/index.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function deny(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

const server = createServer(async (req, res) => {
  // DNS-rebinding defense: only answer to localhost host headers.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') {
    return deny(res, 403, 'forbidden host\n');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return deny(res, 405, 'method not allowed\n');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return deny(res, 400, 'bad request\n');
  }

  const mapped = ROUTES[pathname] ?? pathname;

  // Resolve inside ROOT and reject traversal or denied subtrees.
  const target = normalize(join(ROOT, mapped));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return deny(res, 403, 'forbidden\n');
  }
  const rel = target.slice(ROOT.length).split(sep);
  if (rel.some((s) => s.startsWith('.') && s !== '' && s !== '..')) {
    return deny(res, 404, 'not found\n'); // dotfiles incl. .env, .git
  }
  if (rel.some((s) => DENY_SEGMENTS.has(s))) {
    return deny(res, 404, 'not found\n');
  }

  try {
    let info;
    let file = target;
    try {
      info = await stat(file);
    } catch {
      // Clean-URL fallback: /login -> /login.html (only for extensionless paths).
      if (extname(file) === '') {
        file = `${target}.html`;
        info = await stat(file);
      } else {
        throw new Error('not found');
      }
    }
    if (info.isDirectory()) {
      return deny(res, 404, 'not found\n'); // no directory listings
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    return deny(res, 404, 'not found\n');
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serving ${ROOT}\n`);
  process.stdout.write(`http://localhost:${PORT}/login\n`);
});
