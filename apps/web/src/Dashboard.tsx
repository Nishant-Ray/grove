import { Devices } from './Devices';
import { useEffect, useState } from 'react';
import { Activity, CalendarClock, Clock3, Download, Inbox, RefreshCw } from 'lucide-react';
import { api, apiResponse } from './lib/api';
import './dashboard.css';

const groups = {
  active: { label: 'Scheduled & running', empty: 'No scheduled or running jobs', icon: Activity },
  requests: { label: 'Requests', empty: 'No pending requests', icon: Inbox },
  history: { label: 'History', empty: 'No finished jobs yet', icon: Clock3 },
};
type Group = keyof typeof groups;
type Job = {
  id: string;
  name: string;
  status: string;
  progress: number | null;
  requested_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  result_filename: string | null;
};
type Page = { jobs: Job[]; has_more: boolean };
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function JobRow({ job }: { job: Job }) {
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
  const timeline = [
    ['Requested', job.requested_at],
    ['Scheduled', job.scheduled_at],
    ['Started', job.started_at],
    ['Finished', job.finished_at],
  ];
  return (
    <article className="job-row">
      <div className="job-heading">
        <h3>{job.name}</h3>
        <span className={'job-status ' + job.status}>{job.status}</span>
      </div>
      <div className="job-dates">
        {timeline.map(
          ([label, value]) =>
            value && (
              <span key={label}>
                {label} <time dateTime={value}>{date.format(new Date(value))}</time>
              </span>
            ),
        )}
      </div>
      {job.status === 'running' && (
        <label className="job-progress">
          Progress {job.progress === null ? 'pending' : job.progress + '%'}
          <progress max={100} value={job.progress ?? undefined} />
        </label>
      )}
      {job.result_summary && <p className="job-result">{job.result_summary}</p>}
      {job.result_filename && ['completed', 'failed', 'cancelled'].includes(job.status) && (
        <button className="text-link" disabled={busy} onClick={download}>
          <Download size={15} />
          {busy ? 'Downloading…' : job.result_filename}
        </button>
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
  offset,
  onPage,
}: {
  group: Group;
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
        const data = await api<Page>('/jobs?group=' + group + '&offset=' + offset);
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
  }, [group, offset, reload]);
  const Icon = groups[group].icon;
  return (
    <section className="jobs-panel" aria-label={groups[group].label}>
      <div className="jobs-toolbar">
        <h2>{groups[group].label}</h2>
        <button className="text-link" onClick={() => setReload((n) => n + 1)}>
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
          page.jobs.map((job) => <JobRow key={job.id} job={job} />)
        ) : (
          <div className="jobs-empty">
            <Icon size={34} strokeWidth={1.3} />
            <h3>{offset ? 'No more jobs on this page' : groups[group].empty}</h3>
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
            <button
              className="text-link"
              disabled={!page?.has_more}
              onClick={() => onPage(offset + 20)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export default function Dashboard({ host }: { host: boolean }) {
  const [group, setGroup] = useState<Group>('active');
  const [offset, setOffset] = useState(0);
  return (
    <main className="account-shell jobs-shell">
      <div className="workspace-title">
        <h1>Job dashboard.</h1>
        <a href={host ? '#profile' : '#setup'} className="underlink">
          {host ? 'Hosting settings' : 'Set up hosting'}
        </a>
      </div>
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
      <JobPage key={group + offset} group={group} offset={offset} onPage={setOffset} />
      {host && (
        <div className="host-overview">
          <Devices />
        </div>
      )}
    </main>
  );
}
