function uiBoostrap() {
    console.debug("uiBoostrap()")

    var port = browser.runtime.connect({
        name: "popupPort"
    });

    port.postMessage({ type: "call", method: "getManagedApps" });

    Alpine.store('managedApps')
    port.onMessage.addListener(function (msg) {
        console.log("port.onMessage", msg)
        if (msg.type == "return" && msg.method == "getManagedApps") {
            Alpine.store('managedApps', msg.data)
        }
    });

    Alpine.data("popup", () => ({
        async openConfigOptions() {
            try {
                browser.runtime.openOptionsPage()
            } catch (e) {
                console.error(e)
            }
        },
        async getManagedApps() {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return browser.runtime.getBackgroundPage().asyncCb()
        },
    }))
}

