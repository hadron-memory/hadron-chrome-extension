# Chrome Web Store submission pack

Everything needed to fill out the Web Store developer console listing for the
**Hadron Chrome Extension**. Copy-paste the fields below; complete the checklist
at the end.

- **Visibility:** Public
- **Category:** Productivity
- **Language:** English (United States)
- **Contact email:** help@baragaun.com
- **Privacy policy URL:** https://docs.hadronmemory.com/legal/chrome-extension-privacy/
- **Package:** built by `scripts/package.sh` → `dist/hadron-chrome-extension-<version>.zip`

---

## Store listing

**Name**

```
Hadron Chrome Extension
```

**Short description** (≤132 characters)

```
Send any web page's URL or content to your Hadron memory in one click — optionally handing it to a Hadron App task.
```

**Detailed description**

```
The Hadron Chrome Extension saves web pages straight into your Hadron memory.

Viewing something you want to keep or process? Click the extension and send the
current page to Hadron as a node — either just its URL, or its full page content.
Because it reads the page you're already viewing, it also works on content behind
a login you're signed into.

Features
• One-click capture of the current page's URL or full HTML content.
• Sign in with your Hadron account (OAuth) — the same login as the Hadron CLI and
  macOS app.
• Choose the target memory and set the node's name and location (LOC/URN).
• Optionally hand the captured page to a Hadron App task for background
  processing.

Privacy
The extension reads a page's content only when you click Send, and sends it only
to Hadron to create the node you asked for. It does not track your browsing, show
ads, or share your data. Your sign-in token is stored locally on your device.
Full policy: https://docs.hadronmemory.com/legal/chrome-extension-privacy/

You need a Hadron account to use this extension.
```

**Single purpose** (review form)

```
Capture the web page the user is currently viewing — its URL or content — and
save it to the user's Hadron account as a memory node, optionally triggering a
Hadron App task to process it.
```

---

## Permission justifications (review form)

Provide a justification for each requested permission. Suggested text:

- **`identity`**
  ```
  Used to run the OAuth 2.1 sign-in flow so the user can authenticate to their
  Hadron account (launchWebAuthFlow). No other use.
  ```
- **`activeTab`**
  ```
  Used to read the URL, title, and (when the user selects "Full HTML") the
  content of the tab the user is actively viewing, only at the moment they click
  Send.
  ```
- **`scripting`**
  ```
  Used to run a one-shot capture script in the active tab that returns the page's
  URL, title, and rendered HTML when the user clicks Send.
  ```
- **`storage`**
  ```
  Used to store the user's Hadron sign-in token and OAuth client registration
  locally on the device so they don't have to sign in on every use.
  ```
- **Host permission `https://srv.hadronmemory.com/*`**
  ```
  The Hadron API and OAuth endpoints. The extension sends captured pages and
  authentication requests only to this host.
  ```
- **Remote code:** No. All code is bundled in the package; nothing is fetched and
  executed at runtime.

---

## Privacy practices / data disclosures (review form)

Declare the data the extension handles and certify usage:

- **Data collected:**
  - _Authentication information_ — the Hadron sign-in token (stored locally on the
    device; transmitted only to Hadron as the auth header).
  - _Website content_ — the URL and, when the user opts in, the HTML of the page
    the user explicitly chooses to send, transmitted to Hadron to create the node.
- **Not collected:** personally identifiable information beyond the above, health,
  financial, location, personal communications, or web-browsing history.
- **Certifications (check all):**
  - I do not sell or transfer user data to third parties, outside of the approved
    use cases.
  - I do not use or transfer user data for purposes unrelated to the item's single
    purpose.
  - I do not use or transfer user data to determine creditworthiness or for
    lending purposes.

---

## Assets

- **Store icon 128×128** — `icons/icon-128.png` (already in the package). ✅
- **Screenshots** — at least one required; **1280×800** or **640×400** PNG/JPEG.
  Recommended set (capture the real popup on a page):
  1. Signed-in capture form with the URL/HTML toggle, memory picker, and LOC.
  2. The App → task selection expanded.
  3. A success state ("Saved node …").
- **Small promo tile (optional)** — 440×280.
- **Marquee promo (optional)** — 1400×560.

> Screenshots must be captured from the running extension — load it unpacked
> (`chrome://extensions` → Load unpacked), open the popup on a real page, and grab
> the popup at 1280×800. These can't be pre-generated here.

---

## Submission checklist

- [ ] Register a Chrome Web Store developer account (one-time $5 fee).
- [ ] Bump `version` in `manifest.json` if re-uploading.
- [ ] Build the package: `scripts/package.sh` → upload `dist/hadron-chrome-extension-<version>.zip`.
- [ ] Paste name, short + detailed description, single purpose.
- [ ] Set category (Productivity), language, and contact email (help@baragaun.com).
- [ ] Set privacy policy URL (https://docs.hadronmemory.com/legal/chrome-extension-privacy/).
- [ ] Fill permission justifications and the privacy/data-usage declarations above.
- [ ] Upload the 128×128 icon (in package) and ≥1 screenshot (1280×800).
- [ ] Set visibility to Public and submit for review.
- [ ] After approval, note the store-assigned extension ID (OAuth still works via
      DCR, so no config change is required).
