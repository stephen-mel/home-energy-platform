import type { EnergyPrice } from "../tariff/types";

export type HomeEnergyAssetConfig = {
    id: string;
    name: string;
    metrics: Array<{
        entityId: string;
        label: string;
        unit: string;
        decimals: number;
        normalization?: "powerwall-display-soc";
    }>;
};

export type SiteIntegrationConfig = {
    kraken: {
        enabled: boolean;
        wholeHomeDispatchRate?: { enabled: boolean; importPrice: EnergyPrice | null };
    };

    homeAssistant: {
        enabled: boolean;
        assets?: HomeEnergyAssetConfig[];
    };

    tesla: {
        enabled: boolean;
    };
};

export type SiteConstraints = {
    maxImportKw: number | null;
    maxExportKw: number | null;
};