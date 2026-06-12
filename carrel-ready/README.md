# Carrel — Notion Web Clipper (v0.2)

Reliable, local-first web capture for researchers and founders. A single-purpose
Chrome extension that clips full articles into Notion **without truncating them**,
lets you **set properties before you save**, captures **lazy-loaded images**, can
clip a **selection only**, **queues clips offline** to sync automatically, and
clips with a **keyboard shortcut**.

This is the deliberate answer to the most-repeated complaints about the official
Notion Web Clipper (silent truncation, dropped offline clips, having to open
Notion just to tag a page).

---

## Keyboard shortcuts

- **Ctrl/Cmd + Shift + S** — quick-clip the current page straight to your default
  database with no popup (the flow-state capture). Result shows as a notification.
- **Ctrl/Cmd + Shift + K** — open the Carrel popup.

Both are rebindable at `chrome://extensions/shortcuts`. Quick-clip needs a
**default database** set in Settings.

## Multi-destination (stubbed for v1.1)

The clip pipeline, storage, and popup are already destination-aware. The "Save to"
picker shows **Notion** (live), plus **Obsidian** and **Readwise** as disabled
"(soon)" options. Adding them in v1.1 is an adapter drop-in, not a refactor — see
the documented contract at the top of `destinations.js` (`listTargets`,
`getSchema`, `save`). `doClip()` in the service worker already routes by
destination id and returns each stub's roadmap note if selected.

---

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle on **Developer mode** (top right).
3. Click **Load unpacked** and select this `carrel/` folder.
4. Pin the icon, then open **Settings** to connect Notion.

No build step. Plain MV3 + vanilla JS so you can hand it to Claude Code and
refactor to TypeScript later if you want.

## Connect Notion (one-time)

1. Create an **internal integration** at
   <https://www.notion.so/my-integrations> and copy the secret.
2. In Notion, open each destination database → **•••** → **Connections** →
   add your integration. (The integration only sees databases you explicitly
   share with it.)
3. Paste the secret in Carrel Settings → **Test & save**.

Your token is stored in this browser's local storage and is sent only to
`api.notion.com`. That's the whole permission surface — see `manifest.json`.

---

## How it works (architecture)

- **`content.js`** runs in the page (DOM available). It primes lazy images,
  runs Mozilla **Readability** on a *clone* of the document (never mutating the
  live page), or grabs the current selection, then converts the HTML into Notion
  blocks. Long text is split under Notion's 2000-char rich-text limit so nothing
  is truncated.
- **`service-worker.js`** owns all Notion API calls, the clip pipeline, the
  offline queue (retried on a 1-min alarm, on reconnect, and on demand), the
  toolbar badge, and notifications. Network lives here so a clip survives the
  popup closing mid-save.
- **`popup.*`** is a thin client: pick destination, edit title, add tags, set a
  status/select property, add a note, toggle selection-only, clip.
- **`options.*`** handles connection + preferences.

Permissions are intentionally minimal: `activeTab` + `scripting` (inject only on
your click, no always-on content script), `storage`, `notifications`, `alarms`,
and host access to `api.notion.com` only. Minimal permissions = faster store
review and an easier trust story.

## Known v1 limits (honest list)

- One *live* destination (Notion). Obsidian + Readwise are stubbed and disabled.
- Nested lists are flattened to one level; HTML tables become text rows.
- External images are linked by URL (Notion can't host private/auth-gated images).
- Notion's newer "data source" search edge cases aren't handled yet.

## Roadmap

- **v1.1:** implement the Obsidian + Readwise adapters against the
  `destinations.js` contract (registry, UI, and routing are already in place).
- **v1.2:** clip templates per database; highlight-to-clip; more shortcuts.
- **Monetization:** free up to ~30 clips/month; ~$4/mo or ~$39 lifetime for
  unlimited + templates + multi-destination. License check via ExtensionPay or
  a license-key API (Chrome Web Store payments are deprecated).

---

Built as a v1 to validate the "reliability beats the incumbent" wedge. The moat
isn't the code (it's cloneable) — it's execution + the researcher positioning +
your owned distribution.
