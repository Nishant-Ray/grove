import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const backendDir = fileURLToPath(new URL('../../../backend/', import.meta.url));
const supabaseCli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const env = loadEnv('development', webDir, 'VITE_');
const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];

if (!/^[a-z0-9]+$/.test(ref)) throw new Error('Invalid project reference');

const result = spawnSync(
  process.execPath,
  [supabaseCli, 'functions', 'deploy', 'submit-pilot', `--remote=${ref}`, '--use-api', '--workdir', backendDir],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
