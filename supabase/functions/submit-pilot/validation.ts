export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const EXTENSIONS = ['.py', '.ipynb', '.zip', '.txt', '.csv', '.json'];
export class InputError extends Error {}
export function validatePayload(value: unknown, hasFile: boolean) {
  if (!value || typeof value !== 'object') throw new InputError('Invalid request.');
  const p = value as Record<string, unknown>;
  if (p.kind !== 'job' && p.kind !== 'host') throw new InputError('Choose a job or host request.');
  if (typeof p.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(p.id)) throw new InputError('Invalid request ID.');
  if (!p.fields || typeof p.fields !== 'object' || Array.isArray(p.fields)) throw new InputError('Invalid form fields.');
  const fields = p.fields as Record<string, unknown>;
  if (Object.keys(fields).length > 35) throw new InputError('Too many fields.');
  const details: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-zA-Z]{1,40}$/.test(key)) throw new InputError('Invalid field name.');
    if (typeof value === 'string' && value.length <= 10000) details[key] = value.trim();
    else if (Array.isArray(value) && value.length <= 15 && value.every(v => typeof v === 'string' && v.length <= 200)) details[key] = value;
    else throw new InputError('One of your answers is too long or invalid.');
  }
  const required = (name: string) => {
    const v = details[name];
    if (typeof v !== 'string' || !v.trim()) throw new InputError(`Please complete ${name}.`);
    return v;
  };
  const name = required('name');
  const email = required('email').toLowerCase();
  if (name.length > 150 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Enter a valid name and email.');
  if (typeof p.timezone !== 'string' || p.timezone.length > 100) throw new InputError('Invalid timezone.');
  try { new Intl.DateTimeFormat('en', {timeZone:p.timezone}); } catch { throw new InputError('Invalid timezone.'); }
  for (const key of ['codeLink', 'dataLink']) {
    if (details[key]) {
      try { if (!['http:', 'https:'].includes(new URL(required(key)).protocol)) throw 0; }
      catch { throw new InputError('Links must use http or https.'); }
    }
  }
  let deadline: string | null = null;
  if (p.kind === 'job') {
    for (const key of ['courses', 'currentCompute', 'frameworks']) {
      const v = details[key];
      if (!(typeof v === 'string' && v || Array.isArray(v) && v.length && v.every(x => x.trim()))) throw new InputError(`Choose at least one ${key} option.`);
    }
    for (const key of ['hitLimit', 'description', 'runtime', 'paymentContact']) required(key);
    if (!['Venmo','Zelle'].includes(required('paymentMethod'))) throw new InputError('Choose Venmo or Zelle.');
    if (required('paymentConsent') !== 'yes') throw new InputError('Confirm the payment terms.');
    if (!hasFile && !details.codeLink) throw new InputError('Add a file or notebook/script link.');
    if (typeof p.deadlineUtc !== 'string' || !Number.isFinite(Date.parse(p.deadlineUtc)) || Date.parse(p.deadlineUtc) <= Date.now()) throw new InputError('Choose a future deadline.');
    deadline = new Date(p.deadlineUtc).toISOString();
  } else {
    if (hasFile) throw new InputError('Host requests do not accept files.');
    for (const key of ['source','device','specs','idleTime','availability']) required(key);
    if (required('hostConsent') !== 'yes') throw new InputError('Confirm that we may contact you about a task.');
  }
  return { id:p.id, kind:p.kind, name, email, details, timezone:p.timezone, deadline };
}

export async function validateUpload(file: File) {
  const ext = EXTENSIONS.find(e => file.name.toLowerCase().endsWith(e));
  if (!ext || !file.size || file.size > MAX_FILE_SIZE) throw new InputError('Choose an allowed, nonempty file up to 20 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === '.zip') {
    if (bytes[0] !== 80 || bytes[1] !== 75 || ![3,5,7].includes(bytes[2]) || ![4,6,8].includes(bytes[3])) throw new InputError('The file is not a valid ZIP archive.');
  } else {
    let text: string;
    try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { throw new InputError('Text and code uploads must be UTF-8 files.'); }
    if (text.includes('\0')) throw new InputError('Binary files must be provided in a ZIP archive.');
    if (ext === '.json' || ext === '.ipynb') {
      try { const json = JSON.parse(text); if (ext === '.ipynb' && (!Array.isArray(json.cells) || typeof json.nbformat !== 'number')) throw 0; }
      catch { throw new InputError('The JSON or notebook file is invalid.'); }
    }
  }
  // Content checking is not malware scanning. Files are private, inert, and never executed here.
  return {bytes, ext};
}
