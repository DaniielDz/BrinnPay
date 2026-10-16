import {
  HTTP_STATUS_CLASSES,
  HTTP_METHOD_LABELS,
  DELIVERY_OUTCOMES,
  SWEEP_PASSES,
  QUEUE_STATES,
  HTTP_DURATION_BUCKETS,
} from './metrics.service';
import {
  UNMATCHED_ROUTE,
  normalizeMethodLabel,
  routeTemplateOf,
  statusClassOf,
} from './http-metrics';

/**
 * Label shaping for the HTTP metrics (phase 20 D5(a), §4 rule 4). These are
 * the functions that decide what may become a time series; each closed-set
 * decision is asserted here rather than through a live scrape, so a regression
 * that opens the label space fails loudly in unit tests.
 */
describe('metrics label shaping (phase 20 D5(a))', () => {
  describe('routeTemplateOf', () => {
    it('de-prefixes the global-mount template to the contract path', () => {
      // The app mounts the router under /api/v1; the series must read as the
      // contract path (/payments/:id), not the deployment path.
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: { path: '/payments/:id' } })).toBe(
        '/payments/:id',
      );
    });

    it('keeps a bare-mounted template as-is (test arrangement)', () => {
      expect(routeTemplateOf({ baseUrl: '', route: { path: '/customers/:id' } })).toBe(
        '/customers/:id',
      );
    });

    it('collapses an unmatched request to a single series', () => {
      // A raw URL here would leak a user-controlled string into the label
      // space and mint a series per probe path.
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: undefined })).toBe(UNMATCHED_ROUTE);
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: {} })).toBe(UNMATCHED_ROUTE);
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: { path: '' } })).toBe(UNMATCHED_ROUTE);
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: { path: 42 } })).toBe(UNMATCHED_ROUTE);
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: null })).toBe(UNMATCHED_ROUTE);
    });

    it('buckets framework fallback patterns as unmatched (Express 5 catch-all)', () => {
      // Express 5 (path-to-regexp v8) renders the global-prefix catch-all as
      // `/api/v1{/*splat}`. It *matches* — `req.route.path` is set — but it is
      // a generated fallback, not a contract route: every scan 404 would mint
      // one series if its pattern leaked through.
      expect(routeTemplateOf({ baseUrl: '', route: { path: '/api/v1{/*splat}' } })).toBe(
        UNMATCHED_ROUTE,
      );
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: { path: '{/*splat}' } })).toBe(
        UNMATCHED_ROUTE,
      );
      // Our own templates never use these characters, so the gate is closed.
      expect(routeTemplateOf({ baseUrl: '', route: { path: '/files/:name*' } })).toBe(
        UNMATCHED_ROUTE,
      );
      expect(routeTemplateOf({ baseUrl: '', route: { path: '/a/:b?' } })).toBe(UNMATCHED_ROUTE);
    });

    it('normalizes a prefix-only match to the root', () => {
      expect(routeTemplateOf({ baseUrl: '/api/v1', route: { path: '/' } })).toBe('/');
    });

    it('ensures the emitted template is absolute even for odd mounts', () => {
      expect(routeTemplateOf({ baseUrl: '', route: { path: 'health' } })).toBe('/health');
    });
  });

  describe('normalizeMethodLabel', () => {
    it('uppercases the contract methods', () => {
      expect(normalizeMethodLabel('get')).toBe('GET');
      expect(normalizeMethodLabel('POST')).toBe('POST');
      expect(normalizeMethodLabel('delete')).toBe('DELETE');
    });

    it('folds invented methods into the closed set', () => {
      // A client must not be able to mint a series by inventing a verb.
      expect(normalizeMethodLabel('PURGE')).toBe('other');
      expect(normalizeMethodLabel('')).toBe('other');
      expect(normalizeMethodLabel(undefined)).toBe('other');
    });
  });

  describe('statusClassOf', () => {
    it.each([
      [100, '1xx'],
      [204, '2xx'],
      [301, '3xx'],
      [404, '4xx'],
      [500, '5xx'],
      [599, '5xx'],
    ])('maps %i to %s', (code, expected) => {
      expect(statusClassOf(code)).toBe(expected);
    });

    it('folds non-codes and out-of-range codes into the closed set', () => {
      expect(statusClassOf(0)).toBe('other');
      expect(statusClassOf(99)).toBe('other');
      expect(statusClassOf(600)).toBe('other');
      expect(statusClassOf(Number.NaN)).toBe('other');
      expect(statusClassOf(undefined)).toBe('other');
    });
  });

  it('keeps every v1 label set closed and finite (D5(a), §8)', () => {
    // The closed-set rule of §4 rule 4 is only meaningful if the sets stay
    // small; this pins the catalog against accidental expansion.
    expect(HTTP_STATUS_CLASSES).toEqual(['1xx', '2xx', '3xx', '4xx', '5xx', 'other']);
    expect(HTTP_METHOD_LABELS).toEqual([
      'GET',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'OPTIONS',
      'HEAD',
      'other',
    ]);
    expect(DELIVERY_OUTCOMES).toEqual(['delivered', 'failed', 'retry', 'skipped']);
    expect(SWEEP_PASSES).toEqual(['reconciliation', 'requeue', 'advancement', 'retention']);
    expect(QUEUE_STATES).toEqual(['wait', 'delayed', 'active', 'failed']);
    expect(HTTP_DURATION_BUCKETS).toEqual([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
  });
});
