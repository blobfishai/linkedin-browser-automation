import fs from 'node:fs';
import path from 'node:path';
import { calendarDate, canonicalProfile, recipientId } from './policy.mjs';

export function validateEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The Chrome endpoint must be an HTTP(S) loopback address, such as http://127.0.0.1:9333');
  }
  return url.origin;
}

export function readConfig(filename) {
  const absolute = path.resolve(filename);
  const config = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  for (const key of ['targetId', 'senderName', 'senderProfileUrl', 'body', 'cutoffDate', 'connectionsFile', 'dataDir']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Set ${key} in ${absolute}`);
  }
  if (calendarDate(config.cutoffDate) !== config.cutoffDate) throw new Error('cutoffDate must be a real YYYY-MM-DD date');
  if (typeof config.includeNeverMessaged !== 'boolean') throw new Error('includeNeverMessaged must be true or false');
  if (!Number.isInteger(config.pauseMs) || config.pauseMs < 1000) throw new Error('pauseMs must be an integer of at least 1000');
  canonicalProfile(config.senderProfileUrl);
  return { ...config, endpoint: validateEndpoint(config.endpoint), connectionsFile: path.resolve(path.dirname(absolute), config.connectionsFile), dataDir: path.resolve(path.dirname(absolute), config.dataDir) };
}

export function validateConnections(people) {
  if (!Array.isArray(people)) throw new Error('Connections must be a JSON array');
  const profiles = new Set(), recipients = new Set();
  return people.map(person => {
    if (!person || typeof person.name !== 'string' || !person.name.trim()) throw new Error('Every connection needs a name');
    const profile = canonicalProfile(person.profileUrl), id = recipientId(person.messageUrl);
    if (profiles.has(profile) || recipients.has(id)) throw new Error('Duplicate connection profile or recipient ID');
    profiles.add(profile); recipients.add(id);
    if (person.profileDisplayName !== undefined && (typeof person.profileDisplayName !== 'string' || !person.profileDisplayName.trim())) throw new Error('profileDisplayName must be a reviewed, nonempty name');
    return { ...person, profileUrl: profile };
  });
}

export const readConnections = filename => validateConnections(JSON.parse(fs.readFileSync(filename, 'utf8')));
