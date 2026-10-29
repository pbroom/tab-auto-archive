// Runs tab-auto-archive.uc.js inside jsdom windows with fakes for the Firefox/Zen
// chrome APIs it touches. Run: node test.mjs <path to tab-auto-archive.uc.js>
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const SOURCE = readFileSync(process.argv[2], "utf8");
const HOUR = 3600000;

// ---- process-wide fakes shared by all windows ----
const prefStore = new Map();
const files = new Map();
const observers = new Map();
const windows = [];
const Services = {
  prefs: {
    PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
    getPrefType(k) {
      if (!prefStore.has(k)) return 0;
      const v = prefStore.get(k);
      return typeof v === "boolean" ? 128 : typeof v === "number" ? 64 : 32;
    },
    getBoolPref: (k, d) => (prefStore.has(k) ? prefStore.get(k) : d),
    getIntPref: (k, d) => (prefStore.has(k) ? prefStore.get(k) : d),
    getStringPref: (k, d) => (prefStore.has(k) ? prefStore.get(k) : d),
    setBoolPref: (k, v) => setPref(k, v),
    setIntPref: (k, v) => setPref(k, v),
    setStringPref: (k, v) => setPref(k, v),
    _observers: [],
    addObserver(branch, obs) { this._observers.push([branch, obs]); },
    removeObserver(branch, obs) { this._observers = this._observers.filter(([, o]) => o !== obs); },
  },
  obs: {
    addObserver(obs, topic) { (observers.get(topic) ?? observers.set(topic, new Set()).get(topic)).add(obs); },
    removeObserver(obs, topic) { observers.get(topic)?.delete(obs); },
    notifyObservers(subject, topic, data) { for (const o of [...(observers.get(topic) ?? [])]) o.observe(subject, topic, data); },
  },
  wm: {
    *getEnumerator() { yield* windows.filter(w => !w.closed); },
    getMostRecentWindow() { return windows.filter(w => !w.closed).at(-1) ?? null; },
  },
  scriptSecurityManager: { getSystemPrincipal: () => ({ system: true }) },
};
function setPref(k, v) {
  prefStore.set(k, v);
  for (const [branch, obs] of Services.prefs._observers) if (k.startsWith(branch)) obs.observe(null, "nsPref:changed", k);
}
const IOUtils = {
  async readJSON(p) {
    if (!files.has(p)) { const e = new Error("nf"); e.name = "NotFoundError"; throw e; }
    return JSON.parse(files.get(p));
  },
  async writeUTF8(p, s) { files.set(p, s); },
};
const PathUtils = { profileDir: "/profile", join: (...parts) => parts.join("/") };
const widgets = new Map();
const CustomizableUI = {
  PROVIDER_API: "api",
  getWidget: id => widgets.get(id) ?? null,
  createWidget(spec) { widgets.set(spec.id, { ...spec, provider: "api" }); },
  destroyWidget(id) { widgets.delete(id); },
};
const sessionStates = new WeakMap();
const SessionStore = {
  getTabState(tab) { return JSON.stringify(sessionStates.get(tab) ?? {}); },
  setTabState(tab, state) {
    state = typeof state === "string" ? JSON.parse(state) : state;
    sessionStates.set(tab, state);
    if (state.zenWorkspace) tab.setAttribute("zen-workspace-id", state.zenWorkspace);
    tab.linkedBrowser.currentURI.spec = state.entries?.[(state.index || 1) - 1]?.url ?? "about:blank";
    SessionStore.calls.push(state);
  },
  calls: [],
};

