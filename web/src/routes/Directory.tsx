import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { candidates, type CandidateSort, type Schemas, type SortOrder } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { EmptyState, Icon, PageHeader, Person, formatDate } from '../components/ui.js';

/**
 * Every candidate in the system, whether or not they are on a req — the one screen
 * backed by `GET /candidates`. The Candidates screen lists *applications*; someone who
 * has never been put on a req shows up only here.
 *
 * Search, sort, page and page size live in the URL rather than component state, so a
 * refresh or a shared link lands on the same page of the same search.
 *
 * Sorting happens in the API, not on the rows in hand — sorting one page locally would
 * reorder twenty rows out of thousands and call it sorted.
 */

const PAGE_SIZES = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

/** Long enough to skip the keystrokes in the middle of a word, short enough not to feel slow. */
const SEARCH_DEBOUNCE_MS = 300;

type Row = Schemas['CandidatePage']['items'][number];

const SORTS: readonly CandidateSort[] = ['name', 'email', 'phone', 'createdAt'];
const DEFAULT_SORT: CandidateSort = 'name';
const DEFAULT_ORDER: SortOrder = 'asc';

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
  const sortParam = params.get('sort');
  const sort = SORTS.find((value) => value === sortParam) ?? DEFAULT_SORT;
  const order: SortOrder = params.get('order') === 'desc' ? 'desc' : DEFAULT_ORDER;

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
  function update(next: {
    q?: string;
    page?: number;
    pageSize?: number;
    sort?: CandidateSort;
    order?: SortOrder;
  }) {
    setParams(
      (current) => {
        const merged = new URLSearchParams(current);
        const entries: Array<[string, string | number | undefined, string | number]> = [
          ['q', next.q, ''],
          ['page', next.page, 1],
          ['pageSize', next.pageSize, DEFAULT_PAGE_SIZE],
          ['sort', next.sort, DEFAULT_SORT],
          ['order', next.order, DEFAULT_ORDER],
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

  const result = useApi(
    () => candidates({ q, page, pageSize, sort, order }),
    [q, page, pageSize, sort, order],
  );
  const data = result.data;
  const items = data?.items ?? [];
  const showContact = items.some(hasContact);

  /** Same column flips the direction; a new column starts ascending. Either way, back to page 1. */
  function sortBy(column: CandidateSort) {
    const nextOrder: SortOrder = column === sort && order === 'asc' ? 'desc' : 'asc';
    update({ sort: column, order: nextOrder, page: 1 });
  }

  /**
   * A header that sorts. Only rendered for columns the API can order this caller by:
   * interviewers never see the contact columns, and `name` is the one sort open to them.
   */
  function sortHeader(column: CandidateSort, label: string) {
    const active = column === sort;
    return (
      <th key={column} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className={active ? 'th-sort active' : 'th-sort'}
          onClick={() => sortBy(column)}
        >
          {label}
          <Icon name={active ? (order === 'asc' ? 'sortAsc' : 'sortDesc') : 'sortable'} />
        </button>
      </th>
    );
  }

  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? first + items.length - Math.min(1, items.length) : 0;

  return (
    <div className="stack">
      <PageHeader
        title="Directory"
        subtitle="Every candidate on record, whether or not they are on a requisition."
      />

      <section className="card">
        <div className="toolbar">
          <label className="input-icon grow">
            <span className="sr-only">Search</span>
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search by name, email or phone"
              value={draft}
              maxLength={100}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {data !== null && (
            <span className="muted small num">
              {data.total} {data.total === 1 ? 'candidate' : 'candidates'}
            </span>
          )}
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
          <EmptyState
            title={q === '' ? 'No candidates on record' : `Nobody matches “${q}”`}
            hint={q === '' ? undefined : 'Check the spelling, or search by email or phone instead.'}
          />
        ) : (
          <div className="scroll">
            <table className={result.loading ? 'grid list stale' : 'grid list'} aria-busy={result.loading}>
              <thead>
                <tr>
                  {sortHeader('name', 'Name')}
                  {showContact && (
                    <>
                      {sortHeader('email', 'Email')}
                      {sortHeader('phone', 'Phone')}
                      {sortHeader('createdAt', 'Added')}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Person name={row.name} />
                    </td>
                    {hasContact(row) && (
                      <>
                        <td>
                          <a className="row-link muted" href={`mailto:${row.email}`}>
                            {row.email}
                          </a>
                        </td>
                        <td className="muted num">{row.phone ?? '—'}</td>
                        <td className="muted">{formatDate(row.createdAt)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data !== null && data.total > 0 && (
          <nav className="pager" aria-label="Pagination">
            <span className="muted small num">
              Showing {first}–{last} of {data.total}
            </span>
            <div className="pager-controls">
              <label>
                Rows
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
              <button
                type="button"
                className="secondary sm"
                disabled={page <= 1 || result.loading}
                onClick={() => update({ page: page - 1 })}
              >
                <Icon name="back" /> Previous
              </button>
              <span className="muted">
                Page {data.page} of {Math.max(data.totalPages, 1)}
              </span>
              <button
                type="button"
                className="secondary sm"
                disabled={page >= data.totalPages || result.loading}
                onClick={() => update({ page: page + 1 })}
              >
                Next <Icon name="chevron" />
              </button>
            </div>
          </nav>
        )}
      </section>
    </div>
  );
}
