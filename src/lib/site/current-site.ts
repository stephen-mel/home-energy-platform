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