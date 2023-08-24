
//@ts-check

class AppItem {
  constructor(cfg, windowTitleFingerprint) {
    this.id = cfg.id
    this.update(cfg, windowTitleFingerprint)
    this.$unsetLaunchState()
  }

  update(cfg, windowTitleFingerprint) {
    this._cfg = cfg
    this._urlPattern = new RegExp(cfg.match)
    this._windowTitleFingerprint = windowTitleFingerprint
  }


  get config() {
    return { ...this._cfg }
  }

  get isAutostart() {
    return this._cfg.autostart
  }

  get windowId() {
    return this._lauched?.windowId ?? null
  }

  get windowTitleFingerprint() {
    return this._windowTitleFingerprint
  }

  get tabId() {
    return this._lauched?.tabId ?? null
  }


  set activeUrl(url) {
    if (this._lauched && this.isUrlMatches(url)) {
      this._lauched.activeUrl = url
    } else {
      console.warn("Trying to set activeUrl for app not lauched", { appId: this.id, url })
    }
  }

  get activeUrl() {
    return this._lauched?.activeUrl ?? null
  }

  get isLaunched() {
    return this.windowId !== null
  }

  async getTab() {
    return this.tabId ? await browser.tabs.get(this.tabId) : null
  }

  async getWindow() {
    return this.windowId ? await browser.windows.get(this.windowId, { populate: true }) : null
  }


  $unsetLaunchState() {
    this._lauched = null
  }

  $setLaunchState(windowId, tabId, activeUrl) {
    if (!activeUrl.match(this._urlPattern)) {
      console.warn("setLaunchState() - activeUrl does not match urlPattern", { appid: this.id, activeUrl, urlPattern: this._urlPattern })
    }
    this._lauched = {
      tabId,
      windowId,
      activeUrl,
    }
  }

  isUrlMatches(url) {
    return this._urlPattern?.test(url) ?? false
  }

  async _removeExtraTabs() {
    if (!this.windowId) {
      return
    }
    for (const tab of await browser.tabs.query({ windowId: this.windowId })) {
      if (tab.id && tab.id !== this.tabId) {
        console.info("Closing extra tab", { appId: this.id, windowId: this.windowId, tabId: tab.id })
        await browser.tabs.remove(tab.id)
      }
    }
  }

  async $launch(options) {
    console.debug("AppItem.launch()", { appId: this.id, options })
    if (this.windowId) {
      // existing window and tab
      await browser.windows.update(this.windowId, { focused: true })
      if (options?.tabId && this.tabId !== options.tabId) {
        console.info("Moving tab to existing app window", { appId: this.id, windowId: this.windowId, currentTabId: this.tabId, newTabId: options.tabId })
        await browser.tabs.move(options.tabId, { windowId: this.windowId, index: -1 })
        const t = await browser.tabs.get(options.tabId)
        this.$setLaunchState(this.windowId, options.tabId, t.url)
        // remove extra tabs from the window
        await this._removeExtraTabs()
      }
    } else {
      // no window yet
      const url = options?.tabId ? undefined : (options?.url ?? this._cfg.url);
      const tabId = url ? undefined : options.tabId;
      const w = await browser.windows.create({
        tabId, url,
        titlePreface: this.windowTitleFingerprint + " ",
        focused: true,
        type: this._cfg.window?.type ?? 'popup',
        width: this._cfg.window?.width ?? 1000,
        height: this._cfg.window?.height ?? 700,
      })
      this.$setLaunchState(w.id, w.tabs?.[0]?.id, url ?? w.tabs?.[0]?.url)
      console.info("App window created", { appId: this.id, lauchOptions: options, windowId: this.windowId, tabId: this.tabId, opt: { tabId, url }, w, this: this })
    }
    return this._lauched
  }
}


browser.storage.sync.onChanged.addListener((changes) => {
  console.log("storage.sync.onChanged", changes)
  // @ts-ignore
  getConfig().then(config => appsMgr.updateConfig(config))
})


class AppsManager {

