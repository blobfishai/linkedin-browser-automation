# LinkedIn browser automation

Small, inspectable scripts for working through LinkedIn conversations with an
existing signed-in Chrome session. Built with Node.js and Playwright, with an
optional Swift example for native macOS accessibility control.

The main workflow opens one connection, reads the conversation, checks activity
against a chosen date, and previews a decision. With `--send`, it sends your
configured message to eligible connections and verifies the rendered receipt
before moving to the next person.

This packages the browser workflow from an interactive agent session into a
standalone CLI. It needs no Codex runtime, model API key, or Chrome extension.
The source, sample configuration, and tests contain fictional account data.

## How it works

```text
CLI → Playwright → Chrome DevTools Protocol → selected LinkedIn tab
                    inspect → preview / skip / send → receipt → local ledger
```

- Attaches to a Chrome debugging endpoint on localhost and selects an exact tab ID.
- Reads the rendered page through DOM selectors and accessibility snapshots.
- Checks the recipient, first-degree relationship, signed-in sender, existing
  draft, prior campaign copies, and latest conversation dates.
- Rechecks an older conversation after visiting its profile. Changed or
  ambiguous history stops the batch for review.
- Writes and flushes a send intent before pressing Enter. A missing receipt
  leaves an unresolved attempt that blocks another batch.
- Stops on HTTP 429, saves the resume point, and waits for an explicit `resume`.
- Keeps contact lists, conversation evidence, and receipts in the local data directory.

## Setup

Requires **Node.js 22+** and Chrome. The page selectors currently target
LinkedIn's English interface.

```sh
git clone https://github.com/blobfishai/linkedin-browser-automation.git
cd linkedin-browser-automation
npm ci
node src/cli.mjs init
```

### 1. Start Chrome with debugging enabled

If you already have a signed-in Chrome instance with a local debugging endpoint,
reuse it. Otherwise start a separate profile and sign in through the browser:

```sh
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9333 \
  --user-data-dir="$PWD/local/chrome-profile"

# Linux: use google-chrome with the same flags.
# Windows: use chrome.exe with the same flags and an absolute --user-data-dir.
```

