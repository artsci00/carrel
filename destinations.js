/*
 * Carrel destination registry (multi-destination stub).
 *
 * Notion is the only live adapter in v0.1. Obsidian and Readwise are stubbed so
 * the UI, storage, and clip pipeline are already destination-aware — shipping
 * them in v1.1 means implementing the adapter contract below, NOT reworking the
 * surrounding code.
 *
 * Adapter contract (implement one object per destination):
 *   id            stable key persisted in config (e.g. "obsidian")
 *   label         display name
 *   enabled       boolean — false renders as "soon" and blocks clipping
 *   targetLabel   what a "target" is called in the UI (Database / Vault folder)
 *   supportsProps boolean — whether the popup shows tag/status/property fields
 *   note          short roadmap/help line shown under the picker
 *   async listTargets(ctx)                       -> [{ id, title }]
 *   async getSchema(ctx, targetId)               -> { title, tags[], selects[], url, date }
 *   async save(ctx, { targetId, fields, blocks }) -> { url } | throws { kind:'config'|'network' }
 *
 * `ctx` is supplied by the service worker and exposes shared helpers. For v1.1,
 * move each adapter's live implementation into its object here; the worker's
 * doClip() already routes by destination id.
 *
 * Loads in BOTH contexts: the service worker (importScripts) and the popup
 * (<script src>), so it attaches to `self`/`window` rather than using modules.
 */
(function (root) {
  const soon = (name) =>
    async () => {
      const e = new Error(name + " support is coming in v1.1.");
      e.kind = "config";
      throw e;
    };

  const DESTINATIONS = [
    {
      id: "notion",
      label: "Notion",
      enabled: true,
      targetLabel: "Database",
      supportsProps: true,
      note: "",
      // Live implementation is wired inline in service-worker.js for v0.1.
      // In v1.1 it can move here behind listTargets/getSchema/save.
    },
    {
      id: "obsidian",
      label: "Obsidian",
      enabled: false,
      soon: true,
      targetLabel: "Vault folder",
      supportsProps: false,
      note: "Save Markdown to a local vault via a small companion — planned for v1.1.",
      listTargets: soon("Obsidian"),
      getSchema: soon("Obsidian"),
      save: soon("Obsidian"),
    },
    {
      id: "readwise",
      label: "Readwise",
      enabled: false,
      soon: true,
      targetLabel: "Reader",
      supportsProps: false,
      note: "Push to Readwise Reader with an API token — planned for v1.1.",
      listTargets: soon("Readwise"),
      getSchema: soon("Readwise"),
      save: soon("Readwise"),
    },
  ];

  root.CARREL_DESTINATIONS = DESTINATIONS;
  root.carrelDestination = (id) =>
    DESTINATIONS.find((d) => d.id === id) || DESTINATIONS[0];
})(typeof self !== "undefined" ? self : this);
