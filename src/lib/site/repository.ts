import type { Site } from "./types";
import { currentSite } from "./current-site";

export async function getCurrentSite(): Promise<Site> {
    return currentSite;
}