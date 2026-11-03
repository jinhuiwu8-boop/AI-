import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/shared/store.mjs';

test('failed command rolls back; restart and another connection see committed state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-state-'));
  const filename = join(dir, 'state.sqlite');
  const first = createStore({ filename });
  const second = createStore({ filename });
  try {
    first.transact(s => s.customers.push({ id: 'one', name: 'Synthetic' }));
    assert.equal(second.read().customers.length, 1);
    assert.throws(() => second.transact(s => { s.customers.length = 0; throw new Error('crash'); }));
    assert.equal(first.read().customers.length, 1);
    const copy = first.read(); copy.customers.length = 0;
    assert.equal(first.read().customers.length, 1);
    assert.throws(() => first.transact(async s => { s.customers.length = 0; }));
    assert.equal(first.read().customers.length, 1);
  } finally { first.close(); second.close(); }
  const restarted = createStore({ filename });
  try { assert.equal(restarted.read().customers.length, 1); }
  finally { restarted.close(); rmSync(dir, { recursive: true, force: true }); }
});
