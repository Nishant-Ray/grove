import { useState, type FormEvent } from 'react';
import { ArrowRight, Cpu } from 'lucide-react';
import { api } from './lib/api';

type Draft = { id: string; uploads: string[]; files: File[]; next: number };

export default function SubmitJob({ done, cancel }: { done: () => void; cancel: () => void }) {
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      let upload = draft;
      if (!upload) {
        const script = data.get('script') as File;
        const inputs = (data.getAll('inputs') as File[]).filter((f) => f.name);
        const files = [script, ...inputs];
        const names = ['main.py', ...inputs.map((f) => f.name)];
        if (
          !script.size ||
          inputs.length > 8 ||
          files.reduce((sum, f) => sum + f.size, 0) > 16 * 1024 ** 2
        )
          throw new Error(
            'Choose a nonempty script and up to eight inputs, totaling at most 16 MiB.',
          );
        if (
          new Set(names.map((n) => n.toLowerCase())).size !== names.length ||
          names.some(
            (n) =>
              !/^[a-z0-9_-][a-z0-9_.-]{0,79}$/i.test(n) ||
              n.endsWith('.') ||
              /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(n),
          )
        )
          throw new Error(
            'Use unique, portable input names with letters, numbers, periods, underscores or hyphens. main.py is reserved for the script.',
          );
        const id = crypto.randomUUID();
        setPhase('Checking host…');
        const { uploads } = await api<{ uploads: string[] }>('/jobs/stage', 'POST', {
          id,
          device_id: String(data.get('device')).trim(),
          name: data.get('name'),
          cpus: Number(data.get('cpus')),
          memory_mib: Number(data.get('memory')),
          seconds: Number(data.get('seconds')),
          files: files.map((f, i) => ({ name: names[i], size: f.size })),
        });
        upload = { id, uploads, files, next: 0 };
        setDraft(upload);
      }
      for (let i = upload.next; i < upload.files.length; i++) {
        setPhase('Uploading ' + (i + 1) + ' of ' + upload.files.length + '…');
        const response = await fetch(upload.uploads[i], {
          method: 'PUT',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: upload.files[i],
        });
        if (!response.ok) {
          const info = await response.json().catch(() => ({}));
          if (
            info.error !== 'Duplicate' &&
            info.errorCode !== 'Duplicate' &&
            info.code !== 'KeyAlreadyExists'
          )
            throw new Error(
              'File upload failed. Retry, or start a new request if the link expired.',
            );
        }
        upload = { ...upload, next: i + 1 };
        setDraft(upload);
      }
      setPhase('Submitting…');
      await api('/jobs/' + upload.id + '/submit', 'POST');
      done();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this job.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="jobs-panel submit-panel">
      <div className="jobs-toolbar">
        <h2>Request compute</h2>
        <Cpu size={22} />
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={busy || !!draft}>
          <label className="field">
            Job name
            <input name="name" maxLength={120} placeholder="Dataset summary" required />
          </label>
          <label className="field">
            Host device ID
            <input name="device" placeholder="Paste the ID shared by your host" required />
          </label>
          <label className="field">
            Python script
            <input name="script" type="file" accept=".py" required />
          </label>
          <label className="field">
            Input files (optional)
            <input name="inputs" type="file" multiple />
          </label>
          <p>
            Python 3.12 with the standard library. Read inputs from <code>/inputs/</code> and write
            files to <code>/work/output/</code>. The result ZIP includes your files and console
            output.
          </p>
          <div className="job-budget">
            <label className="field">
              CPU cores
              <input name="cpus" type="number" min="1" max="64" defaultValue="1" required />
            </label>
            <label className="field">
              Memory (MiB)
              <input
                name="memory"
                type="number"
                min="256"
                max="65536"
                defaultValue="512"
                required
              />
            </label>
            <label className="field">
              Time limit (s)
              <input name="seconds" type="number" min="1" max="900" defaultValue="60" required />
            </label>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="inline-actions">
          <button className="button" disabled={busy}>
            {busy ? phase : draft ? 'Retry submission' : 'Send request'} <ArrowRight size={15} />
          </button>
          <button type="button" className="text-link" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
