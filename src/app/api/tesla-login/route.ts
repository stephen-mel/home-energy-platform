import { issueTeslaOAuthState, TESLA_STATE_COOKIE } from "../../../lib/tesla/oauth-state";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const clientId = process.env.TESLA_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "TESLA_CLIENT_ID is not configured" },
      { status: 500 }
    );
  }

  const challenge = issueTeslaOAuthState();
  const params = new URLSearchParams({
    client_id: clientId,
    locale: "en-GB",
    prompt: "login",
    redirect_uri: "http://localhost:3000/api/tesla/callback",
    response_type: "code",
    scope: "openid offline_access energy_device_data energy_cmds",
    prompt_missing_scopes: "true",
    state: challenge.state,
  });

  const response = NextResponse.redirect(
    `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`
  );
  response.cookies.set(TESLA_STATE_COOKIE, challenge.binding, {
    httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:",
    path: "/api/tesla", maxAge: challenge.maxAge,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}