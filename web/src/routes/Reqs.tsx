import { useState } from 'react';
import { roles } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { OpenReqForm } from '../components/OpenReqForm.js';

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL';

const FILTERS: StatusFilter[] = ['OPEN', 'CLOSED', 'ALL'];

export function Reqs() {
  const { user } = useSession();
  const [status, setStatus] = useState<StatusFilter>('OPEN');
  const [opened, setOpened] = useState<Schemas['Role'] | null>(null);
  const reqs = useApi(() => roles(status), [status]);

  /**
   * A new req is OPEN, so the filter moves to where it can be seen — showing a recruiter
   * the CLOSED tab after they opened something is showing them an empty result and
   * calling it a success. Both updates land in one render, so the list refetches once.
   */
  function onOpened(req: Schemas['Role']) {
    setOpened(req);
    setStatus('OPEN');
    reqs.reload();
  }

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

      {/*
        Hidden from a hiring manager rather than disabled: `POST /roles` and the user
        picker it needs are both recruiters-only, so the form could only ever produce a
        403 for them. The API is still the one refusing it.
      */}
      {user?.role === 'RECRUITER' && <OpenReqForm onOpened={onOpened} />}

      {opened !== null && (
        <p className="notice ok pad" role="status">
          Opened <strong>{opened.title}</strong> — {opened.hiringManager.name} owns it, and
          it is OPEN from this moment.
        </p>
      )}

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
