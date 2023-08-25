function uiBoostrap() {
  console.debug("[DBG] uiBoostrap()");

  var port = browser.runtime.connect({
    name: "popupPort",
  });

  port.postMessage({ type: "call", method: "getManagedApps" });
  Alpine.store("managedApps");
  port.onMessage.addListener((msg) => {
    console.debug("[DBG] port.onMessage", msg);
    if (msg["type"] == "return" && msg["method"] == "getManagedApps") {
      Alpine.store("managedApps", msg["data"]);
    }
  });

  Alpine.data("popup", () => ({
    async openConfigOptions() {
      try {
        browser.runtime.openOptionsPage();
      } catch (e) {
        console.error(e);
      }
    },

    async getContainerInfo(containerId) {
      return await tryGetContainer(containerId);
    },
  }));
}
