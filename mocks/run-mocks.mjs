#!/usr/bin/env node
// Arranca ambos mocks (Moodle y PayPal) en paralelo. Ctrl+C detiene ambos.
//   npm run mocks
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const servers = [
  ['moodle', path.join(here, 'moodle/server.mjs')],
  ['paypal', path.join(here, 'paypal/server.mjs')],
];
const children = servers.map(([name, file]) => {
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (buf) => buf.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  child.stdout.on('data', (b) => console.log(tag(b)));
  child.stderr.on('data', (b) => console.error(tag(b)));
  child.on('exit', (code) => { console.log(`[${name}] terminó (${code})`); shutdown(code ?? 1); });
  return child;
});
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
