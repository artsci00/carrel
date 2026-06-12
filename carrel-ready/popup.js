/* Popup: a thin client over the service worker. */

const $ = (id) => document.getElementById(id);
const send = (msg) =>
  new Promise((res) => chrome.runtime.sendMessage(msg, res));
const getLocal = (k) => new Promise((r) => chrome.storage.local.get(k, r));
const setLocal = (o) => new Promise((r) => chrome.storage.local.set(o, r));

let schema = null;
let tags = [];
let tagProp = null;
let destId = "notion";

function show(pane) {
  ["connect", "clip", "boot"].forEach((p) => $(p).classList.add("hidden"));
  $(pane).classList.remove("hidden");
}

$("openSettings").onclick = $("goConnect").onclick = () =>
  chrome.runtime.openOptionsPage();

async function init() {
  const cfg = await getLocal([
    "token",
    "defaultDbId",
    "destinationId",
    "selectionDefault",
    "dbCache",
    "schemaCache",
  ]);
  if (!cfg.token) return show("connect");
  show("clip");

  populateDestinations(cfg.destinationId || "notion");
  applyDestination();

  // Populate destination from cache instantly, then refresh in background.
  if (cfg.dbCache && cfg.dbCache.length) fillDbs(cfg.dbCache, cfg.defaultDbId);
  refreshDatabases(cfg.defaultDbId);

  // Schema (cached) so fields appear without waiting on the network.
  const dbId = cfg.defaultDbId || (cfg.dbCache && cfg.dbCache[0] && cfg.dbCache[0].id);
  if (dbId) {
    if (cfg.schemaCache && cfg.schemaCache[dbId]) applySchema(cfg.schemaCache[dbId]);
    loadSchema(dbId);
  }

  // Selection probe + queue count.
  probeSelection(cfg.selectionDefault);
  refreshQueue();
}

function fillDbs(list, selected) {
  const sel = $("db");
  sel.innerHTML = "";
  list.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.title;
    if (d.id === selected) o.selected = true;
    sel.appendChild(o);
  });
}

async function refreshDatabases(selected) {
  const r = await send({ type: "getDatabases" });
  if (r && r.ok) {
    await setLocal({ dbCache: r.databases });
    fillDbs(r.databases, selected || $("db").value);
    if (!$("db").value && r.databases[0]) {
      $("db").value = r.databases[0].id;
      loadSchema(r.databases[0].id);
    }
  }
}

$("refreshDb").onclick = async () => {
  $("refreshDb").innerHTML = '<span class="spin">⟳</span>';
  await refreshDatabases($("db").value);
  $("refreshDb").textContent = "⟳";
};

$("db").onchange = () => loadSchema($("db").value);

// ---- destination picker --------------------------------------------------
function destInfo(id) {
  return (
    (self.carrelDestination && self.carrelDestination(id)) || {
      id: "notion",
      label: "Notion",
      enabled: true,
      supportsProps: true,
      targetLabel: "Database",
    }
  );
}

function populateDestinations(selected) {
  const sel = $("destination");
  sel.innerHTML = "";
  const list = self.CARREL_DESTINATIONS || [
    { id: "notion", label: "Notion", enabled: true },
  ];
  list.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.enabled ? d.label : `${d.label} (soon)`;
    o.disabled = !d.enabled;
    if (d.id === selected) o.selected = true;
    sel.appendChild(o);
  });
  destId = sel.value || "notion"; // disabled options can't be selected
}

function applyDestination() {
  const d = destInfo(destId);
  const live = d.enabled && d.supportsProps;
  $("dbField").classList.toggle("hidden", !live);
  $("dbLabel").textContent = d.targetLabel || "Destination";
  if (!live) {
    $("tagField").classList.add("hidden");
    $("selectField").classList.add("hidden");
    $("selToggle").classList.add("hidden");
  }
  const note = $("destNote");
  if (!d.enabled && d.note) {
    note.classList.remove("hidden");
    note.textContent = d.note;
  } else {
    note.classList.add("hidden");
  }
  const btn = $("clipBtn");
  btn.disabled = !d.enabled;
  btn.textContent = d.enabled ? `Clip to ${d.label}` : "Coming in v1.1";
}

$("destination").onchange = async () => {
  destId = $("destination").value;
  const d = destInfo(destId);
  if (d.enabled) await setLocal({ destinationId: destId });
  applyDestination();
  if (d.enabled && d.supportsProps && $("db").value) loadSchema($("db").value);
};

