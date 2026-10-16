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
        importTariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string };
        exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string };
        fixedExportAssumption?: {
            provider: "eon-next";
            tariff: "Export Premium v3";
            price: EnergyPrice;
        };
    };

    homeAssistant: {
        enabled: boolean;
        assets?: HomeEnergyAssetConfig[];
        financialEnergy?: { gridImportEntityId: string; gridExportEntityId: string };
    };

    tesla: {
        enabled: boolean;
        energySiteId?: string;
    };
};

export type SiteConstraints = {
    maxImportKw: number | null;
    maxExportKw: number | null;
};
