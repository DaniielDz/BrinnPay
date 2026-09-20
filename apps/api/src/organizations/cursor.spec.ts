import 'reflect-metadata';

import { buildCursorPage, cursorToWhere } from './cursor';

interface Row {
  id: string;
  label: string;
}

const ROWS: Row[] = [
  { id: '0192f2a0-0000-7000-8000-000000000001', label: 'a' },
  { id: '0192f2a0-0000-7000-8000-000000000002', label: 'b' },
  { id: '0192f2a0-0000-7000-8000-000000000003', label: 'c' },
];

describe('cursor pagination helper (phase 4 §4.5)', () => {
  it('returns the full page and next_cursor=null when no more results exist', () => {
    const page = buildCursorPage(ROWS, 3);
    expect(page.data).toEqual(ROWS);
    expect(page.next_cursor).toBeNull();
    expect(page.has_more).toBe(false);
  });

  it('returns limit rows, the last id as next_cursor, and has_more=true when more exist', () => {
    const page = buildCursorPage(ROWS, 2);
    expect(page.data).toEqual(ROWS.slice(0, 2));
    expect(page.next_cursor).toBe(ROWS[1].id);
    expect(page.has_more).toBe(true);
  });

  it('handles an empty result set', () => {
    const page = buildCursorPage([] satisfies Row[], 20);
    expect(page.data).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.has_more).toBe(false);
  });

  it('cursorToWhere returns an id > cursor predicate only when a cursor is given', () => {
    expect(cursorToWhere(undefined)).toBeUndefined();
    expect(cursorToWhere('0192f2a0-0000-7000-8000-000000000001')).toEqual({
      id: { gt: '0192f2a0-0000-7000-8000-000000000001' },
    });
  });
});