import type { Site } from "./types";

export const currentSite: Site = {
    id: "home",
    name: "My Home",

    integrations: {
        kraken: {
            enabled: true,
            wholeHomeDispatchRate: { enabled: true, importPrice: null },
        },

        homeAssistant: {
            enabled: true,
            assets: [{
                id: "powerwall-home",
                name: "Powerwall & Home",
                metrics: [
                    { entityId: "sensor.powerwall_192_168_68_74_charge", label: "Powerwall", unit: "%", decimals: 0, normalization: "powerwall-display-soc" },
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

    tariff: {
        timeZone: "Europe/London",
        normalImport: null,
        export: null,
        versions: [{
            id: "eon-next-drive-smart-v5.2",
            name: "E.ON Next Drive Smart V5.2 (VAT inclusive)",
            provider: "eon-next",
            // Prototype validity: known as of 22 September; October rates unknown.
            effectiveFrom: "2026-09-22T00:00:00+01:00",
            effectiveTo: "2026-10-01T00:00:00+01:00",
            pricesIncludeVat: true,
            normalImport: { amount: 0.2518, currency: "GBP", unit: "kWh" },
            export: { amount: 0.175, currency: "GBP", unit: "kWh" },
            scheduledChargingImport: { amount: 0.0299, currency: "GBP", unit: "kWh" },
            standingCharge: { amount: 0.60, currency: "GBP", unit: "day" },
            dailyImportWindows: [{
                start: "00:00", end: "06:00", kind: "guaranteed-off-peak",
                price: { amount: 0.0299, currency: "GBP", unit: "kWh" },
            }],
        }],
    },

    opportunities: {
        // HA Powerwall convention: grid negative = export; battery negative =
        // energy into storage. Map explicitly into the engine's identical signs.
        telemetry: {
            solarKw: { assetId: "powerwall-home", entityId: "sensor.powerwall_192_168_68_74_solar_power", multiplier: 1 },
            houseLoadKw: { assetId: "powerwall-home", entityId: "sensor.powerwall_192_168_68_74_load_power", multiplier: 1 },
            gridImportKw: { assetId: "powerwall-home", entityId: "sensor.powerwall_192_168_68_74_site_power", multiplier: 1 },
            batteries: [{
                id: "powerwall-home", name: "Powerwall",
                socPercent: { assetId: "powerwall-home", entityId: "sensor.powerwall_192_168_68_74_charge" },
                powerToHomeKw: { assetId: "powerwall-home", entityId: "sensor.powerwall_192_168_68_74_battery_power", multiplier: 1 },
            }],
        },
        exportContext: { capability: "unknown", actualTariff: { status: "unknown", price: null }, economicValue: { kind: "signal" } },
    },

    constraints: {
        maxImportKw: 10,
        maxExportKw: 5,
    },
};