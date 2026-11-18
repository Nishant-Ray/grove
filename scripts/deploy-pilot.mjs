import {loadEnv} from 'vite';
import {spawnSync} from 'node:child_process';
const env=loadEnv('development',process.cwd(),'VITE_');
const ref=new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
if(!/^[a-z0-9]+$/.test(ref)) throw new Error('Invalid project reference');
const result=spawnSync(process.execPath,['node_modules/supabase/dist/supabase.js','functions','deploy','submit-pilot',`--remote=${ref}`,'--use-api'],{stdio:'inherit'});
if(result.error) throw result.error;
process.exit(result.status??1);
