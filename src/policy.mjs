import { createHash } from 'node:crypto';

export const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export const bodyHash = body => createHash('sha256').update(body).digest('hex');

export function linkedinUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Expected an HTTPS linkedin.com URL');
  }
  return url;
}

export function canonicalProfile(value) {
  const url = linkedinUrl(value);
  const match = url.pathname.match(/^\/in\/([^/]+)(?:\/en)?\/?$/);
  if (!match) throw new Error('Expected a LinkedIn /in/ profile URL');
  return `https://www.linkedin.com/in/${match[1]}`;
}

export function recipientId(value) {
  const url = linkedinUrl(value);
  const recipient = url.searchParams.get('recipient');
  if (!/^\/messaging\/compose\/?$/.test(url.pathname) || !recipient || !/^[\w-]+$/.test(recipient)) {
    throw new Error('Use the compose link observed on the connection card, including its recipient parameter');
  }
  const urn = url.searchParams.get('profileUrn');
  if (urn && urn.split(':').at(-1) !== recipient) throw new Error('Compose link recipient and profileUrn disagree');
  return recipient;
}

export function sameProfile(left, right) {
  try { return canonicalProfile(left) === canonicalProfile(right); } catch { return false; }
}

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export function calendarDate(value) {
  const text = normalize(value).toUpperCase();
  let year, month, day;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const english = text.match(/^(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?) (\d{1,2}),? (20\d{2})$/);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (english) { year = Number(english[3]); month = months.indexOf(english[1].slice(0, 3)) + 1; day = Number(english[2]); }
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function assessHistory(observed, config) {
  if (observed.loaderVisible) return { status: 'needs_review', reason: 'Conversation is still loading' };
  if (observed.messageDetails.some(event => event.bodies.some(body => normalize(body) === normalize(config.body)))) {
    return { status: 'skipped_previous_copy', reason: 'The same message is already rendered in the conversation' };
  }
  if (observed.eventCount === 0) {
    if (!config.includeNeverMessaged) return { status: 'skipped_never_messaged', reason: 'Never-messaged connections are excluded' };
    if (!observed.firstDegree || observed.profileLinks.length !== 1) return { status: 'needs_review', reason: 'Empty history lacks a first-degree profile card' };
    return { status: 'eligible_never', reason: 'First-degree connection with no rendered messages' };
  }
  const dates = observed.dates.map(calendarDate);
  const relative = observed.dates.some(value => /^(TODAY|YESTERDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)$/i.test(normalize(value)) || /^[A-Z]+ \d{1,2}$/i.test(normalize(value)));
  if (relative || dates.some(date => date && date >= config.cutoffDate)) {
    return { status: 'skipped_recent_chat', reason: 'Conversation contains recent activity in either direction' };
  }
  if (!dates.length || dates.some(date => date === null) || !observed.atBottom) {
    return { status: 'needs_review', reason: 'Latest activity cannot be established from explicit dates and the bottom marker' };
  }
  return { status: 'eligible_old', reason: `All rendered activity is before ${config.cutoffDate}` };
}

export function historyFingerprint(observed) {
  // Authored bodies and timestamps exclude late-loading link previews.
  return JSON.stringify({ dates: observed.dates, eventCount: observed.eventCount, messages: observed.messageDetails });
}

export function assertNoPreviousSend(events, person) {
  const id = recipientId(person.messageUrl);
  if (events.some(event => (event.recipientId === id || sameProfile(event.profileUrl, person.profileUrl)) && ['sent', 'send_attempted', 'send_uncertain'].includes(event.status))) {
    throw new Error('A send or send attempt already exists for this recipient; reconcile it before continuing');
  }
}
