#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const GOOGLE_VERIFICATION_FILE = /^google[a-z0-9]+\.html$/i;

function withoutComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

function withoutRawTextElements(source) {
  return source.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
}

function parseAttributes(tag) {
  const attributes = new Map();
  const attributeSource = tag
    .replace(/^<\s*[\w:-]+\b/, '')
    .replace(/\/?\s*>$/, '');
  const attributePattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of attributeSource.matchAll(attributePattern)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set(match[1].toLowerCase(), value);
  }

  return attributes;
}

function findTags(source, tagName) {
  return source.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
}

function normalizedText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function extractTitle(source) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  return match ? normalizedText(match[1]) : null;
}

function extractMetaDescription(source) {
  for (const tag of findTags(source, 'meta')) {
    const attributes = parseAttributes(tag);
    if (attributes.get('name')?.toLowerCase() === 'description') {
      return attributes.get('content') ?? '';
    }
  }

  return null;
}

function canonicalLinks(source) {
  const canonicals = [];

  for (const tag of findTags(source, 'link')) {
    const attributes = parseAttributes(tag);
    const relationships = (attributes.get('rel') ?? '')
      .toLowerCase()
      .split(/\s+/);

    if (relationships.includes('canonical')) {
      canonicals.push(attributes.get('href') ?? '');
    }
  }

  return canonicals;
}

function jsonLdBlocks(source) {
  const blocks = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

  for (const match of source.matchAll(scriptPattern)) {
    const attributes = parseAttributes(`<script ${match[1]}>`);
    if (attributes.get('type')?.trim().toLowerCase() === 'application/ld+json') {
      blocks.push(match[2]);
    }
  }

  return blocks;
}

function extractInternalHtmlLinks(source) {
  const links = [];
  const linkTagPattern = /<(?:a|area)\b[^>]*>/gi;

  for (const tag of source.match(linkTagPattern) ?? []) {
    const href = parseAttributes(tag).get('href')?.trim();
    if (!href || !href.startsWith('/') || href.startsWith('//')) {
      continue;
    }

    const pathOnly = href.split(/[?#]/, 1)[0];
    if (/\.html$/i.test(pathOnly)) {
      links.push(href);
    }
  }

  return links;
}

function isGoogleVerificationFile(fileName, source) {
  return GOOGLE_VERIFICATION_FILE.test(fileName)
    && source.trim().toLowerCase()
      === `google-site-verification: ${fileName}`.toLowerCase();
}

function isContentFile(fileName, source) {
  return fileName.toLowerCase() !== '404.html'
    && !isGoogleVerificationFile(fileName, source);
}

export function extractCanonical(source) {
  const structuralSource = withoutRawTextElements(withoutComments(source));
  return canonicalLinks(structuralSource)[0] ?? null;
}

export function extractJsonLd(source) {
  return jsonLdBlocks(withoutComments(source)).map((block) => JSON.parse(block));
}

export function inspectHtml(filePath, source) {
  const fileName = basename(filePath);
  const cleanSource = withoutComments(source);
  const structuralSource = withoutRawTextElements(cleanSource);
  const isContentPage = isContentFile(fileName, cleanSource);
  const title = extractTitle(structuralSource);
  const description = extractMetaDescription(structuralSource);
  const canonical = extractCanonical(structuralSource);
  const h1Count = (structuralSource.match(/<h1\b[^>]*>/gi) ?? []).length;
  const internalHtmlLinks = extractInternalHtmlLinks(structuralSource);
  const errors = [];
  const jsonLd = [];

  jsonLdBlocks(cleanSource).forEach((block, index) => {
    try {
      jsonLd.push(JSON.parse(block));
    } catch (error) {
      errors.push(
        `${fileName}: invalid JSON-LD block ${index + 1}: ${normalizedText(error.message)}`,
      );
    }
  });

  if (isContentPage) {
    if (!title) {
      errors.push(`${fileName}: missing <title>`);
    }
    if (!description?.trim()) {
      errors.push(`${fileName}: missing meta description`);
    }
    if (!canonical?.trim()) {
      errors.push(`${fileName}: missing canonical`);
    }
    if (h1Count !== 1) {
      errors.push(
        `${fileName}: expected exactly one <h1>, found ${h1Count}`,
      );
    }
    if (source.includes('\u2014')) {
      errors.push(`${fileName}: banned em dash character`);
    }
    if (source.includes('\u2013')) {
      errors.push(`${fileName}: banned en dash character`);
    }
  }

  return {
    filePath,
    fileName,
    isContentPage,
    title,
    description,
    canonical,
    h1Count,
    jsonLd,
    internalHtmlLinks,
    errors,
  };
}

function addDuplicateErrors(pages, field, label, errors) {
  const firstPageByValue = new Map();

  for (const page of pages) {
    const value = page[field]?.trim();
    if (!value) {
      continue;
    }

    const firstPage = firstPageByValue.get(value);
    if (firstPage) {
      errors.push(
        `duplicate ${label} in ${firstPage.fileName} and ${page.fileName}: ${value}`,
      );
    } else {
      firstPageByValue.set(value, page);
    }
  }
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function sitemapLocations(rootDir, errors) {
  const sitemapPath = join(rootDir, 'sitemap.xml');
  if (!existsSync(sitemapPath)) {
    errors.push('sitemap.xml: file is missing');
    return new Set();
  }

  const source = withoutComments(readFileSync(sitemapPath, 'utf8'));
  const locations = new Set();
  const locationPattern = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;

  for (const match of source.matchAll(locationPattern)) {
    locations.add(decodeXml(match[1].trim()));
  }

  return locations;
}

function internalLinkResolves(rootDir, href) {
  let pathName;

  try {
    pathName = decodeURIComponent(new URL(href, 'https://local.invalid').pathname);
  } catch {
    return false;
  }

  const targetPath = resolve(rootDir, `.${pathName}`);
  const relativeTarget = relative(rootDir, targetPath);
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    return false;
  }

  return existsSync(targetPath) && statSync(targetPath).isFile();
}

export function validateSite(rootDir) {
  const absoluteRoot = resolve(rootDir);
  const htmlFiles = readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const pages = htmlFiles.map((fileName) => {
    const filePath = join(absoluteRoot, fileName);
    return inspectHtml(filePath, readFileSync(filePath, 'utf8'));
  });
  const errors = pages.flatMap((page) => page.errors);
  const contentPages = pages.filter((page) => page.isContentPage);

  addDuplicateErrors(contentPages, 'canonical', 'canonical', errors);
  addDuplicateErrors(contentPages, 'title', 'title', errors);
  addDuplicateErrors(contentPages, 'description', 'description', errors);

  for (const page of pages) {
    for (const href of page.internalHtmlLinks) {
      if (!internalLinkResolves(absoluteRoot, href)) {
        errors.push(`${page.fileName}: internal link ${href} does not resolve`);
      }
    }
  }

  const sitemapLocs = sitemapLocations(absoluteRoot, errors);
  for (const page of contentPages) {
    if (page.canonical && !sitemapLocs.has(page.canonical)) {
      errors.push(
        `${page.fileName}: canonical ${page.canonical} is missing from sitemap.xml`,
      );
    }
  }

  return { pages, errors };
}

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function runCli() {
  const rootDir = process.argv[2] ?? process.cwd();

  try {
    const { pages, errors } = validateSite(rootDir);
    console.log(`${plural(pages.length, 'page')}, ${plural(errors.length, 'error')}`);
    for (const error of errors) {
      console.log(`- ${normalizedText(error)}`);
    }
    if (errors.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`SEO validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}
