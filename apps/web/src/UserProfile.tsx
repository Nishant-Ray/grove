import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import Stars from './Stars';
import { api } from './lib/api';
import './dashboard.css';
import './marketplace.css';
import './reviews.css';

type Profile = {
  id: string;
  display_name: string;
  host: { rating: number | null; reviews: number; jobs_completed: number; completion_rate: number | null };
  renter: { rating: number | null; reviews: number };
  reviews: { id: string; reviewer_name: string; reviewer_role: 'renter' | 'host'; rating: number; comment: string; created_at: string }[];
};
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function Score({ label, rating, count }: { label: string; rating: number | null; count: number }) {
  return (
    <div className="score">
      <span>{label}</span>
      {rating === null ? (
        <strong>No reviews yet</strong>
      ) : (
        <strong>
          {Number(rating).toFixed(1)} <Stars rating={Number(rating)} /> <small>({count})</small>
        </strong>
      )}
    </div>
  );
}

export default function UserProfile({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Profile>('/users/' + userId + '/profile')
      .then(setProfile)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this profile.'));
  }, [userId]);
  return (
    <main className="account-shell market-shell">
      <div className="workspace-title">
        <h1>{profile ? profile.display_name : 'Profile'}</h1>
        <a href="#account" className="underlink">
          <ArrowLeft size={14} /> Dashboard
        </a>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!profile && !error && <p role="status">Loading profile…</p>}
      {profile && (
        <>
          <section className="jobs-panel scores" aria-label="Reputation">
            <Score label="As a host" rating={profile.host.rating} count={profile.host.reviews} />
            <div className="score">
              <span>Jobs completed as host</span>
              <strong>
                {profile.host.jobs_completed}
                {profile.host.completion_rate !== null && (
                  <small> · {Math.round(Number(profile.host.completion_rate) * 100)}% of accepted jobs</small>
                )}
              </strong>
            </div>
            <Score label="As a renter" rating={profile.renter.rating} count={profile.renter.reviews} />
          </section>
          <section className="jobs-panel" aria-label="Reviews received">
            <div className="jobs-toolbar">
              <h2>Reviews</h2>
            </div>
            {profile.reviews.length ? (
              <ul className="review-list">
                {profile.reviews.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{r.reviewer_name}</strong>
                      <small> as {r.reviewer_role}</small> <Stars rating={r.rating} />
                      <time dateTime={r.created_at}>{when.format(new Date(r.created_at))}</time>
                    </div>
                    {r.comment && <p>{r.comment}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="thread-empty">No reviews yet.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
