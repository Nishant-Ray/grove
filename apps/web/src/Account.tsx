import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Cpu, Monitor, Plus, Sprout } from 'lucide-react';
import { api, type Device, type Profile } from './lib/api';

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function Auth({
  register,
  onLogin,
}: {
  register: boolean;
  onLogin: (user: Profile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: Profile | null }>(
        register ? '/auth/register' : '/auth/login',
        'POST',
        fields,
      );
      if (user) onLogin(user);
      else setSent(String(fields.email));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <aside className="auth-art" aria-hidden="true">
        <div className="tree-rings">
          <div />
          <div />
          <div />
          <div />
        </div>
        <Sprout strokeWidth={1} size={92} />
      </aside>
      <section className="auth-panel">
        <h1>{sent ? 'Check your inbox.' : register ? 'Join Grove.' : 'Welcome back.'}</h1>
        {sent ? (
          <>
            <p>
              Check {sent} for a confirmation link. Once your email is confirmed, log in to open
              your workspace.
            </p>
            <a className="button" href="#login">
              Go to login <ArrowRight size={16} />
            </a>
          </>
        ) : (
          <>
            <p>
              {register
                ? 'Create your account to set up a profile and list your hardware.'
                : 'Log in to your Grove workspace.'}
            </p>
            <form onSubmit={submit}>
              {register && (
                <label className="field">
                  Display name
                  <input name="display_name" autoComplete="nickname" maxLength={100} required />
                </label>
              )}
              <label className="field">
                Email
                <input type="email" name="email" autoComplete="email" required />
              </label>
              <label className="field">
                Password
                <input
                  type="password"
                  name="password"
                  minLength={register ? 8 : 1}
                  maxLength={256}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  placeholder={register ? 'At least 8 characters' : undefined}
                  required
                />
              </label>
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              <button disabled={busy} className="button">
                {busy ? 'Please wait…' : register ? 'Create account' : 'Log in'}{' '}
                <ArrowRight size={16} />
              </button>
            </form>
            <p>
              {register ? 'Already have an account? ' : 'New to Grove? '}
              <a className="underlink" href={register ? '#login' : '#register'}>
                {register ? 'Log in' : 'Create an account'}
              </a>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

export function Account({
  user,
  onProfile,
  onLogout,
}: {
  user: Profile;
  onProfile: (user: Profile) => void;
  onLogout: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    setNotice('');
    try {
      onProfile(await api<Profile>('/profile', 'PUT', data));
      setEditing(false);
      setNotice('Profile saved.');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', 'POST');
      onLogout();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-shell">
      <div className="workspace-title">
        <h1>Your workspace.</h1>
        <button className="text-link" disabled={busy} onClick={logout}>
          Log out
        </button>
      </div>
      <div className="workspace-grid">
        <section className="profile-card">
          <Sprout size={28} />
          <h2>Profile</h2>
          {editing ? (
            <form onSubmit={save}>
              <label className="field">
                Display name
                <input
                  name="display_name"
                  defaultValue={user.display_name}
                  maxLength={100}
                  required
                />
              </label>
              <label className="field">
                Bio
                <textarea name="bio" defaultValue={user.bio} maxLength={400} rows={3} />
              </label>
              <div className="inline-actions">
                <button className="button" disabled={busy}>
                  Save profile
                </button>
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <strong>{user.display_name || user.email}</strong>
              <p>{user.email}</p>
              {user.bio && <p>{user.bio}</p>}
              <button
                className="underlink"
                onClick={() => {
                  setEditing(true);
                  setNotice('');
                }}
              >
                Edit profile
              </button>
            </>
          )}
          <p role="status">{notice}</p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </section>
        <Devices />
      </div>
    </main>
  );
}

function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Device | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Device[]>('/devices')
      .then((rows) => {
        if (active) {
          setDevices(rows);
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (active) setError(message(err));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const add = editing === 'new';
      const row = await api<Device>(
        add ? '/devices' : '/devices/' + editing.id,
        add ? 'POST' : 'PUT',
        data,
      );
      setDevices((rows) =>
        add ? [...rows, row] : rows.map((old) => (old.id === row.id ? row : old)),
      );
      setEditing(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(device: Device) {
    if (!window.confirm('Remove ' + device.name + ' from your listings?')) return;
    setBusy(true);
    setError('');
    try {
      await api('/devices/' + device.id, 'DELETE');
      setDevices((rows) => rows.filter((row) => row.id !== device.id));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const draft = editing && editing !== 'new' ? editing : null;
  return (
    <section className="device-panel">
      <div className="panel-heading">
        <h2>Host devices</h2>
        {!editing && loaded && (
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setEditing('new');
              setError('');
            }}
          >
            <Plus size={16} /> Add device
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!loaded ? (
        error ? (
          <button
            className="underlink"
            onClick={() => {
              setError('');
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        ) : (
          <p>Loading devices…</p>
        )
      ) : editing ? (
        <form key={draft?.id || 'new'} onSubmit={save}>
          <h3>{draft ? 'Edit device' : 'New device'}</h3>
          <label className="field">
            Device name
            <input
              name="name"
              placeholder="Studio workstation"
              defaultValue={draft?.name}
              maxLength={100}
              required
            />
          </label>
          <label className="field">
            Hardware
            <input
              name="hardware"
              placeholder="RTX 4060 · 8 GB VRAM · 32 GB RAM"
              defaultValue={draft?.hardware}
              maxLength={100}
              required
            />
          </label>
          <label className="field">
            Listing availability
            <select name="availability" defaultValue={draft?.availability || 'paused'}>
              <option value="paused">Paused</option>
              <option value="available">Available</option>
            </select>
          </label>
          <div className="inline-actions">
            <button className="button" disabled={busy}>
              Save listing
            </button>
            <button
              type="button"
              className="text-link"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : devices.length ? (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <Monitor size={25} />
              <div>
                <h3>{d.name}</h3>
                <p>{d.hardware}</p>
                <span className={'availability ' + d.availability}>{d.availability}</span>
              </div>
              <div className="device-actions">
                <button
                  disabled={busy}
                  className="text-link"
                  onClick={() => {
                    setEditing(d);
                    setError('');
                  }}
                >
                  Edit
                </button>
                <button disabled={busy} className="text-link" onClick={() => remove(d)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-devices">
          <Cpu size={36} strokeWidth={1.2} />
          <h3>Your first device</h3>
          <p>Add a computer to manage its hardware details and availability.</p>
        </div>
      )}
    </section>
  );
}
