import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('the served page contains executable browser JavaScript', async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, WEB_PORT: String(port), API_PUBLIC_URL: 'https://foundry.frankai.online/api' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('web server did not start: ' + errors)), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('agent-foundry-web listening')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('web server exited: ' + code + ' ' + errors)); });
  });
  const response = await fetch('http://127.0.0.1:' + port + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'the page must include its client script');
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Script(match[1], { filename: 'served-client-' + index + '.js' }));
  }
});
