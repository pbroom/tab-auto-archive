// ==UserScript==
// @name           Tab Auto-Archive
// @description    Arc-style auto-archiving: idle unpinned tabs close on a timer and land in a searchable archive you can restore from.
// @include        main
// @version        0.1.0
// ==/UserScript==

(() => {
  "use strict";

  if (window.location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }
  if (window.ZenTabAutoArchive) {
    return;
  }

  const PREF_BRANCH = "zen.tab-auto-archive.";
  const DEFAULTS = {
    enabled: true,
    // Arc's default is 12 hours.
    "idle-minutes": 720,
    // Arc sends tabs you close yourself to the archive too.
    "archive-on-close": true,
    "check-interval-minutes": 5,
    // 0 keeps archived tabs forever.
    "retention-days": 30,
    "max-entries": 1000,
    "skip-grouped-tabs": true,
    // Comma-separated hostnames; subdomains match too.
    "excluded-domains": "",
  };

  const STORE_FILE = "zen-tab-auto-archive.json";
  const STORE_TOPIC = "zen-tab-auto-archive-changed";
  const WIDGET_ID = "zen-tab-auto-archive-button";
  const PANEL_ID = "zen-tab-auto-archive-panel";
  const MENUITEM_ID = "context_zenArchiveTab";
  const HISTORY_LIMIT = 10;
  const SKIPPED_URLS = new Set([
    "",
    "about:blank",
    "about:newtab",
    "about:home",
    "about:privatebrowsing",
  ]);
  const IDLE_CHOICES = [
    [60, "1 hour"],
    [360, "6 hours"],
    [720, "12 hours"],
    [1440, "24 hours"],
    [10080, "7 days"],
    [43200, "30 days"],
  ];

  const ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill">' +
        '<path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v1A1.5 1.5 0 0 1 13 4.9V12.5A2.5 2.5 0 0 1 10.5 15h-5A2.5 2.5 0 0 1 3 12.5V4.9A1.5 1.5 0 0 1 2 3.5v-1zM4.25 5v7.5c0 .69.56 1.25 1.25 1.25h5c.69 0 1.25-.56 1.25-1.25V5h-7.5zM3.5 2.25a.25.25 0 0 0-.25.25v1c0 .14.11.25.25.25h9a.25.25 0 0 0 .25-.25v-1a.25.25 0 0 0-.25-.25h-9zM6 7.25h4a.62.62 0 1 1 0 1.25H6a.62.62 0 1 1 0-1.25z"/>' +
        "</svg>"
    );

  const STYLE = `
    #${WIDGET_ID} {
      list-style-image: url("${ICON}");
    }
    #${PANEL_ID} {
      --zta-radius: 6px;
      --panel-padding: 0;
    }
    #${PANEL_ID} .zta-header,
    #${PANEL_ID} .zta-footer {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px;
    }
    #${PANEL_ID} .zta-footer {
      border-top: 1px solid var(--zen-colors-border, var(--panel-separator-color));
      font-size: 0.9em;
    }
    #${PANEL_ID} .zta-search {
      flex: 1;
      min-width: 0;
      padding: 5px 8px;
      border: 1px solid var(--zen-colors-border, var(--panel-separator-color));
      border-radius: var(--zta-radius);
      background: transparent;
      color: inherit;
    }
    #${PANEL_ID} button {
      appearance: none;
      border: none;
      border-radius: var(--zta-radius);
      padding: 4px 8px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    #${PANEL_ID} button:hover {
      background: var(--button-hover-bgcolor, color-mix(in srgb, currentColor 10%, transparent));
    }
    #${PANEL_ID} .zta-scope {
      white-space: nowrap;
      opacity: 0.8;
    }
    #${PANEL_ID} .zta-list {
      width: 340px;
      max-height: 420px;
      overflow-y: auto;
      padding: 0 4px 6px;
    }
    #${PANEL_ID} .zta-bucket {
      padding: 8px 8px 4px;
      font-size: 0.8em;
      font-weight: 600;
      opacity: 0.6;
    }
    #${PANEL_ID} .zta-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: var(--zta-radius);
      cursor: pointer;
    }
    #${PANEL_ID} .zta-row:hover,
    #${PANEL_ID} .zta-row:focus-visible {
      background: var(--button-hover-bgcolor, color-mix(in srgb, currentColor 10%, transparent));
      outline: none;
    }
    #${PANEL_ID} .zta-favicon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    #${PANEL_ID} .zta-favicon-missing {
      visibility: hidden;
    }
    #${PANEL_ID} .zta-text {
      flex: 1;
      min-width: 0;
    }
    #${PANEL_ID} .zta-title,
    #${PANEL_ID} .zta-meta {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    #${PANEL_ID} .zta-meta {
      font-size: 0.8em;
      opacity: 0.6;
    }
    #${PANEL_ID} .zta-remove {
      visibility: hidden;
      padding: 0 6px;
      font-size: 1.1em;
      line-height: 1.4;
    }
    #${PANEL_ID} .zta-row:hover .zta-remove {
      visibility: visible;
    }
    #${PANEL_ID} .zta-empty {
      padding: 24px 8px;
      text-align: center;
      opacity: 0.6;
    }
    #${PANEL_ID} .zta-idle {
      margin: 0;
      min-height: 0;
    }
    #${PANEL_ID} .zta-spacer {
      flex: 1;
    }
  `;
  const STYLE_URI = "data:text/css;charset=utf-8," + encodeURIComponent(STYLE);

  function getPref(name) {
    const key = PREF_BRANCH + name;
    const fallback = DEFAULTS[name];
    const prefs = Services.prefs;
    try {
      switch (prefs.getPrefType(key)) {
        case prefs.PREF_BOOL:
          return prefs.getBoolPref(key);
        case prefs.PREF_INT:
          return prefs.getIntPref(key);
        case prefs.PREF_STRING: {
          // Sine's text inputs can store numbers and booleans as strings.
          const value = prefs.getStringPref(key);
          if (typeof fallback === "number") {
            const number = Number(value);
            return Number.isFinite(number) ? number : fallback;
          }
          if (typeof fallback === "boolean") {
            return value.trim().toLowerCase() !== "false";
          }
          return value;
        }
      }
    } catch (error) {
      console.warn("[ZenTabAutoArchive] Bad pref", key, error);
    }
    return fallback;
  }

  function setIntPref(name, value) {
    const key = PREF_BRANCH + name;
    if (Services.prefs.getPrefType(key) === Services.prefs.PREF_STRING) {
      Services.prefs.setStringPref(key, String(value));
    } else {
      Services.prefs.setIntPref(key, value);
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function excludedHosts() {
    return String(getPref("excluded-domains"))
      .split(",")
      .map(host => host.trim().toLowerCase().replace(/^\*?\./, ""))
      .filter(Boolean);
  }

  function isExcludedUrl(url, hosts) {
    const host = hostOf(url).toLowerCase();
    return (
      !!host &&
      hosts.some(excluded => host === excluded || host.endsWith("." + excluded))
    );
  }

  function tabUrl(tab) {
    const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
    if (spec === "about:blank" && tab.hasAttribute("pending")) {
      // Tabs not yet restored this session still sit on about:blank.
      try {
        const { entries = [], index } = JSON.parse(SessionStore.getTabState(tab));
        const url = entries[(index || entries.length) - 1]?.url;
        if (url) {
          return url;
        }
      } catch {}
    }
    return spec;
  }

  /**
   * Whether a tab may go to the archive. Tabs the user closes skip the idle
   * checks, since closing them is the user's own call.
   */
  function isArchivable(tab, { now = Date.now(), idleMs = 0, closing = false, hosts = null } = {}) {
    if (!tab || tab.pinned) {
      return false;
    }
    for (const attr of ["zen-essential", "zen-empty-tab", "zen-glance-tab", "glance-id"]) {
      if (tab.hasAttribute(attr)) {
        return false;
      }
    }
    if (SKIPPED_URLS.has(tabUrl(tab))) {
      return false;
    }
    if (closing) {
      return true;
    }
    if (tab.closing || !tab.isConnected || tab.selected || tab.multiselected) {
      return false;
    }
    for (const attr of ["soundplaying", "pictureinpicture", "split-view", "busy"]) {
      if (tab.hasAttribute(attr)) {
        return false;
      }
    }
    if (tab.splitView || tab.querySelector?.(".tabbrowser-tab[glance-id]")) {
      return false;
    }
    if (tab.group && getPref("skip-grouped-tabs")) {
      return false;
    }
    if (isExcludedUrl(tabUrl(tab), hosts ?? excludedHosts())) {
      return false;
    }
    const browser = tab.linkedBrowser;
    try {
      if (
        window.webrtcUI?.browserHasStreams(browser) ||
        browser?.browsingContext?.currentWindowGlobal?.hasActivePeerConnections()
      ) {
        return false;
      }
    } catch {}
    const lastAccessed = tab.lastAccessed;
    if (!lastAccessed || !Number.isFinite(lastAccessed)) {
      return false;
    }
    return now - lastAccessed >= idleMs;
  }

  function makeEntry(tab, reason) {
    const url = tabUrl(tab);
    let state = null;
    try {
      state = JSON.parse(SessionStore.getTabState(tab));
      // Page storage and form contents can be large and private; history is enough.
      for (const key of ["storage", "formdata", "image", "extData"]) {
        delete state[key];
      }
      if (Array.isArray(state.entries) && state.entries.length > HISTORY_LIMIT) {
        const drop = state.entries.length - HISTORY_LIMIT;
        state.entries = state.entries.slice(drop);
        state.index = Math.max(1, (state.index || 1) - drop);
      }
    } catch (error) {
      console.warn("[ZenTabAutoArchive] No session state for tab", url, error);
    }
    return {
      id: crypto.randomUUID(),
      url,
      title: tab.label || url,
      image: tab.getAttribute("image") || "",
      spaceId: tab.getAttribute("zen-workspace-id") || "",
      userContextId: tab.userContextId || 0,
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : Date.now(),
      archivedAt: Date.now(),
      reason,
      state,
    };
  }

  /**
   * The archive, kept as a full copy in every window. A window that changes it
   * saves the file and sends the same change to the other windows.
   */
  class ArchiveStore {
    entries = [];
    loaded = false;
    #ready = Promise.withResolvers();
    #saveTimer = null;
    #writing = Promise.resolve();
    #listeners = new Set();
    #windowKey = crypto.randomUUID();

    get path() {
      return PathUtils.join(PathUtils.profileDir, STORE_FILE);
    }

    get ready() {
      return this.#ready.promise;
    }

    async load() {
      try {
        for (const win of Services.wm.getEnumerator("navigator:browser")) {
          const other = win !== window && win.ZenTabAutoArchive?.store;
          if (other?.loaded) {
            this.entries = JSON.parse(JSON.stringify(other.entries));
            return;
          }
        }
        try {
          const data = await IOUtils.readJSON(this.path);
          this.entries = Array.isArray(data?.entries) ? data.entries : [];
        } catch (error) {
          if (error.name !== "NotFoundError") {
            console.error("[ZenTabAutoArchive] Could not read archive", error);
          }
        }
        this.#prune();
      } finally {
        this.loaded = true;
        Services.obs.addObserver(this, STORE_TOPIC);
        Services.obs.addObserver(this, "quit-application-granted");
        this.#ready.resolve();
        this.#emit();
      }
    }

    destroy() {
      if (this.loaded) {
        Services.obs.removeObserver(this, STORE_TOPIC);
        Services.obs.removeObserver(this, "quit-application-granted");
      }
      this.flush();
      this.#listeners.clear();
    }

    onChange(listener) {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    }

    get(id) {
      return this.entries.find(entry => entry.id === id);
    }

    async add(entries) {
      await this.ready;
      this.#change({ op: "add", entries });
    }

    async remove(ids) {
      await this.ready;
      this.#change({ op: "remove", ids });
    }

    async clear(spaceId = null) {
      await this.ready;
      this.#change({ op: "clear", spaceId });
    }

    #apply({ op, entries, ids, spaceId }) {
      if (op === "add") {
        // One entry per page and space, like Arc: the newest wins.
        const key = entry => `${entry.spaceId}\n${entry.url}`;
        const keys = new Set(entries.map(key));
        this.entries = [...entries.toReversed(), ...this.entries.filter(entry => !keys.has(key(entry)))];
      } else if (op === "remove") {
        const drop = new Set(ids);
        this.entries = this.entries.filter(entry => !drop.has(entry.id));
      } else if (op === "clear") {
        this.entries = spaceId ? this.entries.filter(entry => entry.spaceId !== spaceId) : [];
      }
      this.#prune();
      this.#emit();
    }

    #change(change) {
      this.#apply(change);
      Services.obs.notifyObservers(null, STORE_TOPIC, JSON.stringify({ from: this.#windowKey, change }));
      clearTimeout(this.#saveTimer);
      this.#saveTimer = setTimeout(() => this.flush(), 1000);
    }

    flush() {
      if (this.#saveTimer === null) {
        return this.#writing;
      }
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      const json = JSON.stringify({ version: 1, entries: this.entries });
      this.#writing = this.#writing
        .then(() => IOUtils.writeUTF8(this.path, json, { tmpPath: this.path + ".tmp" }))
        .catch(error => console.error("[ZenTabAutoArchive] Could not save archive", error));
      return this.#writing;
    }

    #prune() {
      const retentionDays = getPref("retention-days");
      if (retentionDays > 0) {
        const cutoff = Date.now() - retentionDays * 86400000;
        this.entries = this.entries.filter(entry => entry.archivedAt >= cutoff);
      }
      const max = getPref("max-entries");
      if (max > 0 && this.entries.length > max) {
        this.entries = this.entries.slice(0, max);
      }
    }

    observe(_subject, topic, data) {
      if (topic === "quit-application-granted") {
        this.flush();
        return;
      }
      if (topic !== STORE_TOPIC) {
        return;
      }
      const { from, change } = JSON.parse(data);
      if (from !== this.#windowKey) {
        this.#apply(change);
      }
    }

    #emit() {
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  function relativeTime(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
  }

  function dayBucket(timestamp) {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    if (timestamp >= startOfToday) {
      return "Today";
    }
    if (timestamp >= startOfToday - 86400000) {
      return "Yesterday";
    }
    if (timestamp >= startOfToday - 6 * 86400000) {
      return "This week";
    }
    return "Older";
  }

  const HTML_NS = "http://www.w3.org/1999/xhtml";

  function html(tag, props = {}, children = []) {
    const element = document.createElementNS(HTML_NS, tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") {
        element.className = value;
      } else if (key === "text") {
        element.textContent = value;
      } else {
        element.setAttribute(key, value);
      }
    }
    element.append(...children);
    return element;
  }

  class TabArchive {
    store = new ArchiveStore();
    #timer = null;
    #firstRun = null;
    #panel = null;
    #search = null;
    #list = null;
    #scopeAll = false;
    #cleanup = [];

    get isPrivate() {
      return PrivateBrowsingUtils.isWindowPrivate(window);
    }

    get spaces() {
      return window.gZenWorkspaces;
    }

    get activeSpaceId() {
      return this.spaces?.activeWorkspace || "";
    }

    async init() {
      await window.delayedStartupPromise;
      await this.spaces?.promiseInitialized;
      if (window.closed) {
        return;
      }
      window.windowUtils.loadSheetUsingURIString(STYLE_URI, window.windowUtils.AUTHOR_SHEET);
      this.#cleanup.push(() =>
        window.windowUtils.removeSheetUsingURIString(STYLE_URI, window.windowUtils.AUTHOR_SHEET)
      );
      this.#createWidget();
      this.#addContextMenuItem();
      this.#listen(gBrowser.tabContainer, "TabClose", event => this.#onTabClose(event));
      this.#listen(window, "unload", () => this.uninit(), { once: true });
      Services.prefs.addObserver(PREF_BRANCH, this);
      this.#cleanup.push(() => Services.prefs.removeObserver(PREF_BRANCH, this));
      this.#cleanup.push(this.store.onChange(() => this.#renderIfOpen()));
      await this.store.load();
      this.#schedule();
      // Give session restore a moment before the first sweep.
      this.#firstRun = setTimeout(() => this.archiveIdleTabs(), 30000);
    }

    uninit() {
      clearInterval(this.#timer);
      clearTimeout(this.#firstRun);
      for (const fn of this.#cleanup.splice(0)) {
        try {
          fn();
        } catch (error) {
          console.error(error);
        }
      }
      this.store.destroy();
      document.getElementById(PANEL_ID)?.remove();
      document.getElementById(MENUITEM_ID)?.remove();
      delete window.ZenTabAutoArchive;
    }

    #listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      this.#cleanup.push(() => target.removeEventListener(type, handler, options));
    }

    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed") {
        return;
      }
      if (data === PREF_BRANCH + "check-interval-minutes") {
        this.#schedule();
      }
      this.#renderIfOpen();
    }

    #schedule() {
      clearInterval(this.#timer);
      const minutes = Math.max(1, getPref("check-interval-minutes"));
      this.#timer = setInterval(() => this.archiveIdleTabs(), minutes * 60000);
    }

    /** Tabs in every space of this window, not only the visible one. */
    get allTabs() {
      try {
        const tabs = this.spaces?.allStoredTabs;
        if (tabs?.length) {
          return Array.from(tabs);
        }
      } catch {}
      return Array.from(gBrowser.tabs);
    }

    idleTabs() {
      const idleMs = getPref("idle-minutes") * 60000;
      const now = Date.now();
      const hosts = excludedHosts();
      return this.allTabs.filter(tab => isArchivable(tab, { now, idleMs, hosts }));
    }

    async archiveIdleTabs({ force = false } = {}) {
      if (this.isPrivate || (!force && !getPref("enabled")) || !this.store.loaded) {
        return 0;
      }
      if (gBrowser.selectedTab?.hasAttribute("busy") && !force) {
        // Don't yank the tab strip around during a page load.
        return 0;
      }
      return this.archiveTabs(this.idleTabs(), "idle");
    }

    async archiveTabs(tabs, reason) {
      tabs = tabs.filter(tab => !tab.closing);
      if (!tabs.length) {
        return 0;
      }
      const entries = tabs.map(tab => makeEntry(tab, reason));
      for (const tab of tabs) {
        tab._zenTabArchived = true;
      }
      await this.store.add(entries);
      gBrowser.removeTabs(tabs, { animate: false, closeWindowWithLastTab: false });
      return tabs.length;
    }

    #onTabClose(event) {
      const tab = event.target;
      if (
        tab._zenTabArchived ||
        event.detail?.adoptedBy ||
        event.detail?.skipSessionStore ||
        this.isPrivate ||
        !getPref("archive-on-close") ||
        !isArchivable(tab, { closing: true })
      ) {
        return;
      }
      // Read the state now; the tab is gone after this event.
      this.store.add([makeEntry(tab, "closed")]);
    }

    async restore(id, { inBackground = false } = {}) {
      await this.store.ready;
      const entry = this.store.get(id);
      if (!entry) {
        return null;
      }
      const spaces = this.spaces;
      let spaceId = "";
      if (spaces?.workspaceEnabled) {
        spaceId = spaces.getWorkspaceFromId(entry.spaceId) ? entry.spaceId : this.activeSpaceId;
        if (!inBackground && spaceId !== this.activeSpaceId) {
          await spaces.changeWorkspaceWithID(spaceId);
        }
      }
      const tab = gBrowser.addTrustedTab("about:blank", {
        skipAnimation: true,
        inBackground: true,
        userContextId: entry.userContextId || 0,
      });
      if (spaceId) {
        // Put the tab in its space's strip before restoring; restoring only
        // sets the attribute.
        spaces.moveTabToWorkspace(tab, spaceId);
      }
      if (entry.state) {
        const state = { ...entry.state, pinned: false, hidden: false };
        delete state.zenEssential;
        delete state.lastAccessed;
        if (spaceId) {
          state.zenWorkspace = spaceId;
        }
        SessionStore.setTabState(tab, state);
      } else {
        tab.linkedBrowser.fixupAndLoadURIString(entry.url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
      if (!inBackground) {
        gBrowser.selectedTab = tab;
      }
      await this.store.remove([id]);
      return tab;
    }

    // UI

    #createWidget() {
      const existing = CustomizableUI.getWidget(WIDGET_ID);
      if (existing?.provider === CustomizableUI.PROVIDER_API) {
        // Another window already made it; CustomizableUI builds it here too.
        return;
      }
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "button",
        label: "Archived Tabs",
        tooltiptext: "Archived Tabs",
        defaultArea: "zen-sidebar-foot-buttons",
        onCommand(event) {
          const win = event.target.ownerGlobal;
          win.ZenTabAutoArchive?.togglePanel(event.target);
        },
      });
    }

    #addContextMenuItem() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu || document.getElementById(MENUITEM_ID)) {
        return;
      }
      const item = document.createXULElement("menuitem");
      item.id = MENUITEM_ID;
      item.setAttribute("label", "Archive Tab");
      item.setAttribute("accesskey", "v");
      const closeItem = document.getElementById("context_closeTab");
      menu.insertBefore(item, closeItem ?? null);
      const contextTabs = () => {
        const tab = window.TabContextMenu?.contextTab;
        if (!tab) {
          return [];
        }
        return tab.multiselected ? gBrowser.selectedTabs : [tab];
      };
      this.#listen(item, "command", () => {
        const tabs = contextTabs().filter(tab => isArchivable(tab, { closing: true }));
        this.archiveTabs(tabs, "manual");
      });
      this.#listen(menu, "popupshowing", event => {
        if (event.target !== menu) {
          return;
        }
        const tabs = contextTabs();
        item.hidden = this.isPrivate || !tabs.some(tab => isArchivable(tab, { closing: true }));
        item.setAttribute("label", tabs.length > 1 ? "Archive Tabs" : "Archive Tab");
      });
    }

    #ensurePanel() {
      if (this.#panel) {
        return this.#panel;
      }
      const panel = document.createXULElement("panel");
      panel.id = PANEL_ID;
      panel.setAttribute("type", "arrow");
      panel.setAttribute("orient", "vertical");
      panel.setAttribute("noautofocus", "true");

      this.#search = html("input", {
        type: "search",
        class: "zta-search",
        placeholder: "Search archived tabs",
      });
      const scope = html("button", { class: "zta-scope", text: "This space" });
      this.#list = html("div", { class: "zta-list", role: "list" });

      const idleSelect = document.createXULElement("menulist");
      idleSelect.className = "zta-idle";
      idleSelect.setAttribute("tooltiptext", "Archive idle tabs after");
      const idlePopup = document.createXULElement("menupopup");
      for (const [value, label] of [...IDLE_CHOICES, [0, "Never"]]) {
        idlePopup.append(this.#menuitem(value, label));
      }
      idleSelect.append(idlePopup);
      const sweep = html("button", { class: "zta-sweep", text: "Archive idle now" });
      const clear = html("button", { class: "zta-clear", text: "Clear" });

      panel.append(
        html("div", { class: "zta-header" }, [this.#search, scope]),
        this.#list,
        html("div", { class: "zta-footer" }, [
          html("label", { class: "zta-idle-label", text: "Archive after" }),
          idleSelect,
          html("div", { class: "zta-spacer" }),
          sweep,
          clear,
        ])
      );

      this.#search.addEventListener("input", () => this.render());
      this.#search.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          this.#list.querySelector(".zta-row")?.click();
        }
      });
      scope.addEventListener("click", () => {
        this.#scopeAll = !this.#scopeAll;
        scope.textContent = this.#scopeAll ? "All spaces" : "This space";
        this.render();
      });
      idleSelect.addEventListener("command", () => {
        const minutes = Number(idleSelect.value);
        Services.prefs.setBoolPref(PREF_BRANCH + "enabled", minutes > 0);
        if (minutes > 0) {
          setIntPref("idle-minutes", minutes);
        }
      });
      sweep.addEventListener("click", () => this.archiveIdleTabs({ force: true }));
      clear.addEventListener("click", () => {
        this.store.clear(this.#scopeAll ? null : this.activeSpaceId || null);
      });
      panel.addEventListener("popupshowing", () => {
        const minutes = getPref("enabled") ? getPref("idle-minutes") : 0;
        if (![0, ...IDLE_CHOICES.map(([value]) => value)].includes(minutes)) {
          idlePopup.append(this.#menuitem(minutes, `${minutes} minutes`));
        }
        idleSelect.value = String(minutes);
        this.render();
      });
      panel.addEventListener("popupshown", () => this.#search.focus());

      document.getElementById("mainPopupSet").appendChild(panel);
      return (this.#panel = panel);
    }

    #menuitem(value, label) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("value", String(value));
      item.setAttribute("label", label);
      return item;
    }

    togglePanel(anchor) {
      const panel = this.#ensurePanel();
      if (panel.state === "open" || panel.state === "showing") {
        panel.hidePopup();
        return;
      }
      this.#search.value = "";
      panel.openPopup(anchor, "before_start");
    }

    #renderIfOpen() {
      if (this.#panel?.state === "open") {
        this.render();
      }
    }

    visibleEntries() {
      const query = (this.#search?.value || "").trim().toLowerCase();
      const spaceId = this.activeSpaceId;
      return this.store.entries.filter(entry => {
        if (!this.#scopeAll && spaceId && entry.spaceId && entry.spaceId !== spaceId) {
          return false;
        }
        return !query || entry.title.toLowerCase().includes(query) || entry.url.toLowerCase().includes(query);
      });
    }

    render() {
      if (!this.#list) {
        return;
      }
      const entries = this.visibleEntries();
      const rows = [];
      let bucket = null;
      for (const entry of entries) {
        const nextBucket = dayBucket(entry.archivedAt);
        if (nextBucket !== bucket) {
          bucket = nextBucket;
          rows.push(html("div", { class: "zta-bucket", text: bucket }));
        }
        rows.push(this.#row(entry));
      }
      if (!rows.length) {
        const empty = this.store.entries.length ? "No matches" : "Nothing archived yet";
        rows.push(html("div", { class: "zta-empty", text: empty }));
      }
      this.#list.replaceChildren(...rows);
    }

    #spaceLabel(spaceId) {
      const space = spaceId && this.spaces?.getWorkspaceFromId(spaceId);
      if (!space) {
        return "";
      }
      const icon = space.icon && !space.icon.includes("/") ? `${space.icon} ` : "";
      return icon + (space.name || "");
    }

    #row(entry) {
      const icon = html("img", { class: "zta-favicon", alt: "" });
      icon.src = entry.image || `page-icon:${entry.url}`;
      icon.addEventListener("error", () => icon.classList.add("zta-favicon-missing"), { once: true });

      const meta = [hostOf(entry.url), relativeTime(entry.archivedAt)];
      if (this.#scopeAll) {
        const label = this.#spaceLabel(entry.spaceId);
        if (label) {
          meta.unshift(label);
        }
      }
      const remove = html("button", { class: "zta-remove", title: "Remove from archive", text: "×" });
      const row = html(
        "div",
        { class: "zta-row", role: "listitem", title: entry.url, tabindex: "0" },
        [
          icon,
          html("div", { class: "zta-text" }, [
            html("div", { class: "zta-title", text: entry.title || entry.url }),
            html("div", { class: "zta-meta", text: meta.filter(Boolean).join(" · ") }),
          ]),
          remove,
        ]
      );
      remove.addEventListener("click", event => {
        event.stopPropagation();
        this.store.remove([entry.id]);
      });
      row.addEventListener("click", event => {
        const background = event.button === 1 || event.ctrlKey || event.metaKey;
        if (!background) {
          this.#panel.hidePopup();
        }
        this.restore(entry.id, { inBackground: background });
      });
      row.addEventListener("auxclick", event => {
        if (event.button === 1) {
          this.restore(entry.id, { inBackground: true });
        }
      });
      row.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          row.click();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          this.store.remove([entry.id]);
        }
      });
      return row;
    }
  }

  const archive = new TabArchive();
  window.ZenTabAutoArchive = archive;
  // Sine calls this when the mod is turned off or reloaded.
  window.addUnloadListener?.(() => {
    archive.uninit();
    if (!Services.wm.getMostRecentWindow("navigator:browser")?.ZenTabAutoArchive) {
      CustomizableUI.destroyWidget(WIDGET_ID);
    }
  });
  archive.init().catch(error => console.error("[ZenTabAutoArchive] init failed", error));

  // For the test harness.
  window.ZenTabAutoArchive._internals = { isArchivable, makeEntry, getPref, isExcludedUrl, ArchiveStore };
})();
