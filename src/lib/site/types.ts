import type { TelemetryBindings } from "../opportunity/home-assistant-input";
import type { ExportContext } from "../opportunity/types";
import type { TariffConfig } from "../tariff/types";
import type {
    SiteConstraints,
    SiteIntegrationConfig,
} from "./config";

export type Site = {
    id: string;
    name: string;
    integrations: SiteIntegrationConfig;
    constraints: SiteConstraints;
    tariff?: TariffConfig;
    opportunities?: { telemetry: TelemetryBindings; exportContext?: ExportContext };
};