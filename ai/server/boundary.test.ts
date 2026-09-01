import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The client/server boundary, checked physically.
 *
 * ESLint forbids the import and Metro refuses to resolve it, but both are
 * configuration: a rule can be disabled inline, and a resolver entry can be
 * deleted in a refactor without anyone noticing. This test reads the actual
 * source tree, so the boundary fails loudly in CI regardless of what the
 * configs say.
 *
 * It runs from the compiled output, so it locates the repository from the
 * working directory npm sets.
 */

const ROOT = process.cwd();

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist-test',
  '.expo',
  '.git',
  'assets',
  'docs',
]);

/** Trees that are allowed to contain server-only AI code. */
const SERVER_TREES = [join('ai', 'server'), join('supabase', 'functions')];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) {
      continue;
    }
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function isInServerTree(file: string): boolean {
  const rel = relative(ROOT, file);
  return SERVER_TREES.some((tree) => rel === tree || rel.startsWith(tree + sep));
}

/** Only real import/require statements, so prose in a comment does not trip. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

describe('client/server AI boundary', () => {
  it('sanity: the working directory is the repository root', () => {
    assert.equal(
      readFileSync(join(ROOT, 'package.json'), 'utf8').includes('shop-discovery-app'),
      true
    );
  });

  it('no file outside the server trees imports ai/server', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(ROOT)) {
      if (isInServerTree(file)) {
        continue;
      }
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (/(^|[/])ai[/]server([/]|$)/.test(specifier)) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `server-only AI code is reachable from the app:\n${offenders.join('\n')}`
    );
  });

  it('ai/contracts never reaches sideways into ai/server', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(ROOT, 'ai', 'contracts'))) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.includes('server')) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }

    assert.deepEqual(offenders, [], `ai/contracts must stay client-safe:\n${offenders.join('\n')}`);
  });

  it('Metro still blocks ai/server from resolution', () => {
    const config = readFileSync(join(ROOT, 'metro.config.js'), 'utf8');
    assert.equal(
      config.includes('blockList'),
      true,
      'metro.config.js no longer defines a blockList'
    );
    assert.match(
      config,
      /ai\[\\\\\/\]server/,
      'metro.config.js no longer blocks ai/server from the bundle'
    );
  });
});
