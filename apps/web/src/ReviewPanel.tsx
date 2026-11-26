import { useState, type FormEvent } from 'react';
import { Star } from 'lucide-react';
import Stars from './Stars';
import { api, type JobDetail, type Review } from './lib/api';
import './reviews.css';

function Quote({ who, review }: { who: string; review: Review }) {
  return (
    <figure className="review-quote">
      <figcaption>
        <strong>{who}</strong> <Stars rating={review.rating} />
      </figcaption>
      {review.comment && <blockquote>{review.comment}</blockquote>}
    </figure>
  );
}

export default function ReviewPanel({ detail, onSaved }: { detail: JobDetail; onSaved: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { mine, theirs, can_review } = detail.reviews;
  const other = detail.role === 'renter' ? detail.host_name : detail.renter_name;
  const otherId = detail.role === 'renter' ? detail.job.host_id : detail.job.owner_id;
  if (detail.job.status !== 'completed' && !mine && !theirs) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!rating) return setError('Choose a rating from 1 to 5 stars.');
    setBusy(true);
    setError('');
    try {
      await api('/jobs/' + detail.job.id + '/review', 'POST', { rating, comment });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your review.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-panel review-panel" aria-label="Reviews">
      <div className="jobs-toolbar">
        <h2>Reviews</h2>
        {otherId && (
          <a className="underlink" href={'#user/' + otherId}>
            {other}'s profile
          </a>
        )}
      </div>
      {mine && <Quote who="Your review" review={mine} />}
      {theirs && <Quote who={`${other}'s review of you`} review={theirs} />}
      {can_review ? (
        <form onSubmit={submit} className="review-form">
          <fieldset className="star-input">
            <legend>How was working with {other}?</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className={n <= rating ? 'on' : ''}>
                <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} />
                <Star size={26} aria-hidden="true" />
                <span className="visually-hidden">
                  {n} {n === 1 ? 'star' : 'stars'}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            Comment (optional)
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={3}
              placeholder={detail.role === 'renter' ? 'Was the host reliable and quick to start?' : 'Were the instructions and data clear?'} />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="button" disabled={busy}>
            {busy ? 'Posting…' : 'Post review'}
          </button>
          <p className="fine-print">Reviews are public to Grove members and can't be edited later.</p>
        </form>
      ) : (
        !mine && <p className="fine-print">Reviews close 14 days after a job completes.</p>
      )}
    </section>
  );
}