  /**
   * @param {{ apps: { id: string, url: string, match: string, autostart: boolean }[] }} config
   */
  constructor({ apps }) {

    const extensionInstanceUUID = new URL(browser.runtime.getURL('')).host
    this.managerId = btoa(extensionInstanceUUID).replace(/\=\/\+/g, '').substring(0, 8)
    console.info("Extension instance uuid: ", extensionInstanceUUID, "AppManagerId: ", this.managerId)

    this.apps = new Map(apps?.map(appCfg => [appCfg.id, new AppItem(appCfg, this._getWindowTitleFingerprintForAppId(appCfg.id))]))

    this._reconsile()
  }

  _reconsile() {
    console.log("reconsile()", this.apps)
    return browser.windows.getAll().then(async (windows) => {
      for (const app of this.apps.values()) {
        console.log(app)
        const w = windows.find(w => w.title?.includes(app.windowTitleFingerprint))
        if (w) {
          console.info("Reconsile existing app window", { app, window: w })
          const t = (await browser.tabs.query({ windowId: w.id, active: true }))[0]
          app.$setLaunchState(w.id, t.id, t.url)
          companionAppCtl.postAppLauch(app)
        }
      }
    })

  }

  async updateConfig({ apps }) {
    console.log("updateConfig()", { apps })
    apps = apps.filter(app => {
      if (!app.enabled) {
        console.log("Config change: app disabled. appId: %s", app.id, { app })
      }
      return app.enabled
    })
    const pendingAppIds = new Set(this.apps.keys())
    for (const appCfg of apps) {
      const appId = appCfg.id
      const windowTitleFingerprint = this._getWindowTitleFingerprintForAppId(appId)
      const appItem = this.apps.get(appId)
      if (appItem) {
        const currentAppTab = await appItem.getTab()
        console.log("Config change: existing app updated. appId: %s", appId, { appItem, appCfg, currentAppTab })
        appItem.update(appCfg, windowTitleFingerprint)
        if (currentAppTab && !appItem.isUrlMatches(currentAppTab.url)) {
          console.info("Config change: appId: %s | Current app tab url does not match new config. Releasing app tab", appId, { appItem, currentAppTab })
          appItem.$unsetLaunchState()
          companionAppCtl.postAppClose(appItem.id);
          openInNonAppWindow(currentAppTab.id)
        }
        pendingAppIds.delete(appId)
      } else {
        console.log("Config change: new app added. appId: %s", appId, { appCfg })
        this.apps.set(appId, new AppItem(appCfg, windowTitleFingerprint))
      }
    }
    for (const appId of pendingAppIds) {
      console.info("Config change: app was removed. appId: %s", appId)
      this.apps[appId].unsetLaunchState()
      companionAppCtl.postAppClose(appId);
      this.apps.delete(appId)
    }

    companionAppCtl.postConfig({ apps })
    await this._reconsile()
  }

  _getWindowTitleFingerprintForAppId(id) {
    return `<TA#${id}@${this.managerId}>`
  }

  async launch(appId, options) {
    const appItem = this.apps.get(appId)
    if (!appItem) {
      throw new Error(`App not found: ${appId}`)
    }
    await appItem.$launch(options)
    // TODO: implement navigation complete listener to detect when app tab is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    companionAppCtl.postAppLauch(appItem)
  }

  async unlaunch(appId) {
    const appItem = this.apps.get(appId)
    if (!appItem) {
      throw new Error(`App not found: ${appId}`)
    }
    appItem.$unsetLaunchState()
    companionAppCtl.postAppClose(appItem.id);
  }

  async launchAllAutostartable() {
    for (const appItem of this.apps.values()) {
      if (appItem.isAutostart) {
        if (appItem.isLaunched) {
          console.debug("App already launched. Autostart skipping", { appItem })
          continue
        }
        console.log("Autostarting app", { appItem })
        await this.launch(appItem.id)
        companionAppCtl.postWindowAction(appItem.id, 'iconify')
      }
    }
  }

