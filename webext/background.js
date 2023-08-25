const extensionName = browser.runtime.getManifest().name;
const companionNativeAppId = "webext.tabapps.companion";

class CompanionAppCtl extends NativeAppCtl {
  postWindowAction(appId, action) {
    this.post("window-action", { appId, action });
  }

  postPing() {
    this.post("ping");
  }

  postConfig(config) {
    this.post("config", { ...config, managerId: appsMgr.managerId });
  }

  postAppLauch(app) {
    this.post("app-launch", { appId: app.id, windowTitleFingerprint: app.windowTitleFingerprint });
  }

  postAppClose(appId) {
    this.post("app-close", { appId });
  }
}

class AppItem {
  constructor(cfg, windowTitleFingerprint) {
    this.id = cfg.id;
    this.update(cfg, windowTitleFingerprint);
    this.$unsetLaunchState();
  }

  update(cfg, windowTitleFingerprint) {
    this._cfg = cfg;
    this._urlPattern = new RegExp(cfg.match);
    this._windowTitleFingerprint = windowTitleFingerprint;
  }

  get config() {
    return { ...this._cfg };
  }

  get isAutostart() {
    return this._cfg.autostart;
  }

  get windowId() {
    return this._lauched?.windowId ?? null;
  }

  get nativeWindow() {
    return this._lauched?.nativeWindow ?? null;
  }

  get windowTitleFingerprint() {
    return this._windowTitleFingerprint;
  }

  get tabId() {
    return this._lauched?.tabId ?? null;
  }

  set activeUrl(url) {
    if (this._lauched && this.isUrlMatches(url)) {
      if (this._lauched?.activeUrl instanceof RichPromise) {
        this._lauched.activeUrl.resolve(url);
      }
      this._lauched.activeUrl = url;
    } else {
      console.warn("Trying to set activeUrl for app not lauched", { appId: this.id, url });
    }
  }

  get activeUrl() {
    if (this._lauched?.activeUrl && typeof this._lauched.activeUrl === "string") {
      return this._lauched.activeUrl;
    }
    return null;
  }

  get isLaunched() {
    return this.windowId !== null;
  }

  async getTab() {
    return this.tabId ? await browser.tabs.get(this.tabId) : null;
  }

  async getWindow() {
    return this.windowId ? await browser.windows.get(this.windowId, { populate: true }) : null;
  }

  async $waitForActiveUrl() {
    return (await this._lauched?.activeUrl) ?? null;
  }

  $unsetLaunchState() {
    this._lauched = null;
  }

  $setLaunchState({ windowId, tabId, activeUrl }) {
    console.debug("[DBG] $setLaunchState() appid=%s", this.id, { windowId, tabId, activeUrl });
    if (activeUrl && !activeUrl.match(this._urlPattern)) {
      console.warn("$setLaunchState() appid=%s : %s does not match %s", this.id, activeUrl, this._urlPattern);
    }
    this._lauched = { tabId, windowId, activeUrl: activeUrl || new RichPromise(null, 5000) };
  }

  $setNativeWindowIdState({ nativeWindowId }) {
    if (this._lauched) {
      this._lauched.nativeWindow = { id: nativeWindowId };
    }
  }

  isUrlMatches(url) {
    return this._urlPattern?.test(url) ?? false;
  }

  async _removeExtraTabs() {
    if (!this.windowId) {
      return;
    }
    for (const tab of await browser.tabs.query({ windowId: this.windowId })) {
      if (tab.id && tab.id !== this.tabId) {
        console.info("Closing extra tab", {
          appId: this.id,
          windowId: this.windowId,
          tabId: tab.id,
        });
        await browser.tabs.remove(tab.id);
      }
    }
  }

  async $launch(options) {
    console.debug("[DBG] AppItem::launch()", { appId: this.id, options });
    if (this.windowId) {
      // existing window and tab
      await browser.windows.update(this.windowId, { focused: true });
      if (options?.tabId && this.tabId !== options.tabId) {
        console.info("Moving tab to existing app window", {
          appId: this.id,
          windowId: this.windowId,
          currentTabId: this.tabId,
          newTabId: options.tabId,
        });
        await browser.tabs.move(options.tabId, { windowId: this.windowId, index: -1 });
        const t = await browser.tabs.get(options.tabId);
        this.$setLaunchState({ windowId: this.windowId, tabId: options.tabId, activeUrl: t.url });
        // remove extra tabs from the window
        await this._removeExtraTabs();
      }
    } else {
      // no window yet
      const url = options?.tabId ? undefined : options?.url ?? this._cfg.url;
      const tabId = url ? undefined : options.tabId;
      const w = await browser.windows.create({
        tabId,
        url,
        titlePreface: this.windowTitleFingerprint + " ",
        focused: true,
        type: this._cfg.window?.type ?? "popup",
        width: this._cfg.window?.width ?? 1000,
        height: this._cfg.window?.height ?? 700,
        cookieStoreId: options.cookieStoreId || undefined,
      });
      this.$setLaunchState({ windowId: w.id, tabId: w.tabs?.[0]?.id, activeUrl: null });
      console.info("App window created for %s wId=%s tId=%s", this.id, w.id, w.tabs?.[0]?.id, { app: this, w });
    }
    return this._lauched;
  }
}

