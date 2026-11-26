import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Cpu, Leaf, Monitor, Sprout } from 'lucide-react';
import Onboarding from './Onboarding';
import Dashboard from './Dashboard';
import NewJob from './NewJob';
import JobDetail from './JobDetail';
import Wallet from './Wallet';
import UserProfile from './UserProfile';
import Notifications from './Notifications';
import Network from './Network';
import { Account, Auth } from './Account';
import { api, type Profile } from './lib/api';
import './account.css';

function currentPage() {
  const hash = window.location.hash.slice(1);
  if (/^(job|user)\/[0-9a-f-]{36}$/.test(hash)) return hash;
  return ['register', 'login', 'account', 'profile', 'setup', 'new-job', 'wallet'].includes(hash) ? hash : 'home';
}

export default function App() {
  const [page, setPage] = useState(currentPage);
  const [user, setUser] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);
  const [restoreError, setRestoreError] = useState('');

  useEffect(() => {
    let active = true;
    const go = () => {
      setPage(currentPage());
      if (currentPage() !== 'home') window.scrollTo(0, 0);
    };
    const signedOut = () => {
      if (active) setUser(null);
    };
    window.addEventListener('hashchange', go);
    window.addEventListener('grove:signed-out', signedOut);
    api<Profile>('/profile')
      .then((profile) => {
        if (active) setUser(profile);
      })
      .catch((error) => {
        if (active && error.status !== 401) setRestoreError('Your workspace could not be loaded.');
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      window.removeEventListener('hashchange', go);
      window.removeEventListener('grove:signed-out', signedOut);
    };
  }, []);

  function enter(profile: Profile) {
    setUser(profile);
    setRestoreError('');
    window.location.hash = 'account';
  }

  const needsSetup = user?.workspace_mode === 'new' || user?.workspace_mode === 'host_setup';
  const start = user ? '#account' : '#register';
  return (
    <>
      <header className="site-header grove-header">
        <a className="brand" href="#" aria-label="Grove home">
          <Sprout size={30} />
          <span>grove</span>
        </a>
        <nav aria-label="Main navigation">
          {user && <Notifications key={user.email} />}
          {user && needsSetup ? (
            <a href="#profile" className="text-link">
              Account settings
            </a>
          ) : user ? (
            <>
              <a
                className="text-link"
                href="#account"
                aria-current={page !== 'profile' && page !== 'wallet' ? 'page' : undefined}
              >
                Dashboard
              </a>
              <a className="text-link" href="#wallet" aria-current={page === 'wallet' ? 'page' : undefined}>
                Wallet
              </a>
              <a
                className="text-link"
                href="#profile"
                aria-current={page === 'profile' ? 'page' : undefined}
              >
                Profile &amp; devices
              </a>
            </>
          ) : (
            <>
              <a className="text-link" href="#login">
                Log in
              </a>
              <a className="button nav-cta" href="#register">
                Sign up <ArrowUpRight size={15} />
              </a>
            </>
          )}
        </nav>
      </header>
      {page === 'home' && !user ? (
        <main>
          <section className="hero">
            <div className="hero-copy">
              <h1>
                Big ideas.
                <br />A little <em>spare power.</em>
              </h1>
              <p>
                Your next breakthrough shouldn’t need a new computer. Bring your project or share
                the hardware you already own.
              </p>
              <div className="hero-actions">
                <a className="button" href={start}>
                  {user ? 'Open workspace' : 'Join Grove'} <ArrowUpRight size={17} />
                </a>
                <a className="text-link" href="#how-it-works">
                  How it works <ArrowRight size={15} />
                </a>
              </div>
            </div>
            <Network />
          </section>
          <div className="principles">
            <span>
              <Cpu size={17} /> Shared compute
            </span>
            <span>
              <Monitor size={17} /> Community hardware
            </span>
            <span>
              <Leaf size={17} /> A longer life for every device
            </span>
          </div>
          <section id="how-it-works" className="section audience">
            <div className="section-heading">
              <h2>
                Someone needs power.
                <br />
                <em>Someone has it to spare.</em>
              </h2>
            </div>
            <div className="audience-grid">
              <article className="audience-card user-card">
                <span className="icon-box">
                  <Sprout />
                </span>
                <h3>Bring your ideas.</h3>
                <p>
                  Set up your Grove profile. One account gives you a home for your work and the
                  hardware you share.
                </p>
                <a href={start} className="text-link">
                  Open your workspace <ArrowRight size={16} />
                </a>
              </article>
              <article className="audience-card host-card">
                <span className="icon-box">
                  <Monitor />
                </span>
                <h3>List your hardware.</h3>
                <p>
                  Add your device, describe its compute capabilities, and choose when it’s
                  available. You can pause a listing at any time.
                </p>
                <a href={start} className="text-link">
                  Become a host <ArrowRight size={16} />
                </a>
              </article>
            </div>
          </section>
          <section className="environment" id="our-thinking">
            <div className="environment-art" aria-hidden="true">
              <div className="tree-rings">
                <div />
                <div />
                <div />
                <div />
                <div />
              </div>
              <Sprout className="big-sprout" strokeWidth={0.8} />
              <span className="art-caption">MORE LIFE IN EVERY DEVICE.</span>
            </div>
            <div className="environment-copy">
              <span className="eyebrow">GOOD THINGS DESERVE A LONGER LIFE</span>
              <h2>
                The next frontier
                <br />
                might already be
                <br />
                <em>on your desk.</em>
              </h2>
              <p>
                Every computer carries the resources it took to make it. We believe there’s more we
                can do with the hardware we already have.
              </p>
              <p>
                By connecting spare capacity with real projects, Grove aims to make devices useful
                for longer—and reduce the need to build more.
              </p>
              <div className="environment-note">
                <Leaf size={20} />
                <span>
                  Our focus is hardware reuse. Environmental benefits depend on the hardware,
                  electricity, and new purchases reuse can help avoid.
                </span>
              </div>
            </div>
          </section>
        </main>
      ) : !ready ? (
        <main className="account-shell">Loading your workspace…</main>
      ) : user && (page === 'setup' || (needsSetup && page !== 'profile')) ? (
        <Onboarding user={user} onChange={setUser} />
      ) : user && page === 'new-job' ? (
        <NewJob />
      ) : user && page === 'wallet' ? (
        <Wallet host={user.workspace_mode === 'host'} />
      ) : user && page.startsWith('user/') ? (
        <UserProfile key={page} userId={page.slice(5)} />
      ) : user && page.startsWith('job/') ? (
        <JobDetail key={page} jobId={page.slice(4)} />
      ) : user && page !== 'profile' ? (
        <Dashboard host={user.workspace_mode === 'host'} />
      ) : user ? (
        <Account
          user={user}
          onProfile={setUser}
          onLogout={() => {
            setUser(null);
            window.location.hash = '';
          }}
        />
      ) : (page === 'account' || page === 'profile') && restoreError ? (
        <main className="account-shell">
          <p role="alert">{restoreError}</p>
          <button className="button" onClick={() => location.reload()}>
            Retry
          </button>
        </main>
      ) : (
        <Auth key={page} register={page === 'register'} onLogin={enter} />
      )}
      <footer>
        <a className="brand" href="#">
          <Sprout size={24} />
          <span>grove</span>
        </a>
        <span>Shared compute. Existing hardware.</span>
      </footer>
    </>
  );
}