  isAppWindow(windowId) {
    for (const appItem of this.apps.values()) {
      if (appItem.windowId && appItem.windowId === windowId) {
        return true
      }
    }
    return false
  }

  getApp(options) {
    let found = false
    for (const appItem of this.apps.values()) {
      if (options?.url) {
        found = appItem.isUrlMatches(options.url)
      }
      if (options?.tabId) {
        found = appItem.tabId === options.tabId
      }
      if (options?.windowId) {
        found = appItem.windowId === options.windowId
      }
      if (found) {
        return appItem
      }
    }
    return null
  }
}


class CompanionAppCtl {

  constructor() {
    this._ensureConnected()
  }

  async _ensureConnected() {
    let companionAppNativePort = browser.runtime.connectNative('webext.tabapps.companion');
    this.companionAppNativePort = companionAppNativePort;
    companionAppNativePort.onDisconnect.addListener(() => {
      const retryAfterMs = 5000;
      this.companionAppNativePort = null;
      console.log("Disconnected from native app", companionAppNativePort.error, `Retrying after ${retryAfterMs}ms`);
      setTimeout(() => this._ensureConnected(), retryAfterMs);
    });
    companionAppNativePort.onMessage.addListener(ev => {
      console.log("Received message from native app: ", ev);
    });
  }

  _post(msg) {
    if (!this.companionAppNativePort) {
      console.warn("Companion app not connected. Dropping message", msg)
      return
    }
    console.log("Posting message to companion app: ", msg);
    this.companionAppNativePort.postMessage(msg);
  }

  postWindowAction(appId, action) {
    this._post({ type: "window-action", appId, action });
  }

  postPing() {
    this._post({ type: "ping" });
  }

  postConfig(config) {
    this._post({ type: "config", ...config, managerId: appsMgr.managerId });
  }

  postAppLauch(app) {
    this._post({ type: "app-launch", appId: app.id, windowTitleFingerprint: app.windowTitleFingerprint });
  }

  postAppClose(appId) {
    this._post({ type: "app-close", appId });
  }
}


const appsMgr = new AppsManager({ apps: [] })
const companionAppCtl = new CompanionAppCtl()

function asyncCb(fn) {
  return (...args) => {
    fn(...args).catch(err => console.error(err))
  }
}

async function openInNonAppWindow(urlOrTabId) {
  let nonAppWindowId = null
  for (const w of (await browser.windows.getAll())) {
    if (w.type !== 'normal') {
      continue
    }
    if (!appsMgr.isAppWindow(w.id)) {
      console.log("Found non-app window", { w })
      nonAppWindowId = w.id
    }
  }
  const url = typeof urlOrTabId === 'string' ? urlOrTabId : undefined
  const tabId = typeof urlOrTabId === 'number' ? urlOrTabId : undefined
  if (!url && !tabId) {
    throw new Error("urlOrTabId must be string or number")
  }
  if (nonAppWindowId) {
    await browser.windows.update(nonAppWindowId, { focused: true, state: 'normal' })
    if (url) {
      console.log("Opening url in non-app window", { url, tabId, nonAppWindowId })
      const t = await browser.tabs.create({ url: urlOrTabId, windowId: nonAppWindowId })
      return { windowId: nonAppWindowId, tabId: t.id }
    }
    if (tabId) {
      console.log("Moving tab to non-app window", { url, tabId, nonAppWindowId })
      await browser.tabs.move(tabId, { windowId: nonAppWindowId, index: -1 })
      return { windowId: nonAppWindowId, tabId }
    }
  } else {
    console.log("No non-app window found. Creating new one for", { url, tabId })
    const w = await browser.windows.create({ url, tabId })
    return { windowId: w.id, tabId: w.tabs?.[0]?.id }
  }
}


