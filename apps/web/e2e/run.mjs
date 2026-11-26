// Runs the browser suites, each against a freshly reset local database so leftover data from one
// suite can't affect the next. Expects local Supabase, the API (port 8000) and Vite (port 5173) to be
// running; see the README. Usage: npm run test:e2e [-- booking messaging ...]
// Set E2E_SKIP_RESET=1 to keep the current database.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API } from './lib.mjs';

const all = ['booking', 'notifications', 'messaging', 'read-markers'];
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : all;
const webDir = fileURLToPath(new URL('../', import.meta.url));
const supabase = fileURLToPath(new URL('../node_modules/.bin/supabase', import.meta.url));
const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));

async function ready() {
  // Auth and PostgREST restart after a reset; a bad login answers 400 once both are up.
  for (let i = 0; i < 60; i++) {
    try {
      const [rates, login] = await Promise.all([
        fetch(API + '/api/gpu-rates'),
        fetch(API + '/api/auth/login', {
          method: 'POST', headers: { 'X-Grove-Request': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'not-a-password' }),
        }),
      ]);
      if (rates.ok && login.status === 400) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API at ${API} is not ready`);
}

const results = [];
for (const name of chosen) {
  if (!all.includes(name)) throw new Error(`Unknown suite "${name}". Choose from: ${all.join(', ')}`);
  if (!process.env.E2E_SKIP_RESET) {
    const reset = spawnSync(supabase, ['db', 'reset', '--workdir', backend], { cwd: webDir, encoding: 'utf8' });
    if (reset.status !== 0) throw new Error('supabase db reset failed:\n' + reset.stderr);
  }
  await ready();
  console.log(`\n=== ${name}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { stdio: 'inherit' });
  results.push([name, run.status === 0]);
}
console.log('\n' + results.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`).join('\n'));
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
