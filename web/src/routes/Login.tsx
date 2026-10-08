import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useSession } from '../auth/session.js';
import { Icon, Person } from '../components/ui.js';

/** The seeded accounts, so a reviewer can get in without reading the README first. */
const DEMO = [
  { email: 'rachel.recruiter@example.com', name: 'Rachel Ahmed', role: 'Recruiter' },
  { email: 'hana.manager@example.com', name: 'Hana Suzuki', role: 'Hiring manager' },
  { email: 'hamid.manager@example.com', name: 'Hamid Karimi', role: 'Hiring manager' },
  { email: 'ingrid.interviewer@example.com', name: 'Ingrid Olsen', role: 'Interviewer' },
];

export function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState(DEMO[0]!.email);
  const [password, setPassword] = useState('poc-dev-password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await signIn(email, password);
    } catch (cause) {
      // A wrong password and an unknown account are the same 401 by design, so there is
      // nothing more specific to say here than what the API said.
      setError(
        cause instanceof ApiError ? (cause.problem?.detail ?? cause.message) : 'Login failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="login-wrap">
        <div className="login-brand">
          <span className="logo">
            <Icon name="logo" />
          </span>
          Recruitment Pipeline
        </div>

        <form className="card login" onSubmit={submit}>
          <div className="login-head">
            <h1>Welcome back</h1>
            <p className="muted">Sign in to see your pipeline.</p>
          </div>

          <label className="field">
            Work email
            <input
              type="email"
              value={email}
              autoComplete="username"
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label className="field">
            Password
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error !== null && (
            <div className="notice error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="demo">
            <p className="divider">or try a demo account</p>
            <div className="demo-list">
              {DEMO.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  className={account.email === email ? 'demo-account selected' : 'demo-account'}
                  onClick={() => setEmail(account.email)}
                  aria-pressed={account.email === email}
                >
                  <Person name={account.name} meta={`${account.role} · ${account.email}`} />
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
