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