browser.storage.sync.onChanged.addListener((changes) => {
  console.debug("[DBG] storage.sync.onChanged", changes);
  getConfig().then((config) => appsMgr.updateConfig(config));
});

class AppsManager {
  /**
   * @param {CompanionAppCtl} companionAppCtl
   * @param {{ apps: { id: string, url: string, match: string, autostart: boolean }[] }} config
   */
  constructor(companionAppCtl, { apps }) {
    this._companionAppCtl = companionAppCtl;
    const extensionInstanceUUID = new URL(browser.runtime.getURL("")).host;
    this.managerId = btoa(extensionInstanceUUID)
      .replace(/\=\/\+/g, "")
      .substring(0, 4);
    console.info("Extension instance uuid: ", extensionInstanceUUID, "AppManagerId: ", this.managerId);

    this.apps = new Map(
      apps?.map((appCfg) => [appCfg.id, new AppItem(appCfg, this._getWindowTitleFingerprintForAppId(appCfg.id))])
    );

    this._companionAppCtl.addEventListener("ping", () => this._companionAppCtl.postPing());
    this._companionAppCtl.addEventListener("ready", () => {});
    this._companionAppCtl.addEventListener("dump", () => {});

    this._companionAppCtl.addEventListener("window-state", (ev) => {
      //@ts-ignore
      const app = this.apps.get(ev.detail.appId)?.$setNativeWindowIdState({ nativeWindowId: ev.detail.nativeWindowId });
    });
    this._reconsile();
  }

  _reconsile() {
    console.log("[DBG] reconsile()", Array.from(this.apps.values()));
    return browser.windows.getAll().then(async (windows) => {
      for (const app of this.apps.values()) {
        const w = windows.find((w) => w.title?.includes(app.windowTitleFingerprint));
        if (w) {
          console.info("Reconsile existing app window for %s", app.id, { app, window: w });
          const t = (await browser.tabs.query({ windowId: w.id, active: true }))[0];
          app.$setLaunchState({ windowId: w.id, tabId: t.id, activeUrl: t.url });
          this._companionAppCtl.postAppLauch(app);
        }
      }
    });
  }

  async updateConfig({ apps }) {
    console.debug("[DBG] updateConfig()", { apps });
    apps = apps.filter((app) => {
      if (!app.enabled) {
        console.log("Config change: app disabled. appId: %s", app.id, { app });
      }
      return app.enabled;
    });
    const remainingAppIds = new Set(this.apps.keys());
    for (const appCfg of apps) {
      const appId = appCfg.id;
      const windowTitleFingerprint = this._getWindowTitleFingerprintForAppId(appId);
      const app = this.apps.get(appId);
      if (app) {
        const currentAppTab = await app.getTab();
        console.log("Config change: existing app updated. appId: %s", appId, {
          app,
          appCfg,
          currentAppTab,
        });
        app.update(appCfg, windowTitleFingerprint);
        if (currentAppTab && !app.isUrlMatches(currentAppTab.url)) {
          console.info(
            `Config update for ${appId} | Current app tab url does not match new config. Releasing app tab`,
            { app, currentAppTab }
          );
          app.$unsetLaunchState();
          this._companionAppCtl.postAppClose(app.id);
          openInNonAppWindow(currentAppTab.id);
        }
        remainingAppIds.delete(appId);
      } else {
        console.info("Config update for %s new app added", appId, { appCfg });
        this.apps.set(appId, new AppItem(appCfg, windowTitleFingerprint));
      }
    }
    for (const appId of remainingAppIds) {
      console.info("Config update for %s app was removed", appId);
      this._companionAppCtl.postAppClose(appId);
      this.apps.delete(appId);
    }

    this._companionAppCtl.postConfig({ apps });
    await this._reconsile();
  }

  _getWindowTitleFingerprintForAppId(id) {
    return `<TA#${id}@${this.managerId}>`;
  }

