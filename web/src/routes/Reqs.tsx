import { useState } from 'react';
import { roles } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { OpenReqForm } from '../components/OpenReqForm.js';
import { EmptyState, Icon, PageHeader, Person, Segmented, formatDate } from '../components/ui.js';

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL';

const FILTERS = [
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
] as const satisfies ReadonlyArray<{ value: StatusFilter; label: string }>;

export function Reqs() {
  const { user } = useSession();
  const [status, setStatus] = useState<StatusFilter>('OPEN');
  const [opened, setOpened] = useState<Schemas['Role'] | null>(null);
  const [creating, setCreating] = useState(false);
  const reqs = useApi(() => roles(status), [status]);

  /**
   * A new req is OPEN, so the filter moves to where it can be seen — showing a recruiter
   * the CLOSED tab after they opened something is showing them an empty result and
   * calling it a success. Both updates land in one render, so the list refetches once.
   */
  function onOpened(req: Schemas['Role']) {
    setOpened(req);
    setCreating(false);
    setStatus('OPEN');
    reqs.reload();
  }

  const isRecruiter = user?.role === 'RECRUITER';
  const list = reqs.data ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Requisitions"
        subtitle={
          isRecruiter
            ? 'Every role the team is hiring for.'
            : 'The roles you are the hiring manager for.'
        }
        actions={
          /*
            Hidden from a hiring manager rather than disabled: `POST /roles` and the user
            picker it needs are both recruiters-only, so the form could only ever produce a
            403 for them. The API is still the one refusing it.
          */
          isRecruiter && !creating ? (
            <button type="button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Open a req
            </button>
          ) : undefined
        }
      />

      {creating && <OpenReqForm onOpened={onOpened} onCancel={() => setCreating(false)} />}

      {opened !== null && (
        <div className="notice ok" role="status">
          <Icon name="check" />
          <span>
            <strong>{opened.title}</strong> is open, with {opened.hiringManager.name} as hiring
            manager.
          </span>
        </div>
      )}

      <section className="card">
        <div className="toolbar">
          <Segmented label="Status" value={status} options={FILTERS} onChange={setStatus} />
          {!reqs.loading && reqs.error === null && (
            <span className="muted small">
              {list.length} {list.length === 1 ? 'requisition' : 'requisitions'}
            </span>
          )}
        </div>

        {reqs.loading ? (
          <Loading label="Loading requisitions…" />
        ) : reqs.error !== null ? (
          <ErrorNotice error={reqs.error} onRetry={reqs.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title={status === 'CLOSED' ? 'No closed requisitions' : 'No requisitions yet'}
            hint={isRecruiter && status !== 'CLOSED' ? 'Open one to start hiring.' : undefined}
          />
        ) : (
          <div className="scroll">
            <table className="grid list">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Hiring manager</th>
                  <th className="right">Candidates</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {list.map((req) => (
                  <tr key={req.id}>
                    <td>
                      <strong>{req.title}</strong>
                    </td>
                    <td>
                      <span className={req.status === 'OPEN' ? 'badge open' : 'badge closed'}>
                        {req.status === 'OPEN' ? 'Open' : 'Closed'}
                      </span>
                    </td>
                    <td>
                      <Person name={req.hiringManager.name} />
                    </td>
                    <td className="right num">{req.applicationCount}</td>
                    <td className="muted">{formatDate(req.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
