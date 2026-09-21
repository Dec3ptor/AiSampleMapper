#!/usr/bin/env node
/* Builds artifact.html from index.html.
 *
 * index.html is a complete document so the app can be opened straight off disk.
 * A published Claude Artifact supplies its own <!doctype>/<html>/<head>/<body>
 * wrapper, so the published page must be the body content only, with the
 * <title> and the stylesheet links carried across. Same source, two targets.
 *
 *   node tools/build-artifact.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const title = /<title>([\s\S]*?)<\/title>/.exec(src);
const description = /<meta name="description" content="([^"]*)"/.exec(src);
const links = [...src.matchAll(/<link\b[^>]*rel="(?:stylesheet|preconnect)"[^>]*>/g)].map(m => m[0]);
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(src);

if (!title || !body) {
  console.error('index.html is missing a <title> or a <body>; nothing written.');
  process.exit(1);
}

const out = [
  `<title>${title[1]}</title>`,
  ...links,
  body[1].trim(),
  ''
].join('\n');

const dest = path.join(root, 'artifact.html');
fs.writeFileSync(dest, out);

console.log(`artifact.html  ${(out.length / 1024).toFixed(1)} kB`);
console.log(`title          ${title[1]}`);
if (description) console.log(`description    ${description[1]}`);
console.log('\nPublish with index.html omitted and these as supporting files:');
for (const f of ['css/app.css', 'js/geo.js', 'js/geometry.js', 'js/plan.js',
                 'js/store.js', 'js/render.js', 'js/export.js', 'js/app.js',
                 'sample/site-aerial.jpg']) {
  const s = fs.statSync(path.join(root, f));
  console.log(`  ${f.padEnd(24)} ${(s.size / 1024).toFixed(1)} kB`);
}
