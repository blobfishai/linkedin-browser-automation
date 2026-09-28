import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { runBatch } from '../src/runner.mjs';

const person = { name: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example-person', messageUrl: 'https://www.linkedin.com/messaging/compose/?recipient=EXAMPLE_ID' };
const config = { body: 'An example note', pauseMs: 1000 };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-local-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new Store(directory);
}
test('send intent survives reopening, and a receipt resolves it', t => {
  const store = fixture(t); store.personEvent(person, config, { status: 'send_attempted' });
  const reopened = new Store(store.directory);
  assert.equal(reopened.summary().unresolved.length, 1);
  reopened.personEvent(person, config, { status: 'sent', evidence: 'receipt.txt' });
  assert.equal(store.summary().unresolved.length, 0);
  assert.equal(store.summary().sent, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.ledger).mode & 0o777, 0o600);
});
test('a truncated ledger fails closed', t => {
  const store = fixture(t); fs.writeFileSync(store.ledger, '{"status":');
  assert.throws(() => store.events(), /incomplete or invalid/);
});
test('a second process cannot acquire or release the active lock', t => {
  const first = fixture(t), second = new Store(first.directory);
  first.acquire();
  assert.throws(() => second.acquire(), /Another run/);
  second.release(); assert.equal(fs.existsSync(first.lock), true);
  first.release(); second.acquire(); second.release();
});
test('preview neither sends nor consumes a connection', async t => {
  const store = fixture(t), results = [];
  const workflow = { inspect: async () => ({ decision: { status: 'eligible_old' } }), send: async () => { throw new Error('Unexpected send'); } };
  await runBatch({ config, people: [person], store, workflow, onResult: result => results.push(result) });
  assert.equal(results[0].status, 'would_send'); assert.deepEqual(store.events(), []);
});
test('unresolved sends and rate-limit state block the next batch before inspection', async t => {
  const store = fixture(t), workflow = { inspect: async () => { throw new Error('Should not inspect'); } };
  store.personEvent(person, config, { status: 'send_uncertain' });
  await assert.rejects(runBatch({ config, people: [person], store, workflow }), /unresolved/);
  store.setState({ blocked: true, reason: 'http_429' });
  await assert.rejects(runBatch({ config, people: [person], store, workflow }), /campaign is stopped/);
});
test('an ambiguous conversation stops the batch before the next person', async t => {
  const store = fixture(t); let inspected = 0;
  const workflow = { inspect: async () => { inspected++; return { decision: { status: 'needs_review' } }; } };
  await runBatch({ config, people: [person, { ...person, messageUrl: person.messageUrl.replace('EXAMPLE_ID', 'OTHER_ID') }], store, workflow, limit: 2 });
  assert.equal(inspected, 1);
});
test('confirmed skips are resumed by recipient ID, and CSV cells are escaped', async t => {
  const store = fixture(t);
  store.personEvent({ ...person, name: '=EXAMPLE()' }, config, { status: 'skipped_recent_chat', reason: 'Comma, and "quote"' });
  await runBatch({ config, people: [{ ...person, profileUrl: 'https://www.linkedin.com/in/renamed' }], store, workflow: { inspect: async () => { throw new Error('Duplicate inspection'); } } });
  const summary = store.checkpoint(); assert.equal(summary.skipped, 1);
  const csv = fs.readFileSync(path.join(store.directory, 'outreach-results.csv'), 'utf8');
  assert.ok(csv.includes("'=EXAMPLE()")); assert.ok(csv.includes('Comma, and ""quote""'));
});
test('init creates a private empty campaign and refuses to overwrite it', t => {
  const store = fixture(t), dir = path.join(store.directory, 'campaign');
  const run = () => spawnSync(process.execPath, ['src/cli.mjs', 'init', '--dir', dir], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'connections.json'))), []);
  assert.equal(run().status, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
});
