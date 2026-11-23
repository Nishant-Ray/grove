import { useEffect, useState } from 'react';
import { api } from './lib/api';

type Host = {
  id: string;
  device_id: string;
  state: 'pending' | 'online' | 'paused' | 'offline';
  last_seen: string | null;
  limits: { cpus: number; memory_mib: number } | null;
  capabilities: {
    os: string;
    arch: string;
    engine_arch: string;
    runtime: string;
    cpus: number;
    memory_mib: number;
    disk_mib: number;
    checksum_verified: boolean;
  } | null;
};

export function useHostConnections(enabled: boolean) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await api<Host[]>('/hosts');
        if (active) {
          setHosts(rows);
          setError('');
        }
      } catch {
        if (active) setError('Could not refresh desktop status.');
      } finally {
        if (active) timer = setTimeout(poll, 15000);
      }
    };
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, revision]);
  async function unlink(host: Host) {
    if (!confirm('Unlink this desktop and revoke its access?')) return;
    try {
      await api('/hosts/' + host.id, 'DELETE');
      setHosts((old) => old.filter((h) => h.id !== host.id));
      refresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink this desktop.');
    }
  }
  return { hosts, error, unlink };
}

export function HostConnection({ host, unlink }: { host: Host; unlink: () => void }) {
  const caps = host.capabilities;
  return (
    <div className="host-connection">
      <strong>Desktop · {host.state}</strong>
      {caps && (
        <p>
          {caps.os} · {caps.arch} ·{' '}
          {caps.runtime === 'ready'
            ? `Docker ${caps.engine_arch} · ${caps.cpus} cores · ${(caps.memory_mib / 1024).toFixed(1)} GiB`
            : 'Docker unavailable'}
        </p>
      )}
      {caps && (
        <p>
          CPU checksum {caps.checksum_verified ? 'verified' : 'unverified'} ·{' '}
          {(caps.disk_mib / 1024).toFixed(1)} GiB local disk free
        </p>
      )}
      {host.limits && (
        <p>
          Sharing limit · {host.limits.cpus} cores · {host.limits.memory_mib} MiB
        </p>
      )}
      {host.last_seen && <p>Last seen {new Date(host.last_seen).toLocaleString()}</p>}
      <button type="button" className="underlink" onClick={unlink}>
        Unlink desktop
      </button>
    </div>
  );
}
