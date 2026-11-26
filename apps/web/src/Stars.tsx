import { Star } from 'lucide-react';

// Read-only star rating; the accessible name states the exact value.
export default function Stars({ rating, size = 15 }: { rating: number; size?: number }) {
  return (
    <span className="stars" role="img" aria-label={`${rating.toFixed(1)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={size} className={rating >= n - 0.25 ? 'on' : rating >= n - 0.75 ? 'half' : ''} aria-hidden="true" />
      ))}
    </span>
  );
}
