import { useState } from 'react';
import { roles } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL';

const FILTERS: StatusFilter[] = ['OPEN', 'CLOSED', 'ALL'];

export function Reqs() {
  const [status, setStatus] = useState<StatusFilter>('OPEN');
  const reqs = useApi(() => roles(status), [status]);

  return (
    <section className="card">
      <header className="card-head row">
        <div>
          <h2>Reqs</h2>
          <p className="muted">
            Recruiters see every req; a hiring manager sees the ones they own — the same
            request, scoped by who is asking.
          </p>
        </div>
        <div className="tabs">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={filter === status ? 'tab active' : 'tab'}
              onClick={() => setStatus(filter)}
            >
              {filter}
            </button>
          ))}
        </div>
      </header>

      {reqs.loading ? (
        <Loading label="Loading reqs…" />
      ) : reqs.error !== null ? (
        <ErrorNotice error={reqs.error} onRetry={reqs.reload} />
      ) : (reqs.data ?? []).length === 0 ? (
        <p className="muted pad">No reqs with that status.</p>
      ) : (
        <table className="grid list">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Hiring manager</th>
              <th>Applications</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {(reqs.data ?? []).map((req) => (
              <tr key={req.id}>
                <td>{req.title}</td>
                <td>
                  <span className={req.status === 'OPEN' ? 'pill open' : 'pill closed'}>
                    {req.status}
                  </span>
                </td>
                <td className="muted">{req.hiringManager.name}</td>
                <td>{req.applicationCount}</td>
                <td className="muted">{new Date(req.openedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
