import { chromium } from 'playwright';
import { validateEndpoint } from './config.mjs';
import { normalize, sameProfile, recipientId, assessHistory, historyFingerprint, assertNoPreviousSend } from './policy.mjs';

export async function listTabs(endpoint) {
  const response = await fetch(`${validateEndpoint(endpoint)}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome returned HTTP ${response.status}`);
  return (await response.json()).filter(target => target.type === 'page').map(({ id, title, url }) => ({ id, title, url }));
}

export async function attach(config) {
  const browser = await chromium.connectOverCDP(validateEndpoint(config.endpoint), { timeout: 10000, noDefaults: true });
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page);
        let target;
        try { target = (await session.send('Target.getTargetInfo')).targetInfo; } finally { await session.detach(); }
        if (target.targetId === config.targetId) return { browser, page };
      }
    }
    throw new Error('The configured targetId is missing. Run tabs and select the intended tab again.');
  } catch (error) { await browser.close(); throw error; }
}

export class LinkedInWorkflow {
  constructor(page, config, store, timeout = 20000) {
    this.page = page; this.config = config; this.store = store; this.timeout = timeout;
    this.person = undefined; this.rateLimited = false;
    this.onResponse = response => {
      try { if (response.status() === 429 && /(^|\.)linkedin\.com$/.test(new URL(response.url()).hostname)) this.rateLimited = true; } catch { /* Ignore non-URL browser resources. */ }
    };
    page.on('response', this.onResponse);
    page.setDefaultTimeout(timeout);
  }
  dispose() { this.page.off('response', this.onResponse); }
  checkStop() {
    if (!this.rateLimited) return;
    this.store.setState({ blocked: true, reason: 'http_429', profileUrl: this.person?.profileUrl });
    throw new Error('LinkedIn returned HTTP 429. The stop is saved; there is no automatic retry.');
  }
  async navigate(url) {
    this.checkStop();
    try {
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      if (response?.status() === 429) this.rateLimited = true;
      this.checkStop();
      if (response && response.status() >= 400) throw new Error(`Navigation returned HTTP ${response.status()}`);
    } catch (error) { this.checkStop(); throw error; }
  }
  async readConversation() {
    const pane = this.page.locator('main .msg-convo-wrapper--scrollable');
    try {
      await pane.waitFor({ state: 'visible', timeout: this.timeout });
      await this.page.waitForFunction(() => {
        const pane = document.querySelector('main .msg-convo-wrapper--scrollable');
        if (!pane) return false;
        const busy = [...pane.querySelectorAll('.msg-s-message-list__loader:not(.hidden)')].some(e => e.getBoundingClientRect().height > 0);
        return !busy && !!pane.querySelector('.profile-card-one-to-one__profile-link, .msg-s-message-list__event');
      }, undefined, { timeout: this.timeout });
      const end = pane.locator('.msg-s-message-list__bottom-of-list');
      if (await end.count() === 1) await end.scrollIntoViewIfNeeded();
      this.checkStop();
      return await pane.evaluate(element => {
        const events = [...element.querySelectorAll('.msg-s-message-list__event')];
        const end = element.querySelector('.msg-s-message-list__bottom-of-list')?.getBoundingClientRect();
        const viewports = [...element.querySelectorAll('.msg-s-message-list.scrollable')];
        const viewport = viewports.length === 1 ? viewports[0].getBoundingClientRect() : null;
        return {
          eventCount: events.length,
          dates: [...element.querySelectorAll('.msg-s-message-list__time-heading')].map(e => e.innerText.trim()),
          messageDetails: events.map(event => ({
            bodies: [...event.querySelectorAll('.msg-s-event-listitem__body')].map(e => e.innerText),
            times: [...event.querySelectorAll('time')].map(e => e.innerText),
            senders: [...event.querySelectorAll('a[href*="/in/"]')].map(e => ({ name: e.innerText.trim(), href: e.href })),
          })),
          profileLinks: [...element.querySelectorAll('.profile-card-one-to-one__profile-link')].map(e => ({ name: e.innerText.trim(), href: e.href })),
          recipientNames: [...element.querySelectorAll('button[aria-label^="Remove "]')].map(e => e.innerText.trim()),
          firstDegree: [...element.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.trim() === '1st degree connection'),
          loaderVisible: [...element.querySelectorAll('.msg-s-message-list__loader:not(.hidden)')].some(e => e.getBoundingClientRect().height > 0),
          atBottom: !!(end && viewport && end.bottom <= viewport.bottom + 3 && end.bottom >= viewport.top - 3),
        };
      });
    } catch (error) { this.checkStop(); throw error; }
  }
  assertRecipient(person, observed) {
    if (recipientId(this.page.url()) !== recipientId(person.messageUrl) || observed.recipientNames.length !== 1 || normalize(observed.recipientNames[0]) !== normalize(person.name)) {
      throw new Error('The rendered recipient differs from the selected connection');
    }
    if (observed.eventCount === 0) {
      const card = observed.profileLinks[0];
      const urnProfile = `https://www.linkedin.com/in/${recipientId(person.messageUrl)}`;
      if (observed.profileLinks.length !== 1 || !card || normalize(card.name) !== normalize(person.profileDisplayName || person.name) || (!sameProfile(card.href, person.profileUrl) && !sameProfile(card.href, urnProfile))) {
        throw new Error('The empty conversation profile card does not match the connection');
      }
    }
  }
  async inspect(person) {
    this.person = person;
    if (this.page.url() !== person.messageUrl) await this.navigate(person.messageUrl);
    const observed = await this.readConversation();
    this.assertRecipient(person, observed);
    const decision = assessHistory(observed, this.config);
    const snapshot = await this.page.locator('main .msg-convo-wrapper--scrollable').ariaSnapshot();
    const evidence = this.store.evidence(person, 'before.txt', snapshot);
    const assessment = { person, observed, decision, evidence, inspectedAt: new Date().toISOString() };
    this.store.evidence(person, 'assessment.json', assessment);
    return assessment;
  }
  async verifyOldProfile(person) {
    await this.navigate(person.profileUrl);
    const primary = this.page.locator('main').getByRole('region', { name: 'Primary content', exact: true });
    await primary.getByRole('heading', { name: person.profileDisplayName || person.name, exact: true }).waitFor({ state: 'visible' });
    await primary.getByText('· 1st', { exact: true }).waitFor({ state: 'visible' });
    if (!sameProfile(this.page.url(), person.profileUrl)) throw new Error('The profile redirected to a different person');
    const links = await primary.getByRole('link', { name: 'Message', exact: true }).evaluateAll(elements => elements.map(e => e.href));
    if (!links.length || links.some(link => recipientId(link) !== recipientId(person.messageUrl))) throw new Error('Profile Message links do not match the saved recipient');
    this.store.evidence(person, 'profile-before-send.txt', await primary.ariaSnapshot());
    this.checkStop();
  }
  async verifyReceipt(person) {
    await this.page.waitForFunction(body => {
      const norm = text => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const events = [...document.querySelectorAll('main .msg-s-message-list__event')];
      return [...(events.at(-1)?.querySelectorAll('.msg-s-event-listitem__body') || [])].some(e => norm(e.innerText) === norm(body));
    }, this.config.body, { timeout: this.timeout });
    const main = this.page.locator('main');
    let recipientConfirmed = false;
    if (this.page.url() === person.messageUrl) {
      const chips = main.locator('button[aria-label^="Remove "]');
      recipientConfirmed = await chips.count() === 1 && normalize(await chips.innerText()) === normalize(person.name);
      if (!recipientConfirmed) throw new Error('Post-send recipient changed');
    }
    if (!/\/messaging\/thread\//.test(this.page.url())) {
      await main.getByRole('list', { name: 'Conversation List', exact: true }).getByRole('heading', { name: person.name, exact: true }).click();
      await this.page.waitForURL(/\/messaging\/thread\//, { timeout: this.timeout });
    }
    const list = main.locator('.msg-s-message-list-content');
    const newest = list.locator('.msg-s-message-list__event').last();
    const details = await newest.evaluate(event => ({ bodies: [...event.querySelectorAll('.msg-s-event-listitem__body')].map(e => e.innerText), links: [...event.querySelectorAll('a[href*="/in/"]')].map(e => ({ name: e.innerText.trim(), href: e.href })) }));
    if (!details.bodies.some(body => normalize(body) === normalize(this.config.body)) || !details.links.some(link => sameProfile(link.href, this.config.senderProfileUrl))) throw new Error('Receipt does not match the configured body and sender profile');
    const links = await list.locator('a[href*="/in/"]').evaluateAll(elements => elements.map(e => e.href));
    const urnProfile = `https://www.linkedin.com/in/${recipientId(person.messageUrl)}`;
    if (!recipientConfirmed && !links.some(link => sameProfile(link, person.profileUrl) || sameProfile(link, urnProfile))) throw new Error('Receipt recipient cannot be established');
    const snapshot = await list.ariaSnapshot();
    if (/could not be sent|couldn.t be sent|failed to send|not delivered|unable to send/i.test(snapshot)) throw new Error('LinkedIn displays a delivery error');
    this.checkStop();
    return { evidence: this.store.evidence(person, 'sent.txt', snapshot), threadUrl: this.page.url() };
  }
  async send(assessment) {
    const { person, observed } = assessment;
    if (!assessment.decision.status.startsWith('eligible_')) throw new Error('This assessment is not eligible to send');
    assertNoPreviousSend(this.store.events(), person);
    if (assessment.decision.status === 'eligible_old') await this.verifyOldProfile(person);
    const fresh = await this.inspect(person);
    if (fresh.decision.status !== assessment.decision.status || historyFingerprint(fresh.observed) !== historyFingerprint(observed)) throw new Error('History changed after inspection; review it again');
    if (await this.page.getByRole('button', { name: `${this.config.senderName} Me`, exact: true }).count() !== 1) throw new Error('The signed-in sender differs from the configuration');
    const pane = this.page.locator('main .msg-convo-wrapper--scrollable');
    const editor = pane.getByRole('textbox', { name: 'Write a message…', exact: true });
    if (normalize(await editor.innerText())) throw new Error('An existing draft must be resolved before sending');
    const evidence = this.store.evidence(person, 'before-send.txt', await pane.ariaSnapshot());
    await editor.fill(this.config.body);
    if (await editor.innerText() !== this.config.body) throw new Error('Draft differs from the configured message');
    const finalObserved = await this.readConversation();
    this.assertRecipient(person, finalObserved);
    if (historyFingerprint(finalObserved) !== historyFingerprint(fresh.observed)) throw new Error('History changed immediately before send');
    this.checkStop();
    this.store.personEvent(person, this.config, { status: 'send_attempted', evidence });
    try {
      await editor.press('Enter');
      const receipt = await this.verifyReceipt(person);
      this.store.personEvent(person, this.config, { status: 'sent', reason: fresh.decision.reason, ...receipt });
      return { status: 'sent', ...receipt };
    } catch (error) {
      this.store.personEvent(person, this.config, { status: 'send_uncertain', error: String(error) });
      this.checkStop();
      throw error;
    }
  }
}
