import { useEffect, useState, type FormEvent } from 'react';
import { Monitor } from 'lucide-react';
import { api, type Device } from './lib/api';

export default function PairDesktop({ link, email }: { link: string; email: string }) {
  const [, fingerprint, expiry] = link.split('/');
  const valid = /^[0-9a-f]{64}$/.test(fingerprint || '') && /^\d{10}$/.test(expiry || '');
  const [expired, setExpired] = useState(!valid || Number(expiry) * 1000 <= Date.now());
  const [devices, setDevices] = useState<Device[]>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (expired) return;
    let active = true;
    const timeout = window.setTimeout(
      () => setExpired(true),
      Math.min(660000, Number(expiry) * 1000 - Date.now()),
    );
    api<Device[]>('/devices')
      .then((rows) => {
        if (active) {
          setDevices(rows);
          setSelected(rows[0]?.id || '');
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [expiry, expired]);

  async function approve(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/hosts/approve', 'POST', {
        device_id: selected,
        fingerprint,
        expires: Number(expiry),
      });
      setApproved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <aside className="auth-art" aria-hidden="true">
        <Monitor strokeWidth={1} size={90} />
      </aside>
      <section className="auth-panel">
        <h1>{approved ? 'Desktop approved.' : expired ? 'Link expired.' : 'Link your desktop.'}</h1>
        {approved ? (
          <p>Return to Grove Host on your computer to set sharing limits and go online.</p>
        ) : expired ? (
          <p>Open Grove Host and request a new pairing link.</p>
        ) : (
          <>
            <p>
              Signed in as {email}. Only approve if this code matches the one in Grove Host on your
              computer.
            </p>
            <output className="pair-code">
              {fingerprint.slice(0, 4)} {fingerprint.slice(4, 8)}
            </output>
            {devices?.length ? (
              <form onSubmit={approve}>
                <label className="field">
                  Device listing
                  <select required value={selected} onChange={(e) => setSelected(e.target.value)}>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button" disabled={busy}>
                  {busy ? 'Linking…' : 'Approve desktop'}
                </button>
              </form>
            ) : devices ? (
              <p>
                Add a device listing in your profile, then reopen the pairing link from Grove Host.
              </p>
            ) : (
              !error && <p>Loading listings…</p>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </>
        )}
        <a className="text-link" href="#profile">
          Profile &amp; devices
        </a>
      </section>
    </main>
  );
}
