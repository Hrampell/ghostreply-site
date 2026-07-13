import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractCanonical,
  extractJsonLd,
  inspectHtml,
  validateSite,
} from '../scripts/validate-seo.mjs';

const validatorPath = fileURLToPath(
  new URL('../scripts/validate-seo.mjs', import.meta.url),
);

function htmlPage({
  title = 'GhostReply for Busy Professionals',
  description = 'Draft thoughtful text replies faster on your Mac.',
  canonical = 'https://ghostreply.lol/',
  h1 = '<h1>Reply without the busywork</h1>',
  body = '',
  jsonLd,
} = {}) {
  const jsonLdTag = jsonLd === undefined
    ? ''
    : `<script type="application/ld+json">${jsonLd}</script>`;

  return `<!doctype html>
<html lang="en">
  <head>
    ${title === null ? '' : `<title>${title}</title>`}
    ${description === null ? '' : `<meta name="description" content="${description}">`}
    ${canonical === null ? '' : `<link rel="canonical" href="${canonical}">`}
    ${jsonLdTag}
  </head>
  <body>${h1 === null ? '' : h1}${body}</body>
</html>`;
}

function sitemap(...canonicals) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${canonicals.map((canonical) => `  <url><loc>${canonical}</loc></url>`).join('\n')}
</urlset>`;
}

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'ghostreply-seo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }

  return root;
}

function assertHasError(result, pattern) {
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `Expected an error matching ${pattern}, received:\n${result.errors.join('\n')}`,
  );
}

test('extractCanonical reads a canonical link regardless of attribute order', () => {
  const source = `<link href='https://ghostreply.lol/sales.html' data-test="x" rel='canonical'>`;

  assert.equal(extractCanonical(source), 'https://ghostreply.lol/sales.html');
  assert.equal(extractCanonical('<html></html>'), null);
});

test('extractJsonLd parses every JSON-LD block', () => {
  const source = `
    <script type="application/ld+json">{"@type":"SoftwareApplication"}</script>
    <script data-name="faq" type='application/ld+json'>[{"@type":"Question"}]</script>
  `;

  assert.deepEqual(extractJsonLd(source), [
    { '@type': 'SoftwareApplication' },
    [{ '@type': 'Question' }],
  ]);
});

test('extractJsonLd handles greater-than signs inside quoted script attributes', () => {
  const source = `
    <script data-note="a > b" type="application/ld+json">
      {"@type":"SoftwareApplication"}
    </script>
  `;

  assert.deepEqual(extractJsonLd(source), [
    { '@type': 'SoftwareApplication' },
  ]);
});

test('extractJsonLd preserves HTML-comment-like text inside JSON strings', () => {
  const source = `
    <script type="application/ld+json">
      {"text":"before <!--keep--> after"}
    </script>
  `;

  assert.deepEqual(extractJsonLd(source), [
    { text: 'before <!--keep--> after' },
  ]);
});

test('inspectHtml reports extracted metadata and links', () => {
  const source = htmlPage({
    body: '<a href="/sales.html?ref=footer#demo">Sales</a>',
    jsonLd: '{"@type":"SoftwareApplication"}',
  });

  const page = inspectHtml('/site/index.html', source);

  assert.equal(page.title, 'GhostReply for Busy Professionals');
  assert.equal(page.description, 'Draft thoughtful text replies faster on your Mac.');
  assert.equal(page.canonical, 'https://ghostreply.lol/');
  assert.equal(page.h1Count, 1);
  assert.deepEqual(page.internalHtmlLinks, ['/sales.html?ref=footer#demo']);
  assert.deepEqual(page.jsonLd, [{ '@type': 'SoftwareApplication' }]);
  assert.deepEqual(page.errors, []);
});

for (const [label, option, pattern] of [
  ['title', { title: null }, /index\.html: missing <title>/i],
  ['description', { description: null }, /index\.html: missing meta description/i],
  ['canonical', { canonical: null }, /index\.html: missing canonical/i],
  ['H1', { h1: null }, /index\.html: expected exactly one <h1>.*found 0/i],
]) {
  test(`validateSite rejects a content page missing its ${label}`, (t) => {
    const root = fixture(t, {
      'index.html': htmlPage(option),
      'sitemap.xml': sitemap('https://ghostreply.lol/'),
    });

    assertHasError(validateSite(root), pattern);
  });
}

test('validateSite rejects a content page with more than one H1', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      h1: '<h1>First heading</h1><h1>Second heading</h1>',
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  assertHasError(
    validateSite(root),
    /index\.html: expected exactly one <h1>.*found 2/i,
  );
});

test('validateSite rejects duplicate canonicals, titles, and descriptions', (t) => {
  const duplicateCanonical = 'https://ghostreply.lol/shared.html';
  const root = fixture(t, {
    'first.html': htmlPage({ canonical: duplicateCanonical }),
    'second.html': htmlPage({ canonical: duplicateCanonical }),
    'sitemap.xml': sitemap(duplicateCanonical),
  });

  const result = validateSite(root);

  assertHasError(result, /duplicate canonical.*first\.html.*second\.html/i);
  assertHasError(result, /duplicate title.*first\.html.*second\.html/i);
  assertHasError(result, /duplicate description.*first\.html.*second\.html/i);
});

test('validateSite rejects invalid JSON-LD', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({ jsonLd: '{\n"@type":\n}' }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assertHasError(result, /index\.html: invalid JSON-LD block 1/i);
  assert.doesNotMatch(result.errors.join(''), /[\r\n]/);
});

test('validateSite rejects em dashes and en dashes in marketing HTML', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      body: '<p>Fast replies\u2014without delay. Clear writing\u2013every time.</p>',
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assertHasError(result, /index\.html: banned em dash/i);
  assertHasError(result, /index\.html: banned en dash/i);
});

test('validateSite rejects a missing root-relative HTML link target', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      body: '<a href="/missing.html?from=home#details">Missing page</a>',
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  assertHasError(
    validateSite(root),
    /index\.html: internal link \/missing\.html\?from=home#details does not resolve/i,
  );
});

test('validateSite URL-decodes links before identifying HTML targets', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      body: '<a href="/missing%2Ehtml">Missing encoded page</a>',
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  assertHasError(
    validateSite(root),
    /index\.html: internal link \/missing%2Ehtml does not resolve/i,
  );
});

test('validateSite rejects a canonical content page omitted from sitemap.xml', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage(),
    'sitemap.xml': sitemap('https://ghostreply.lol/somewhere-else.html'),
  });

  assertHasError(
    validateSite(root),
    /index\.html: canonical https:\/\/ghostreply\.lol\/ is missing from sitemap\.xml/i,
  );
});

test('a canonical in a commented-out sitemap entry is still omitted', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage(),
    'sitemap.xml': `<?xml version="1.0"?>
      <urlset><!-- <url><loc>https://ghostreply.lol/</loc></url> --></urlset>`,
  });

  assertHasError(
    validateSite(root),
    /index\.html: canonical https:\/\/ghostreply\.lol\/ is missing from sitemap\.xml/i,
  );
});

