export type PilotKind = 'job' | 'host';
export type PilotSubmission = { kind: PilotKind; fields: Record<string, string | string[]>; file: File | null; timezone: string; requestId: string };
export type SubmissionResult = { status: 'submitted'; id: string };
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.ipynb', '.py', '.zip', '.txt', '.csv', '.json'];
export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) return 'Please choose a file smaller than 20 MB, or share a link instead.';
  if (!ALLOWED_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext))) return 'Choose a notebook, Python script, ZIP, TXT, CSV, or JSON file.';
  return null;
}
// Fail closed if live collection is disabled or not configured in a deployment.
export const pilotLive = import.meta.env.VITE_PILOT_LIVE === 'true';
export async function submitPilot(submission: PilotSubmission): Promise<SubmissionResult> {
  if (!pilotLive) throw new Error('Submissions are temporarily unavailable. Please try again later.');
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Submissions are not configured yet.');
  if (submission.file) { const error = validateFile(submission.file); if (error) throw new Error(error); }
  const deadline = submission.fields.deadline;
  const body = new FormData();
  body.append('payload', JSON.stringify({id:submission.requestId, kind:submission.kind, fields:submission.fields, timezone:submission.timezone,
    deadlineUtc:submission.kind === 'job' && typeof deadline === 'string' ? new Date(deadline).toISOString() : null}));
  if (submission.file) body.append('file', submission.file);
  let response: Response;
  try { response = await fetch(`${url.replace(/\/$/,'')}/functions/v1/submit-pilot`, {method:'POST',headers:{apikey:key},body,signal:AbortSignal.timeout(120000)}); }
  catch { throw new Error('Could not confirm receipt. Check your connection, then retry with the same details.'); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Could not save your request. Please try again.');
  if (result?.status !== 'submitted' || result.id !== submission.requestId) throw new Error('The server did not confirm your request. Please retry.');
  return {status:'submitted',id:result.id};
}
