import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useSession } from '../auth/session.js';

/** The seeded accounts, so a reviewer can get in without reading the README first. */
const DEMO = [
  { email: 'rachel.recruiter@example.com', role: 'Recruiter' },
  { email: 'hana.manager@example.com', role: 'Hiring manager' },
  { email: 'ingrid.interviewer@example.com', role: 'Interviewer' },
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
      <form className="card login" onSubmit={submit}>
        <h1>Recruitment Pipeline</h1>
        <p className="muted">Sign in with a seeded account.</p>

        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error !== null && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <ul className="demo">
          {DEMO.map((account) => (
            <li key={account.email}>
              <button type="button" className="link" onClick={() => setEmail(account.email)}>
                {account.role}
              </button>
              <span className="muted">{account.email}</span>
            </li>
          ))}
        </ul>
      </form>
    </div>
  );
}
