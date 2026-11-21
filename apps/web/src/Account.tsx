import { useState, type FormEvent } from 'react';
import { ArrowRight, Sprout } from 'lucide-react';
import { Devices } from './Devices';
import { api, type Profile } from './lib/api';

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
          <div className="workspace-preference">
            <strong>Workspace preference</strong>
            <p>
              {
                {
                  host: 'Host a device',
                  rent: 'Rent compute',
                  new: 'Choose a starting point',
                  host_setup: 'Finish device setup',
                }[user.workspace_mode]
              }
            </p>
            <a className="underlink" href="#setup">
              Change preference
            </a>
          </div>
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