Chrome requires a separate user data directory for these debugging switches.
See [Chrome's debugging changes](https://developer.chrome.com/blog/remote-debugging-port).
The CLI uses Playwright's
[`connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
with `noDefaults: true`, so it preserves the existing context's display settings.

### 2. Configure the campaign and chosen tab

Open LinkedIn in the tab you want the CLI to control, then list tabs:

```sh
node src/cli.mjs tabs
```

Edit `local/config.json`:

| Field | Meaning |
| --- | --- |
| `endpoint` | Chrome's local debugging address. |
| `targetId` | The `id` of the chosen tab from `tabs`. |
| `senderName` | Your name as shown on LinkedIn's “Me” menu. |
| `senderProfileUrl` | The exact profile link rendered on your messages. Messaging may use an opaque `/in/ACo…` identifier; use that observed link when present. |
| `body` | Your exact message, including whitespace. |
| `cutoffDate` | A `YYYY-MM-DD` date. Activity on or after this date causes a skip. |
| `includeNeverMessaged` | Whether an empty, verified first-degree conversation qualifies. |
| `pauseMs` | Minimum pause between completed profiles; defaults to 15 seconds. |
| `connectionsFile` | Connection list, relative to the configuration file. |
| `dataDir` | Ledger and evidence directory, relative to the configuration file. |

`init` sets the cutoff to one year before today and creates an empty connection
list. Edit the placeholders before running. `inspect` reports rendered sender
links in `observed.messageDetails[].senders`, which helps configure the exact
sender profile link before enabling sends.

### 3. Supply observed connection links

Each entry in `local/connections.json` contains a name, profile URL, and the
Message link observed on the connection card:

```json
[
  {
    "name": "Example Person",
    "profileUrl": "https://www.linkedin.com/in/example-person/",
    "messageUrl": "https://www.linkedin.com/messaging/compose/?recipient=EXAMPLE_RECIPIENT_ID"
  }
]
```

Copy real links from your own browser. The example recipient ID is a placeholder.
For a reviewed difference between a connection-card name and its profile
heading, add `profileDisplayName`; the recipient ID must still match.

You can also select a tab showing the Connections page and capture cards already
loaded in its DOM:

```sh
node src/cli.mjs collect-visible
```

This merges observed cards into your local list. It does not scroll or claim a
complete network export. DOM shape changes can cause cards to be omitted; inspect
the saved list. The configured tab is reused for subsequent conversations.

## Inspect, preview, and send

```sh
# Read one conversation and save its evidence.
node src/cli.mjs inspect --profile "https://www.linkedin.com/in/example-person/"

# Preview one decision. The editor and completion ledger are unchanged.
node src/cli.mjs run --limit 1

# Send your configured message to eligible connections, one person at a time.
node src/cli.mjs run --limit 6 --send

# Read progress without attaching to Chrome.
node src/cli.mjs status
```

All commands accept `--config /path/to/config.json`. Limits are bounded from
1 to 100 profiles per invocation. Previewed people remain eligible for a later
send run. A send run records confirmed skips as completed decisions.

The CLI disconnects its CDP client when finished; Chrome and its existing tabs
remain open. This is covered by the local browser tests.

### Rate limits and uncertain sends

After HTTP 429, let normal browser access recover. This command reopens and
inspects the saved blocked profile, then clears the stop if the page loads:

```sh
node src/cli.mjs resume
```

`resume` does not send. A normal `run` rechecks eligibility. No timing interval
guarantees that the service will allow requests.

If a send may have happened but its receipt was not confirmed:

```sh
node src/cli.mjs reconcile --profile "https://www.linkedin.com/in/example-person/"
```

This checks the existing rendered message against the original intent and
configured sender, then records confirmation. It does not resend. An absent or
ambiguous receipt stays unresolved. Keep the ledger intact.

A `run.lock` prevents concurrent CLI commands from controlling the same campaign.
If a process crashes, inspect the PID recorded in that file before removing a
stale lock. The lock does not coordinate other programs controlling the same tab.

## Source guide

| Source | Purpose |
| --- | --- |
| [`src/cli.mjs`](src/cli.mjs) | Commands and local configuration setup. |
| [`src/browser.mjs`](src/browser.mjs) | CDP attachment, inspection, profile checks, sending, and receipt verification. |
| [`src/policy.mjs`](src/policy.mjs) | Date eligibility, identity normalization, and duplicate checks. |
| [`src/runner.mjs`](src/runner.mjs) | Sequential batches, pauses, preview mode, and reconciliation. |
| [`src/store.mjs`](src/store.mjs) | Durable send intents, private evidence, locks, CSV exports, and summaries. |
| [`native/macos-control.swift`](native/macos-control.swift) | Optional native accessibility control example. |

The original agent snippets were named `gtmPwPrelude`, `gtmInspectTemplate`,
`gtmSendNeverTemplate`, `gtmSendOldTemplate`, `gtmSkipTemplate`, and
`gtmOneByOneLoop`. Their behavior is expressed as ordinary functions here. The
old Python checkpoint helper is implemented in `Store.checkpoint()`.

## Native macOS control example

The Swift example demonstrates the earlier native control approach: read an
accessibility tree, select a unique control by role and title, and invoke its
action. Playwright drives the main outreach workflow.

```sh
swift native/macos-control.swift --help
swift native/macos-control.swift CHROME_PID "https://www.linkedin.com/mynetwork/invite-connect/connections/"
```

Find the intended Chrome process in Activity Monitor. Grant Accessibility access
to the terminal running Swift. The controller reads JSON commands from stdin:

```json
{"command":"snapshot"}
{"command":"press","role":"AXLink","title":"Send a message to Example Person"}
{"command":"type","role":"AXTextArea","title":"Write a message…","text":"An example draft"}
```

Replace example labels with exact values from the current snapshot. `type`
requires an empty field and enters text without submitting it. `scroll` invokes
`AXScrollToVisible` on a uniquely identified control. Each command reacquires
the matching page from the focused Chrome window.

## Local data and validation

`local/` and known campaign artifact filenames are ignored by Git. Files created
by the CLI use mode `0600` and directories use `0700` on Unix. Keep any custom
data directory outside version control: snapshots and receipts contain private
conversation data. Browser login remains in Chrome's profile.

```sh
npm test
npx playwright install chromium
npm run test:browser

# macOS only; checks compilation without controlling any app.
swiftc -typecheck native/macos-control.swift
```

Tests cover eligibility boundaries, duplicates, durable intent records, locks,
preview behavior, changed history, receipt failures, rate-limit stops,
reconciliation, and CDP disconnection. Browser tests intercept every fixture
request and make no requests to LinkedIn. This public CLI has been checked with
those local fixtures; its selectors still need verification against your current
LinkedIn interface. It is an independent project using the browser UI.

## Contributing

Include a fictional local fixture for changes to selectors or sending behavior.
Run both test suites and keep campaign records out of patches. See the
[MIT license](LICENSE).
