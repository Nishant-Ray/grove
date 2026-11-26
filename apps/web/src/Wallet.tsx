import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Banknote, CreditCard, RefreshCw } from 'lucide-react';
import { api, usd, usdPrecise } from './lib/api';
import './dashboard.css';
import './marketplace.css';
import './wallet.css';

type Entry = {
  id: number;
  kind: 'topup' | 'reserve' | 'release' | 'charge' | 'host_earning' | 'grove_fee' | 'withdrawal' | 'withdrawal_reversal';
  amount_micros: number;
  job_id: string | null;
  created_at: string;
  job: { name: string } | null;
};
type WalletData = {
  balance_micros: number;
  reserved_micros: number;
  earnings_micros: number;
  available_micros: number;
  activity: Entry[];
  payouts: { details_submitted: boolean; payouts_enabled: boolean } | null;
  withdrawals: { id: string; amount_micros: number; status: 'pending' | 'paid' | 'failed'; created_at: string }[];
  limits: { min_topup_usd: number; max_topup_usd: number; min_withdrawal_usd: number };
};

const labels: Record<Entry['kind'], [string, '+' | '-' | '']> = {
  topup: ['Credits added', '+'],
  reserve: ['Reserved for a job', ''],
  release: ['Reserve released', ''],
  charge: ['Compute used', '-'],
  host_earning: ['Earned from a job', '+'],
  grove_fee: ['Grove fee', ''],
  withdrawal: ['Withdrawn to bank', '-'],
  withdrawal_reversal: ['Withdrawal returned', '+'],
};
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Read and clear ?checkout=… / ?payouts=… that Stripe appends when sending people back.
function takeReturnParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.size) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  return params;
}

