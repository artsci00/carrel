const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const getLocal = (k) => new Promise((r) => chrome.storage.local.get(k, r));
const setLocal = (o) => new Promise((r) => chrome.storage.local.set(o, r));

async function restore() {
  const c = await getLocal([
    "token",
    "defaultDbId",
    "loadImages",
    "appendSource",
    "selectionDefault",
    "dbCache",
  ]);
  if (c.token) $("token").value = c.token;
  $("loadImages").checked = c.loadImages !== false;
  $("appendSource").checked = c.appendSource !== false;
  $("selectionDefault").checked = !!c.selectionDefault;
  if (c.dbCache && c.dbCache.length) fillDbs(c.dbCache, c.defaultDbId);
}

function fillDbs(list, selected) {
  const sel = $("defaultDb");
  sel.innerHTML = "";
  list.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.title;
    if (d.id === selected) o.selected = true;
    sel.appendChild(o);
  });
}

$("test").onclick = async () => {
  const token = $("token").value.trim();
  const st = $("tokenStatus");
  if (!token) {
    st.className = "inline-status err";
    st.textContent = "Paste your integration secret first.";
    return;
  }
  st.className = "inline-status";
  st.textContent = "Testing…";
  const r = await send({ type: "testToken", token });
  if (r && r.ok) {
    await setLocal({ token, dbCache: r.databases });
    fillDbs(r.databases, $("defaultDb").value);
    st.className = "inline-status ok";
    st.textContent =
      r.count > 0
        ? `Connected · ${r.count} database${r.count > 1 ? "s" : ""} shared.`
        : "Connected, but no databases are shared yet — add the integration to a database in Notion.";
  } else {
    st.className = "inline-status err";
    st.textContent = (r && r.error) || "Could not connect.";
  }
};

$("defaultDb").onchange = async () => {
  await setLocal({ defaultDbId: $("defaultDb").value });
};

$("savePrefs").onclick = async () => {
  await setLocal({
    defaultDbId: $("defaultDb").value,
    loadImages: $("loadImages").checked,
    appendSource: $("appendSource").checked,
    selectionDefault: $("selectionDefault").checked,
  });
  const st = $("prefStatus");
  st.className = "inline-status ok";
  st.textContent = "Saved.";
  setTimeout(() => (st.textContent = ""), 1500);
};

restore();
