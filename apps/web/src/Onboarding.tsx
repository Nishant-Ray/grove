import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Cpu, Layers3 } from 'lucide-react';
import { Devices } from './Devices';
import { api, type Profile } from './lib/api';
import './onboarding.css';

export default function Onboarding({
  user,
  onChange,
}: {
  user: Profile;
  onChange: (profile: Profile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const host = user.workspace_mode === 'host_setup';
  async function choose(mode: Profile['workspace_mode']) {
    setBusy(true);
    setError('');
    try {
      const profile = await api<Profile>('/profile/preference', 'PUT', { mode });
      onChange(profile);
      window.location.hash = mode === 'host_setup' || mode === 'new' ? 'setup' : 'account';
    } catch {
      setError('Could not save your preference. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={'setup-shell ' + (host ? 'setup-device' : '')}>
      <header className="setup-heading">
        <h1>
          {host ? (
            <>
              Set up your <em>device.</em>
            </>
          ) : (
            <>
              How will you use <em>Grove?</em>
            </>
          )}
        </h1>
        <p>
          {host
            ? 'Tell us what your machine can share and when it’s available.'
            : 'Choose where to start. You can rent and host from the same account.'}
        </p>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {host ? (
        <>
          <Devices
            onboarding
            onFinish={() => choose('host')}
            onCancelSetup={() => choose('new')}
            finishing={busy}
          />
          <button disabled={busy} className="text-link" onClick={() => choose('rent')}>
            <ArrowLeft size={15} />
            Continue as a renter
          </button>
        </>
      ) : (
        <div className="role-grid">
          <button disabled={busy} className="role-card rent-card" onClick={() => choose('rent')}>
            <span className="role-art">
              <Layers3 size={56} strokeWidth={1.15} />
            </span>
            <span className="role-body">
              <strong>Rent compute</strong>
              <span>Bring a project and track its progress in your dashboard.</span>
              <b>
                Open dashboard <ArrowUpRight size={16} />
              </b>
            </span>
          </button>
          <button
            disabled={busy}
            className="role-card host-card"
            onClick={() => choose('host_setup')}
          >
            <span className="role-art">
              <Cpu size={56} strokeWidth={1.15} />
            </span>
            <span className="role-body">
              <strong>Host a device</strong>
              <span>Share spare compute and choose how your machine is listed.</span>
              <b>
                Set up hardware <ArrowUpRight size={16} />
              </b>
            </span>
          </button>
        </div>
      )}
    </main>
  );
}