export default function Wallet({ host }: { host: boolean }) {
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    try {
      const wallet = await api<WalletData>('/wallet');
      setData(wallet);
      setAmount((current) => current || (Math.floor(wallet.earnings_micros / 10_000) / 100).toFixed(2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your wallet.');
    }
  }, []);

  useEffect(() => {
    const params = takeReturnParams();
    (async () => {
      const session = params.get('session_id');
      if (params.get('checkout') === 'success' && session) {
        try {
          const result = await api<{ credited: boolean; payment_status: string; amount_usd: number }>(
            '/wallet/checkout/confirm', 'POST', { session_id: session },
          );
          setNotice(
            result.payment_status === 'paid'
              ? `Payment received: $${result.amount_usd.toFixed(2)} in credits added.`
              : 'Payment is processing. Credits are added as soon as Stripe confirms it.',
          );
        } catch {
          setNotice('Payment received. Your credits will appear shortly.');
        }
      } else if (params.get('checkout') === 'cancelled') {
        setNotice('Checkout cancelled. You were not charged.');
      } else if (params.get('payouts')) {
        try {
          const status = await api<{ payouts_enabled: boolean }>('/payouts/refresh', 'POST');
          setNotice(status.payouts_enabled ? 'Payouts are set up. You can withdraw your earnings.' : 'Stripe needs a few more details before payouts can start.');
        } catch {
          /* status shows on the card below */
        }
      }
      load();
    })();
  }, [load]);

  async function redirect(path: string, body?: unknown) {
    setBusy(path);
    setError('');
    try {
      const { url } = await api<{ url: string }>(path, 'POST', body);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Please try again.');
      setBusy('');
    }
  }

  async function withdraw(event: FormEvent) {
    event.preventDefault();
    setBusy('withdraw');
    setError('');
    setNotice('');
    try {
      await api('/payouts/withdraw', 'POST', { amount_usd: amount });
      setNotice(`$${Number(amount).toFixed(2)} is on its way to your Stripe account.`);
      setAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal failed. Please try again.');
    } finally {
      setBusy('');
      load();
    }
  }

  const topUps = data ? [10, 25, 50, 100].filter((n) => n >= data.limits.min_topup_usd && n <= data.limits.max_topup_usd) : [];
  const showEarnings = data && (host || data.earnings_micros > 0 || data.payouts || data.withdrawals.length > 0);
  return (
    <main className="account-shell market-shell">
      <div className="workspace-title">
        <h1>Wallet.</h1>
        <button className="text-link" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {notice && (
        <p role="status" className="wallet-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Loading wallet…</p>}
      {data && (
        <>
          <section className="jobs-panel wallet-card" aria-label="Compute credits">
            <div className="wallet-head">
              <CreditCard size={22} strokeWidth={1.5} />
              <h2>Compute credits</h2>
            </div>
            <p className="wallet-amount" data-testid="available">
              {usd(data.available_micros)}
              <small> available</small>
            </p>
            <p className="wallet-sub">
              {usd(data.balance_micros)} balance · {usd(data.reserved_micros)} reserved for active jobs
            </p>
            <div className="topup-row">
              {topUps.map((n) => (
                <button key={n} className="button" disabled={!!busy} onClick={() => redirect('/wallet/checkout', { amount_usd: n })}>
                  Add ${n}
                </button>
              ))}
            </div>
            <p className="fine-print">
              Payments are processed by Stripe. Booking reserves your estimate plus 25%; you pay per second for the time
              used and nothing if the host's side fails.
            </p>
          </section>

          {showEarnings && (
            <section className="jobs-panel wallet-card" aria-label="Host earnings">
              <div className="wallet-head">
                <Banknote size={22} strokeWidth={1.5} />
                <h2>Host earnings</h2>
              </div>
              <p className="wallet-amount" data-testid="earnings">
                {usd(data.earnings_micros)}
                <small> ready to withdraw</small>
              </p>
              {!data.payouts?.payouts_enabled ? (
                <>
                  <p className="wallet-sub">
                    {data.payouts?.details_submitted
                      ? 'Stripe is reviewing your details. This usually takes a few minutes.'
                      : 'Connect a bank account through Stripe to withdraw. You keep earning in the meantime.'}
                  </p>
                  <button className="button" disabled={!!busy} onClick={() => redirect('/payouts/onboard')}>
                    {data.payouts ? 'Continue payout setup' : 'Set up payouts'} <ArrowUpRight size={15} />
                  </button>
                </>
              ) : (
                <form className="withdraw-form" onSubmit={withdraw}>
                  <label className="field">
                    Amount (USD)
                    <input
                      type="number"
                      min={data.limits.min_withdrawal_usd}
                      step="0.01"
                      max={data.earnings_micros / 1_000_000}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </label>
                  <button className="button" disabled={!!busy || data.earnings_micros < data.limits.min_withdrawal_usd * 1_000_000}>
                    {busy === 'withdraw' ? 'Sending…' : 'Withdraw'}
                  </button>
                  <p className="fine-print">Minimum ${Number(data.limits.min_withdrawal_usd).toFixed(2)}. Sent to your Stripe account.</p>
                </form>
              )}
            </section>
          )}

          <section className="jobs-panel" aria-label="Activity">
            <div className="jobs-toolbar">
              <h2>Activity</h2>
            </div>
            {data.activity.length ? (
              <ul className="ledger">
                {data.activity.map((e) => {
                  const [label, sign] = labels[e.kind];
                  return (
                    <li key={e.id} className={'ledger-row ' + (sign === '+' ? 'in' : sign === '-' ? 'out' : 'info')}>
                      <span>
                        <strong>{label}</strong>
                        {e.job_id && e.job && (
                          <a className="underlink" href={'#job/' + e.job_id}>
                            {e.job.name}
                          </a>
                        )}
                        <time dateTime={e.created_at}>{when.format(new Date(e.created_at))}</time>
                      </span>
                      <b>
                        {sign}
                        {usdPrecise(e.amount_micros)}
                      </b>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="thread-empty">No activity yet. Add credits to book your first job.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
