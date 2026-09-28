import { setTimeout as sleep } from 'node:timers/promises';
import { recipientId, sameProfile, bodyHash, normalize } from './policy.mjs';

export async function runBatch({ config, people, store, workflow, limit = 1, send = false, onResult = () => {}, pause = sleep }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
  if (store.state().blocked) throw new Error('This campaign is stopped. Review its saved state and use resume after access is restored.');
  if (store.summary().unresolved.length) throw new Error('An unresolved send attempt must be reconciled before another batch');
  const events = store.events();
  const done = new Set(events.filter(e => e.status === 'sent' || e.status.startsWith('skipped_')).map(e => e.recipientId));
  const pending = people.filter(person => !done.has(recipientId(person.messageUrl))).slice(0, limit);
  let previous = Date.parse(events.filter(e => e.status === 'sent' || e.status.startsWith('skipped_')).at(-1)?.at || '1970-01-01');
  for (const person of pending) {
    const delay = Math.max(0, config.pauseMs - (Date.now() - previous));
    if (delay) await pause(delay);
    const assessment = await workflow.inspect(person);
    let result = { profileUrl: person.profileUrl, name: person.name, ...assessment.decision };
    if (assessment.decision.status === 'needs_review') {
      onResult(result);
      break;
    }
    if (assessment.decision.status.startsWith('skipped_')) {
      if (send) store.personEvent(person, config, { ...assessment.decision, evidence: assessment.evidence });
    } else if (send) result = { ...result, ...await workflow.send(assessment) };
    else result = { ...result, status: 'would_send' };
    previous = Date.now();
    onResult(result);
    if (send) store.checkpoint();
  }
  return store.summary();
}

export async function reconcile({ person, config, store, workflow }) {
  const last = store.events().filter(e => (e.recipientId === recipientId(person.messageUrl) || sameProfile(e.profileUrl, person.profileUrl)) && ['sent', 'send_attempted', 'send_uncertain'].includes(e.status)).at(-1);
  if (!last || last.status === 'sent' || last.bodyHash !== bodyHash(config.body)) throw new Error('There is no unresolved attempt for this recipient and exact message');
  const assessment = await workflow.inspect(person);
  const newest = assessment.observed.messageDetails.at(-1);
  if (!newest?.bodies.some(body => normalize(body) === normalize(config.body)) || !newest.senders.some(sender => sameProfile(sender.href, config.senderProfileUrl))) throw new Error('The inspected conversation does not establish delivery; the attempt stays unresolved');
  const receipt = await workflow.verifyReceipt(person);
  store.personEvent(person, config, { status: 'sent', reconciled: true, ...receipt });
  return store.checkpoint();
}
