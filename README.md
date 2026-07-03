# Hadron Chrome Extension

A Chrome extension for [Hadron](https://srv.hadronmemory.com). Today it sends the URL or full
HTML of the page you're viewing to Hadron as a node — optionally handing it to a Hadron App
task for background processing. More Hadron-in-the-browser capabilities will be added over time.

It authenticates with the same OAuth 2.1 + PKCE + Dynamic Client Registration flow as the
Hadron CLI and macOS app, and captures content by reading the DOM you're already viewing, so
pages behind a login you're signed into (a Reddit thread, a private doc) are clipped without a
second authentication.

## Features

- **OAuth login** against `srv.hadronmemory.com` via `chrome.identity.launchWebAuthFlow`.
- **URL or full HTML** — choose per clip.
- **Target memory** picker (the paginated `memories` query).
- **LOC / URN + node name** for the created node.
- **Optional App → task** selection; the chosen runnable task is invoked to process the clip.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this directory.
4. Pin the "Hadron Chrome Extension" icon and click it.

The extension ID is pinned by the `key` in `manifest.json`, so the OAuth redirect URI is stable:

```
ID:       ccigdjebbcfljhappibfcfgkcmomiccb
Redirect: https://ccigdjebbcfljhappibfcfgkcmomiccb.chromiumapp.org/
```

The extension registers itself with the server (Dynamic Client Registration) the first time you
sign in and caches the resulting `client_id`.

## Usage

1. Click the toolbar icon → **Sign in to Hadron** (a browser window handles the OAuth consent).
2. Choose **Page URL** or **Full HTML content**.
3. Pick a **target memory**, adjust the **node name** and **LOC / URN**.
4. (Optional) Choose an **App**, then a **task** to process the clip.
5. **Send to Hadron**.

## Packaging & distribution

Build a Chrome Web Store-ready zip:

```
scripts/package.sh              # store build → dist/hadron-chrome-extension-<version>.zip
scripts/package.sh --keep-key   # keep the pinned dev ID (for sideloading/testing)
```

The store build strips the manifest `key`; the Web Store assigns the extension ID on first
upload. OAuth still works with any assigned ID because the extension self-registers its
redirect URI (`https://<id>.chromiumapp.org/`) via Dynamic Client Registration.

To publish: create a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole)
(one-time $5 fee), upload the zip, complete the listing (description, screenshots, a privacy
policy URL, and permission justifications for `identity`/`scripting`/`activeTab` + the
`srv.hadronmemory.com` host), then submit for review. After it's live, users install with one
click. (Sideloading unpacked/.crx is blocked on stable Chrome, so the store — or an enterprise
force-install policy — is the path for reaching others.)

## Architecture

```
manifest.json     MV3 manifest (permissions, pinned key, popup, service worker)
background.js     Service worker — owns OAuth, GraphQL, and page capture
popup.html/.css/.js   Toolbar popup UI
lib/config.js     Base URL + endpoint paths + storage keys
lib/oauth.js      PKCE, discovery, DCR, launchWebAuthFlow, token exchange/storage
lib/api.js        GraphQL client + operations (memories, apps, appNodes, createNode/updateNode, runTask)
lib/capture.js    chrome.scripting page-context capture (url / title / outerHTML)
icons/            Toolbar/action icons
```

Tokens and the cached client registration live in `chrome.storage.local`. The popup never
handles the token directly — it messages the service worker for every privileged action.

## Notes / limitations

- **Background processing:** node creation currently uses `createNode` (with an `updateNode`
  fallback on a loc collision, so a re-clip replaces the previous capture) and the App-task step
  calls the `runTask` mutation, which renders synchronously. A dedicated server-side
  `importNode` API (accepting either a URL for later server-side fetch or inline content, plus
  the target node) is planned — migrating to it is a contained change in `lib/api.js`.
- **Full HTML** is sent as the rendered DOM with scripts, stylesheets, comments,
  and large inline data-URIs stripped (no readability extraction). This keeps
  clips under the server body limit and gives the processing task cleaner input.
  The server accepts bodies up to 25mb (`express.json({ limit: '25mb' })`).
- Chrome 116+ (MV3, `chrome.scripting`, service-worker modules).
