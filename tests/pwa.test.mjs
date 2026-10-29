import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('PWA: caches stay within the project scope and never intercept Tobii requests', async () => {
  const handlers = {};
  const deleted = [];
  let precached;
  let claimed = false;
  const cache = { addAll: async files => { precached = files; }, match: async () => 'offline app' };
  const self = { registration: { scope: 'https://ian030590.github.io/FlyingMoo/' },
    addEventListener: (type, handler) => { handlers[type] = handler; }, clients: { claim: async () => { claimed = true; } } };
  vm.runInNewContext(readFileSync(new URL('../wwwroot/sw.js', import.meta.url), 'utf8')
    .replace('"__PRECACHE__"', '["./", "models/face_landmarker.task"]'), {
    self, URL, caches: { open: async () => cache,
      keys: async () => ['flyingmoo-/FlyingMoo/-old', 'flyingmoo-/OtherApp/-old', 'other-cache'],
      delete: async name => { deleted.push(name); } }, fetch: () => { throw new Error('Network should not be used'); }
  });
  let pending;
  handlers.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(precached[1], 'models/face_landmarker.task');
  handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, ['flyingmoo-/FlyingMoo/-old']);
  assert.equal(claimed, true);
  let intercepted;
  const fetchEvent = url => ({ request: { url, method: 'GET', mode: 'navigate' }, respondWith: p => { intercepted = p; } });
  handlers.fetch(fetchEvent('http://127.0.0.1:17343/command'));
  handlers.fetch(fetchEvent('https://ian030590.github.io/OtherApp/'));
  assert.equal(intercepted, undefined);
  handlers.fetch(fetchEvent('https://ian030590.github.io/FlyingMoo/'));
  assert.equal(await intercepted, 'offline app');
});
