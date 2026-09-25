import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { candidates, type Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';

/**
 * Every candidate in the system, whether or not they are on a req — the one screen
 * backed by `GET /candidates`. The Candidates screen lists *applications*; someone who
 * has never been put on a req shows up only here.
 *
 * Search, page and page size live in the URL rather than component state, so a refresh
 * or a shared link lands on the same page of the same search.
 */

const PAGE_SIZES = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

/** Long enough to skip the keystrokes in the middle of a word, short enough not to feel slow. */
const SEARCH_DEBOUNCE_MS = 300;

type Row = Schemas['CandidatePage']['items'][number];

function positiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Recruiters get the full record; the union is narrowed here rather than cast. */
function hasContact(row: Row): row is Schemas['CandidateRecruiterView'] {
  return 'email' in row;
}

export function Directory() {
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const page = positiveInt(params.get('page'), 1);
  const pageSizeParam = positiveInt(params.get('pageSize'), DEFAULT_PAGE_SIZE);
  // The API caps page size at 100 and 400s above it; a hand-edited URL falls back instead.
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeParam)
    ? pageSizeParam
    : DEFAULT_PAGE_SIZE;

  /**
   * The input's own text, ahead of the URL by up to one debounce. Keeping them separate
   * is what lets typing feel immediate while only settled terms reach the API.
   */
  const [draft, setDraft] = useState(q);

  /**
   * The URL can change under the input — the nav link, back/forward — and the debounce
   * below would otherwise write the stale draft straight back. Adjusted during render,
   * not in an effect, so the input never shows the old text for a frame. The trim check
   * leaves a trailing space mid-typing alone when it is our own debounce that landed.
   */
  const [seenQ, setSeenQ] = useState(q);
  if (q !== seenQ) {
    setSeenQ(q);
    if (draft.trim() !== q) setDraft(q);
  }

  /** Writes to the URL, dropping values that equal the default so links stay short. */
  function update(next: { q?: string; page?: number; pageSize?: number }) {
    setParams(
      (current) => {
        const merged = new URLSearchParams(current);
        const entries: Array<[string, string | number | undefined, string | number]> = [
          ['q', next.q, ''],
          ['page', next.page, 1],
          ['pageSize', next.pageSize, DEFAULT_PAGE_SIZE],
        ];
        for (const [key, value, fallback] of entries) {
          if (value === undefined) continue;
          if (value === fallback) merged.delete(key);
          else merged.set(key, String(value));
        }
        return merged;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    const term = draft.trim();
    if (term === q) return;
    // A new search starts at page 1: page 4 of the old results means nothing for the new ones.
    const timer = window.setTimeout(() => update({ q: term, page: 1 }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, q]);

  const result = useApi(() => candidates({ q, page, pageSize }), [q, page, pageSize]);
  const data = result.data;
  const items = data?.items ?? [];
  const showContact = items.some(hasContact);

  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? first + items.length - Math.min(1, items.length) : 0;

  return (
    <section className="card">
      <header className="card-head">
        <h2>Directory</h2>
        <p className="muted">
          Every candidate on record, on a req or not. Search matches name, email or phone.
        </p>
      </header>

      <div className="filters pad">
        <label className="inline grow">
          Search
          <input
            type="search"
            className="search"
            placeholder="Name, email or phone"
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <label className="inline">
          Per page
          <select
            value={pageSize}
            onChange={(event) => update({ pageSize: Number(event.target.value), page: 1 })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        The table stays up while a new page loads — dimmed rather than swapped for a
        spinner, so paging and typing do not make the screen jump.
      */}
      {result.error !== null ? (
        <ErrorNotice error={result.error} onRetry={result.reload} />
      ) : data === null ? (
        <Loading label="Loading candidates…" />
      ) : items.length === 0 ? (
        <p className="muted pad">
          {q === '' ? 'No candidates on record.' : `Nobody matches “${q}”.`}
        </p>
      ) : (
        <table className={result.loading ? 'grid list stale' : 'grid list'} aria-busy={result.loading}>
          <thead>
            <tr>
              <th>Name</th>
              {showContact && (
                <>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Added</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                {hasContact(row) && (
                  <>
                    <td className="muted">{row.email}</td>
                    <td className="muted">{row.phone ?? '—'}</td>
                    <td className="muted">{new Date(row.createdAt).toLocaleDateString()}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data !== null && data.total > 0 && (
        <nav className="pager pad bordered" aria-label="Pagination">
          <span className="muted">
            {first}–{last} of {data.total}
          </span>
          <div className="pager-controls">
            <button
              type="button"
              className="secondary"
              disabled={page <= 1 || result.loading}
              onClick={() => update({ page: 1 })}
              aria-label="First page"
            >
              «
            </button>
            <button
              type="button"
              className="secondary"
              disabled={page <= 1 || result.loading}
              onClick={() => update({ page: page - 1 })}
            >
              Previous
            </button>
            <span className="muted">
              Page {data.page} of {Math.max(data.totalPages, 1)}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={page >= data.totalPages || result.loading}
              onClick={() => update({ page: page + 1 })}
            >
              Next
            </button>
            <button
              type="button"
              className="secondary"
              disabled={page >= data.totalPages || result.loading}
              onClick={() => update({ page: data.totalPages })}
              aria-label="Last page"
            >
              »
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
