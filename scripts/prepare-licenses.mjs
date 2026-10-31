#!/usr/bin/env node
// Writes the third-party licence notices shipped with the site.
//   public/third-party-licenses.txt  full licence texts of every production dependency (served at /third-party-licenses.txt)
//   THIRD_PARTY_NOTICES.md           summary table: package, version, licence, link
// Fails when a production package has an unknown licence or one outside ALLOWED, so a copyleft or
// proprietary dependency cannot reach the build unnoticed. Run: node scripts/prepare-licenses.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0']);
const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense)([-._].*)?$/i;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** Finds `name` the way Node does: node_modules next to the requiring package, then its ancestors. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === dirname(dir)) return undefined;
  }
}

/** Every package reachable from the root `dependencies`, one entry per name@version. */
function collectProduction() {
  const found = new Map();
  const visit = (dir, optional) => {
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) return;
    found.set(key, { dir, pkg });
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const child = resolvePackage(name, dir);
      if (!child) throw new Error(`${key} depends on ${name}, which is not installed. Run npm install.`);
      visit(child, false);
    }
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      const child = resolvePackage(name, dir);
      if (child) visit(child, true);
    }
  };
  const rootPkg = readJson(join(ROOT, 'package.json'));
  for (const name of Object.keys(rootPkg.dependencies ?? {})) {
    const dir = resolvePackage(name, ROOT);
    if (!dir) throw new Error(`${name} is not installed. Run npm install.`);
    visit(dir, false);
  }
  return [...found.values()];
}

/** The declared licence as an SPDX expression string, or undefined. */
function declaredLicense(pkg) {
  const one = value => (typeof value === 'string' ? value : value?.type);
  if (pkg.license) return one(pkg.license);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) return `(${pkg.licenses.map(one).join(' OR ')})`;
  return undefined;
}

/** True when the SPDX expression can be satisfied using allowed licences only (OR: any branch, AND: every part). */
function expressionAllowed(expression) {
  const tokens = expression.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
  let i = 0;
  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[i] === 'OR') { i++; ok = parseAnd() || ok; }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[i] === 'AND') { i++; ok = parseAtom() && ok; }
    return ok;
  };
  const parseAtom = () => {
    const token = tokens[i++];
    if (token === '(') { const ok = parseOr(); i++; return ok; }
    return ALLOWED.has(token);
  };
  const ok = parseOr();
  return ok && i === tokens.length;
}

const MIT_TEXT = copyright => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const authorName = pkg => (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name)?.replace(/\s*[<(].*$/, '').trim();

/** Licence files shipped in the package, plus a standard text when there are none. */
function licenseTexts({ dir, pkg }, license) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const texts = [];
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n?/g, '\n').trim();
    if (text && !texts.some(entry => entry.text === text)) texts.push({ name, text });
  }
  if (texts.length) return texts;
  const author = authorName(pkg) ?? `the ${pkg.name} authors`;
  if (license === 'MIT') return [{ name: '(standard MIT text; the package ships no licence file)', text: MIT_TEXT(`Copyright (c) ${author}`) }];
  if (license === 'Apache-2.0') {
    const standard = readFileSync(join(ROOT, 'scripts/license-templates/Apache-2.0.txt'), 'utf8').replace(/\r\n?/g, '\n').trim();
    return [{ name: '(standard Apache-2.0 text; the package ships no licence file)', text: `Copyright ${author}\n\n${standard}` }];
  }
  throw new Error(`${pkg.name}@${pkg.version} (${license}) ships no licence file and has no built-in template`);
}

/** A browsable https link for the package: repository, else homepage, else its npm page. */
function linkOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (repo) {
    const url = repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^github:/, 'https://github.com/').replace(/\.git$/, '');
    if (/^https?:\/\//.test(url)) return url;
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  }
  return pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`;
}

const packages = collectProduction().sort((a, b) =>
  a.pkg.name.localeCompare(b.pkg.name, 'en') || a.pkg.version.localeCompare(b.pkg.version, 'en', { numeric: true }));

const problems = [];
const entries = [];
for (const item of packages) {
  const id = `${item.pkg.name}@${item.pkg.version}`;
  const license = declaredLicense(item.pkg);
  if (!license || /^(SEE LICENSE|UNLICENSED)/i.test(license)) { problems.push(`${id}: unknown licence (${license ?? 'none declared'})`); continue; }
  if (!expressionAllowed(license)) { problems.push(`${id}: licence ${license} is outside the allowlist (${[...ALLOWED].join(', ')})`); continue; }
  try {
    entries.push({ id, name: item.pkg.name, version: item.pkg.version, license, link: linkOf(item.pkg), texts: licenseTexts(item, license) });
  } catch (error) { problems.push(error.message); }
}
if (problems.length) {
  console.error(`Third-party licence check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const rule = '='.repeat(78);
const txt = [
  'Typhoon Lab third-party licences',
  '',
  'Typhoon Lab itself is licensed under CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/).',
  'The open-source packages below are included in the production build and keep their own licences,',
  'reproduced here. Third-party data keeps its own terms; see DATA_SOURCES.md in the source repository.',
  '',
  `${entries.length} packages`,
  '',
  ...entries.flatMap(entry => [
    rule,
    `${entry.name} ${entry.version}`,
    `License: ${entry.license}`,
    `Source: ${entry.link}`,
    '',
    ...entry.texts.flatMap(({ name, text }) => [`--- ${name} ---`, '', text, '']),
  ]),
].join('\n');
writeFileSync(join(ROOT, 'public/third-party-licenses.txt'), `${txt}\n`);

const cell = value => value.replace(/\|/g, '\\|');
const md = [
  '# Third-party notices',
  '',
  'Typhoon Lab\'s own work is licensed under CC BY-NC-SA 4.0 (see [LICENSE](LICENSE)). The production build includes the open-source packages below, which keep their own licences and are not relicensed. Their full licence texts are in [`public/third-party-licenses.txt`](public/third-party-licenses.txt), served at <https://typhoon.typostudio.dev/third-party-licenses.txt>. Third-party data is covered in [DATA_SOURCES.md](DATA_SOURCES.md).',
  '',
  'Generated by `node scripts/prepare-licenses.mjs` (part of `npm run build`). Do not edit by hand.',
  '',
  '| Package | Version | License | Link |',
  '| --- | --- | --- | --- |',
  ...entries.map(entry => `| ${cell(entry.name)} | ${entry.version} | ${cell(entry.license)} | ${entry.link} |`),
  '',
].join('\n');
writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), md);

const histogram = {};
for (const entry of entries) histogram[entry.license] = (histogram[entry.license] ?? 0) + 1;
console.log(`${entries.length} production packages`);
for (const [license, count] of Object.entries(histogram).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${license}: ${count}`);
