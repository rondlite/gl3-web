import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * Turns package README markdown into HTML.
 *
 * Package READMEs are publisher controlled, so everything here is sanitised on
 * the way out. There is deliberately no unsanitised path: the catalogue has no
 * notion of a trusted publisher, so an exception for one would be an exception
 * for all of them.
 *
 * This runs on the server rather than in the browser because the site is built
 * by GitHub Actions, where store-api is unreachable, so nothing can be rendered
 * from catalogue data at build time. Keeping it here also means no markdown
 * parser and no sanitiser ship to visitors.
 */

// Allowlist, never a denylist: sanitize-html's defaults permit a known set of
// tags, so script, style and every event handler attribute are excluded by not
// being named rather than by being blocked.
//
// Held as its own typed array (rather than inline on baseOptions) because
// sanitize-html.IOptions widens allowedTags to `string[] | false`, and
// blockOptions below needs to spread it back into an array.
const baseAllowedTags: string[] = [...sanitizeHtml.defaults.allowedTags];

const baseOptions: sanitizeHtml.IOptions = {
  allowedTags: baseAllowedTags,
  allowedAttributes: {
    // rel and target are here, not just in transformTags, because
    // sanitize-html filters attributes after a transform runs: an attribute
    // the transform adds still gets stripped if it isn't allowlisted too.
    a: ['href', 'title', 'rel', 'target'],
    code: ['class'],
    span: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // noopener and noreferrer stop a linked page reaching back through
    // window.opener. target=_blank keeps a publisher's link from navigating
    // the storefront away from itself.
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
      target: '_blank',
    }),
  },
};

// Block rendering allows images because badges are a normal part of a README
// and stripping them leaves visible gaps. https only: these pages are served
// over https and a mixed content image would be blocked by the browser anyway.
const blockOptions: sanitizeHtml.IOptions = {
  ...baseOptions,
  allowedTags: [...baseAllowedTags, 'img'],
  allowedAttributes: {
    ...baseOptions.allowedAttributes,
    img: ['src', 'alt', 'title'],
  },
  allowedSchemesByTag: { img: ['https'] },
};

/**
 * Renders a card description.
 *
 * Inline parsing on purpose: a description is a fragment, so emphasis, inline
 * code and links should render, but a README whose first line starts with "#"
 * must not turn its card into a heading. Cards stay uniform whatever the
 * package opens with. Images are excluded for the same reason: a card is a
 * three line summary and an image in it breaks the grid.
 */
export function renderInline(src: string | null): string | null {
  if (src === null) {
    return null;
  }
  return sanitizeHtml(marked.parseInline(src, { async: false }), baseOptions);
}

/** Renders a full README for a plugin page. */
export function renderBlock(src: string | null): string | null {
  if (src === null) {
    return null;
  }
  return sanitizeHtml(marked.parse(src, { async: false }), blockOptions);
}
