const COMPANION_NATIVE_APP_ID = "webext.tabapps.companion";

console.info("Extension name=%s id=%s instance=%s", extensionName(), extensionId(), extensionInstanceId());
class CompanionAppCtl extends NativeClientCtl {
  postWindowAction(appId, action) {
    this.post("window-action", { appId, action });
  }

  async postPing() {
    this.post("ping");
  }

  async postConfig(config) {
    this.post("config", { ...config, extensionInstanceId: extensionInstanceId() });
  }

  /**
   * @param {AppItem} app
   */
  async postAppLauch(app) {
    this.post("app-launch", {
      appId: app.id,
      windowTitleFingerprint: app.getWindowTitleFingerprint() ?? (await app.getTab())?.title, // TODO: remove
      windowSelector: {
        titleFingerPrint: app.getWindowTitleFingerprint(),
        title: (await app.getTab())?.title,
      },
    });
  }

  async postAppClose(appId) {
    this.post("app-close", { appId });
  }
}

class AppItem {
  constructor(cfg) {
    this.id = cfg.id;
    this.update(cfg);
    this.$unsetLaunchState();
  }

  update(cfg) {
    this._cfg = cfg;
    this._urlPattern = new RegExp(cfg.match);
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

  getWindowTitleFingerprint() {
    if (!isFirefox()) {
      return null;
    }
    const hash = btoa(hashCode32(extensionInstanceId() + (this.config.cookieStoreId ?? "default") + this.id))
      .replace(/\=\/\+/g, "")
      .substring(0, 4);
    return `<TA#${this.id}@${hash}>`;
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

  async getContainer() {
    return await tryGetContainer(this._lauched?.cookieStoreId);
  }

  async $waitForActiveUrl() {
    return (await this._lauched?.activeUrl) ?? null;
  }

  $unsetLaunchState() {
    this._lauched = null;
  }

  async $setLaunchState({ windowId, tabId, cookieStoreId, activeUrl }) {
    console.debug("[DBG] AppItem::$setLaunchState() appid=%s", this.id, { windowId, tabId, activeUrl });
    if (activeUrl && !activeUrl.match(this._urlPattern)) {
      console.warn("AppItem::$setLaunchState() appid=%s : %s does not match %s", this.id, activeUrl, this._urlPattern);
    }
    this._lauched = { tabId, windowId, activeUrl: activeUrl || new RichPromise(null, 5000), cookieStoreId };
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
        await this.$setLaunchState({
          windowId: this.windowId,
          tabId: options.tabId,
          activeUrl: t.url,
          cookieStoreId: t.cookieStoreId,
        });
        // remove extra tabs from the window
        await this._removeExtraTabs();
      }
    } else {
      // no window yet
      const url = options?.tabId ? undefined : options?.url ?? this._cfg.url;
      let tabId = url ? undefined : options.tabId;
      const cookieStoreId = options?.cookieStoreId || this._cfg.cookieStoreId || undefined;
      const container = await tryGetContainer(cookieStoreId);
      const w = await browser.windows.create({
        tabId,
        url,
        focused: true,
        type: this._cfg.window?.type ?? "popup",
        width: this._cfg.window?.width ?? 1000,
        height: this._cfg.window?.height ?? 700,
        ...(isFirefox() && {
          titlePreface: `${this.getWindowTitleFingerprint()} `,
          cookieStoreId: cookieStoreId,
        }),
      });
      tabId = w.tabs?.[0].id;
      await this.$setLaunchState({ windowId: w.id, tabId, activeUrl: null, cookieStoreId });
      console.info(`App window created aid=${this.id} wId=${w.id} tId${tabId} container=${container?.name}`, {
        app: this,
        w,
        cookieStoreId,
        container,
      });
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

    this._apps = new Map(apps?.map((appCfg) => [appCfg.id, new AppItem(appCfg)]));

    this._companionAppCtl.addEventListener("ping", () => this._companionAppCtl.postPing());
    this._companionAppCtl.addEventListener("ready", () => {});
    this._companionAppCtl.addEventListener("dump", () => {});

    this._companionAppCtl.addEventListener(
      "<connected>",
      /**@param {any} ev*/ (ev) => {
        if (ev.detail.connectionAttempt > 1) {
          console.warn("Companion app reconnected, synchronizing state");
          this._companionAppCtl.postConfig({ apps: this.apps.map((app) => app.config) });
        }
        this.apps.forEach((app) => app.isLaunched && this._companionAppCtl.postAppLauch(app));
      }
    );

    this._companionAppCtl.addEventListener(
      "window-state",
      /**@param {any} ev*/ (ev) => {
        this._apps.get(ev.detail.appId)?.$setNativeWindowIdState({ nativeWindowId: ev.detail.nativeWindowId });
      }
    );
    this._reconsile();
  }

  _reconsile() {
    console.debug("[DBG] AppManager::reconsile()", this.apps);
    return browser.windows.getAll({ populate: true }).then(async (windows) => {
      for (const app of this._apps.values()) {
        if (!app.isLaunched) {
          continue;
        }
        for (const w of windows) {
          const tf = app.getWindowTitleFingerprint();
          if (tf && !w.title?.includes(tf)) {
            continue;
          }
          if (!tf && !(w.type === "popup" && app.isUrlMatches(w.tabs?.[0]?.url))) {
            continue;
          }
          console.info("Reconsile existing app window for %s", app.id, { app, window: w });
          const t = (await browser.tabs.query({ windowId: w.id, active: true }))[0];
          await app.$setLaunchState({ windowId: w.id, tabId: t.id, activeUrl: t.url, cookieStoreId: t.cookieStoreId });
          this._companionAppCtl.postAppLauch(app);
          break;
        }
      }
    });
  }

  get apps() {
    return Array.from(this._apps.values());
  }

  async updateConfig(config) {
    console.debug("[DBG] AppManager::updateConfig()", config);
    config.apps = config.apps.filter((app) => {
      if (!app.enabled) {
        console.info("Config change: app disabled. appId: %s", app.id, { app });
      }
      return app.enabled;
    });
    const remainingAppIds = new Set(this._apps.keys());
    for (const appCfg of config.apps) {
      const appId = appCfg.id;
      const app = this._apps.get(appId);
      if (app) {
        const currentAppTab = await app.getTab();
        console.info("Config change: existing app updated. appId: %s", appId, {
          app,
          appCfg,
          currentAppTab,
        });
        app.update(appCfg);
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
        this._apps.set(appId, new AppItem(appCfg));
      }
    }
    for (const appId of remainingAppIds) {
      console.info("Config update for %s app was removed", appId);
      this._companionAppCtl.postAppClose(appId);
      this._apps.delete(appId);
    }

    this._companionAppCtl.postConfig({ apps: config.apps });
    await this._reconsile();
  }

  async launch(appId, options) {
    const app = this._apps.get(appId);
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
    const app = this._apps.get(appId);
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
    return Promise.allSettled(Array.from(this._apps.values()).map(_autostart));
  }

  isAppWindow(windowId) {
    for (const app of this._apps.values()) {
      if (app.windowId && app.windowId === windowId) {
        return true;
      }
    }
    return false;
  }

  getApp(options) {
    let found = false;
    for (const app of this._apps.values()) {
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

const appsMgr = new AppsManager(new CompanionAppCtl(COMPANION_NATIVE_APP_ID), { apps: [] });

/**
 * @template T
 * @param {T extends unknown[] ? (...args: T)=>Promise: never} fn
 * @returns {(...args: T extends unknown[] ? T: never)=>void}
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
  //@ts-ignore
  asyncCb(async (details) => {
    if (details.frameId !== 0) {
      return; // ignore iframe navigations
    }
    if (["about:", "moz-extension:"].includes(new URL(details.url).protocol)) {
      return; // ignore non web navigations
    }
    console.debug("[DBG] webNavigation.onBeforeNavigate() %s", details.url, { details });

    const t = await browser.tabs.get(details.tabId);

    const cancelSourceNavigation = async () => {
      if (["about:blank"].includes(t.url ?? "")) {
        console.debug(`[DBG] Closing about:* tab=${t.id} wid=${t.windowId} url=${t.url}`, t);
        await browser.tabs.remove(details.tabId);
      } else {
        console.debug(`[DBG] Executing window.stop() on  windowId=${t.windowId} tabId=${t.id} url=${t.url}`, t);
        // await browser.tabs.goBack(details.tabId)
        const exec = await browser.tabs.executeScript(details.tabId, { code: "window.stop()" });
        console.debug(`[DBG] window.stop() executed`, exec);
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

    const appForUrl = appsMgr.getApp({ url: details.url });
    if (!appForUrl) {
      return;
    }
    // navigation to app url from non-app tab
    const configuredCookieStoreId = appForUrl.config.cookieStoreId;
    if (configuredCookieStoreId && configuredCookieStoreId !== t.cookieStoreId) {
      console.debug(
        "[DBG Ignoring navigation to app url. Container configured = %s | current = %s | url=%s",
        (await tryGetContainer(configuredCookieStoreId))?.name ?? `<unavailble #${configuredCookieStoreId}>`,
        (await tryGetContainer(t.cookieStoreId))?.name ?? `<none>`,
        details.url,
        appForUrl
      );
      return;
    }
    await Promise.all([
      cancelSourceNavigation(),
      appsMgr.launch(appForUrl.id, { url: details.url, cookieStoreId: t.cookieStoreId }),
    ]);
  })
);

browser.webNavigation.onCommitted.addListener(
  //@ts-ignore
  asyncCb(async (details) => {
    if (details.frameId !== 0) {
      return; // ignore iframe navigations
    }
    const app = appsMgr.getApp({ tabId: details.tabId });
    if (!app) {
      return; // non-app window
    }
    if (app.isUrlMatches(details.url)) {
      app.activeUrl = details.url;
    } else {
      if (app.activeUrl) {
        console.warn("Unexpected url %s in app tab. Navigate back to last active url", details.url, { app, details });
        await browser.tabs.update(app.tabId, { url: app.activeUrl });
      } else {
        console.error("Unexpected url %s in app tab. Last active url is none", details.url, { app, details });
      }
    }
  })
);

browser.webNavigation.onCompleted.addListener(
  //@ts-ignore
  asyncCb(async (details) => {
    if (details.frameId !== 0) {
      return; // ignore iframe navigations
    }
    if (!appsMgr.getApp({ tabId: details.tabId })?.isUrlMatches(details.url)) {
      return; // non-app window
    }
    console.debug("[DBG] Navigation completed. Registering 'beforeunload' listener", details.url, details);
    await browser.tabs.executeScript(this.tabId, {
      code: `
        console.log('beforeunload listener is injected by ${extensionName} extension')
        window.addEventListener('beforeunload', (e) => e.preventDefault())
    `,
    });
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

browser.runtime.onInstalled.addListener(
  asyncCb(async () => {
    console.info("Extension installed. Opening options page");
    await browser.runtime.openOptionsPage();
  })
);

browser.runtime.onSuspend.addListener(() => {
  console.warn("onSuspend() !!");
});

browser.runtime.onStartup.addListener(() => {
  console.info("onStartup()");
});

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
      console.debug(`[DBG] DUMP(${a.id})`, { _current: a._lauched, a, w });
    }
  })();
}

function getManagedApps() {
  return appsMgr.apps.map((app) => ({
    id: app.id,
    config: app.config,
    isLaunched: app.isLaunched,
    windowId: app.windowId,
    tabId: app.tabId,
    activeUrl: app.activeUrl,
    nativeWindow: app.nativeWindow,
    cookieStoreId: app._lauched?.cookieStoreId,
  }));
}

getConfig().then(async (config) => {
  console.info("Initial config load", config);
  await appsMgr.updateConfig(config);
  await appsMgr.launchAllAutostartable();
});
