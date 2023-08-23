
//@ts-check

const DEFAULT_CONFIG = {
  apps: [
    {
      id: 'mdn',
      label: 'MDN',
      autostart: false,
      match: '^https?://developer\\.mozilla\\.org',
      url: 'https://developer.mozilla.org',
      icon: 'https://developer.mozilla.org/favicon.ico',
    },
    {
      id: 'slack',
      label: 'Slack',
      autostart: false,
      match: '^https?://app\\.slack\\.com',
      url: 'https://app.slack.com',
      icon: 'https://app.slack.com/favicon.ico',
    }
  ]
}


class AppItem {

  /**
   * @param {typeof DEFAULT_CONFIG.apps[0]} cfg
   * @param {string} windowTitleFingerprint
   */
  constructor(cfg, windowTitleFingerprint) {
    this.id = cfg.id
    this.cfg = cfg
    this._urlPattern = new RegExp(cfg.match)
    this.unsetLaunchState()
    this.windowTitleFingerprint = windowTitleFingerprint
  }

  get windowId() {
    return this._lauched?.windowId ?? null
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


  unsetLaunchState() {
    this._lauched = null
  }

  setLaunchState(windowId, tabId, activeUrl) {
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
    return this._urlPattern.test(url)
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

  async launch(options) {
    console.debug("AppItem.launch()", { appId: this.id, options })
    if (this.windowId) {
      // existing window and tab
      await browser.windows.update(this.windowId, { focused: true })
      if (options?.tabId && this.tabId !== options.tabId) {
        console.info("Moving tab to existing app window", { appId: this.id, windowId: this.windowId, currentTabId: this.tabId, newTabId: options.tabId })
        await browser.tabs.move(options.tabId, { windowId: this.windowId, index: -1 })
        const t = await browser.tabs.get(options.tabId)
        this.setLaunchState(this.windowId, options.tabId, t.url)
        // remove extra tabs from the window
        await this._removeExtraTabs()
      }
    } else {
      // no window yet
      const url = options?.tabId ? undefined : (options?.url ?? this.cfg.url);
      const tabId = url ? undefined : options.tabId;
      const w = await browser.windows.create({
        tabId, url,
        titlePreface: this.windowTitleFingerprint + " ",
        focused: true,
        type: this.cfg.window?.type ?? 'popup',
        width: this.cfg.window?.width ?? 1000,
        height: this.cfg.window?.height ?? 700,
      })
      this.setLaunchState(w.id, w.tabs?.[0]?.id, url ?? w.tabs?.[0]?.url)
      console.info("App window created", { appId: this.id, lauchOptions: options, windowId: this.windowId, tabId: this.tabId, opt: { tabId, url }, w, this: this })
    }
    return this._lauched
  }
}

class AppsManager {

  constructor() {

    const extensionInstanceUUID = new URL(browser.runtime.getURL('')).host
    this.managerId = btoa(extensionInstanceUUID).replace(/\=\/\+/g, '').substring(0, 8)
    console.info("Extension instance uuid: ", extensionInstanceUUID, "AppManagerId: ", this.managerId)

    this.apps = new Map(DEFAULT_CONFIG.apps.map(appCfg => [appCfg.id, new AppItem(appCfg, this._getWindowTitleFingerprintForAppId(appCfg.id))]))


    browser.windows.getAll().then(async windows => {
      for (const app of this.apps.values()) {
        console.log(app)
        const w = windows.find(w => w.title?.includes(app.windowTitleFingerprint))
        if (w) {
          console.info("Reconsile existing app window", { app, window: w })
          const t = (await browser.tabs.query({ windowId: w.id, active: true }))[0]
          app.setLaunchState(w.id, t.id, t.url)
          companionAppCtl.postAppLauch(app)
        }
      }
    })
  }

  _getWindowTitleFingerprintForAppId(id) {
    return `<TA#${id}@${this.managerId}>`
  }

  async launch(appId, options) {
    const appItem = this.apps.get(appId)
    if (!appItem) {
      throw new Error(`App not found: ${appId}`)
    }
    await appItem.launch(options)
  }

  async launchAllAutostartable() {
    for (const appItem of this.apps.values()) {
      if (appItem.cfg.autostart) {
        await appItem.launch()
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
    this.companionAppNativePort = browser.runtime.connectNative('webext.tabapps.companion');

    this.companionAppNativePort.postMessage({ type: "ping" });

    this.companionAppNativePort.onDisconnect.addListener(() => {
      console.log("Disconnected from native app.", this.companionAppNativePort.error);
    });

    this.companionAppNativePort.onMessage.addListener(ev => {
      console.log("Received message from native app: ", ev);
    });

    this.postPing()
    this.postConfig()
  }

  postPing() {
    this.companionAppNativePort.postMessage({ type: "ping" });
  }

  postConfig() {
    this.companionAppNativePort.postMessage({ type: "config", ...DEFAULT_CONFIG, managerId: appsMgr.managerId });
  }

  postAppLauch(app) {
    this.companionAppNativePort.postMessage({ type: "app-launch", appId: app.id, windowTitleFingerprint: app.windowTitleFingerprint });
  }

  postAppClose(appId) {
    this.companionAppNativePort.postMessage({ type: "app-close", appId });
  }
}


const appsMgr = new AppsManager()
const companionAppCtl = new CompanionAppCtl()

function asyncCb(fn) {
  return (...args) => {
    fn(...args).catch(err => console.error(err))
  }
}

async function openInNonAppWindow(url) {
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
  if (nonAppWindowId) {
    await browser.windows.update(nonAppWindowId, { focused: true, state: 'normal' })
    console.log("Opening url in non-app window", { url, nonAppWindowId })
    const t = await browser.tabs.create({ url, windowId: nonAppWindowId })
    return { windowId: nonAppWindowId, tabId: t.id }
  } else {
    console.log("No non-app window found. Creating new one for", url)
    const w = await browser.windows.create({ url })
    return { windowId: w.id, tabId: w.tabs?.[0]?.id }
  }
}



browser.webNavigation.onBeforeNavigate.addListener(asyncCb(async details => {
  if (details.frameId !== 0) {
    return;  // ignore iframe navigations
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
    await Promise.all([cancelSourceNavigation(), toBeLaunchedAppItem.launch({ url: details.url })])
    setTimeout(() => companionAppCtl.postAppLauch(toBeLaunchedAppItem), 500)
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
  
    console.debug("Registering beforeunload listener",  details.url)
    await browser.tabs.executeScript(this.tabId, { code: `
        console.log('beforeunload listener injected by ${browser.runtime.getManifest().name} extension')
        window.addEventListener('beforeunload', () => 'bla bla')
    ` })
  } else {
    console.warn("Unexpected url in app tab after navigation completed. Navigate back to last active url", { appItem, details })
    await browser.tabs.update(appItem.tabId, { url: appItem.activeUrl })
  }
}))

// browser.tabs.onUpdated.addListener(asyncCb(async (tabId, changeInfo, tab) => {
//   if (changeInfo.status !== 'loading' || !changeInfo.url) {
//     return
//   }
//   console.debug('[DBG] tabs.onUpdated()', { tabId, changeInfo, tab })
//   const appItem = appsMgr.getApp({ url: tab.url })
//   if (!appItem) {
//     return
//   }
//   console.debug('appItem=', appItem)
//   if (appItem.tabId === tabId) {
//     console.debug('skip: update on existing app tab', { appId: appItem.id, tabId, changeInfo })
//     return
//   }
//   await appItem.launch({ tabId })
// }));


browser.windows.onRemoved.addListener((windowId) => {
  const appItem = appsMgr.getApp({ windowId: windowId })
  if (!appItem) {
    return
  }
  console.info("App window closed", { appId: appItem.id, windowId })
  appItem.unsetLaunchState()
  companionAppCtl.postAppClose(appItem.id);
})

browser.runtime.onStartup.addListener(asyncCb(async () => {
  console.info("onStartup - launchAllAutostartable()")
  await appsMgr.launchAllAutostartable()
}))


function dump() {
  (async () => {
    for (const a of appsMgr.apps.values()) {
      const w = a.isLaunched ? await browser.windows.get(a.windowId, { populate: true }) : null
      console.debug(`DUMP(${a.id})`, { _current: a._lauched, a, w })
    }
  })()
}