import type { Site } from "./types";

export const currentSite: Site = {
    id: "home",
    name: "My Home",

    integrations: {
        kraken: {
            enabled: true,
        },

        homeAssistant: {
            enabled: true,
            assets: [{
                id: "powerwall-home",
                name: "Powerwall & Home",
                metrics: [
                    { entityId: "sensor.powerwall_192_168_68_74_charge", label: "Powerwall", unit: "%", decimals: 0 },
                    { entityId: "sensor.powerwall_192_168_68_74_solar_power", label: "Solar", unit: "kW", decimals: 2 },
                    { entityId: "sensor.powerwall_192_168_68_74_load_power", label: "House", unit: "kW", decimals: 2 },
                    { entityId: "sensor.powerwall_192_168_68_74_battery_power", label: "Battery", unit: "kW", decimals: 2 },
                    { entityId: "sensor.powerwall_192_168_68_74_site_power", label: "Grid", unit: "kW", decimals: 2 },
                ],
            }],
        },

        tesla: {
            enabled: true,
        },
    },

    constraints: {
        maxImportKw: 10,
        maxExportKw: 5,
    },
};