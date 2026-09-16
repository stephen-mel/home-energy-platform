import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.TESLA_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "TESLA_CLIENT_ID is not configured" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    locale: "en-GB",
    prompt: "login",
    redirect_uri: "http://localhost:3000/api/tesla/callback",
    response_type: "code",
    scope: "openid offline_access energy_device_data",
    state: crypto.randomUUID(),
  });

  return NextResponse.redirect(
    `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`
  );
}