import { createClient } from 'npm:@supabase/supabase-js@2';
import { InputError, MAX_FILE_SIZE, validatePayload, validateUpload } from './validation.ts';

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim());
const bucket = 'pilot-workloads';
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))).map(b => b.toString(16).padStart(2,'0')).join('');

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const headers = { 'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : 'null', 'Access-Control-Allow-Headers': 'apikey, content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Vary':'Origin', 'Cache-Control':'no-store' };
  const respond = (body: unknown, status = 200) => Response.json(body, {status, headers});
  if (!allowedOrigins.includes(origin)) return respond({error:'This site is not allowed to submit requests.'},403);
  if (req.method === 'OPTIONS') return new Response(null, {status:204, headers});
  if (req.method !== 'POST') return respond({error:'Method not allowed.'},405);
  if (!req.headers.get('content-type')?.startsWith('multipart/form-data')) return respond({error:'Use a form submission.'},415);
  try {
    // Bound actual bytes, including requests without a trusted Content-Length header.
    const reader = req.body?.getReader();
    if (!reader) throw new InputError('Empty request.');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_FILE_SIZE + 65536) { await reader.cancel(); return respond({error:'The upload is too large.'},413); } chunks.push(value); }
    const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    const form = await new Response(body, {headers:{'Content-Type':req.headers.get('content-type')!}}).formData();
    const raw = form.get('payload');
    if (typeof raw !== 'string' || raw.length > 40000) throw new InputError('Invalid form payload.');
    let payload; try { payload = JSON.parse(raw); } catch { throw new InputError('Invalid form payload.'); }
    const entry = form.get('file');
    const file = entry instanceof File ? entry : null;
    const values = validatePayload(payload, !!file);
    const upload = file ? await validateUpload(file) : null;
    const hash = await digest(new TextEncoder().encode(JSON.stringify(values) + (upload ? await digest(upload.bytes) : '')));
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Missing server configuration');
    const db = createClient(url, key, {auth:{persistSession:false,autoRefreshToken:false}});
    const {data:state,error:reserveError} = await db.rpc('reserve_pilot_submission', { p_id:values.id, p_hash:hash, p_kind:values.kind, p_email:values.email, p_name:values.name, p_details:values.details, p_deadline:values.deadline, p_timezone:values.timezone });
    if (reserveError) {
      if (reserveError.message.includes('PILOT_LIMIT')) return respond({error:'The pilot has reached its submission limit. Please try again later.'},429);
      if (reserveError.message.includes('PILOT_CONFLICT')) return respond({error:'This request changed after an earlier attempt. Close the form and submit a new request.'},409);
      throw reserveError;
    }
    if (state === 'pending_review') return respond({status:'submitted',id:values.id});
    const path = upload ? `${values.id}/workload${upload.ext}` : null;
    if (upload && path) {
      const {error} = await db.storage.from(bucket).upload(path, upload.bytes, {contentType:'application/octet-stream',upsert:true});
      if (error) throw error;
    }
    const {error:finalizeError} = await db.from('pilot_submissions').update({status:'pending_review',file_path:path}).eq('id',values.id).eq('request_hash',hash).select('id').single();
    if (finalizeError) throw finalizeError;
    return respond({status:'submitted',id:values.id});
  } catch (error) {
    if (error instanceof InputError) return respond({error:error.message},400);
    // Do not log submitted answers, file contents, payment details or credentials.
    console.error('Pilot submission failed; check database schema, bucket, and function configuration.');
    return respond({error:'Could not finish saving your request. Please retry with the same details.'},503);
  }
});
