import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHistory, calendarDate, canonicalProfile, recipientId, assertNoPreviousSend, historyFingerprint } from '../src/policy.mjs';
import { validateConnections, validateEndpoint } from '../src/config.mjs';

const config = { cutoffDate: '2025-09-27', body: 'Hello\u00a0there', includeNeverMessaged: true };
const person = { name: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example-person/', messageUrl: 'https://www.linkedin.com/messaging/compose/?recipient=EXAMPLE_ID' };
const old = () => ({ eventCount: 1, dates: ['APR 14, 2025'], messageDetails: [{ bodies: ['An older message'], times: ['8:00 AM'], senders: [] }], profileLinks: [], firstDegree: false, loaderVisible: false, atBottom: true });

test('calendar dates reject rollover, ambiguous dates and invalid leap days', () => {
  assert.equal(calendarDate('APR 14, 2025'), '2025-04-14');
  assert.equal(calendarDate('September 27, 2025'), '2025-09-27');
  assert.equal(calendarDate('2024-02-29'), '2024-02-29');
  for (const date of ['2025-02-29', 'FEB 30, 2024', 'TODAY', 'APR 14', '2025-13-01', 'garbage']) assert.equal(calendarDate(date), null);
});
test('cutoff is inclusive and activity in either direction is disqualifying', () => {
  const observed = old(); observed.dates.push('SEP 27, 2025');
  assert.equal(assessHistory(observed, config).status, 'skipped_recent_chat');
  observed.dates = ['YESTERDAY']; assert.equal(assessHistory(observed, config).status, 'skipped_recent_chat');
  observed.dates = ['SEP 26, 2025']; assert.equal(assessHistory(observed, config).status, 'eligible_old');
});
test('missing dates, active loaders and missing latest marker require review', () => {
  for (const changes of [{ dates: [] }, { dates: ['a date we cannot parse'] }, { atBottom: false }, { loaderVisible: true }]) assert.equal(assessHistory({ ...old(), ...changes }, config).status, 'needs_review');
});
test('duplicate message detection normalizes nonbreaking spaces', () => {
  const observed = old(); observed.messageDetails[0].bodies = ['Hello there'];
  assert.equal(assessHistory(observed, config).status, 'skipped_previous_copy');
});
test('empty history needs a profile card and first-degree relationship', () => {
  const observed = { ...old(), eventCount: 0, messageDetails: [], dates: [] };
  assert.equal(assessHistory(observed, config).status, 'needs_review');
  observed.profileLinks = [{ name: 'Example Person' }]; observed.firstDegree = true;
  assert.equal(assessHistory(observed, config).status, 'eligible_never');
  assert.equal(assessHistory(observed, { ...config, includeNeverMessaged: false }).status, 'skipped_never_messaged');
});
test('only observed LinkedIn compose URLs and loopback CDP endpoints are accepted', () => {
  assert.equal(canonicalProfile(person.profileUrl + 'en/'), person.profileUrl.slice(0, -1));
  assert.equal(recipientId(person.messageUrl), 'EXAMPLE_ID');
  assert.throws(() => canonicalProfile('https://linkedin.com.evil.test/in/example'));
  assert.throws(() => recipientId(person.messageUrl + '&profileUrn=urn:li:fsd_profile:DIFFERENT'));
  assert.throws(() => recipientId('https://www.linkedin.com/messaging/thread/example/'));
  assert.throws(() => validateEndpoint('http://public.example:9333'));
  assert.throws(() => validateEndpoint('http://user:password@localhost:9333'));
  assert.equal(validateEndpoint('http://127.0.0.1:9333/'), 'http://127.0.0.1:9333');
});
test('recipient IDs deduplicate different profile aliases', () => {
  assert.throws(() => validateConnections([person, { ...person, profileUrl: 'https://www.linkedin.com/in/other-alias/' }]));
  for (const status of ['sent', 'send_attempted', 'send_uncertain']) assert.throws(() => assertNoPreviousSend([{ status, recipientId: 'EXAMPLE_ID', profileUrl: 'https://www.linkedin.com/in/other-alias/' }], person));
});
test('history fingerprints ignore unrelated link-preview renderings', () => {
  assert.equal(historyFingerprint({ ...old(), fullText: 'preview loading' }), historyFingerprint({ ...old(), fullText: 'preview loaded' }));
  const changed = old(); changed.messageDetails[0].bodies.push('New reply');
  assert.notEqual(historyFingerprint(old()), historyFingerprint(changed));
});
