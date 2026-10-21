import type { ReactElement } from 'react';

import type {
  ContractOperation,
  ContractParameter,
  ContractSchema,
  ContractView,
} from '../../lib/docs/openapi';
import { Guide } from './guide';
import { MarkdownLite } from './markdown-lite';

/**
 * Embedded, display-only API reference (phase 15 §6, ADR-0030, Q4).
 *
 * Everything rendered here comes from the canonical `docs/openapi.yaml`
 * loaded by `lib/docs/openapi.ts`: there is no hand-written operation,
 * parameter, response or schema anywhere in this component, so the reference
 * cannot become a second contract. It sends no requests — no form, no button,
 * no fetch — which is exactly what Q4 answered, and it stays compatible with
 * the Phase 14 CSP because no remote asset or renderer is involved.
 */

export interface ApiReferenceProps {
  contract: ContractView;
  baseUrl: { value: string; configured: boolean };
  swagger: { value: string; configured: boolean };
}

const METHOD_CLASS: Record<string, string> = {
  GET: 'docs-method-get',
  POST: 'docs-method-post',
  PATCH: 'docs-method-patch',
  PUT: 'docs-method-put',
  DELETE: 'docs-method-delete',
};

function ParameterTable({ parameters }: { parameters: readonly ContractParameter[] }): ReactElement {
  if (parameters.length === 0) return <p className="docs-none">No path, query or header parameters.</p>;

  return (
    <div className="table-scroll">
      <table>
        <caption className="visually-hidden">Parameters</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">In</th>
            <th scope="col">Required</th>
            <th scope="col">Type</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {parameters.map((parameter) => (
            <tr key={`${parameter.where}-${parameter.name}`}>
              <th scope="row">
                <code>{parameter.name}</code>
              </th>
              <td>{parameter.where}</td>
              <td>{parameter.required ? 'yes' : 'no'}</td>
              <td>
                <code>{parameter.type}</code>
              </td>
              <td>
                <MarkdownLite text={parameter.description} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operation({ operation }: { operation: ContractOperation }): ReactElement {
  return (
    <article className="docs-op" id={operation.id}>
      <h3>
        <span className={`docs-method ${METHOD_CLASS[operation.method] ?? ''}`}>
          {operation.method}
        </span>
        <code className="docs-op-path">{operation.path}</code>
      </h3>
      <p className="docs-op-summary">
        {operation.summary} <code className="docs-op-id">{operation.id}</code>
      </p>

      {operation.description ? <MarkdownLite text={operation.description} /> : null}

      <h4>Security</h4>
      {operation.security.length === 0 ? (
        <p>Public operation: no credential is required.</p>
      ) : (
        <ul className="docs-security">
          {operation.security.map((scheme) => (
            <li key={scheme}>
              <code>{scheme}</code>
            </li>
          ))}
        </ul>
      )}

      <h4>Parameters</h4>
      <ParameterTable parameters={operation.parameters} />

      <h4>Request body</h4>
      {operation.requestBody ? (
        <p>
          <code>application/json</code>
          {operation.requestBody.schemaName ? (
            <>
              {' · schema '}
              <a href={`#schema-${operation.requestBody.schemaName}`}>
                <code>{operation.requestBody.schemaName}</code>
              </a>
            </>
          ) : null}
          {' · '}
          <strong>{operation.requestBody.required ? 'required' : 'optional'}</strong>
          {operation.requestBody.requiredFields.length > 0 ? (
            <>
              {' · required fields: '}
              {operation.requestBody.requiredFields.map((field, index) => (
                <span key={field}>
                  <code>{field}</code>
                  {index < operation.requestBody!.requiredFields.length - 1 ? ', ' : ''}
                </span>
              ))}
            </>
          ) : null}
        </p>
      ) : (
        <p className="docs-none">No request body.</p>
      )}

      <h4>Responses</h4>
      <div className="table-scroll">
        <table>
          <caption className="visually-hidden">Documented responses</caption>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Description</th>
              <th scope="col">Headers</th>
              <th scope="col">Body</th>
            </tr>
          </thead>
          <tbody>
            {operation.responses.map((response) => (
              <tr key={response.status}>
                <th scope="row">
                  <code>{response.status}</code>
                </th>
                <td>
                  <MarkdownLite text={response.description} />
                </td>
                <td>
                  {response.headers.length > 0
                    ? response.headers.map((header, index) => (
                        <span key={header}>
                          <code>{header}</code>
                          {index < response.headers.length - 1 ? ', ' : ''}
                        </span>
                      ))
                    : '—'}
                </td>
                <td>
                  {response.schemaName ? (
                    <a href={`#schema-${response.schemaName}`}>
                      <code>{response.schemaName}</code>
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function Schema({ schema }: { schema: ContractSchema }): ReactElement {
  return (
    <article className="docs-schema" id={`schema-${schema.name}`}>
      <h3>
        <code>{schema.name}</code>
        {schema.type ? <span className="docs-schema-type"> · {schema.type}</span> : null}
      </h3>

      {schema.description ? <MarkdownLite text={schema.description} /> : null}

      {schema.enumValues && schema.enumValues.length > 0 ? (
        <p className="docs-enum">
          Allowed values:{' '}
          {schema.enumValues.map((value, index) => (
            <span key={value}>
              <code>{value}</code>
              {index < schema.enumValues!.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      ) : null}

      {schema.properties.length > 0 ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Properties of {schema.name}</caption>
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Type</th>
                <th scope="col">Required</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {schema.properties.map((property) => (
                <tr key={property.name}>
                  <th scope="row">
                    <code>{property.name}</code>
                  </th>
                  <td>
                    <code>{property.type}</code>
                    {property.enumValues && property.enumValues.length > 0 ? (
                      <span className="docs-enum-inline">
                        {' '}
                        one of: {property.enumValues.map((value) => value).join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td>{property.required ? 'yes' : 'no'}</td>
                  <td>
                    <MarkdownLite text={property.description} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="docs-none">No properties beyond the type above.</p>
      )}

      {schema.closed ? <p className="docs-note">Additional properties are not allowed.</p> : null}
    </article>
  );
}

export function ApiReference({
  contract,
  baseUrl,
  swagger,
}: ApiReferenceProps): ReactElement {
  return (
    <Guide
      title="API reference"
      lead="Every operation, parameter, response and schema of the BrinnPay v1 API, generated from the canonical OpenAPI contract. This page is read-only: it presents the contract and sends no requests."
      sources={['docs/openapi.yaml']}
    >
      <section aria-labelledby="reference-base-url">
        <h2 id="reference-base-url">Base URL</h2>
        <p>
          The contract declares the versioned prefix as a relative path (<code>/api/v1</code>).
          Point your client at the API origin of your deployment and append it:
        </p>
        <pre className="docs-base-url">
          <code>{baseUrl.value}</code>
        </pre>
        {baseUrl.configured ? (
          <p className="hint">
            This build was configured with <code>NEXT_PUBLIC_API_BASE_URL</code>, so the value
            above is the configured API origin for this deployment.
          </p>
        ) : (
          <p className="hint">
            Replace <code>&lt;your-api-origin&gt;</code> with your API origin — for local
            development that is <code>http://localhost:3000</code>.
          </p>
        )}
        <p>
          For interactive exploration, the API also serves Swagger UI from the same contract:{' '}
          {swagger.configured ? (
            <a href={swagger.value} rel="noopener noreferrer">
              {swagger.value}
            </a>
          ) : (
            <code>{swagger.value}</code>
          )}
          .
        </p>
      </section>

      <section aria-labelledby="reference-authentication">
        <h2 id="reference-authentication">Authentication</h2>
        <ul className="docs-security">
          {contract.securitySchemes.map((scheme) => (
            <li key={scheme.name}>
              <code>{scheme.name}</code> — <code>{scheme.label}</code>
              <MarkdownLite text={scheme.description} />
            </li>
          ))}
        </ul>
        <p className="hint">
          Each operation below lists the security it requires; an operation marked
          <em> public</em> needs no credential.
        </p>
      </section>

      <section aria-labelledby="reference-contents">
        <h2 id="reference-contents">Operations</h2>
        <nav className="docs-reference-toc" aria-label="Operations">
          {contract.tags.map((tag) => (
            <div key={tag.name} className="docs-reference-toc-group">
              <h3>{tag.name}</h3>
              <ul>
                {tag.operations.map((operation) => (
                  <li key={operation.id}>
                    <a href={`#${operation.id}`}>
                      <span className={`docs-method ${METHOD_CLASS[operation.method] ?? ''}`}>
                        {operation.method}
                      </span>{' '}
                      {operation.summary}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </section>

      <section aria-labelledby="reference-operations">
        <h2 id="reference-operations">Operation detail</h2>
        {contract.tags.map((tag) => (
          <div key={tag.name} className="docs-reference-tag">
            <h3>{tag.name}</h3>
            {tag.description ? <p className="docs-tag-description">{tag.description}</p> : null}
            {tag.operations.map((operation) => (
              <Operation key={operation.id} operation={operation} />
            ))}
          </div>
        ))}
      </section>

      <section aria-labelledby="reference-schemas">
        <h2 id="reference-schemas">Schemas</h2>
        <ul className="docs-schema-index">
          {contract.schemas.map((schema) => (
            <li key={schema.name}>
              <a href={`#schema-${schema.name}`}>
                <code>{schema.name}</code>
              </a>
            </li>
          ))}
        </ul>
        {contract.schemas.map((schema) => (
          <Schema key={schema.name} schema={schema} />
        ))}
      </section>
    </Guide>
  );
}
