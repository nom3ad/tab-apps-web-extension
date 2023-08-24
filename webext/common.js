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
    console.log("get(config)", c)
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