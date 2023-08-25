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
 * @returns {Promise<{apps: any[]}>}
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

class NativeClientCtl extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.connectionAttempt = 0;
    this._ensureConnected();
  }

  async _ensureConnected() {
    this.connectionAttempt++;
    let nativePort = browser.runtime.connectNative(this.id);
    this.nativePort = nativePort;
    nativePort.onDisconnect.addListener(() => {
      const retryAfterMs = 5000;
      this.nativePort = null;
      console.error("Disconnected from native port", nativePort.error, `Retrying after ${retryAfterMs}ms`);
      setTimeout(() => this._ensureConnected(), retryAfterMs);
    });
    nativePort.onMessage.addListener((msg) => {
      const type = msg["type"] ?? "<unknown>";
      console.debug("[DBG] Received message from native port %s | type: %s", this.id, type, msg);
      this.dispatchEvent(new CustomEvent(type, { detail: msg }));

      if (!nativePort.error) {
        // XXX: not enough to ensure native port is connected
        this.dispatchEvent(
          new CustomEvent("<connected>", {
            detail: { connectionAttempt: this.connectionAttempt, nativePort },
          })
        );
      }
    });
  }

  post(type, msg) {
    if (!this.nativePort) {
      console.warn("Native port %s not connected. Dropping message of type: %s", this.id, type, msg);
      return;
    }
    console.debug("[DBG] Posting message to native port %s | type:%s", this.id, type, msg);
    this.nativePort.postMessage({ type, ...msg });
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

const hashCode32 = (s) =>
  s.split("").reduce((a, b) => {
    a = (a << 5) - a + b.charCodeAt(0);
    return a & a;
  }, 0);
