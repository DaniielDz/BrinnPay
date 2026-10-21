import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, within } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ApiReferencePage from '../../app/(public)/docs/api-reference/page';
import { loadContract, resolveApiBaseUrl, resolveSwaggerUrl } from '../../lib/docs/openapi';

/**
 * Embedded API reference (phase 15 §6, D2, Q4, §13.1).
 *
 * The reference is *generated from* `docs/openapi.yaml`: this suite loads the
 * canonical file independently and proves the rendered page says exactly what
 * the contract says — so a hand-written second contract cannot appear — and
 * that the page is display-only (no request is ever issued).
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..', '..');
const webRoot = join(repoRoot, 'apps', 'web');

const canonical = parseYaml(readFileSync(join(repoRoot, 'docs', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, any>>;
};

interface DeclaredOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const declaredOperations: DeclaredOperation[] = Object.entries(canonical.paths).flatMap(
  ([path, pathItem]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = pathItem?.[method];
      if (!operation) return [];
      return [
        {
          id: String(operation.operationId),
          method: method.toUpperCase(),
          path,
          summary: String(operation.summary ?? ''),
        },
      ];
    }),
);

function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => join(dir, entry))
    .filter((file) => statSync(file).isFile());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Rendering the reference (every operation plus every schema) is the heaviest
 * page in the docs area: give each test room on a loaded runner instead of the
 * 5-second default.
 */
const itRenders = (name: string, fn: () => void): void => {
  it(name, fn, 30_000);
};

describe('API reference content (D2: generated from the canonical contract)', () => {
  itRenders('renders every operation of the canonical file, and only those', () => {
    const contract = loadContract();
    expect(declaredOperations.length).toBeGreaterThan(0);
    expect(contract.operations.map((operation) => operation.id).sort()).toEqual(
      declaredOperations.map((operation) => operation.id).sort(),
    );

    const { container, unmount } = render(<ApiReferencePage />);

    // One rendered detail block per contract operation, each anchored by its
    // `operationId`, with the contract's own path, method and summary.
    const rendered = Array.from(container.querySelectorAll('article.docs-op'));
    expect(rendered).toHaveLength(declaredOperations.length);
    const byId = new Map(rendered.map((element) => [element.id, element as HTMLElement]));

    for (const declared of declaredOperations) {
      const node = byId.get(declared.id);
      expect(node, `missing operation ${declared.id}`).toBeDefined();

      expect(node!.querySelector('.docs-op-path')?.textContent).toBe(declared.path);
      expect(node!.querySelector('.docs-method')?.textContent).toBe(declared.method);
      expect(node!.querySelector('.docs-op-summary')?.textContent).toContain(declared.summary);
      expect(node!.querySelector('.docs-op-id')?.textContent).toBe(declared.id);

      // §6: summary, security, parameters and documented responses as authored.
      expect(Array.from(node!.querySelectorAll('h4')).map((heading) => heading.textContent)).toEqual([
        'Security',
        'Parameters',
        'Request body',
        'Responses',
      ]);
      const captions = Array.from(node!.querySelectorAll('table caption')).map(
        (caption) => caption.textContent,
      );
      expect(captions[captions.length - 1]).toBe('Documented responses');
    }

    unmount();
  });

  itRenders('lists the contract tags, security schemes and schemas', () => {
    const contract = loadContract();
    const { container, unmount } = render(<ApiReferencePage />);

    expect(contract.tags.length).toBeGreaterThan(0);
    expect(contract.schemas.length).toBeGreaterThan(0);
    expect(contract.securitySchemes.length).toBeGreaterThan(0);

    const toc = container.querySelector('nav.docs-reference-toc') as HTMLElement;
    expect(toc).not.toBeNull();
    expect(within(toc).getAllByRole('link')).toHaveLength(
      contract.operations.length,
    );

    const schemaIndex = container.querySelectorAll('.docs-schema-index li');
    expect(schemaIndex).toHaveLength(contract.schemas.length);
    const renderedSchemaIds = new Set(
      Array.from(container.querySelectorAll('article.docs-schema')).map(
        (element) => element.id,
      ),
    );
    for (const schema of contract.schemas) {
      expect(renderedSchemaIds.has(`schema-${schema.name}`)).toBe(true);
    }

    unmount();
  });

  itRenders('states the sources of truth and never a hand-written contract', () => {
    const { container, unmount } = render(<ApiReferencePage />);
    expect(container.textContent).toContain('docs/openapi.yaml');
    // The reference is read-only by construction (§6, Q4).
    expect(container.textContent).toMatch(/sends no requests/i);
    unmount();

    // No second contract file may exist anywhere in the web application.
    const sourceFiles = filesUnder(webRoot).filter(
      (file) => !file.includes(`${join(webRoot, '.next')}`) && !file.includes('node_modules'),
    );
    const contractLike = sourceFiles.filter((file) =>
      /(?:openapi|swagger|swagger-ui|contract)\.(?:ya?ml|json)$/i.test(file),
    );
    expect(contractLike).toEqual([]);
    expect(sourceFiles.filter((file) => /\.ya?ml$/.test(file))).toEqual([]);
  });
});

describe('API reference base URL handling (§6)', () => {
  itRenders('falls back to an explicit placeholder, never a wrong absolute host', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');

    expect(resolveApiBaseUrl()).toEqual({
      value: '<your-api-origin>/api/v1',
      configured: false,
    });
    expect(resolveSwaggerUrl()).toEqual({ value: '<your-api-origin>/docs', configured: false });

    const { container, unmount } = render(<ApiReferencePage />);
    expect(container.querySelector('.docs-base-url')?.textContent).toBe(
      '<your-api-origin>/api/v1',
    );
    expect(container.textContent).toContain('http://localhost:3000');
    unmount();
  });

  itRenders('presents the configured origin when the deployment declares one', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://sandbox.example.test/');

    expect(resolveApiBaseUrl()).toEqual({
      value: 'https://sandbox.example.test/api/v1',
      configured: true,
    });
    expect(resolveSwaggerUrl()).toEqual({
      value: 'https://sandbox.example.test/docs',
      configured: true,
    });

    const { container, unmount } = render(<ApiReferencePage />);
    expect(container.querySelector('.docs-base-url')?.textContent).toBe(
      'https://sandbox.example.test/api/v1',
    );
    const swagger = container.querySelector('a[rel="noopener noreferrer"]');
    expect(swagger?.getAttribute('href')).toBe('https://sandbox.example.test/docs');
    unmount();
  });
});

describe('API reference is display-only (Q4, §13.1)', () => {
  itRenders('sends no request and offers no interactive control', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container, unmount } = render(<ApiReferencePage />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(container.querySelectorAll('script, iframe')).toHaveLength(0);
    // No "Try it" surface: only anchors and the contract's own text.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    unmount();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
