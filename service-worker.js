/*
 * Carrel service worker.
 * Owns: Notion API calls, the clip pipeline, the offline queue + retry,
 * the toolbar badge, and notifications. The popup is just a thin client that
 * messages this worker, so a clip survives the popup closing mid-save.
 */

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const QUEUE_KEY = "queue";
const RETRY_ALARM = "carrel-retry";

// Destination registry (Notion live; Obsidian/Readwise stubbed). Loaded here so
// the clip pipeline can route by destination id.
try {
  importScripts("destinations.js");
} catch (e) {
  // If this fails the worker still runs with Notion-only behaviour.
}

// ---- storage helpers -----------------------------------------------------
const getLocal = (keys) =>
  new Promise((res) => chrome.storage.local.get(keys, res));
const setLocal = (obj) =>
  new Promise((res) => chrome.storage.local.set(obj, res));

async function getConfig() {
  const c = await getLocal([
    "token",
    "defaultDbId",
    "destinationId",
    "loadImages",
    "selectionDefault",
    "appendSource",
  ]);
  return {
    token: c.token || "",
    defaultDbId: c.defaultDbId || "",
    destinationId: c.destinationId || "notion",
    loadImages: c.loadImages !== false,
    selectionDefault: !!c.selectionDefault,
    appendSource: c.appendSource !== false,
  };
}

// ---- Notion client -------------------------------------------------------
async function notion(path, method = "GET", body) {
  const { token } = await getConfig();
  if (!token) {
    const err = new Error("No Notion token saved. Open Settings to connect.");
    err.kind = "config";
    throw err;
  }
  let res;
  try {
    res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error("Network error reaching Notion.");
    err.kind = "network";
    throw err;
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.message || "";
    } catch (e) {}
    const err = new Error(`Notion ${res.status}: ${detail || res.statusText}`);
    // 429 / 5xx are transient -> worth queueing. 4xx are config/data errors.
    err.kind = res.status === 429 || res.status >= 500 ? "network" : "config";
    throw err;
  }
  return res.json();
}

async function listDatabases() {
  const data = await notion("/search", "POST", {
    filter: { property: "object", value: "database" },
    page_size: 100,
  });
  return (data.results || []).map((db) => ({
    id: db.id,
    title:
      (db.title || []).map((t) => t.plain_text).join("") || "Untitled database",
  }));
}

async function getSchema(dbId) {
  const db = await notion("/databases/" + dbId, "GET");
  const props = db.properties || {};
  const schema = { title: null, tags: [], selects: [], url: null, date: null };
  for (const [name, def] of Object.entries(props)) {
    if (def.type === "title") schema.title = name;
    else if (def.type === "multi_select")
      schema.tags.push({ name, options: (def.multi_select.options || []).map((o) => o.name) });
    else if (def.type === "select")
      schema.selects.push({ name, kind: "select", options: (def.select.options || []).map((o) => o.name) });
    else if (def.type === "status")
      schema.selects.push({ name, kind: "status", options: (def.status.options || []).map((o) => o.name) });
    else if (def.type === "url" && !schema.url) schema.url = name;
    else if (def.type === "date" && !schema.date) schema.date = name;
  }
  return schema;
}

// ---- build the Notion page payload --------------------------------------
function buildProperties(schema, fields) {
  const properties = {};
  if (schema.title) {
    properties[schema.title] = {
      title: [{ text: { content: (fields.title || "Untitled").slice(0, 1900) } }],
    };
  }
  if (fields.tagProp && fields.tags && fields.tags.length) {
    properties[fields.tagProp] = {
      multi_select: fields.tags.map((t) => ({ name: t })),
    };
  }
  if (fields.selectProp && fields.selectValue) {
    const sel = schema.selects.find((s) => s.name === fields.selectProp);
    if (sel) {
      properties[fields.selectProp] =
        sel.kind === "status"
          ? { status: { name: fields.selectValue } }
          : { select: { name: fields.selectValue } };
    }
  }
  if (schema.url && fields.url) properties[schema.url] = { url: fields.url };
  if (schema.date)
    properties[schema.date] = { date: { start: new Date().toISOString().slice(0, 10) } };
  return properties;
}

