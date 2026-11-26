import { Devices } from './Devices';
import { useEffect, useState } from 'react';
import { Activity, CalendarClock, Clock3, Download, Inbox, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { api, apiResponse, usd, type Job } from './lib/api';
import './dashboard.css';
import './marketplace.css';

const groups = {
  active: { label: 'Scheduled & running', empty: 'No scheduled or running jobs', icon: Activity },
  requests: { label: 'Requests', empty: 'No pending requests', icon: Inbox },
  history: { label: 'History', empty: 'No finished jobs yet', icon: Clock3 },
};
type Group = keyof typeof groups;
export type Role = 'renter' | 'host';
type Page = { jobs: Job[]; has_more: boolean };
type Action = 'accept' | 'decline' | 'start' | 'complete' | 'fail_host' | 'fail_job' | 'stop' | 'cancel';
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const outcomes: Record<string, string> = {
  completed: 'Completed',
  renter_stopped: 'Stopped by renter',
  job_error: 'Failed: job error',
  host_side: 'Failed on the host’s side (not charged)',
  no_show: 'Host did not start in time (not charged)',
  host_cancelled: 'Cancelled by host (not charged)',
  renter_cancelled: 'Cancelled by renter',
  declined: 'Declined by host',
  not_accepted: 'Not accepted in time',
};

const actions: Record<Role, Partial<Record<Job['status'], [Action, string][]>>> = {
  renter: {
    requested: [['cancel', 'Cancel request']],
    scheduled: [['cancel', 'Cancel']],
    running: [['stop', 'Stop job']],
  },
  host: {
    requested: [
      ['accept', 'Accept'],
      ['decline', 'Decline'],
    ],
    scheduled: [
      ['start', 'Start job'],
      ['cancel', 'Cancel'],
    ],
    running: [
      ['complete', 'Mark complete'],
      ['fail_host', 'Failed: my side'],
      ['fail_job', 'Failed: job error'],
    ],
  },
};
const confirmations: Partial<Record<Action, string>> = {
  decline: 'Decline this request?',
  cancel: 'Cancel this job?',
  stop: 'Stop this job now? You will be charged for the time used so far.',
  fail_host: 'Mark this job as failed on your side? The renter will not be charged and it counts against your reliability.',
  fail_job: 'Mark this job as failed because of an error in the renter’s job? The renter is charged for time used.',
};

export function JobRow({
  job,
  role,
  onChange,
  detail = false,
}: {
  job: Job;
  role: Role;
  onChange: () => void;
  detail?: boolean;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    setError('');
    try {
      const response = await apiResponse('/jobs/' + job.id + '/result');
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href;
      link.download = job.result_filename || 'result';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      setError('Could not download this result. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function act(action: Action) {
    const question = confirmations[action];
    if (question && !window.confirm(question)) return;
    setBusy(true);
    setError('');
    try {
      await api('/jobs/' + job.id + '/' + action, 'POST');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this job. Please try again.');
    } finally {
      // The job page keeps this row mounted across actions, so always re-enable it.
      setBusy(false);
    }
  }
  const timeline = [
    ['Requested', job.requested_at],
    ['Scheduled', job.scheduled_at],
    ['Started', job.started_at],
    ['Finished', job.finished_at],
  ];
  const rate = role === 'host' ? job.host_payout_per_hr : job.rate_per_hr;
  const charged = job.charged_micros;
  const earned =
    charged !== null && job.rate_per_hr && job.host_payout_per_hr
      ? Math.round((charged * job.host_payout_per_hr) / job.rate_per_hr)
      : null;
  return (
    <article className="job-row">
      <div className="job-heading">
        <h3>{detail ? job.name : <a href={'#job/' + job.id}>{job.name}</a>}</h3>
        <span className={'job-status ' + job.status}>{job.status}</span>
      </div>
      {rate !== null && (
        <p className="job-meta">
          {job.priority && <span className="job-priority">{job.priority}</span>}
          {role === 'host' ? 'You earn' : 'Rate'} ${Number(rate).toFixed(4)}/hr
          {job.est_hours !== null && ` · est. ${Number(job.est_hours)} h`}
          {job.code_link && (
            <>
              {' · '}
              <a className="underlink" href={job.code_link} target="_blank" rel="noopener noreferrer">
                Code link
              </a>
            </>
          )}
        </p>
      )}
      <div className="job-dates">
        {timeline.map(
          ([label, value]) =>
            value && (
              <span key={label}>
                {label} <time dateTime={value}>{date.format(new Date(value))}</time>
              </span>
            ),
        )}
        {job.start_by && (job.status === 'requested' || job.status === 'scheduled') && (
          <span>
            {job.status === 'requested' ? 'Respond by' : 'Start by'}{' '}
            <time dateTime={job.start_by}>{date.format(new Date(job.start_by))}</time>
          </span>
        )}
      </div>
      {job.status === 'running' && (
        <label className="job-progress">
          Progress {job.progress === null ? 'pending' : job.progress + '%'}
          <progress max={100} value={job.progress ?? undefined} />
        </label>
      )}
      {job.outcome_reason && job.outcome_reason !== 'completed' && (
        <p className="job-result">{outcomes[job.outcome_reason] ?? job.outcome_reason}</p>
      )}
      {charged !== null && (
        <p className="job-result">
          {role === 'host' ? `Earned ${usd(earned ?? 0)}` : `Charged ${usd(charged)}`}
        </p>
      )}
      {job.result_summary && <p className="job-result">{job.result_summary}</p>}
      {role === 'renter' && job.result_filename && ['completed', 'failed', 'cancelled'].includes(job.status) && (
        <button className="text-link" disabled={busy} onClick={download}>
          <Download size={15} />
          {busy ? 'Downloading…' : job.result_filename}
        </button>
      )}
      {!detail && job.accepted_at && (
        <a className="underlink job-thread-link" href={'#job/' + job.id}>
          <MessageSquare size={14} /> Messages
        </a>
      )}
      {actions[role][job.status] && (
        <div className="inline-actions job-actions">
          {actions[role][job.status]!.map(([action, label], i) => (
            <button
              key={action}
              className={i === 0 && !confirmations[action] ? 'button' : 'text-link'}
              disabled={busy}
              onClick={() => act(action)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </article>
  );
}

function JobPage({
  group,
  role,
  offset,
  onPage,
}: {
  group: Group;
  role: Role;
  offset: number;
  onPage: (offset: number) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number;
    async function load() {
      try {
        const data = await api<Page>('/jobs?group=' + group + '&role=' + role + '&offset=' + offset);
        if (active) {
          setPage(data);
          setUpdated(new Date());
          setError('');
        }
      } catch {
        if (active) setError('Could not refresh your jobs. Please try again.');
      } finally {
        if (active) timer = window.setTimeout(load, 15000);
      }
    }
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [group, role, offset, reload]);
  const Icon = groups[group].icon;
  const refresh = () => setReload((n) => n + 1);
  return (
    <section className="jobs-panel" aria-label={groups[group].label}>
      <div className="jobs-toolbar">
        <h2>{groups[group].label}</h2>
        <button className="text-link" onClick={refresh}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!page && !error && <p role="status">Loading jobs…</p>}
      {page &&
        (page.jobs.length ? (
          page.jobs.map((job) => <JobRow key={job.id + job.status} job={job} role={role} onChange={refresh} />)
        ) : (
          <div className="jobs-empty">
            <Icon size={34} strokeWidth={1.3} />
            <h3>{offset ? 'No more jobs on this page' : groups[group].empty}</h3>
            {!offset && role === 'renter' && group !== 'history' && (
              <a className="button" href="#new-job">
                <Plus size={16} /> Find a host
              </a>
            )}
          </div>
        ))}
      <div className="jobs-foot">
        {updated && <small>Updated {updated.toLocaleTimeString()}</small>}
        {(offset > 0 || page?.has_more) && (
          <div className="inline-actions">
            <button className="text-link" disabled={!offset} onClick={() => onPage(offset - 20)}>
              Previous
            </button>
            <span>Page {1 + offset / 20}</span>
            <button className="text-link" disabled={!page?.has_more} onClick={() => onPage(offset + 20)}>
              Next
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export default function Dashboard({ host }: { host: boolean }) {
  const [role, setRole] = useState<Role>('renter');
  const [group, setGroup] = useState<Group>('active');
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);

  // While a host has the dashboard open, their available devices count as online.
  useEffect(() => {
    if (!host) return;
    let active = true;
    const beat = () =>
      api('/devices/heartbeat', 'POST')
        .then(() => active && setOnline(true))
        .catch(() => active && setOnline(false));
    beat();
    const timer = window.setInterval(beat, 60000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [host]);

  return (
    <main className="account-shell jobs-shell">
      <div className="workspace-title">
        <h1>Job dashboard.</h1>
        <div className="inline-actions">
          <a href="#new-job" className="button">
            <Plus size={16} /> Find a host
          </a>
          <a href={host ? '#profile' : '#setup'} className="underlink">
            {host ? 'Hosting settings' : 'Set up hosting'}
          </a>
        </div>
      </div>
      {host && (
        <div className="role-switch" role="group" aria-label="Dashboard view">
          {(['renter', 'host'] as Role[]).map((r) => (
            <button
              key={r}
              aria-pressed={role === r}
              onClick={() => {
                setRole(r);
                setOffset(0);
              }}
            >
              {r === 'renter' ? 'Renting' : 'Hosting'}
            </button>
          ))}
          <span className={'presence ' + (online ? 'on' : 'off')}>
            {online === null ? 'Connecting…' : online ? 'Online: available devices can receive jobs' : 'Offline: retrying'}
          </span>
        </div>
      )}
      <nav className="jobs-nav" aria-label="Job views">
        {(Object.keys(groups) as Group[]).map((key) => {
          const Icon = key === 'active' ? CalendarClock : groups[key].icon;
          return (
            <button
              key={key}
              aria-pressed={key === group}
              onClick={() => {
                setGroup(key);
                setOffset(0);
              }}
            >
              <Icon size={16} />
              {groups[key].label}
            </button>
          );
        })}
      </nav>
      <JobPage key={role + group + offset} group={group} role={role} offset={offset} onPage={setOffset} />
      {host && (
        <div className="host-overview">
          <Devices />
        </div>
      )}
    </main>
  );
}
