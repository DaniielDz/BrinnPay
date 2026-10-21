import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { metadata } from '../../app/layout';

/**
 * Favicon and social-preview metadata (ui-polish D5, F2/F5): the app declares
 * an app-served SVG favicon (committed under `apps/web/app`, served by Next.js
 * under the existing CSP `img-src 'self'`) plus open-graph metadata built from
 * the title/description that already existed. No OG image — metadata-only per
 * D5's minimal resolution. Asserted here so the D5 outcome is a locked
 * contract, not an accident of presentation.
 */
describe('root metadata and favicon (ui-polish D5)', () => {
  it('declares the app-served SVG favicon and keeps the file committed', () => {
    // `metadata.icons` is a union (URL string | descriptors); assert the shape.
    expect(metadata).toMatchObject({
      icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }] },
    });

    // Vitest runs with the package root (`apps/web`) as cwd.
    const iconPath = join(process.cwd(), 'app', 'icon.svg');
    expect(existsSync(iconPath)).toBe(true);
  });

  it('keeps the product title/description and adds open-graph metadata', () => {
    expect(metadata.title).toBe('BrinnPay');
    expect(metadata.description).toBe('Payment infrastructure sandbox for developers.');
    expect(metadata.openGraph).toMatchObject({
      type: 'website',
      siteName: 'BrinnPay',
      title: 'BrinnPay',
      description: 'Payment infrastructure sandbox for developers.',
    });
  });
});