// ---- per-window fakes ----
function makeWindow({ spaces = ["s1", "s2"], active = "s1", privateWin = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="mainPopupSet"></div><div id="tabs"></div><div id="tabContextMenu"><div id="context_closeTab"></div></div></body>`, {
    url: "chrome://browser/content/browser.xhtml",
    runScripts: "outside-only",
  });
  const win = dom.window;
  const doc = win.document;
  doc.createXULElement = tag => {
    const el = doc.createElement("xul-" + tag);
    if (tag === "panel") {
      el.state = "closed";
      el.openPopup = () => { el.state = "open"; el.dispatchEvent(new win.Event("popupshowing")); el.dispatchEvent(new win.Event("popupshown")); };
      el.hidePopup = () => { el.state = "closed"; };
    }
    if (tag === "menulist") {
      Object.defineProperty(el, "value", { get: () => el.getAttribute("value"), set: v => el.setAttribute("value", v) });
    }
    return el;
  };
  const container = doc.getElementById("tabs");
  let selectedTab = null;
  const gBrowser = {
    tabContainer: container,
    get tabs() { return [...container.children]; },
    get selectedTab() { return selectedTab; },
    set selectedTab(t) { if (selectedTab) { selectedTab.selected = false; selectedTab.lastAccessed = Date.now(); } selectedTab = t; t.selected = true; t.lastAccessed = Infinity; },
    get selectedTabs() { return this.tabs.filter(t => t.multiselected || t.selected); },
    removed: [],
    removeTabs(tabs) {
      for (const t of tabs) {
        t.closing = true;
        t.dispatchEvent(new win.CustomEvent("TabClose", { bubbles: true, detail: {} }));
        t.remove();
        this.removed.push(t);
      }
    },
    addTrustedTab(url, opts) {
      const t = makeTab(win, { url, space: ws.activeWorkspace, lastAccessed: Date.now() });
      t.userContextId = opts.userContextId;
      t.addOpts = opts;
      container.append(t);
      return t;
    },
  };
  const ws = {
    activeWorkspace: active,
    workspaceEnabled: true,
    promiseInitialized: Promise.resolve(),
    spaces: spaces.map(uuid => ({ uuid, name: "Space " + uuid, icon: "🧪" })),
    getWorkspaceFromId(id) { return this.spaces.find(s => s.uuid === id) ?? null; },
    get allStoredTabs() { return gBrowser.tabs; },
    async changeWorkspaceWithID(id) { this.changes.push(id); this.activeWorkspace = id; },
    changes: [],
    moveTabToWorkspace(tab, id) { this.moves.push([tab, id]); tab.setAttribute("zen-workspace-id", id); },
    moves: [],
  };
  Object.assign(win, {
    Services, IOUtils, PathUtils, CustomizableUI, SessionStore,
    gBrowser, gZenWorkspaces: ws,
    PrivateBrowsingUtils: { isWindowPrivate: () => privateWin },
    delayedStartupPromise: Promise.resolve(),
    windowUtils: { AUTHOR_SHEET: 2, sheets: new Set(), loadSheetUsingURIString(u) { this.sheets.add(u); }, removeSheetUsingURIString(u) { this.sheets.delete(u); } },
    TabContextMenu: { contextTab: null },
    crypto: globalThis.crypto,
    // jsdom's own timers run on Node's clock; tests drive sweeps by hand.
  });
  windows.push(win);
  return win;
}

function makeTab(win, { url = "https://example.com/", space = "s1", lastAccessed = Date.now() - 13 * HOUR, attrs = {}, pinned = false, group = null, label } = {}) {
  const t = win.document.createElement("fake-tab");
  t.setAttribute("zen-workspace-id", space);
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
  Object.assign(t, {
    pinned, group, selected: false, multiselected: false, closing: false, lastAccessed,
    label: label ?? "Title " + url, userContextId: 0,
    linkedBrowser: { currentURI: { spec: url }, fixupAndLoadURIString(u) { t.linkedBrowser.currentURI.spec = u; } },
  });
  sessionStates.set(t, {
    entries: Array.from({ length: 15 }, (_, i) => ({ url: i === 14 ? url : url + "#h" + i })),
    index: 15, lastAccessed, storage: { big: "x".repeat(1000) }, formdata: { id: {} }, zenWorkspace: space,
  });
  return t;
}

async function boot(win) {
  win.eval(SOURCE);
  await new Promise(r => setTimeout(r, 0));
  await win.ZenTabAutoArchive.store.ready;
  return win.ZenTabAutoArchive;
}
const tick = () => new Promise(r => setTimeout(r, 0));

const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function reset() {
  const pending = [];
  for (const w of windows) {
    const a = w.ZenTabAutoArchive;
    try { a?.uninit(); if (a) pending.push(a.store.flush()); } catch {}
    w.close();
  }
  await Promise.all(pending);
  windows.length = 0;
  prefStore.clear(); files.clear(); observers.clear(); widgets.clear();
  Services.prefs._observers = []; SessionStore.calls.length = 0;
}

// ---- tests ----
test("eligibility rules", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const { isArchivable: check } = a._internals;
  const isArchivable = (tab, opts) => { win.gBrowser.tabContainer.append(tab); return check(tab, opts); };
  const idleMs = 12 * HOUR;
  const now = Date.now();
  const ok = makeTab(win);
  assert.equal(isArchivable(ok, { now, idleMs }), true);
  assert.equal(isArchivable(makeTab(win, { lastAccessed: now - HOUR }), { now, idleMs }), false, "recent");
  assert.equal(isArchivable(makeTab(win, { pinned: true }), { now, idleMs }), false, "pinned");
  for (const attr of ["zen-essential", "zen-empty-tab", "zen-glance-tab", "glance-id", "soundplaying", "pictureinpicture", "split-view", "busy"]) {
    assert.equal(isArchivable(makeTab(win, { attrs: { [attr]: "true" } }), { now, idleMs }), false, attr);
  }
  assert.equal(isArchivable(makeTab(win, { group: {} }), { now, idleMs }), false, "grouped");
  prefStore.set("zen.tab-auto-archive.skip-grouped-tabs", false);
  assert.equal(isArchivable(makeTab(win, { group: {} }), { now, idleMs }), true, "grouped allowed");
  assert.equal(isArchivable(makeTab(win, { url: "about:newtab" }), { now, idleMs }), false, "newtab");
  const sel = makeTab(win); sel.selected = true;
  assert.equal(isArchivable(sel, { now, idleMs }), false, "selected");
  assert.equal(isArchivable(makeTab(win, { lastAccessed: Infinity }), { now, idleMs }), false, "infinite");
  assert.equal(isArchivable(makeTab(win, { url: "https://mail.google.com/x" }), { now, idleMs, hosts: ["google.com"] }), false, "excluded subdomain");
  assert.equal(isArchivable(makeTab(win, { url: "https://notgoogle.com/" }), { now, idleMs, hosts: ["google.com"] }), true, "not excluded");
  // Closing skips idle checks but still protects pinned/essentials.
  assert.equal(isArchivable(makeTab(win, { lastAccessed: now }), { closing: true }), true);
  assert.equal(isArchivable(makeTab(win, { attrs: { "zen-essential": "true" } }), { closing: true }), false);
});

test("sweep archives idle tabs in every space, keeps the rest", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const c = win.gBrowser.tabContainer;
  const idle1 = makeTab(win, { url: "https://a.test/", space: "s1" });
  const idle2 = makeTab(win, { url: "https://b.test/", space: "s2" });
  const fresh = makeTab(win, { url: "https://c.test/", lastAccessed: Date.now() - HOUR });
  const pinned = makeTab(win, { url: "https://d.test/", pinned: true });
  const current = makeTab(win, { url: "https://e.test/" });
  c.append(idle1, idle2, fresh, pinned, current);
  win.gBrowser.selectedTab = current;
  const n = await a.archiveIdleTabs();
  assert.equal(n, 2);
  assert.deepEqual(win.gBrowser.tabs, [fresh, pinned, current]);
  same(a.store.entries.map(e => [e.url, e.spaceId, e.reason]).sort(), [["https://a.test/", "s1", "idle"], ["https://b.test/", "s2", "idle"]]);
  const e = a.store.entries[0];
  assert.equal(e.state.entries.length, 10, "history trimmed");
  assert.equal(e.state.index, 10);
  assert.equal(e.state.storage, undefined, "storage stripped");
  assert.equal(e.state.formdata, undefined, "formdata stripped");
});

test("unrestored (pending) tabs use their session URL", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const t = makeTab(win, { url: "https://pending.test/", attrs: { pending: "true" } });
  t.linkedBrowser.currentURI.spec = "about:blank";
  win.gBrowser.tabContainer.append(t);
  assert.equal(await a.archiveIdleTabs(), 1);
  assert.equal(a.store.entries[0].url, "https://pending.test/");
});

test("idle threshold pref and enabled pref", async () => {
  const win = makeWindow();
  const a = await boot(win);
  win.gBrowser.tabContainer.append(makeTab(win, { lastAccessed: Date.now() - 2 * HOUR }));
  assert.equal(await a.archiveIdleTabs(), 0);
  prefStore.set("zen.tab-auto-archive.idle-minutes", "60"); // Sine may store a string
  prefStore.set("zen.tab-auto-archive.enabled", false);
  assert.equal(await a.archiveIdleTabs(), 0, "disabled");
  assert.equal(await a.archiveIdleTabs({ force: true }), 1, "forced sweep");
});

test("private windows never archive", async () => {
  const win = makeWindow({ privateWin: true });
  const a = await boot(win);
  const t = makeTab(win);
  win.gBrowser.tabContainer.append(t);
  assert.equal(await a.archiveIdleTabs({ force: true }), 0);
  win.gBrowser.removeTabs([t]);
  await tick();
  assert.equal(a.store.entries.length, 0);
});

test("closing a tab archives it (archive-on-close), with exceptions", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const c = win.gBrowser.tabContainer;
  const t = makeTab(win, { url: "https://closed.test/", lastAccessed: Date.now() });
  const p = makeTab(win, { url: "https://pinned.test/", pinned: true });
  const moved = makeTab(win, { url: "https://moved.test/" });
  c.append(t, p, moved);
  win.gBrowser.removeTabs([t, p]);
  moved.dispatchEvent(new win.CustomEvent("TabClose", { bubbles: true, detail: { adoptedBy: {} } }));
  await tick();
  same(a.store.entries.map(e => [e.url, e.reason]), [["https://closed.test/", "closed"]]);
  prefStore.set("zen.tab-auto-archive.archive-on-close", false);
  const t2 = makeTab(win, { url: "https://nope.test/" });
  c.append(t2);
  win.gBrowser.removeTabs([t2]);
  await tick();
  assert.equal(a.store.entries.length, 1);
});

test("archived tabs are not double-counted by the close listener", async () => {
  const win = makeWindow();
  const a = await boot(win);
  win.gBrowser.tabContainer.append(makeTab(win, { url: "https://x.test/" }));
  await a.archiveIdleTabs();
  await tick();
  assert.equal(a.store.entries.length, 1);
  assert.equal(a.store.entries[0].reason, "idle");
});

test("same page in same space dedupes to newest", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const c = win.gBrowser.tabContainer;
  c.append(makeTab(win, { url: "https://dup.test/" }), makeTab(win, { url: "https://dup.test/", space: "s2" }));
  await a.archiveIdleTabs();
  c.append(makeTab(win, { url: "https://dup.test/" }));
  await a.archiveIdleTabs();
  assert.equal(a.store.entries.length, 2);
  same(a.store.entries.map(e => e.spaceId).sort(), ["s1", "s2"]);
});

test("restore reopens in original space with history, then leaves archive", async () => {
  const win = makeWindow({ active: "s1" });
  const a = await boot(win);
  win.gBrowser.tabContainer.append(makeTab(win, { url: "https://r.test/", space: "s2" }));
  await a.archiveIdleTabs();
  const id = a.store.entries[0].id;
  const tab = await a.restore(id);
  assert.deepEqual(win.gZenWorkspaces.changes, ["s2"], "switched to s2");
  assert.equal(tab.getAttribute("zen-workspace-id"), "s2");
  assert.equal(tab.linkedBrowser.currentURI.spec, "https://r.test/");
  const state = SessionStore.calls.at(-1);
  assert.equal(state.entries.length, 10);
  assert.equal(state.pinned, false);
  assert.equal(state.lastAccessed, undefined);
  assert.equal(win.gBrowser.selectedTab, tab);
  assert.equal(a.store.entries.length, 0);
});

test("restore into a deleted space falls back to the active one", async () => {
  const win = makeWindow({ active: "s1" });
  const a = await boot(win);
  win.gBrowser.tabContainer.append(makeTab(win, { url: "https://gone.test/", space: "deleted" }));
  await a.archiveIdleTabs();
  const tab = await a.restore(a.store.entries[0].id);
  assert.deepEqual(win.gZenWorkspaces.changes, []);
  assert.equal(tab.getAttribute("zen-workspace-id"), "s1");
});

test("background restore keeps current space and selection", async () => {
  const win = makeWindow({ active: "s1" });
  const a = await boot(win);
  const cur = makeTab(win, { url: "https://cur.test/" });
  win.gBrowser.tabContainer.append(cur, makeTab(win, { url: "https://bg.test/", space: "s2" }));
  win.gBrowser.selectedTab = cur;
  await a.archiveIdleTabs();
  const tab = await a.restore(a.store.entries[0].id, { inBackground: true });
  assert.deepEqual(win.gZenWorkspaces.changes, []);
  assert.equal(win.gBrowser.selectedTab, cur);
  assert.equal(tab.getAttribute("zen-workspace-id"), "s2");
  assert.deepEqual(win.gZenWorkspaces.moves.map(([t, id]) => [t, id]), [[tab, "s2"]], "moved into s2's strip");
});

test("persists to profile file and reloads", async () => {
  const win = makeWindow();
  const a = await boot(win);
  win.gBrowser.tabContainer.append(makeTab(win, { url: "https://persist.test/" }));
  await a.archiveIdleTabs();
  await a.store.flush();
  // flush only writes when a save is pending; force through the timer path
  await new Promise(r => setTimeout(r, 1100));
  await a.store.flush();
  const saved = JSON.parse(files.get("/profile/zen-tab-auto-archive.json"));
  assert.equal(saved.version, 1);
  assert.equal(saved.entries[0].url, "https://persist.test/");
  const savedFiles = new Map(files);
  await reset();
  for (const [k, v] of savedFiles) files.set(k, v);
  const win2 = makeWindow();
  const b = await boot(win2);
  assert.equal(b.store.entries[0].url, "https://persist.test/");
});

test("retention and max entries prune", async () => {
  files.set("/profile/zen-tab-auto-archive.json", JSON.stringify({ version: 1, entries: [
    { id: "old", url: "https://old.test/", spaceId: "s1", archivedAt: Date.now() - 40 * 24 * HOUR, title: "old" },
    { id: "new", url: "https://new.test/", spaceId: "s1", archivedAt: Date.now() - HOUR, title: "new" },
  ] }));
  const win = makeWindow();
  const a = await boot(win);
  same(a.store.entries.map(e => e.id), ["new"]);
  prefStore.set("zen.tab-auto-archive.max-entries", 2);
  const c = win.gBrowser.tabContainer;
  c.append(makeTab(win, { url: "https://1.test/" }), makeTab(win, { url: "https://2.test/" }));
  await a.archiveIdleTabs();
  assert.equal(a.store.entries.length, 2);
  assert.ok(!a.store.entries.some(e => e.id === "new"), "oldest dropped first");
});

test("changes reach other windows; new windows copy live state", async () => {
  const w1 = makeWindow();
  const a = await boot(w1);
  const w2 = makeWindow();
  const b = await boot(w2);
  w1.gBrowser.tabContainer.append(makeTab(w1, { url: "https://shared.test/" }));
  await a.archiveIdleTabs();
  assert.equal(b.store.entries.length, 1);
  await b.store.remove([b.store.entries[0].id]);
  assert.equal(a.store.entries.length, 0);
  w1.gBrowser.tabContainer.append(makeTab(w1, { url: "https://unsaved.test/" }));
  await a.archiveIdleTabs();
  const w3 = makeWindow();
  const c3 = await boot(w3);
  assert.equal(c3.store.entries[0].url, "https://unsaved.test/", "copied before file write");
});

test("widget is created once and placed in Zen's sidebar footer", async () => {
  const w1 = makeWindow();
  await boot(w1);
  const w2 = makeWindow();
  await boot(w2);
  const widget = widgets.get("zen-tab-auto-archive-button");
  assert.equal(widget.defaultArea, "zen-sidebar-foot-buttons");
  assert.equal(w1.windowUtils.sheets.size, 1, "style loaded");
});

test("panel: lists current space, search, scope toggle, restore, remove", async () => {
  const win = makeWindow({ active: "s1" });
  const a = await boot(win);
  const doc = win.document;
  const c = win.gBrowser.tabContainer;
  c.append(
    makeTab(win, { url: "https://alpha.test/", space: "s1", label: "Alpha docs" }),
    makeTab(win, { url: "https://beta.test/", space: "s1", label: "Beta <b>bold</b>" }),
    makeTab(win, { url: "https://gamma.test/", space: "s2", label: "Gamma" }),
  );
  await a.archiveIdleTabs();
  const button = doc.createElement("button");
  widgets.get("zen-tab-auto-archive-button").onCommand({ target: Object.assign(button, { ownerGlobal: win }) });
  const panel = doc.getElementById("zen-tab-auto-archive-panel");
  assert.equal(panel.state, "open");
  const titles = () => [...panel.querySelectorAll(".zta-title")].map(e => e.textContent);
  assert.deepEqual(titles().sort(), ["Alpha docs", "Beta <b>bold</b>"]);
  assert.equal(panel.querySelector(".zta-title b"), null, "titles are text, not HTML");
  assert.equal(panel.querySelector(".zta-bucket").textContent, "Today");
  panel.querySelector(".zta-scope").click();
  assert.equal(titles().length, 3);
  assert.match(panel.querySelector(".zta-meta").textContent, /Space s/);
  const search = panel.querySelector(".zta-search");
  search.value = "gamma";
  search.dispatchEvent(new win.Event("input"));
  assert.deepEqual(titles(), ["Gamma"]);
  search.value = "zzz";
  search.dispatchEvent(new win.Event("input"));
  assert.equal(panel.querySelector(".zta-empty").textContent, "No matches");
  search.value = "";
  search.dispatchEvent(new win.Event("input"));
  // remove one
  const betaRow = [...panel.querySelectorAll(".zta-row")].find(r => r.textContent.includes("Beta"));
  betaRow.querySelector(".zta-remove").click();
  await tick();
  assert.equal(a.store.entries.length, 2);
  assert.equal(titles().length, 2, "re-rendered after change");
  // restore by click
  const gammaRow = [...panel.querySelectorAll(".zta-row")].find(r => r.textContent.includes("Gamma"));
  gammaRow.click();
  await tick(); await tick();
  assert.equal(panel.state, "closed");
  assert.deepEqual(win.gZenWorkspaces.changes, ["s2"]);
  assert.equal(a.store.entries.length, 1);
});

test("panel idle menu writes prefs", async () => {
  const win = makeWindow();
  const a = await boot(win);
  a.togglePanel(win.document.body);
  const menulist = win.document.querySelector(".zta-idle");
  assert.equal(menulist.value, "720");
  menulist.value = "10080";
  menulist.dispatchEvent(new win.Event("command"));
  assert.equal(prefStore.get("zen.tab-auto-archive.idle-minutes"), 10080);
  assert.equal(prefStore.get("zen.tab-auto-archive.enabled"), true);
  menulist.value = "0";
  menulist.dispatchEvent(new win.Event("command"));
  assert.equal(prefStore.get("zen.tab-auto-archive.enabled"), false);
  assert.equal(prefStore.get("zen.tab-auto-archive.idle-minutes"), 10080, "threshold kept");
});

test("context menu archives the tab, hidden for pinned", async () => {
  const win = makeWindow();
  const a = await boot(win);
  const doc = win.document;
  const item = doc.getElementById("context_zenArchiveTab");
  assert.equal(item.nextElementSibling.id, "context_closeTab");
  const menu = doc.getElementById("tabContextMenu");
  const pinned = makeTab(win, { pinned: true });
  const t = makeTab(win, { url: "https://ctx.test/", lastAccessed: Date.now() });
  win.gBrowser.tabContainer.append(pinned, t);
  win.TabContextMenu.contextTab = pinned;
  menu.dispatchEvent(new win.Event("popupshowing"));
  assert.equal(item.hidden, true);
  win.TabContextMenu.contextTab = t;
  menu.dispatchEvent(new win.Event("popupshowing"));
  assert.equal(item.hidden, false);
  item.dispatchEvent(new win.Event("command"));
  await tick();
  same(a.store.entries.map(e => [e.url, e.reason]), [["https://ctx.test/", "manual"]]);
  assert.ok(!win.gBrowser.tabs.includes(t));
});

test("uninit removes UI, listeners, and style", async () => {
  const win = makeWindow();
  const a = await boot(win);
  a.togglePanel(win.document.body);
  a.uninit();
  assert.equal(win.document.getElementById("zen-tab-auto-archive-panel"), null);
  assert.equal(win.document.getElementById("context_zenArchiveTab"), null);
  assert.equal(win.windowUtils.sheets.size, 0);
  assert.equal(win.ZenTabAutoArchive, undefined);
  const t = makeTab(win);
  win.gBrowser.tabContainer.append(t);
  win.gBrowser.removeTabs([t]);
  await tick();
  assert.equal(a.store.entries.length, 0, "close listener gone");
});

let failed = 0;
for (const [name, fn] of tests) {
  await reset();
  try {
    await fn();
    console.log("ok   ", name);
  } catch (error) {
    failed++;
    console.log("FAIL ", name, "\n", error);
  }
}
await reset();
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
