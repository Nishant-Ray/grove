import {loadEnv} from 'vite';
const env=loadEnv('development',process.cwd(),'VITE_');
const url=env.VITE_SUPABASE_URL, key=env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!url || !key) throw new Error('Missing public Supabase configuration.');
if(!key.startsWith('sb_publishable_')) throw new Error('Expected a publishable key; do not use a secret key.');
const headers={apikey:key};
// Query zero records; only check that anonymous readers cannot access submissions.
const r=await fetch(`${url}/rest/v1/pilot_submissions?select=id&limit=0`,{headers});
console.log('Private table check:',[401,403].includes(r.status)?'PASS (public reads denied)':`UNVERIFIED (HTTP ${r.status})`);
const f=await fetch(`${url}/functions/v1/submit-pilot`,{method:'OPTIONS',headers:{...headers,Origin:'http://localhost:5173'}});
console.log('Submission endpoint:',f.status===204?'deployed (preflight accepted)':`not ready (HTTP ${f.status})`);
