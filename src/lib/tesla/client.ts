import { readFile } from "fs/promises";
import path from "path";

type TeslaTokens = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    created_at: number;
};

async function getTeslaTokens(): Promise<TeslaTokens> {
    const tokenFile = path.join(
        process.cwd(),
        ".tesla-tokens.json"
    );

    const contents = await readFile(tokenFile, "utf8");
    return JSON.parse(contents) as TeslaTokens;
}

export async function getTeslaProducts() {
    const tokens = await getTeslaTokens();

    const response = await fetch(
        "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/products",
        {
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
            },
            cache: "no-store",
        }
    );

    if (!response.ok) {
        const errorText = await response.text();

        console.error(
            "Tesla Fleet API products request failed:",
            response.status,
            errorText
        );

        throw new Error(
            `Tesla Fleet API HTTP error ${response.status}`
        );
    }

    return response.json();
}