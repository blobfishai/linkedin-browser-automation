import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalProfile, bodyHash, recipientId } from './policy.mjs';

export function writePrivate(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.ledger = path.join(directory, 'outreach-ledger.jsonl');
    this.lock = path.join(directory, 'run.lock');
  }
  acquire() {
    try { this.lockFd = fs.openSync(this.lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`Another run owns ${this.lock}. Check its PID before removing a stale lock.`); throw error; }
    fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  }
  release() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); fs.unlinkSync(this.lock); this.lockFd = undefined; }
  }
  events() {
    if (!fs.existsSync(this.ledger)) return [];
    return fs.readFileSync(this.ledger, 'utf8').split('\n').filter(Boolean).map((line, i) => {
      try { const event = JSON.parse(line); if (!event.status || !event.at) throw new Error('Missing status or timestamp'); return event; }
      catch { throw new Error(`Ledger line ${i + 1} is incomplete or invalid; preserve it for review`); }
    });
  }
  append(event) {
    const row = { ...event, at: new Date().toISOString() };
    const fd = fs.openSync(this.ledger, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return row;
  }
  personEvent(person, config, event) {
    return this.append({ name: person.name, profileUrl: canonicalProfile(person.profileUrl), recipientId: recipientId(person.messageUrl), bodyHash: bodyHash(config.body), ...event });
  }
  state() {
    const file = path.join(this.directory, 'state.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { blocked: false };
  }
  setState(value) { writePrivate(path.join(this.directory, 'state.json'), { ...value, at: new Date().toISOString() }); }
  evidence(person, suffix, value) {
    const key = bodyHash(canonicalProfile(person.profileUrl)).slice(0, 20);
    const filename = path.join(this.directory, 'evidence', `${key}-${Date.now()}-${randomUUID()}-${suffix}`);
    writePrivate(filename, value);
    return path.relative(this.directory, filename);
  }
  summary() {
    const completed = new Map(), attempts = new Map();
    for (const event of this.events()) {
      const key = event.recipientId || event.profileUrl;
      if (event.status === 'sent' || event.status.startsWith('skipped_')) completed.set(key, event);
      if (['sent', 'send_attempted', 'send_uncertain'].includes(event.status)) attempts.set(key, event);
    }
    const rows = [...completed.values()];
    return { processed: rows.length, sent: rows.filter(e => e.status === 'sent').length, skipped: rows.filter(e => e.status.startsWith('skipped_')).length, unresolved: [...attempts.values()].filter(e => e.status !== 'sent').map(e => ({ profileUrl: e.profileUrl, status: e.status })), state: this.state() };
  }
  checkpoint() {
    const summary = this.summary();
    writePrivate(path.join(this.directory, 'outreach-summary.json'), summary);
    const latest = new Map();
    for (const event of this.events()) if (event.status === 'sent' || event.status.startsWith('skipped_')) latest.set(event.recipientId || event.profileUrl, event);
    const fields = ['name', 'profileUrl', 'status', 'at', 'reason', 'evidence'];
    const cell = value => `"${String(value ?? '').replace(/^([=+@\-])/, "'$1").replaceAll('"', '""')}"`;
    writePrivate(path.join(this.directory, 'outreach-results.csv'), [fields.join(','), ...[...latest.values()].map(event => fields.map(key => cell(event[key])).join(','))].join('\n') + '\n');
    return summary;
  }
}
