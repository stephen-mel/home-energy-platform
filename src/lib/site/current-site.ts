import type { Site } from "./types";

export const currentSite: Site = {
    id: "home",
    name: "My Home",

    integrations: {
        kraken: {
            enabled: true,
            wholeHomeDispatchRate: { enabled: true, importPrice: null },
            importTariffIdentity: {
                tariffCode: "E-TOU-NEXT_DRIVE_SMART_V5_2-G",
                meterPointRef: "45ee067bfe464f8f50729df68fbe962c6837d98db03443e7b7648de2bb70e0f9",
            },
            exportTariffIdentity: {
                accountRef: "1b64b91bc669c17f9f5b4d0bd31560fe521f5b51a07e24812a692badfd5106fe",
                productCode: "NEXT_EXPORT_PREMIUM_V3",
                tariffCode: "E-1R-NEXT_EXPORT_PREMIUM_V3-G",
            },
            fixedExportAssumption: {
                provider: "eon-next",
                tariff: "Export Premium v3",
                price: { amount: 0.175, currency: "GBP", unit: "kWh" },
                validFrom: "2026-10-23T00:00:00+01:00",
                validTo: "2027-12-01T00:00:00Z",
                confirmedAt: "2026-10-23T00:00:00+01:00",
            },
        },

        homeAssistant: {
            enabled: true,
            financialEnergy: {
                gridImportEntityId: "sensor.powerwall_192_168_68_74_site_import",
                gridExportEntityId: "sensor.powerwall_192_168_68_74_site_export",
            },
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
            energySiteId: "1689589307992591",
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
