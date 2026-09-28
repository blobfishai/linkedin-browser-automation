import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { LinkedInWorkflow, attach, listTabs } from '../../src/browser.mjs';
import { Store } from '../../src/store.mjs';
import { runBatch, reconcile } from '../../src/runner.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
const person = { name: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example-person', messageUrl: 'https://www.linkedin.com/messaging/compose/?recipient=EXAMPLE_ID' };
const config = { senderName: 'Example Sender', senderProfileUrl: 'https://www.linkedin.com/in/example-sender', body: 'Hello\u00a0there. An example note.', cutoffDate: '2025-09-27', includeNeverMessaged: true, pauseMs: 1000 };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function event(body, date = 'APR 14, 2025', sender = config.senderProfileUrl) {
  return `<article class="msg-s-message-list__event"><div class="msg-s-message-list__time-heading">${escape(date)}</div><a href="${sender}">Example Sender</a><time>8:00 AM</time><p class="msg-s-event-listitem__body">${escape(body)}</p></article>`;
}
function conversation(state) {
  const history = state.old ? event('An older message', state.recent ? 'SEP 27, 2025' : 'APR 14, 2025') : '';
  const sent = state.alreadySent ? event(config.body, 'TODAY') : '';
  return `<!doctype html><meta charset="utf-8"><style>.scrollable { height: 160px; overflow: auto; border: 1px solid; } article { padding: 12px; } [contenteditable] { min-height: 40px; }</style>
  <button aria-label="${escape(state.senderName || config.senderName)} Me">Me</button>
  <main>
    <ul aria-label="Conversation List"><li><h3 id="thread-link">Example Person</h3></li></ul>
    <div class="msg-convo-wrapper--scrollable">
      <button aria-label="Remove Example Person">Example Person</button>
      <div class="msg-s-message-list scrollable"><div class="msg-s-message-list-content">
        <a class="profile-card-one-to-one__profile-link" href="${person.profileUrl}">Example Person</a><span>1st degree connection</span>
        <div id="messages">${history}${sent}</div>
        <div class="msg-s-message-list__bottom-of-list" style="height:1px"></div>
      </div></div>
      <div role="textbox" aria-label="Write a message…" contenteditable="true">${escape(state.draft || '')}</div>
    </div>
  </main>
  <script>
    window.sendCount = 0;
    document.getElementById('thread-link').onclick = () => history.pushState({}, '', '/messaging/thread/example-thread/');
    document.querySelector('[contenteditable]').addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); window.sendCount++;
      if (${!!state.noReceipt}) return;
      const article = document.createElement('article'); article.className = 'msg-s-message-list__event';
      const sender = document.createElement('a'); sender.href = ${JSON.stringify(state.wrongReceiptSender ? 'https://www.linkedin.com/in/wrong-sender' : config.senderProfileUrl)}; sender.textContent = 'Example Sender'; article.append(sender);
      const body = document.createElement('p'); body.className = 'msg-s-event-listitem__body'; body.innerText = event.target.innerText; article.append(body);
      document.getElementById('messages').append(article); event.target.innerText = '';
      if (${!!state.deliveryError}) article.append(document.createTextNode('Message could not be sent'));
      if (!${!!state.stayOnCompose}) history.pushState({}, '', '/messaging/thread/example-thread/');
    });
  </script>`;
}

async function fixture(t, state = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-fixture-'));
  const context = await browser.newContext();
  let composeVisits = 0;
  // Every request is intercepted. No LinkedIn request leaves this local fixture.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.linkedin.com') return route.abort();
    if (url.pathname.startsWith('/in/')) {
      if (state.profile429) return route.fulfill({ status: 429, contentType: 'text/html', body: 'Too many requests' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main><section aria-label="Primary content"><h1>Example Person</h1><span>· 1st</span><a href="${escape(person.messageUrl)}">Message</a></section></main>` });
    }
    composeVisits++;
    return route.fulfill({ contentType: 'text/html', body: conversation({ ...state, recent: state.changeHistory && composeVisits > 1 }) });
  });
  const page = await context.newPage(), store = new Store(directory);
  const workflow = new LinkedInWorkflow(page, config, store, 1600);
  t.after(async () => { workflow.dispose(); await context.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { page, store, workflow, state };
}

test('never-messaged workflow fills once and saves a verified receipt', async t => {
  const { page, store, workflow } = await fixture(t);
  const assessment = await workflow.inspect(person);
  assert.equal(assessment.decision.status, 'eligible_never');
  assert.equal((await workflow.send(assessment)).status, 'sent');
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  assert.deepEqual(store.events().map(e => e.status), ['send_attempted', 'sent']);
  const receipt = path.join(store.directory, store.events().at(-1).evidence);
  assert.ok(fs.readFileSync(receipt, 'utf8').includes('An example note'));
});
test('old conversation rechecks profile and supports compose-to-thread navigation', async t => {
  const { page, store, workflow } = await fixture(t, { old: true, stayOnCompose: true });
  const assessment = await workflow.inspect(person);
  assert.equal(assessment.decision.status, 'eligible_old');
  await workflow.send(assessment);
  assert.equal(store.summary().sent, 1);
  assert.match(page.url(), /\/messaging\/thread\//);
});
test('preview leaves the editor and ledger untouched', async t => {
  const { page, store, workflow } = await fixture(t);
  await runBatch({ config, people: [person], store, workflow });
  assert.equal(await page.getByRole('textbox').innerText(), '');
  assert.deepEqual(store.events(), []);
});
test('existing drafts and sender mismatches prevent submission', async t => {
  for (const state of [{ draft: 'An unfinished personal draft' }, { senderName: 'Different Account' }]) {
    const { page, store, workflow } = await fixture(t, state);
    const assessment = await workflow.inspect(person);
    await assert.rejects(workflow.send(assessment), /existing draft|signed-in sender/);
    assert.equal(await page.evaluate(() => window.sendCount), 0);
    assert.deepEqual(store.events(), []);
    if (state.draft) assert.equal(await page.getByRole('textbox').innerText(), state.draft);
  }
});
test('a newer reply during profile verification prevents a send', async t => {
  const { page, store, workflow } = await fixture(t, { old: true, changeHistory: true });
  const assessment = await workflow.inspect(person);
  await assert.rejects(workflow.send(assessment), /History changed/);
  assert.equal(await page.evaluate(() => window.sendCount), 0);
  assert.deepEqual(store.events(), []);
});
test('HTTP 429 persists a stop without retrying or sending', async t => {
  const { store, workflow } = await fixture(t, { old: true, profile429: true });
  const assessment = await workflow.inspect(person);
  await assert.rejects(workflow.send(assessment), /HTTP 429/);
  assert.equal(store.state().blocked, true);
  assert.equal(store.state().profileUrl, person.profileUrl);
  assert.deepEqual(store.events(), []);
});
test('an absent receipt remains uncertain and blocks subsequent batches', async t => {
  const { page, store, workflow } = await fixture(t, { noReceipt: true });
  const assessment = await workflow.inspect(person);
  await assert.rejects(workflow.send(assessment), /Timeout/);
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  assert.deepEqual(store.events().map(e => e.status), ['send_attempted', 'send_uncertain']);
  await assert.rejects(runBatch({ config, people: [person], store, workflow, send: true }), /unresolved/);
});
test('wrong sender and delivery errors cannot become confirmed receipts', async t => {
  for (const state of [{ wrongReceiptSender: true }, { deliveryError: true }]) {
    const { store, workflow } = await fixture(t, state);
    const assessment = await workflow.inspect(person);
    await assert.rejects(workflow.send(assessment), /Receipt does not match|delivery error/);
    assert.equal(store.summary().sent, 0); assert.equal(store.summary().unresolved.length, 1);
  }
});
test('reconciliation confirms an existing receipt without resending', async t => {
  const { page, store, workflow } = await fixture(t, { alreadySent: true, stayOnCompose: true });
  store.personEvent(person, config, { status: 'send_attempted' });
  store.personEvent(person, config, { status: 'send_uncertain' });
  const result = await reconcile({ person, config, store, workflow });
  assert.equal(result.sent, 1); assert.deepEqual(result.unresolved, []);
  assert.equal(await page.evaluate(() => window.sendCount), 0);
});
test('CDP selects the exact tab and disconnecting leaves the browser alive', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-cdp-test-'));
  const owner = await chromium.launchPersistentContext(directory, { headless: true, args: ['--remote-debugging-port=0'] });
  t.after(async () => { await owner.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const page = await owner.newPage(); await page.goto('data:text/html,<title>Local fixture</title>');
  const port = fs.readFileSync(path.join(directory, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const endpoint = `http://127.0.0.1:${port}`;
  const targets = await listTabs(endpoint), selected = targets.find(target => target.title === 'Local fixture');
  assert.ok(selected);
  const connected = await attach({ endpoint, targetId: selected.id });
  assert.equal(await connected.page.title(), 'Local fixture');
  await connected.browser.close();
  assert.equal(await page.evaluate(() => 6 * 7), 42);
  await assert.rejects(attach({ endpoint, targetId: 'MISSING_TARGET' }), /configured targetId is missing/);
  assert.equal(await page.title(), 'Local fixture');
});