browser.webNavigation.onBeforeNavigate.addListener(asyncCb(async details => {
  if (details.frameId !== 0) {
    return;  // ignore iframe navigations
  }
  if (details.url.startsWith('moz-extension://')) {
    return; // ignore extention navigations
  }
  console.debug('[DBG] webNavigation.onBeforeNavigate()', { details })

  const cancelSourceNavigation = async () => {
    // console.debug("Canceling navigation", { details })
    // browser.history.getVisits()
    const t = await browser.tabs.get(details.tabId)
    if (['about:newtab', 'about:home', 'about:blank'].includes(t.url ?? '')) {
      await browser.tabs.remove(details.tabId)
    }
    else {
      console.debug(`Executing window.stop() on  windowId=${t.windowId} tabId=${t.id} url=(${t.url})`, t)
      // await browser.tabs.goBack(details.tabId)
      await browser.tabs.executeScript(details.tabId, { code: 'window.stop()' })
    }
  }

  const launchedAppItem = appsMgr.getApp({ tabId: details.tabId })
  if (launchedAppItem) { // navigation in app tab
    if (!launchedAppItem.isUrlMatches(details.url)) { // navigation url does not belong to app
      const appTab = await launchedAppItem.getTab()
      console.info("Extenal navigation candidate detected", details, { lauchedAppItem: launchedAppItem, appTab });
      await Promise.all([cancelSourceNavigation(), openInNonAppWindow(details.url)])
    }
    return // ignore self navigation in app tab
  }

  const toBeLaunchedAppItem = appsMgr.getApp({ url: details.url })
  if (toBeLaunchedAppItem) { // navigation to app url from non-app tab
    await Promise.all([cancelSourceNavigation(), appsMgr.launch(toBeLaunchedAppItem.id, { url: details.url })])
  }

}));

browser.webNavigation.onCompleted.addListener(asyncCb(async details => {
  if (details.frameId !== 0) {
    return;  // ignore iframe navigations
  }
  const appItem = appsMgr.getApp({ tabId: details.tabId })
  if (!appItem) {
    return
  }
  if (appItem.isUrlMatches(details.url)) {
    appItem.activeUrl = details.url

    console.debug("Registering beforeunload listener", details.url)
    await browser.tabs.executeScript(this.tabId, {
      code: `
        console.log('beforeunload listener injected by ${browser.runtime.getManifest().name} extension')
        window.addEventListener('beforeunload', () => 'bla bla')
    ` })
  } else {
    console.warn("Unexpected url in app tab after navigation completed. Navigate back to last active url", { appItem, details })
    await browser.tabs.update(appItem.tabId, { url: appItem.activeUrl })
  }
}))

browser.windows.onRemoved.addListener((windowId) => {
  const appItem = appsMgr.getApp({ windowId: windowId })
  if (!appItem) {
    return
  }
  console.info("App window closed", { appId: appItem.id, windowId })
  appsMgr.unlaunch(appItem.id)
})

browser.runtime.onStartup.addListener(asyncCb(async () => {
  // open extension config page
  await browser.runtime.openOptionsPage()
}))



browser.runtime.onConnect.addListener(function (port) {
  console.debug("Connected extension port", port);
  port.onMessage.addListener(function (msg) {
    console.debug("Recived extension port message", msg);
    switch (msg['type']) {
      case 'call':
        switch (msg['method']) {
          case 'getManagedApps':
            port.postMessage({
              type: "return",
              method: "getManagedApps",
              data: getManagedApps()
            });
            break;
          default:
            console.error("Unknown method", msg['method'])
        }
        break
      default:
        console.error("Unknown message type", msg['type'])
    }
  });
})



function dump() {
  (async () => {
    for (const a of appsMgr.apps.values()) {
      const w = a.isLaunched ? await browser.windows.get(a.windowId, { populate: true }) : null
      console.debug(`DUMP(${a.id})`, { _current: a._lauched, a, w })
    }
  })()
}

function getManagedApps() {
  return Array.from(appsMgr.apps.values())
}


// @ts-ignore
getConfig().then(async config => {
  console.log("Initial config load", config)
  await appsMgr.updateConfig(config)
  await appsMgr.launchAllAutostartable()
})