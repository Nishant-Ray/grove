import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from './lib/api';
import './notifications.css';

type Notification = {
  id: string;
  kind: string;
  job_id: string | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
};
type Feed = { notifications: Notification[]; unread: number; unread_more: boolean };

const ago = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function when(iso: string) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (minutes > -1) return 'just now';
  if (minutes > -60) return ago.format(minutes, 'minute');
  if (minutes > -1440) return ago.format(Math.round(minutes / 60), 'hour');
  return ago.format(Math.round(minutes / 1440), 'day');
}

export default function Notifications() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setFeed(await api<Feed>('/notifications?limit=20'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30000);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  async function markRead(ids?: string[]) {
    if (!feed) return;
    const now = new Date().toISOString();
    const target = new Set(ids ?? feed.notifications.map((n) => n.id));
    setFeed({
      ...feed,
      unread: ids ? Math.max(0, feed.unread - feed.notifications.filter((n) => target.has(n.id) && !n.read_at).length) : 0,
      notifications: feed.notifications.map((n) => (target.has(n.id) && !n.read_at ? { ...n, read_at: now } : n)),
    });
    try {
      await api('/notifications/read', 'POST', ids ? { ids } : {});
    } finally {
      load();
    }
  }

  const unread = feed?.unread ?? 0;
  const label = unread ? `Notifications, ${unread}${feed?.unread_more ? '+' : ''} unread` : 'Notifications';
  return (
    <div className="notify" ref={root}>
      <button
        className="notify-bell"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen(!open);
          if (!open) load();
        }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="notify-badge" aria-hidden="true">
            {unread}
            {feed?.unread_more ? '+' : ''}
          </span>
        )}
      </button>
      {open && (
        <div className="notify-panel" role="region" aria-label="Notifications">
          <div className="notify-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="text-link" onClick={() => markRead()}>
                Mark all read
              </button>
            )}
          </div>
          {error && !feed && <p className="notify-empty">Could not load notifications.</p>}
          {feed && !feed.notifications.length && <p className="notify-empty">You're all caught up.</p>}
          <ul>
            {feed?.notifications.map((n) => (
              <li key={n.id}>
                <a
                  href="#account"
                  className={n.read_at ? 'notify-item' : 'notify-item unread'}
                  onClick={() => {
                    if (!n.read_at) markRead([n.id]);
                    setOpen(false);
                  }}
                >
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                  <time dateTime={n.created_at}>{when(n.created_at)}</time>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
