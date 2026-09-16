import { NextResponse } from "next/server";

const TESLA_FLEET_API =
  "https://fleet-api.prd.eu.vn.cloud.tesla.com";

const TESLA_AUTH =
  "https://fleet-auth.prd.vn.cloud.tesla.com";

const TESLA_DOMAIN =
  "home-energy-platform.vercel.app";

export async function GET() {
  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        success: false,
        error: "Tesla OAuth credentials are not configured",
      },
      { status: 500 }
    );
  }

  try {
    // Step 1: obtain a Tesla partner token
    const tokenResponse = await fetch(
      `${TESLA_AUTH}/oauth2/v3/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          audience: TESLA_FLEET_API,
          scope: "openid energy_device_data",
        }),
        cache: "no-store",
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();

      console.error(
        "Tesla partner token request failed:",
        tokenResponse.status,
        errorText
      );

      return NextResponse.json(
        {
          success: false,
          error: `Tesla partner token request failed with HTTP ${tokenResponse.status}`,
        },
        { status: 500 }
      );
    }

    const tokenData = await tokenResponse.json();
    const partnerToken = tokenData.access_token;

    if (!partnerToken) {
      throw new Error(
        "Tesla partner token response did not contain an access token"
      );
    }

    // Step 2: register our application/domain with Tesla
    const registerResponse = await fetch(
      `${TESLA_FLEET_API}/api/1/partner_accounts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${partnerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          domain: TESLA_DOMAIN,
        }),
        cache: "no-store",
      }
    );

    const responseText = await registerResponse.text();

    if (!registerResponse.ok) {
      console.error(
        "Tesla partner registration failed:",
        registerResponse.status,
        responseText
      );

      return NextResponse.json(
        {
          success: false,
          error: `Tesla partner registration failed with HTTP ${registerResponse.status}`,
        },
        { status: 500 }
      );
    }

    let registration = null;

    if (responseText) {
      try {
        registration = JSON.parse(responseText);
      } catch {
        registration = responseText;
      }
    }

    return NextResponse.json({
      success: true,
      message: "Tesla partner account registered successfully",
      registration,
    });
  } catch (error) {
    console.error("Tesla partner registration failed:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Tesla partner registration error",
      },
      { status: 500 }
    );
  }
}