test('HTML-like JSON-LD strings do not count as headings or internal links', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      jsonLd: JSON.stringify({
        headline: '<h1>Not document markup</h1>',
        example: '<a href="/missing.html">Example</a>',
      }),
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assert.equal(result.pages[0].h1Count, 1);
  assert.deepEqual(result.pages[0].internalHtmlLinks, []);
  assert.deepEqual(result.errors, []);
});

test('HTML comments do not count as headings or internal links', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({
      body: '<!-- <h1>Hidden heading</h1><a href="/missing.html">Hidden link</a> -->',
    }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assert.equal(result.pages[0].h1Count, 1);
  assert.deepEqual(result.pages[0].internalHtmlLinks, []);
  assert.deepEqual(result.errors, []);
});

test('404 and Google verification files may omit canonical metadata', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage(),
    '404.html': htmlPage({
      title: 'Page not found',
      description: 'The requested page could not be found.',
      canonical: null,
      h1: '<h1>Page not found</h1>',
    }),
    'google5bc07300a6d1eb86.html': 'google-site-verification: google5bc07300a6d1eb86.html',
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assert.equal(result.pages.length, 3);
  assert.deepEqual(result.errors, []);
});

test('a marketing page whose name starts with google is not verification HTML', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage(),
    'google-business.html': '<h1>Google business messaging</h1>',
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const result = validateSite(root);

  assert.equal(
    result.pages.find((page) => page.fileName === 'google-business.html')?.isContentPage,
    true,
  );
  assertHasError(result, /google-business\.html: missing <title>/i);
  assertHasError(result, /google-business\.html: missing canonical/i);
});

test('validateSite accepts a complete site with resolving internal HTML links', (t) => {
  const root = fixture(t, {
    'index.html': htmlPage({ body: '<a href="/sales.html">Sales</a>' }),
    'sales.html': htmlPage({
      title: 'GhostReply for Sales Teams',
      description: 'Keep prospect conversations moving from iMessage on Mac.',
      canonical: 'https://ghostreply.lol/sales.html',
      h1: '<h1>Reply while the lead is warm</h1>',
    }),
    'sitemap.xml': sitemap(
      'https://ghostreply.lol/',
      'https://ghostreply.lol/sales.html',
    ),
  });

  const result = validateSite(root);

  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.errors, []);
});

test('direct CLI prints counts and exits nonzero when validation fails', (t) => {
  const validRoot = fixture(t, {
    'index.html': htmlPage(),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });
  const invalidRoot = fixture(t, {
    'index.html': htmlPage({ title: null }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });
  const multilineJsonRoot = fixture(t, {
    'index.html': htmlPage({ jsonLd: '{\n"@type":\n}' }),
    'sitemap.xml': sitemap('https://ghostreply.lol/'),
  });

  const validRun = spawnSync(process.execPath, [validatorPath, validRoot], {
    encoding: 'utf8',
  });
  const invalidRun = spawnSync(process.execPath, [validatorPath, invalidRoot], {
    encoding: 'utf8',
  });
  const multilineJsonRun = spawnSync(
    process.execPath,
    [validatorPath, multilineJsonRoot],
    { encoding: 'utf8' },
  );

  assert.equal(validRun.status, 0, validRun.stderr || validRun.stdout);
  assert.match(validRun.stdout, /1 page.*0 errors/i);
  assert.notEqual(invalidRun.status, 0);
  assert.match(invalidRun.stdout, /1 page.*1 error/i);
  assert.match(invalidRun.stdout, /index\.html: missing <title>/i);
  assert.notEqual(multilineJsonRun.status, 0);
  assert.equal(
    multilineJsonRun.stdout.trim().split(/\r?\n/).length,
    2,
    multilineJsonRun.stdout,
  );
});

test('homepage demo exposes controls and respects reduced motion', () => {
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');

  assert.match(source, /<video[^>]+id="demoV"[^>]+controls[^>]*>/);
  assert.match(
    source,
    /if \(reduce\) \{ wrap\.classList\.add\('in'\); v\.pause && v\.pause\(\); return; \}/,
  );
});
