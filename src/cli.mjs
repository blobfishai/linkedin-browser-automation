#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attach, listTabs, LinkedInWorkflow } from './browser.mjs';
import { readConfig, readConnections, validateConnections } from './config.mjs';
import { sameProfile } from './policy.mjs';
import { Store, writePrivate } from './store.mjs';
import { runBatch, reconcile } from './runner.mjs';

const help = `LinkedIn browser automation

  node src/cli.mjs init [--dir local]
  node src/cli.mjs tabs [--endpoint http://127.0.0.1:9333]
  node src/cli.mjs collect-visible [--config local/config.json]
  node src/cli.mjs inspect --profile PROFILE_URL [--config FILE]
  node src/cli.mjs run --limit 1 [--config FILE] [--send]
  node src/cli.mjs status [--config FILE]
  node src/cli.mjs resume [--config FILE]
  node src/cli.mjs reconcile --profile PROFILE_URL [--config FILE]

run previews decisions unless --send is present. The chosen tab is selected by
its Chrome target ID. All campaign data stays in the configured local directory.
`;
const output = value => console.log(JSON.stringify(value, null, 2));

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string', default: 'local/config.json' }, dir: { type: 'string', default: 'local' },
    endpoint: { type: 'string', default: 'http://127.0.0.1:9333' }, profile: { type: 'string' },
    limit: { type: 'string', default: '1' }, send: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  const [command] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (positionals.length > 1) throw new Error('Unexpected positional arguments');
  if (command === 'init') {
    const dir = path.resolve(values.dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(dir, 'config.json')) || fs.existsSync(path.join(dir, 'connections.json'))) throw new Error('This directory already contains a configuration or connection list');
    const example = JSON.parse(fs.readFileSync(new URL('../examples/config.example.json', import.meta.url), 'utf8'));
    const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    example.cutoffDate = cutoff.toISOString().slice(0, 10); example.endpoint = values.endpoint;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(example, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'connections.json'), '[]\n', { flag: 'wx', mode: 0o600 });
    output({ directory: dir, next: 'Edit config.json, then use tabs to select the intended Chrome tab.' });
    return;
  }
  if (command === 'tabs') { output(await listTabs(values.endpoint)); return; }
  if (!['collect-visible', 'inspect', 'run', 'status', 'resume', 'reconcile'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const config = readConfig(values.config);
  const store = new Store(config.dataDir);
  if (command === 'status') { output(store.summary()); return; }
  const people = readConnections(config.connectionsFile);
  let selected;
  if (['inspect', 'reconcile'].includes(command)) {
    if (!values.profile) throw new Error('Provide --profile with a URL from connections.json');
    selected = people.find(person => sameProfile(person.profileUrl, values.profile));
    if (!selected) throw new Error('The requested profile is missing from connections.json');
  }
  store.acquire();
  let browser, workflow;
  try {
    const attached = await attach(config); browser = attached.browser;
    workflow = new LinkedInWorkflow(attached.page, config, store);
    if (command === 'inspect') output(await workflow.inspect(selected));
    else if (command === 'run') output(await runBatch({ config, people, store, workflow, limit: Number(values.limit), send: values.send, onResult: output }));
    else if (command === 'reconcile') output(await reconcile({ person: selected, config, store, workflow }));
    else if (command === 'resume') {
      const state = store.state();
      if (!state.blocked) throw new Error('The campaign is not stopped');
      const person = people.find(person => sameProfile(person.profileUrl, state.profileUrl));
      if (!person) throw new Error('The stopped profile is missing from connections.json');
      const assessment = await workflow.inspect(person);
      store.setState({ blocked: false, resumedAfter: state.reason });
      output({ resumed: true, decision: assessment.decision, sends: 0 });
    } else if (command === 'collect-visible') {
      const url = new URL(attached.page.url());
      if (url.origin !== 'https://www.linkedin.com' || url.pathname !== '/mynetwork/invite-connect/connections/') throw new Error('Select a tab already showing the LinkedIn Connections page');
      const observed = await attached.page.locator('main').evaluate(main => {
        const rows = [];
        for (const message of main.querySelectorAll('a[href*="/messaging/compose/"]')) {
          let card = message.parentElement;
          for (let depth = 0; card && depth < 8; depth++, card = card.parentElement) {
            const profiles = [...card.querySelectorAll('a[href*="/in/"]')].filter(a => a.innerText.trim());
            if (profiles.length === 1) { rows.push({ name: profiles[0].innerText.trim(), profileUrl: profiles[0].href, messageUrl: message.href }); break; }
            if (profiles.length > 1) break;
          }
        }
        return rows;
      });
      const merged = new Map(people.map(person => [person.profileUrl.replace(/\/$/, ''), person]));
      for (const person of observed) merged.set(person.profileUrl.replace(/\/$/, ''), person);
      const validated = validateConnections([...merged.values()]);
      writePrivate(config.connectionsFile, validated);
      output({ observed: observed.length, saved: validated.length, completeInventory: false });
    }
  } finally {
    workflow?.dispose();
    // connectOverCDP's close disconnects this client; it leaves Chrome and its tabs running.
    try { if (browser) await browser.close(); } finally { store.release(); }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
