function uiBoostrap() {
    console.debug("uiBoostrap()")

    Alpine.store('config', {})

    getConfig().then((config) => {
        if (config) {
            console.debug("Setting Alpine.store('config')", config)
            Alpine.store('config', config)
        }
    })

    Alpine.data('configForm', () => ({
        errorMsg: "",
        successMsg: "",

        showError(msg) {
            this.errorMsg = msg;
            this.successMsg = "";
        },
        showSuccess(msg) {
            this.errorMsg = "";
            this.successMsg = msg;
        },
        handleSubmit() {
            console.log("submitConfigForm()")
            const apps = Alpine.store('config').apps
            for (const a of apps) {
                if (apps.filter(app => app.id === a.id).length > 1) {
                    this.showError("Found duplicate app id: " + a.id)
                    return
                }
                if (!a.id || !a.label || !a.match || !a.url) {
                    this.showError("Found incomplete config!")
                    return
                }
                if (!/^\w+$/.test(a.id)) {
                    this.showError("Invalid app id: " + a.id + "  (Should only contain lowercase alphanumeric characters)")
                    return
                }
                try {
                    new RegExp(a.match)
                } catch (e) {
                    this.showError("Invalid regex: " + a.match + " " + e)
                    return
                }
            }
            saveConfig({ apps }).then(() => {
                this.showSuccess("Saved!")
                apps.forEach(a => {
                    delete a._unsaved
                })
            })
        },
        addAppItem() {
            console.log("addAppItem()")
            const apps = Alpine.store('config').apps
            if (apps.find(a => !a.id)) {
                return
            }
            apps.push({ id: '', enabled: true, _unsaved: true })
        },
        deleteAppItem(item) {
            console.log("deleteItem()", item)
            Alpine.store('config').apps = Alpine.store('config').apps.filter((app) => app.id !== item.id)
        }
    }))
}