function leadBlocks(fields, appendSource) {
  const blocks = [];
  if (fields.notes && fields.notes.trim()) {
    blocks.push({
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "📝" },
        rich_text: [{ type: "text", text: { content: fields.notes.slice(0, 1900) } }],
      },
    });
  }
  if (appendSource) {
    const meta = [];
    if (fields.byline) meta.push(fields.byline);
    if (fields.siteName) meta.push(fields.siteName);
    meta.push("Captured " + new Date().toLocaleString());
    if (fields.wordCount) meta.push(`${fields.wordCount} words`);
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: meta.join("  ·  ").slice(0, 1900) },
            annotations: { italic: true, color: "gray" },
          },
        ],
      },
    });
    if (fields.url)
      blocks.push({ type: "bookmark", bookmark: { url: fields.url } });
    blocks.push({ type: "divider", divider: {} });
  }
  return blocks;
}

// ---- create page with chunked children ----------------------------------
async function createPage(dbId, properties, children) {
  const first = children.slice(0, 100);
  const rest = children.slice(100);
  const page = await notion("/pages", "POST", {
    parent: { database_id: dbId },
    properties,
    children: first,
  });
  let i = 0;
  while (i < rest.length) {
    const batch = rest.slice(i, i + 100);
    await notion(`/blocks/${page.id}/children`, "PATCH", { children: batch });
    i += 100;
  }
  return page;
}

// ---- queue ---------------------------------------------------------------
async function getQueue() {
  const q = await getLocal([QUEUE_KEY]);
  return q[QUEUE_KEY] || [];
}
async function setQueue(arr) {
  await setLocal({ [QUEUE_KEY]: arr });
  updateBadge(arr.length);
}
function updateBadge(n) {
  chrome.action.setBadgeBackgroundColor({ color: "#C9742E" });
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}
async function enqueue(item) {
  const q = await getQueue();
  q.push({ ...item, id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), attempts: 0, createdAt: Date.now() });
  await setQueue(q);
}

async function flushQueue() {
  let q = await getQueue();
  if (!q.length) return { flushed: 0, remaining: 0 };
  let flushed = 0;
  const keep = [];
  for (const item of q) {
    try {
      await createPage(item.dbId, item.properties, item.children);
      flushed++;
    } catch (e) {
      if (e.kind === "config") {
        // Permanent for now; surface it but stop hammering.
        notify("Clip needs attention", e.message);
        keep.push(item); // keep so the user can fix the token / db
      } else {
        item.attempts = (item.attempts || 0) + 1;
        keep.push(item);
      }
    }
  }
  await setQueue(keep);
  if (flushed)
    notify(
      "Carrel synced",
      `${flushed} queued clip${flushed > 1 ? "s" : ""} saved to Notion.`
    );
  return { flushed, remaining: keep.length };
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message: (message || "").slice(0, 250),
  });
}

// ---- extraction via scripting -------------------------------------------
async function extractFromTab(tabId, opts) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/Readability.js", "content.js"],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (o) => globalThis.carrelExtract(o),
    args: [opts],
  });
  return results && results[0] ? results[0].result : null;
}

async function selectionInfo(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.carrelSelectionInfo(),
    });
    return r && r[0] ? r[0].result : null;
  } catch (e) {
    return null;
  }
}

