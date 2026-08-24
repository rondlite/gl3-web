import { describe, expect, it } from 'vitest';

import { renderBlock, renderInline } from '../markdown.js';

describe('renderInline', () => {
  it('renders emphasis as markup rather than asterisks', () => {
    expect(renderInline('**bold**')).toBe('<strong>bold</strong>');
  });

  it('returns null for null, so "no description" stays distinguishable', () => {
    expect(renderInline(null)).toBeNull();
  });

  it('does not let a description that starts with a hash become a heading', () => {
    const html = renderInline('# Heading');
    expect(html).not.toContain('<h1');
  });

  it('strips images, which would break the card grid', () => {
    const html = renderInline('![badge](https://img.example/b.svg)');
    expect(html).not.toContain('<img');
  });

  it('keeps the inline formatting a description is allowed to use', () => {
    expect(renderInline('*a* and `b`')).toBe('<em>a</em> and <code>b</code>');
  });
});

// A description is publisher controlled and renders inside a card. Markdown is
// not the only way in: parseInline passes raw HTML straight through, so the
// allowlist is what actually holds the card's shape, and these are the tests
// that exercise it.
describe('renderInline stays inline', () => {
  it('strips raw block HTML a publisher writes instead of markdown', () => {
    const html = renderInline('<h1>BIG</h1><div>block</div><table><tr><td>cell</td></tr></table>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<div');
    expect(html).not.toContain('<table');
  });

  it('strips a pre block, which would break the clamp', () => {
    expect(renderInline('<pre>wide</pre>')).not.toContain('<pre');
  });

  it('drops class, so a description cannot wear the storefront own badge', () => {
    // custom.css is global, so .gl3-tag.is-paid inside a card would render the
    // site's own "Premium" marker on a package that never paid for it.
    const html = renderInline('x <span class="gl3-tag is-paid">Premium</span>');
    expect(html).not.toContain('gl3-tag');
    expect(html).not.toContain('class=');
  });
});

describe('renderBlock', () => {
  it('renders a heading', () => {
    expect(renderBlock('# Title')).toContain('<h1');
  });

  it('keeps an https image, because README badges are normal', () => {
    const html = renderBlock('![badge](https://img.example/b.svg)');
    expect(html).toContain('<img');
    expect(html).toContain('https://img.example/b.svg');
  });

  it('drops an http image, since the page is served over https', () => {
    expect(renderBlock('![b](http://img.example/b.svg)')).not.toContain('http://img.example');
  });
});

// These are the tests that must fail loudly if the sanitiser is ever removed,
// reconfigured or swapped. Package READMEs are publisher controlled, so this is
// the only thing between a plugin author and script execution on gl3.dev.
describe('sanitising publisher content', () => {
  it('removes a script tag', () => {
    const html = renderBlock('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('removes an event handler attribute', () => {
    const html = renderBlock('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('removes a javascript: link', () => {
    const html = renderBlock('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('removes a style tag', () => {
    expect(renderBlock('<style>body{display:none}</style>')).not.toContain('<style');
  });

  it('hardens links, so a publisher cannot reach back through window.opener', () => {
    const html = renderBlock('[docs](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('hardens links in inline rendering too', () => {
    const html = renderInline('[docs](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
