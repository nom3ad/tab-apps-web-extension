const SAMPLE_APPS = [
  {
    id: "example",
    enabled: false,
    label: "Example",
    autostart: false,
    match: "^https?://example\\.com",
    url: "https://example.com",
    icon: "",
  },
];

/**
 * @returns {Promise<{apps: Foobar[]}>}
 */
async function getConfig() {
  const c = await browser.storage.sync.get(["apps"]);
  console.debug("[DBG] get(config)", c);
  if (!c.apps?.length) {
    console.log("No apps defined. Using default sample apps");
    c.apps = SAMPLE_APPS;
  }
  return { apps: c.apps ?? [] };
}

async function saveConfig({ apps }) {
  apps = JSON.parse(JSON.stringify(apps));
  console.log("Saving config", { apps });
  await browser.storage.sync.set({
    apps,
  });
}

async function resetDefault() {
  await saveConfig({
    apps: SAMPLE_APPS,
  });
}

class NativeAppCtl extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this._ensureConnected();
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
    companionAppNativePort.onMessage.addListener((msg) => {
      console.debug("[DBG] Received message from native app: ", msg);
      this.dispatchEvent(new CustomEvent(msg["type"] ?? "<unknown>", { detail: msg }));
    });
  }

  post(type, msg) {
    if (!this.companionAppNativePort) {
      console.warn("Companion app not connected. Dropping message type=%s", msg);
      return;
    }
    console.debug("[DBG] Posting message to companion app: type=%s", type, msg);
    this.companionAppNativePort.postMessage({ type, ...msg });
  }
}

class RichPromise extends Promise {
  constructor(executor, timeoutMs = 0) {
    let _resolve, _reject;
    super((resolve, reject) => {
      _resolve = (value) => {
        this._settledTime = Date.now();
        resolve(value);
      };
      _reject = (reason) => {
        this._settledTime = Date.now();
        reject(reason);
      };
      executor?.(_resolve, _reject);
    });
    this._startTime = Date.now();
    if (timeoutMs) {
      this._timeoutRef = setTimeout(() => _reject(`timeout after ${timeoutMs}ms`), timeoutMs);
    }
    this._resolve = _resolve;
    this._reject = _reject;
  }
  resolve(value) {
    console.info("RichPromise::resolve", this);
    this._timeoutRef && clearTimeout(this._timeoutRef);
    this._resolve(value);
  }

  reject(reason) {
    console.info("RichPromise::reject", this);
    this._timeoutRef && clearTimeout(this._timeoutRef);
    this._reject(reason);
  }

  isSettled() {
    return !!this._settledTime;
  }

  elapsed() {
    return (this._settledTime ?? Date.now()) - this._startTime;
  }
}
