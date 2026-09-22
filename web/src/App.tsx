import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './auth/session.js';
import { Login } from './routes/Login.js';
import { Pipeline } from './routes/Pipeline.js';
import { Reqs } from './routes/Reqs.js';

/**
 * Nothing here decides what a role may see — the API does, and it answers 403 or 404 on
 * its own terms. The navigation hides links that would only produce a 403, which is a
 * courtesy to the user and not a security boundary: typing the URL still reaches the
 * request, and the request still gets refused by the server.
 */
const NAV = [
  { to: '/pipeline', label: 'Pipeline', roles: ['RECRUITER', 'HIRING_MANAGER'] },
  { to: '/reqs', label: 'Reqs', roles: ['RECRUITER', 'HIRING_MANAGER'] },
];

export function App() {
  const { user, ready, signOut } = useSession();

  // Until the stored token has been checked against `GET /auth/me`, showing either the
  // app or the login form would be a guess.
  if (!ready) {
    return <div className="centered muted">Loading…</div>;
  }

  if (user === null) {
    return <Login />;
  }

  const visible = NAV.filter((item) => item.roles.includes(user.role));

  return (
    <div className="app">
      <header className="top">
        <strong className="brand">Recruitment Pipeline</strong>
        <nav>
          {visible.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <span>{user.name}</span>
          <span className="pill role">{user.role}</span>
          <button type="button" className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main>
        {visible.length === 0 ? (
          /**
           * An interviewer has no screen here yet. Routing them to `/pipeline` anyway
           * would show a red 403 that reads like a fault — it is not one, it is the
           * authorization model working, so say that instead.
           */
          <section className="card pad">
            <h2>Nothing here yet for {user.role.toLowerCase().replace('_', ' ')}s</h2>
            <p className="muted">
              This UI covers the recruiter pipeline so far. Interviewer screens — assigned
              rounds and feedback — are next; the API already serves them.
            </p>
          </section>
        ) : (
          <Routes>
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/reqs" element={<Reqs />} />
            <Route path="*" element={<Navigate to={visible[0]!.to} replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
