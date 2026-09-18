export type SiteIntegrationConfig = {
    kraken: {
        enabled: boolean;
    };

    homeAssistant: {
        enabled: boolean;
    };

    tesla: {
        enabled: boolean;
    };
};

export type SiteConstraints = {
    maxImportKw: number | null;
    maxExportKw: number | null;
};