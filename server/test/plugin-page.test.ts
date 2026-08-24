import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { Plugin, PluginDetail } from '../catalog.js';
import { discoverStylesheets, renderPluginPage, renderSitemap } from '../plugin-page.js';

function plugin(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return {
    name: '@gl3-plugins/fixer',
    paid: true,
    version: '0.1.9',
    description: 'An AI contract broker',
    descriptionHtml: 'An AI contract broker',
    keywords: ['gl3'],
    license: 'MIT',
    install: 'npm install @gl3-plugins/fixer',
    href: '/plugins/gl3-plugins/fixer.html',
    readmeHtml: '<h1>Fixer</h1>',
    ...overrides,
  };
}

const origin = 'https://gl3.dev';

describe('renderPluginPage', () => {
  it('includes the rendered readme', () => {
    expect(renderPluginPage({ plugin: plugin(), stylesheets: [], origin })).toContain(
      '<h1>Fixer</h1>'
    );
  });

  it('titles the page after the package', () => {
    expect(renderPluginPage({ plugin: plugin(), stylesheets: [], origin })).toContain(
      '<title>@gl3-plugins/fixer'
    );
  });

  it('uses the plain description in the meta tag, not the markup', () => {
    const html = renderPluginPage({
      plugin: plugin({ description: '**bold**', descriptionHtml: '<strong>bold</strong>' }),
      stylesheets: [],
      origin,
    });
    expect(html).toContain('content="**bold**"');
  });

  it('links every discovered stylesheet', () => {
    const html = renderPluginPage({
      plugin: plugin(),
      stylesheets: ['/assets/style.abc123.css'],
      origin,
    });
    expect(html).toContain('href="/assets/style.abc123.css"');
  });

  it('still renders when no stylesheet was discovered', () => {
    const html = renderPluginPage({ plugin: plugin(), stylesheets: [], origin });
    expect(html).toContain('<h1>Fixer</h1>');
    expect(html).toContain('<style>');
  });

  it('says so when the readme has not been fetched', () => {
    const html = renderPluginPage({
      plugin: plugin({ readmeHtml: null }),
      stylesheets: [],
      origin,
    });
    expect(html).toContain('No description has been published');
  });

  it('escapes the package name in the title', () => {
    const html = renderPluginPage({
      plugin: plugin({ name: '@gl3/<script>alert(1)</script>' }),
      stylesheets: [],
      origin,
    });
    // Assert on the escaped form rather than the absence of "<script>": the
    // page carries its own theme script, so a bare absence check would fail
    // on the page's own markup and prove nothing about the package name.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('gives Open Graph an absolute URL', () => {
    const html = renderPluginPage({ plugin: plugin(), stylesheets: [], origin });
    expect(html).toContain('https://gl3.dev/plugins/gl3-plugins/fixer.html');
  });

  it('escapes an apostrophe, which the helper owes its callers', () => {
    const html = renderPluginPage({
      plugin: plugin({ description: "it's ours" }),
      stylesheets: [],
      origin,
    });
    expect(html).toContain('it&#39;s ours');
    expect(html).not.toContain("it's ours");
  });
});

const VITE_DIST = './server/test/fixtures/vite-dist';
const REAL_DIST = './site/.vitepress/dist';

describe('discoverStylesheets', () => {
  it('finds the stylesheet in the shape Vite actually emits', async () => {
    // rel carries two tokens and href sits between rel and as. A pattern that
    // demands rel="stylesheet" or a fixed attribute order matches nothing here.
    expect(await discoverStylesheets(VITE_DIST)).toEqual([
      '/assets/style.DM80HEo_.css',
      '/vp-icons.css',
    ]);
  });

  it('ignores a preload that is not a stylesheet', async () => {
    const found = await discoverStylesheets(VITE_DIST);
    expect(found.some((href) => href.endsWith('.woff2'))).toBe(false);
    expect(found.some((href) => href.endsWith('.js'))).toBe(false);
  });

  it('returns nothing when the build output is missing, so the page still renders', async () => {
    expect(await discoverStylesheets('./server/test/fixtures/no-such-build')).toEqual([]);
  });

  // Asserted against the real build rather than a fixture: the fixture only
  // proves the regex matches what Vite emitted when it was written, and this is
  // the check that fails when a future Vite changes the markup.
  it.skipIf(!existsSync(`${REAL_DIST}/index.html`))(
    "matches this repository's own build output",
    async () => {
      const found = await discoverStylesheets(REAL_DIST);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((href) => href.endsWith('.css'))).toBe(true);
    }
  );
});

describe('renderSitemap', () => {
  it('lists the built pages and every plugin page', () => {
    const xml = renderSitemap({ plugins: [plugin() as Plugin], origin });
    expect(xml).toContain('<loc>https://gl3.dev/</loc>');
    expect(xml).toContain('<loc>https://gl3.dev/plugins.html</loc>');
    expect(xml).toContain('<loc>https://gl3.dev/plugins/gl3-plugins/fixer.html</loc>');
  });

  it('is well formed when the catalogue is empty', () => {
    const xml = renderSitemap({ plugins: [], origin });
    expect(xml).toContain('<urlset');
    expect(xml).toContain('</urlset>');
  });

  // The sitemap is the only path by which a crawler reaches a plugin page, so
  // the file that advertises it is part of the feature, not decoration.
  it('is advertised to crawlers by robots.txt', async () => {
    const robots = await readFile('./site/public/robots.txt', 'utf-8');
    expect(robots).toContain('Sitemap: https://gl3.dev/sitemap.xml');
  });
});