  async launch(appId, options) {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }
    // await new Promise((resolve) => setTimeout(resolve, 3000));
    await app.$launch(options);
    try {
      await app.$waitForActiveUrl();
    } catch (e) {
      console.error("App did not load in time", app, e);
      return;
    }
    this._companionAppCtl.postAppLauch(app);
  }

  async unlaunch(appId) {
    const app = this.apps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }
    app.$unsetLaunchState();
    this._companionAppCtl.postAppClose(app.id);
  }

  async launchAllAutostartable() {
    const _autostart = async (app) => {
      if (app.isAutostart) {
        if (app.isLaunched) {
          console.debug("[DBG] App already launched. Autostart skipping", { app });
          return;
        }
        console.info("Autostarting app", { app });
        await this.launch(app.id, { cookieStoreId: app.config.cookieStoreId });
        this._companionAppCtl.postWindowAction(app.id, "iconify");
      }
    };
    return Promise.allSettled(Array.from(this.apps.values()).map(_autostart));
  }

  isAppWindow(windowId) {
    for (const app of this.apps.values()) {
      if (app.windowId && app.windowId === windowId) {
        return true;
      }
    }
    return false;
  }

  getApp(options) {
    let found = false;
    for (const app of this.apps.values()) {
      if (options?.url) {
        found = app.isUrlMatches(options.url);
      }
      if (options?.tabId) {
        found = app.tabId === options.tabId;
      }
      if (options?.windowId) {
        found = app.windowId === options.windowId;
      }
      if (found) {
        return app;
      }
    }
    return null;
  }
}

const appsMgr = new AppsManager(new CompanionAppCtl(companionNativeAppId), { apps: [] });

/**
 * x@template T
 * x@param {T extends unknown[] ? (...args: T)=>Promise: never} fn
 * x@returns {(...args: T extends unknown[] ? T: never)=>void}
 */
function asyncCb(fn) {
  return (...args) => {
    fn(...args).catch((err) => console.error(err));
  };
}

async function openInNonAppWindow(urlOrTabId) {
  let nonAppWindowId = null;
  for (const w of await browser.windows.getAll()) {
    if (w.type !== "normal") {
      continue;
    }
    if (!appsMgr.isAppWindow(w.id)) {
      console.debug("[DBG] Found non-app window", { w });
      nonAppWindowId = w.id;
    }
  }
  const url = typeof urlOrTabId === "string" ? urlOrTabId : undefined;
  const tabId = typeof urlOrTabId === "number" ? urlOrTabId : undefined;
  if (!url && !tabId) {
    throw new Error("urlOrTabId must be string or number");
  }
  if (nonAppWindowId) {
    await browser.windows.update(nonAppWindowId, { focused: true, state: "normal" });
    if (url) {
      console.log("Opening url in non-app window", { url, tabId, nonAppWindowId });
      const t = await browser.tabs.create({ url: urlOrTabId, windowId: nonAppWindowId });
      return { windowId: nonAppWindowId, tabId: t.id };
    }
    if (tabId) {
      console.log("Moving tab to non-app window", { url, tabId, nonAppWindowId });
      await browser.tabs.move(tabId, { windowId: nonAppWindowId, index: -1 });
      return { windowId: nonAppWindowId, tabId };
    }
  } else {
    console.log("No non-app window found. Creating new one for", { url, tabId });
    const w = await browser.windows.create({ url, tabId });
    return { windowId: w.id, tabId: w.tabs?.[0]?.id };
  }
}

