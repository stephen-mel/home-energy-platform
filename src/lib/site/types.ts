import type {
    SiteConstraints,
    SiteIntegrationConfig,
} from "./config";

export type Site = {
    id: string;
    name: string;
    integrations: SiteIntegrationConfig;
    constraints: SiteConstraints;
};