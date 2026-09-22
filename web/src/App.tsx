import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './auth/session.js';
import { Login } from './routes/Login.js';
import { MyRounds } from './routes/MyRounds.js';
import { Pipeline } from './routes/Pipeline.js';
import { Reqs } from './routes/Reqs.js';
import { RoundDetail } from './routes/RoundDetail.js';

/**
 * Nothing here decides what a role may see — the API does, and it answers 403 or 404 on
 * its own terms. The navigation hides links that would only produce a 403, which is a
 * courtesy to the user and not a security boundary: typing the URL still reaches the
 * request, and the request still gets refused by the server.
 */
const NAV = [
  { to: '/pipeline', label: 'Pipeline', roles: ['RECRUITER', 'HIRING_MANAGER'] },
  { to: '/reqs', label: 'Reqs', roles: ['RECRUITER', 'HIRING_MANAGER'] },
  { to: '/rounds', label: 'My rounds', roles: ['INTERVIEWER'] },
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
           * Every seeded role now has a screen, so this is reachable only by a role added
           * to the API without one added here. Routing them to someone else's view would
           * show a red 403 that reads like a fault — it is not one, it is the
           * authorization model working, so say that instead.
           */
          <section className="card pad">
            <h2>Nothing here yet for {user.role.toLowerCase().replace('_', ' ')}s</h2>
            <p className="muted">
              This UI has no screen for your role. The API may still serve you — see the
              OpenAPI document at <code>/docs</code>.
            </p>
          </section>
        ) : (
          <Routes>
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/reqs" element={<Reqs />} />
            <Route path="/rounds" element={<MyRounds />} />
            {/*
              Registered for every role, not just interviewers: `GET /rounds/:id` serves
              recruiters too, so a link to one should work for them. The submit form
              inside is what checks the role, and the API checks it again.
            */}
            <Route path="/rounds/:id" element={<RoundDetail />} />
            <Route path="*" element={<Navigate to={visible[0]!.to} replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
