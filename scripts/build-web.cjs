'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'wwwroot');
const output = path.join(root, 'dist-web');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true });
const files = fs.readdirSync(source, { recursive: true }).filter(file =>
  fs.statSync(path.join(source, file)).isFile() && file !== 'sw.js'
).map(file => file.replaceAll('\\', '/')).sort();
const hash = crypto.createHash('sha256');
for (const file of files) hash.update(file).update(fs.readFileSync(path.join(source, file)));
const worker = fs.readFileSync(path.join(source, 'sw.js'), 'utf8')
  .replace('"__PRECACHE__"', JSON.stringify(['./', ...files]))
  .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 16));
fs.writeFileSync(path.join(output, 'sw.js'), worker);
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log(`Built ${files.length} offline assets in dist-web/`);
