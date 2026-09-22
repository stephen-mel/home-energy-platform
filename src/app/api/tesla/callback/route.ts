import { consumeTeslaOAuthState, TESLA_STATE_COOKIE } from "../../../../lib/tesla/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";

export async function GET(request: NextRequest) {
  if (!consumeTeslaOAuthState(request.nextUrl.searchParams.get("state"), request.cookies.get(TESLA_STATE_COOKIE)?.value)) {
    return NextResponse.json({ success: false, error: "Invalid or expired OAuth state" }, { status: 400 });
  }
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.json(
      { success: false, error: "Tesla authorization was not completed" },
      { status: 400 }
    );
  }

  if (!code) {
    return NextResponse.json(
      {
        success: false,
        error: "No authorization code received from Tesla",
      },
      { status: 400 }
    );
  }

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
    const response = await fetch(
      "https://auth.tesla.com/oauth2/v3/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: "http://localhost:3000/api/tesla/callback",
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `Tesla token exchange failed with HTTP ${response.status}`,
        },
        { status: 500 }
      );
    }

    const tokens = await response.json();

    const tokenFile = path.join(
      process.cwd(),
      ".tesla-tokens.json"
    );

    await writeFile(
      tokenFile,
      JSON.stringify(
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          created_at: Date.now(),
        },
        null,
        2
      ),
      "utf8"
    );


    return NextResponse.json({
      success: true,
      message: "Tesla OAuth connection successful and tokens saved",
      hasAccessToken: Boolean(tokens.access_token),
      hasRefreshToken: Boolean(tokens.refresh_token),
      expiresIn: tokens.expires_in ?? null,
    });
  } catch {
    return NextResponse.json({ success: false, error: "Tesla OAuth callback failed" }, { status: 500 });
  }
}