// ---- main clip pipeline --------------------------------------------------
async function doClip(payload) {
  const cfg = await getConfig();

  // Route by destination. Only Notion is live in v0.1; stubs return their note.
  const destId = payload.destination || cfg.destinationId || "notion";
  const dest =
    (self.carrelDestination && self.carrelDestination(destId)) || { id: "notion", enabled: true };
  if (!dest.enabled)
    return { ok: false, error: dest.note || `${dest.label} is coming in v1.1.` };

  const dbId = payload.dbId || cfg.defaultDbId;
  if (!dbId) return { ok: false, error: "Choose a destination database first." };

  const tab = payload.tabId
    ? { id: payload.tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !tab.id) return { ok: false, error: "No active tab to clip." };

  // 1) extract in the page
  let extracted;
  try {
    extracted = await extractFromTab(tab.id, {
      loadImages: cfg.loadImages,
      selectionOnly: payload.selectionOnly,
    });
  } catch (e) {
    return {
      ok: false,
      error:
        "Couldn't read this page (the browser blocks clipping on some system pages).",
    };
  }
  if (!extracted || !extracted.ok)
    return { ok: false, error: (extracted && extracted.error) || "Extraction failed." };

  // 2) build payload
  let schema;
  try {
    schema = await getSchema(dbId);
  } catch (e) {
    return { ok: false, error: e.message, kind: e.kind };
  }
  const fields = {
    title: payload.title || extracted.title,
    tagProp: payload.tagProp,
    tags: payload.tags || [],
    selectProp: payload.selectProp,
    selectValue: payload.selectValue,
    url: extracted.url,
    byline: extracted.byline,
    siteName: extracted.siteName,
    wordCount: extracted.wordCount,
    notes: payload.notes,
  };
  const properties = buildProperties(schema, fields);
  const children = [...leadBlocks(fields, cfg.appendSource), ...extracted.blocks];

  // 3) try to save; queue on transient failure
  try {
    const page = await createPage(dbId, properties, children);
    return {
      ok: true,
      url: page.url,
      wordCount: extracted.wordCount,
      usedSelection: extracted.usedSelection,
    };
  } catch (e) {
    if (e.kind === "network") {
      await enqueue({ dbId, properties, children, title: fields.title });
      return {
        ok: true,
        queued: true,
        wordCount: extracted.wordCount,
        usedSelection: extracted.usedSelection,
      };
    }
    return { ok: false, error: e.message, kind: e.kind };
  }
}

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "getDatabases":
          sendResponse({ ok: true, databases: await listDatabases() });
          break;
        case "getSchema":
          sendResponse({ ok: true, schema: await getSchema(msg.dbId) });
          break;
        case "selectionInfo": {
          const tab = (
            await chrome.tabs.query({ active: true, currentWindow: true })
          )[0];
          sendResponse({ ok: true, info: tab ? await selectionInfo(tab.id) : null });
          break;
        }
        case "clip":
          sendResponse(await doClip(msg.payload || {}));
          break;
        case "flushQueue":
          sendResponse({ ok: true, ...(await flushQueue()) });
          break;
        case "queueCount": {
          const q = await getQueue();
          sendResponse({ ok: true, count: q.length });
          break;
        }
        case "testToken": {
          // Save then verify by listing databases.
          await setLocal({ token: msg.token });
          const dbs = await listDatabases();
          sendResponse({ ok: true, count: dbs.length, databases: dbs });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message, kind: e.kind });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// ---- keyboard command: instant clip to default --------------------------
async function quickClip() {
  const cfg = await getConfig();
  if (!cfg.token) {
    notify("Carrel", "Connect Notion in Settings before quick-clipping.");
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!cfg.defaultDbId) {
    notify("Carrel", "Set a default database in Settings to quick-clip.");
    chrome.runtime.openOptionsPage();
    return;
  }
  notify("Carrel", "Clipping this page…");
  const r = await doClip({
    destination: cfg.destinationId,
    selectionOnly: cfg.selectionDefault,
  });
  if (r.ok && r.queued)
    notify("Saved offline", "Carrel will sync this clip automatically.");
  else if (r.ok)
    notify(
      "Clipped to Notion",
      `${r.usedSelection ? "Selection" : "Article"} saved` +
        (r.wordCount ? ` · ${r.wordCount} words` : "") +
        "."
    );
  else notify("Clip failed", r.error || "Something went wrong.");
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "quick-clip") quickClip();
});

// ---- retry triggers ------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  getQueue().then((q) => updateBadge(q.length));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  getQueue().then((q) => updateBadge(q.length));
  flushQueue();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === RETRY_ALARM) flushQueue();
});
self.addEventListener("online", () => flushQueue());
