import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Cpu, Leaf, MapPin, Search } from 'lucide-react';
import { api, type Job, type PriorityLevel, type Recommendation } from './lib/api';
import './marketplace.css';

type Search = {
  name: string;
  priority: string;
  hours: string;
  min_vram: string;
  code_link: string;
  zip: string;
  max_miles: string;
  green_only: boolean;
  sort: 'price' | 'rating' | 'green';
};

const ZIP_KEY = 'grove:renter-zip';

function savedZip() {
  try {
    return localStorage.getItem(ZIP_KEY) ?? '';
  } catch {
    return '';
  }
}

function query(search: Search) {
  const params = new URLSearchParams({
    priority: search.priority,
    hours: search.hours,
    min_vram: search.min_vram,
    sort: search.sort,
  });
  if (search.zip) params.set('zip', search.zip);
  if (search.max_miles) params.set('max_miles', search.max_miles);
  if (search.green_only) params.set('green_only', 'true');
  return params.toString();
}

export default function NewJob() {
  const [levels, setLevels] = useState<PriorityLevel[]>([]);
  const [search, setSearch] = useState<Search | null>(null);
  const [hosts, setHosts] = useState<Recommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState('');
  const [booked, setBooked] = useState<Job | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PriorityLevel[]>('/priority-levels')
      .then(setLevels)
      .catch(() => setError('Could not load priority options. Please refresh.'));
  }, []);

  async function find(next: Search) {
    setSearch(next);
    setLoading(true);
    setError('');
    try {
      const result = await api<{ hosts: Recommendation[] }>('/hosts/recommendations?' + query(next));
      setHosts(result.hosts);
    } catch (err) {
      setHosts(null);
      setError(err instanceof Error ? err.message : 'Could not find hosts. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => String(f.get(name) ?? '').trim();
    const zip = text('zip');
    try {
      if (zip) localStorage.setItem(ZIP_KEY, zip);
    } catch {
      /* Remembering the ZIP is only a convenience. */
    }
    find({
      name: text('name'),
      priority: text('priority'),
      hours: text('hours'),
      min_vram: text('min_vram'),
      code_link: text('code_link'),
      zip,
      max_miles: text('max_miles'),
      green_only: f.get('green_only') === 'on',
      sort: search?.sort ?? 'price',
    });
  }

  async function book(host: Recommendation) {
    if (!search) return;
    setBooking(host.host_device_id);
    setError('');
    try {
      const job = await api<Job>('/jobs', 'POST', {
        name: search.name,
        host_device_id: host.host_device_id,
        priority: search.priority,
        hours: search.hours,
        min_vram_gb: Number(search.min_vram),
        code_link: search.code_link,
      });
      setBooked(job);
    } catch (err) {
      // Availability may have changed: refresh the list, then show why booking failed.
      await find(search);
      setError(err instanceof Error ? err.message : 'Could not book this host. Please try again.');
    } finally {
      setBooking('');
    }
  }

  if (booked) {
    return (
      <main className="account-shell market-shell">
        <section className="jobs-panel booked">
          <h1>{booked.status === 'scheduled' ? 'Your job is booked.' : 'Request sent.'}</h1>
          <p>
            {booked.status === 'scheduled'
              ? 'The host accepted automatically and will start your job shortly.'
              : 'The host reviews each request. You will see it move to scheduled once accepted.'}
          </p>
          <a className="button" href="#account">
            Go to dashboard <ArrowRight size={16} />
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="account-shell market-shell">
      <div className="workspace-title">
        <h1>Find a host.</h1>
        <a href="#account" className="underlink">
          <ArrowLeft size={14} /> Dashboard
        </a>
      </div>
      <form className="jobs-panel job-form" onSubmit={submit}>
        <label className="field">
          Job name
          <input name="name" required maxLength={200} placeholder="Fine-tune sentiment model" />
        </label>
        <fieldset className="priority-options">
          <legend>Priority</legend>
          {levels.map((level, i) => (
            <label key={level.id} className="priority-option">
              <input type="radio" name="priority" value={level.id} defaultChecked={i === levels.length - 1} required />
              <span>
                <strong>
                  {level.label} · {Number(level.multiplier).toFixed(1)}×
                </strong>
                <small>{level.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="spec-grid">
          <label className="field">
            Estimated hours
            <input name="hours" type="number" min="0.01" max="168" step="0.01" defaultValue="1" required />
          </label>
          <label className="field">
            GPU memory needed
            <select name="min_vram" defaultValue="0">
              <option value="0">Any</option>
              {[8, 12, 16, 24].map((gb) => (
                <option key={gb} value={gb}>
                  {gb} GB or more
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Your ZIP code (optional)
            <input name="zip" inputMode="numeric" pattern="\d{5}" title="Five-digit US ZIP code" defaultValue={savedZip()} placeholder="14850" />
          </label>
          <label className="field">
            Distance
            <select name="max_miles" defaultValue="">
              <option value="">Any distance</option>
              <option value="50">Within 50 miles</option>
              <option value="250">Within 250 miles</option>
              <option value="1000">Within 1,000 miles</option>
            </select>
          </label>
        </div>
        <label className="field">
          Notebook or script link (optional)
          <input name="code_link" type="url" pattern="https?://.+" maxLength={2000} placeholder="https://github.com/you/project" />
        </label>
        <label className="consent">
          <input type="checkbox" name="green_only" /> Only show hosts on renewable energy
        </label>
        <button className="button" disabled={loading || !levels.length}>
          <Search size={16} /> {loading ? 'Searching…' : 'Find hosts'}
        </button>
      </form>

      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}

      {search && hosts && (
        <section className="jobs-panel" aria-label="Recommended hosts">
          <div className="jobs-toolbar">
            <h2>
              {hosts.length} {hosts.length === 1 ? 'host' : 'hosts'} available
            </h2>
            <label className="sort-select">
              Sort by
              <select value={search.sort} onChange={(e) => find({ ...search, sort: e.target.value as Search['sort'] })}>
                <option value="price">Lowest price</option>
                <option value="rating">Highest rated</option>
                <option value="green">Renewable first</option>
              </select>
            </label>
          </div>
          {hosts.length ? (
            <ul className="host-list">
              {hosts.map((host) => (
                <li key={host.host_device_id} className="host-card-row">
                  <Cpu size={26} strokeWidth={1.4} />
                  <div className="host-info">
                    <h3>{host.gpu_label}</h3>
                    <p>
                      {host.device_name} · {host.host_name} · {host.vram_gb} GB VRAM
                    </p>
                    <div className="host-tags">
                      {host.green_energy && (
                        <span className="tag-green">
                          <Leaf size={12} /> Renewable
                        </span>
                      )}
                      {host.distance_miles !== null && (
                        <span>
                          <MapPin size={12} /> ~{host.distance_miles.toLocaleString()} mi
                        </span>
                      )}
                      {host.state && <span>{host.state}</span>}
                      <span>{host.rating === null ? 'New host' : `${host.rating.toFixed(1)} ★ (${host.review_count})`}</span>
                    </div>
                  </div>
                  <div className="host-price">
                    <strong>${host.rate_per_hr}/hr</strong>
                    <small>
                      ≈ ${host.estimate} total · ${host.reserve} reserved
                    </small>
                    <button className="button" disabled={!!booking} onClick={() => book(host)}>
                      {booking === host.host_device_id ? 'Booking…' : 'Book'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="jobs-empty">
              <Cpu size={34} strokeWidth={1.3} />
              <h3>No hosts match right now</h3>
              <p>Try Standard priority, less GPU memory, a wider distance, or check back soon.</p>
            </div>
          )}
          <p className="fine-print">
            Prices are set by Grove and usage is metered per second. The reserved amount covers your estimate
            plus 25%; you only pay for time used, and nothing if the host's side fails.
          </p>
        </section>
      )}
    </main>
  );
}
