import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Schemas } from './api/client.js';
import { useSession } from './auth/session.js';
import { ApplicationDetail } from './routes/ApplicationDetail.js';
import { Candidates } from './routes/Candidates.js';
import { Directory } from './routes/Directory.js';
import { Login } from './routes/Login.js';
import { MyRounds } from './routes/MyRounds.js';
import { Pipeline } from './routes/Pipeline.js';
import { Reqs } from './routes/Reqs.js';
import { RoundDetail } from './routes/RoundDetail.js';
import { Avatar, Icon, roleLabel } from './components/ui.js';

type Role = Schemas['PublicUser']['role'];

/**
 * Nothing here decides what a role may see — the API does, and it answers 403 or 404 on
 * its own terms. The navigation hides links that would only produce a 403, which is a
 * courtesy to the user and not a security boundary: typing the URL still reaches the
 * request, and the request still gets refused by the server.
 *
 * Keyed by role rather than filtered by it, so a role added to the API without a screen
 * here is a compile error rather than an empty header.
 */
const NAV: Record<Role, Array<{ to: string; label: string }>> = {
  RECRUITER: [
    { to: '/', label: 'Pipeline' },
    { to: '/candidates', label: 'Candidates' },
    { to: '/directory', label: 'Directory' },
    { to: '/reqs', label: 'Requisitions' },
  ],
  HIRING_MANAGER: [
    { to: '/', label: 'Pipeline' },
    { to: '/candidates', label: 'Candidates' },
    { to: '/reqs', label: 'Requisitions' },
  ],
  INTERVIEWER: [{ to: '/', label: 'My rounds' }],
};

/**
 * `/` is the one landing route: every role signs in and arrives here, and what it renders
 * is the screen that role starts their day on. The alternative — redirecting each role to
 * a different path — means the address of "the app" depends on who you are, which makes
 * a shared link role-specific for no benefit.
 */
function Home({ role }: { role: Role }) {
  return role === 'INTERVIEWER' ? <MyRounds /> : <Pipeline />;
}

export function App() {
  const { user, ready, signOut } = useSession();

  // Until the stored token has been checked against `GET /auth/me`, showing either the
  // app or the login form would be a guess.
  if (!ready) {
    return (
      <div className="centered">
        <span className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  /**
   * Signed out: `/login` is the only route that renders, and everything else redirects to
   * it. The intended destination is deliberately not remembered — every sign-in lands on
   * `/`, so there is no half-restored state to get wrong.
   */
  if (user === null) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="logo">
              <Icon name="logo" />
            </span>
            Recruitment Pipeline
          </Link>
          <nav className="mainnav" aria-label="Main">
            {NAV[user.role].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                // Without `end`, `/` would match every path and stay highlighted everywhere.
                end={item.to === '/'}
                className={({ isActive }) => (isActive ? 'active' : '')}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="account">
            <span className="account-text">
              <span className="account-name">{user.name}</span>
              <span className="account-role">{roleLabel(user.role)}</span>
            </span>
            <Avatar name={user.name} />
            <button type="button" className="ghost sm" onClick={signOut} title="Sign out">
              <Icon name="logout" />
              <span className="sr-only">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="app">
        <Routes>
          <Route path="/" element={<Home role={user.role} />} />
          <Route path="/reqs" element={<Reqs />} />
          <Route path="/candidates" element={<Candidates />} />
          {/*
            Recruiters only in the nav: a hiring manager's `GET /candidates` is a 403, so
            the link would only lead to the error notice.
          */}
          <Route path="/directory" element={<Directory />} />
          {/*
            An application is addressed by the pair it is unique on, the same pair the API
            routes take — so a link to "this candidate on this req" is one URL a recruiter
            can share, and it survives the candidate being on a second req.
          */}
          <Route path="/applications/:candidateId/:roleId" element={<ApplicationDetail />} />
          <Route path="/rounds/:id" element={<RoundDetail />} />

          {/*
            Signing in is what `/login` is for, so a signed-in visit to it is a stale
            bookmark rather than a request to sign in again.
          */}
          <Route path="/login" element={<Navigate to="/" replace />} />

          {/*
            `/pipeline` and `/rounds` were the landing paths before `/` was; they stay
            registered so existing links keep working, and resolve to the same screen
            rather than serving a second copy of it at a second address.
          */}
          <Route path="/pipeline" element={<Navigate to="/" replace />} />
          <Route path="/rounds" element={<Navigate to="/" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
