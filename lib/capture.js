// Page capture helpers. Running the extractor in the page context (via
// chrome.scripting.executeScript) reads the already-rendered, already-
// authenticated DOM — so content behind a login the user is already viewing
// (e.g. a Reddit thread) is captured without any second authentication.

/** Returns the active tab in the current window. */
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Grab { url, title, html } from the given tab.
 * Requires the "scripting" permission plus activeTab (granted on the user
 * gesture of opening the popup).
 *
 * The HTML is "slimmed" in the page context: scripts, stylesheets, comments,
 * and large inline data-URIs are removed. This keeps clips well under the
 * server body limit and gives the processing task cleaner input, while
 * preserving the rendered DOM structure and text.
 */
export async function capturePage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const root = document.documentElement.cloneNode(true);

      // Drop non-content / heavy nodes.
      root
        .querySelectorAll(
          'script, style, link[rel="stylesheet"], noscript, template',
        )
        .forEach((n) => n.remove());

      // Drop HTML comments.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach((c) => c.remove());

      // Neutralize large inline data-URIs (base64 images/fonts) that bloat
      // the payload without adding text value.
      root.querySelectorAll('[src], [href], [srcset]').forEach((el) => {
        for (const attr of ['src', 'href', 'srcset']) {
          const v = el.getAttribute(attr);
          if (v && v.startsWith('data:') && v.length > 256) {
            el.setAttribute(attr, 'data:[stripped]');
          }
        }
      });

      const html = '<!doctype html>\n' + root.outerHTML;
      return { url: location.href, title: document.title, html };
    },
  });
  return result?.result || null;
}
