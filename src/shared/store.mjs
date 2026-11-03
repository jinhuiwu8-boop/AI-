import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createEmptyState() {
  return {
    schemaVersion: 1, customers: [], products: [], prices: {}, priceEvents: [],
    orders: [], salesEvents: [], operations: {}, messages: [], batches: [],
    edgeJobs: [], printAttempts: [], sources: [], notifications: [],
    edgeDevices: [], correctionSamples: [],
  };
}

// Local adapter: a single versioned state row, with the entire command in one
// SQLite write transaction. Production table layout remains a separate adapter.
export function createStore({ filename = ':memory:', initialState } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS local_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, body TEXT NOT NULL)');
  const load = db.prepare('SELECT schema_version, body FROM local_state WHERE id=1');
  const write = db.prepare('UPDATE local_state SET body=? WHERE id=1');
  db.prepare('INSERT OR IGNORE INTO local_state(id,schema_version,body) VALUES(1,1,?)')
    .run(JSON.stringify(initialState ?? createEmptyState()));
  let closed = false;
  let writing = false;
  function state() {
    if (closed) throw new Error('Store is closed');
    const row = load.get();
    if (row.schema_version !== 1) throw new Error('Unsupported local state version');
    const value = JSON.parse(row.body);
    if (value.schemaVersion !== 1) throw new Error('Unsupported state payload version');
    // Additive W2 collections: keep existing W1 business records byte-for-value.
    value.edgeDevices ??= [];
    value.correctionSamples ??= [];
    return value;
  }
  return {
    read() { return state(); },
    transact(fn) {
      if (closed) throw new Error('Store is closed');
      if (writing) throw new Error('Nested store transactions are not supported');
      db.exec('BEGIN IMMEDIATE');
      writing = true;
      try {
        const value = state();
        const result = fn(value);
        if (result && typeof result.then === 'function') throw new Error('Transaction callbacks must be synchronous');
        const copy = result === undefined ? undefined : structuredClone(result);
        write.run(JSON.stringify(value));
        db.exec('COMMIT');
        return copy;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally { writing = false; }
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