async function loadSchema(dbId) {
  const r = await send({ type: "getSchema", dbId });
  if (r && r.ok) {
    applySchema(r.schema);
    const cache = (await getLocal(["schemaCache"])).schemaCache || {};
    cache[dbId] = r.schema;
    await setLocal({ schemaCache: cache });
  }
}

function applySchema(s) {
  schema = s;
  tags = [];
  renderChips();

  const propsOK = destInfo(destId).supportsProps !== false;

  // Tags: use the first multi_select property if present.
  if (propsOK && s.tags && s.tags.length) {
    tagProp = s.tags[0].name;
    $("tagField").classList.remove("hidden");
    $("tagLabel").textContent = s.tags[0].name;
    renderSuggest(s.tags[0].options || []);
  } else {
    tagProp = null;
    $("tagField").classList.add("hidden");
  }

  // Select / status property.
  if (propsOK && s.selects && s.selects.length) {
    const sp = s.selects[0];
    $("selectField").classList.remove("hidden");
    $("selectLabel").textContent = sp.name;
    const sel = $("selectValue");
    sel.innerHTML = '<option value="">— none —</option>';
    (sp.options || []).forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });
    sel.dataset.prop = sp.name;
  } else {
    $("selectField").classList.add("hidden");
  }
}

// ---- tag chips -----------------------------------------------------------
function renderChips() {
  const c = $("chips");
  c.innerHTML = "";
  tags.forEach((t, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t;
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = () => {
      tags.splice(i, 1);
      renderChips();
    };
    chip.appendChild(x);
    c.appendChild(chip);
  });
}
function addTag(t) {
  t = (t || "").trim();
  if (t && !tags.includes(t)) {
    tags.push(t);
    renderChips();
  }
}
function renderSuggest(options) {
  const s = $("tagSuggest");
  s.innerHTML = "";
  options.slice(0, 8).forEach((opt) => {
    const span = document.createElement("span");
    span.textContent = opt;
    span.onclick = () => addTag(opt);
    s.appendChild(span);
  });
}
$("tagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addTag($("tagInput").value);
    $("tagInput").value = "";
  }
});

// ---- selection probe -----------------------------------------------------
async function probeSelection(defaultOn) {
  const r = await send({ type: "selectionInfo" });
  const info = r && r.ok ? r.info : null;
  if (info && info.title && !$("title").value) $("title").value = info.title;
  if (info && info.hasSelection) {
    $("selToggle").classList.remove("hidden");
    $("selectionOnly").checked = !!defaultOn;
    $("selLen").textContent = `(${info.selectionLength} chars selected)`;
  }
}

// ---- queue ---------------------------------------------------------------
async function refreshQueue() {
  const r = await send({ type: "queueCount" });
  const n = r && r.ok ? r.count : 0;
  const q = $("queue");
  if (n > 0) {
    q.classList.remove("hidden");
    q.innerHTML = `<span>${n} clip${n > 1 ? "s" : ""} waiting to sync</span>`;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Retry now";
    btn.onclick = async () => {
      btn.textContent = "Syncing…";
      await send({ type: "flushQueue" });
      refreshQueue();
    };
    q.appendChild(btn);
  } else {
    q.classList.add("hidden");
  }
}

// ---- clip ----------------------------------------------------------------
$("clipBtn").onclick = async () => {
  const btn = $("clipBtn");
  const status = $("status");
  btn.disabled = true;
  btn.textContent = "Clipping…";
  status.className = "status work";
  status.classList.remove("hidden");
  status.textContent = "Reading the page…";

  const selVal = $("selectValue");
  const payload = {
    destination: destId,
    dbId: $("db").value,
    title: $("title").value,
    tagProp,
    tags,
    selectProp: selVal.dataset.prop || null,
    selectValue: selVal.value || null,
    notes: $("notes").value,
    selectionOnly: $("selectionOnly").checked,
  };

  const r = await send({ type: "clip", payload });
  btn.disabled = false;
  btn.textContent = "Clip to Notion";

  if (r && r.ok && r.queued) {
    status.className = "status ok";
    status.innerHTML =
      "Offline — saved locally. Carrel will sync it to Notion automatically.";
    refreshQueue();
  } else if (r && r.ok) {
    status.className = "status ok";
    const words = r.wordCount ? ` · ${r.wordCount} words` : "";
    const what = r.usedSelection ? "Selection" : "Article";
    status.innerHTML = `${what} saved${words}. ${
      r.url ? `<a href="${r.url}" target="_blank">Open in Notion ↗</a>` : ""
    }`;
  } else {
    status.className = "status err";
    status.textContent = (r && r.error) || "Something went wrong.";
  }
};

init();
