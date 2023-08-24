const SAMPLE_APPS = [
  {
    id: 'example',
    enabled: false,
    label: 'Example',
    autostart: false,
    match: '^https?://example\\.com',
    url: 'https://example.com',
    icon: '',
  }
]


/**
 * @returns {Promise<{apps: any[]}>}
 */
async function getConfig() {
  const c = (await browser.storage.sync.get(["apps"]))
  console.debug("get(config)", c)
  if (!c.apps?.length) {
    console.log("No apps defined. Using default sample apps")
    c.apps = SAMPLE_APPS
  }
  return c
}


async function saveConfig({ apps }) {
  apps = JSON.parse(JSON.stringify(apps))
  console.log("Saving config", { apps })
  await browser.storage.sync.set({
    apps,
  });
}

async function resetDefault() {
  await saveConfig({
    apps: SAMPLE_APPS
  })
}

class NativeAppCtl extends EventTarget {

  constructor(id) {
    super()
    this.id = id
    this._ensureConnected()
  }

  async _ensureConnected() {
    let companionAppNativePort = browser.runtime.connectNative(this.id);
    this.companionAppNativePort = companionAppNativePort;
    companionAppNativePort.onDisconnect.addListener(() => {
      const retryAfterMs = 5000;
      this.companionAppNativePort = null;
      console.error("Disconnected from native app", companionAppNativePort.error, `Retrying after ${retryAfterMs}ms`);
      setTimeout(() => this._ensureConnected(), retryAfterMs);
    });
    companionAppNativePort.onMessage.addListener(msg => {
      console.debug("Received message from native app: ", msg);
      this.dispatchEvent(new CustomEvent(msg.type ?? "<unknown>", { detail: msg }));
    });
  }

  post(type, event) {
    if (!this.companionAppNativePort) {
      console.warn("Companion app not connected. Dropping message", msg)
      return
    }
    console.debug("Posting message to companion app: type=%s", type, event);
    this.companionAppNativePort.postMessage({ type, ...event });
  }
}