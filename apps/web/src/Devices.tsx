import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Cpu, Monitor, Plus } from 'lucide-react';
import { api, type Device } from './lib/api';
import { HostConnection, useHostConnections } from './HostConnections';
import DeviceFields, { devicePayload } from './DeviceFields';

export function Devices({
  onboarding = false,
  onFinish,
  onCancelSetup,
  finishing = false,
}: {
  onboarding?: boolean;
  onFinish?: () => void;
  onCancelSetup?: () => void;
  finishing?: boolean;
} = {}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const connections = useHostConnections(!onboarding && devices.length > 0);
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
          if (onboarding && !rows.length) setEditing('new');
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Please try again.');
      });
    return () => {
      active = false;
    };
  }, [attempt, onboarding]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = devicePayload(event.currentTarget, editing === 'new' ? null : editing);
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
      setError(err instanceof Error ? err.message : 'Please try again.');
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
      setError(err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const draft = editing && editing !== 'new' ? editing : null;
  return (
    <section className="device-panel">
      <div className="panel-heading">
        <h2>Host devices</h2>
        {!editing && loaded && !onboarding && (
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
      {connections.error && <p role="status">{connections.error}</p>}
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
          <DeviceFields device={draft} />
          <div className="inline-actions">
            <button className="button" disabled={busy || finishing}>
              Save listing
            </button>
            <button
              type="button"
              className="text-link"
              disabled={busy || finishing}
              onClick={() => {
                if (onboarding && !devices.length) {
                  onCancelSetup?.();
                  return;
                }
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
          {devices.map((d) => {
            const host = connections.hosts.find((h) => h.device_id === d.id);
            return (
              <li key={d.id}>
                <Monitor size={25} />
                <div>
                  <h3>{d.name}</h3>
                  <p>
                    {d.specs
                      ? [d.specs.cpu, d.specs.ram_gb + ' GB RAM', d.specs.gpu, d.specs.os]
                          .filter(Boolean)
                          .join(' · ')
                      : d.hardware}
                  </p>
                  <span className={'availability ' + d.availability}>{d.availability}</span>
                  {host && <HostConnection host={host} unlink={() => connections.unlink(host)} />}
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
                  <button
                    disabled={busy}
                    className="text-link"
                    hidden={onboarding}
                    onClick={() => remove(d)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty-devices">
          <Cpu size={36} strokeWidth={1.2} />
          <h3>Your first device</h3>
          <p>Add a computer to manage its hardware details and availability.</p>
        </div>
      )}
      {onboarding && loaded && !editing && devices.length > 0 && (
        <button className="button" disabled={finishing || busy} onClick={onFinish}>
          Continue to dashboard <ArrowRight size={16} />
        </button>
      )}
    </section>
  );
}