browser.webNavigation.onBeforeNavigate.addListener(
  asyncCb(async (details) => {
    if (details.frameId !== 0) {
      return; // ignore iframe navigations
    }
    if (details.url.startsWith("moz-extension://")) {
      return; // ignore extention navigations
    }
    console.debug("[DBG] webNavigation.onBeforeNavigate() %s", details.url, { details });

    const t = await browser.tabs.get(details.tabId);

    const cancelSourceNavigation = async () => {
      if (["about:newtab", "about:home", "about:blank"].includes(t.url ?? "")) {
        console.debug(`[DBG] Closing about:* tab=${t.id} wid=${t.windowId} url=(${t.url})`, t);
        await browser.tabs.remove(details.tabId);
      } else {
        console.debug(`Executing window.stop() on  windowId=${t.windowId} tabId=${t.id} url=(${t.url})`, t);
        // await browser.tabs.goBack(details.tabId)
        await browser.tabs.executeScript(details.tabId, { code: "window.stop()" });
      }
    };

    const launchedApp = appsMgr.getApp({ tabId: details.tabId });
    if (launchedApp) {
      // navigation in app tab
      if (!launchedApp.isUrlMatches(details.url)) {
        // navigation url does not belong to app
        const appTab = await launchedApp.getTab();
        console.info("Extenal navigation candidate detected", details, { launchedApp, appTab });
        await Promise.all([cancelSourceNavigation(), openInNonAppWindow(details.url)]);
      }
      return; // ignore self navigation in app tab
    }

    const toBeLaunchedApp = appsMgr.getApp({ url: details.url });
    if (toBeLaunchedApp) {
      // navigation to app url from non-app tab
      let cookieStoreId = t.cookieStoreId;
      const configuredCookieStoreId = toBeLaunchedApp.config.cookieStoreId;
      if (configuredCookieStoreId && configuredCookieStoreId !== t.cookieStoreId) {
        try {
          const identity = await browser.contextualIdentities.get(configuredCookieStoreId);
          console.debug(
            "[DBG] Using user configured container contextualIdentity (name: %s, cookieStoreId: %s)",
            identity.name,
            configuredCookieStoreId,
            { toBeLaunchedApp, identity }
          );
          cookieStoreId = configuredCookieStoreId;
        } catch (err) {
          console.error(
            "contextualIdentity for cookieStoreId: %s not found. Not opening tab app",
            configuredCookieStoreId,
            { toBeLaunchedApp, err }
          );
          // TODO: show error to user
          return;
        }
      }
      await Promise.all([
        cancelSourceNavigation(),
        appsMgr.launch(toBeLaunchedApp.id, { url: details.url, cookieStoreId }),
      ]);
    }
  })
);

browser.webNavigation.onCompleted.addListener(
  asyncCb(async (details) => {
    if (details.frameId !== 0) {
      return; // ignore iframe navigations
    }
    const app = appsMgr.getApp({ tabId: details.tabId });
    if (!app) {
      // non-app window
      return;
    }
    if (app.isUrlMatches(details.url)) {
      app.activeUrl = details.url;

      console.debug("[DBG] Registering beforeunload listener", details.url);
      await browser.tabs.executeScript(this.tabId, {
        code: `
        console.log('beforeunload listener injected by ${extensionName} extension')
        window.addEventListener('beforeunload', () => 'bla bla')
    `,
      });
    } else {
      if (app.activeUrl) {
        console.warn("Unexpected url in app tab. Navigate back to last active url", { app, details });
        await browser.tabs.update(app.tabId, { url: app.activeUrl });
      } else {
        console.error("Unexpected url in app tab. Last active url is none", { app, details });
      }
    }
  })
);

browser.windows.onRemoved.addListener((windowId) => {
  const app = appsMgr.getApp({ windowId: windowId });
  if (!app) {
    return;
  }
  console.info("App window closed", { appId: app.id, windowId });
  appsMgr.unlaunch(app.id);
});

browser.runtime.onStartup.addListener(
  asyncCb(async () => {
    // open extension config page
    await browser.runtime.openOptionsPage();
  })
);

let extensionPort = null;
browser.runtime.onConnect.addListener(function (port) {
  extensionPort = port;
  console.debug("[DBG] Connected extension port", port);
  port.onMessage.addListener(function (msg) {
    console.debug("[DBG] Recived extension port message", msg);
    switch (msg["type"]) {
      case "call":
        switch (msg["method"]) {
          case "getManagedApps":
            port.postMessage({
              type: "return",
              method: "getManagedApps",
              data: getManagedApps(),
            });
            break;
          default:
            console.error("Unknown method", msg["method"]);
        }
        break;
      default:
        console.error("Unknown message type", msg["type"]);
    }
  });
  port.onDisconnect.addListener(function () {
    if (port.error) {
      console.error("Disconnected extension port", port, port.error);
    } else {
      console.debug("[DBG] Disconnected extension port", port);
    }
    extensionPort = null;
  });
});

function dump() {
  (async () => {
    for (const a of appsMgr.apps.values()) {
      const w = a.isLaunched ? await browser.windows.get(a.windowId, { populate: true }) : null;
      console.debug(`DUMP(${a.id})`, { _current: a._lauched, a, w });
    }
  })();
}

function getManagedApps() {
  return Array.from(appsMgr.apps.values()).map((app) => ({
    id: app.id,
    config: app.config,
    isLaunched: app.isLaunched,
    windowId: app.windowId,
    tabId: app.tabId,
    activeUrl: app.activeUrl,
    nativeWindow: app.nativeWindow,
    windowTitleFingerprint: app.windowTitleFingerprint,
  }));
}

getConfig().then(async (config) => {
  console.info("Initial config load", config);
  await appsMgr.updateConfig(config);
  await appsMgr.launchAllAutostartable();
});
