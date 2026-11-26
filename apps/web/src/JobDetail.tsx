import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, MessageSquare, Send } from 'lucide-react';
import { JobRow } from './Dashboard';
import { api, type JobDetail as Detail, type Message } from './lib/api';
import './dashboard.css';
import './marketplace.css';
import './messages.css';

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Thread({ jobId, detail }: { jobId: string; detail: Detail }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const latest = useRef<string | null>(null);
  const other = detail.role === 'renter' ? detail.host_name : detail.renter_name;

  const seen = useRef(new Set<string>());

  // Adds messages not seen before and returns them (polls overlap by design).
  const merge = useCallback((incoming: Message[]) => {
    const added = incoming.filter((m) => !seen.current.has(m.id));
    if (!added.length) return added;
    added.forEach((m) => seen.current.add(m.id));
    setMessages((current) => [...current, ...added]);
    latest.current = added[added.length - 1].created_at;
    return added;
  }, []);

  const markRead = useCallback(() => {
    api('/jobs/' + jobId + '/messages/read', 'POST').catch(() => undefined);
  }, [jobId]);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const query = latest.current ? '?after=' + encodeURIComponent(latest.current) : '';
        const result = await api<{ messages: Message[] }>('/jobs/' + jobId + '/messages' + query);
        if (!active) return;
        if (merge(result.messages).some((m) => !m.mine)) markRead();
        setLoaded(true);
        setError('');
      } catch {
        if (active) setError('Could not load messages. Retrying…');
      }
    }
    poll();
    markRead();
    const timer = window.setInterval(poll, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId, merge, markRead]);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      merge([await api<Message>('/jobs/' + jobId + '/messages', 'POST', { body })]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <section className="jobs-panel thread" aria-label="Messages">
      <div className="jobs-toolbar">
        <h2>Messages</h2>
        <small>with {other}</small>
      </div>
      {!loaded && !error && <p role="status">Loading messages…</p>}
      {loaded && !messages.length && (
        <p className="thread-empty">
          No messages yet. Say hello to {other}: share data links, setup notes or questions about the run.
        </p>
      )}
      <ol className="thread-list" ref={list} aria-live="polite">
        {messages.map((m) => (
          <li key={m.id} className={m.mine ? 'bubble mine' : 'bubble'}>
            <span className="bubble-who">{m.mine ? 'You' : other}</span>
            <p>{m.body}</p>
            <time dateTime={m.created_at}>{time.format(new Date(m.created_at))}</time>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {detail.messaging.can_send ? (
        <form className="composer" onSubmit={send}>
          <label className="visually-hidden" htmlFor="message-body">
            Message {other}
          </label>
          <textarea
            id="message-body"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            maxLength={2000}
            rows={2}
            placeholder={`Message ${other}…`}
          />
          <button className="button" disabled={sending || !draft.trim()} aria-label="Send message">
            <Send size={16} />
          </button>
        </form>
      ) : (
        <p className="fine-print">This conversation is closed. Messaging stays open for 14 days after a job ends.</p>
      )}
    </section>
  );
}

export default function JobDetail({ jobId }: { jobId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    api<Detail>('/jobs/' + jobId)
      .then((d) => active && setDetail(d))
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Could not load this job.'));
    return () => {
      active = false;
    };
  }, [jobId, reload]);

  return (
    <main className="account-shell market-shell">
      <div className="workspace-title">
        <h1>{detail ? detail.job.name : 'Job'}</h1>
        <a href="#account" className="underlink">
          <ArrowLeft size={14} /> Dashboard
        </a>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!detail && !error && <p role="status">Loading job…</p>}
      {detail && (
        <>
          <section className="jobs-panel">
            <p className="job-parties">
              {detail.role === 'renter'
                ? `Running on ${detail.device_name}, hosted by ${detail.host_name}`
                : `${detail.renter_name}'s job on your ${detail.device_name}`}
            </p>
            <JobRow job={detail.job} role={detail.role} onChange={() => setReload((n) => n + 1)} detail />
          </section>
          {detail.messaging.visible ? (
            <Thread jobId={jobId} detail={detail} />
          ) : (
            <section className="jobs-panel jobs-empty">
              <MessageSquare size={30} strokeWidth={1.3} />
              <h3>Messaging opens once the host accepts</h3>
            </section>
          )}
        </>
      )}
    </main>
  );
}
