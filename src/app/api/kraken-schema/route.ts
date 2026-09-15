import { getKrakenToken } from "../../../lib/kraken/client";

const KRAKEN_GRAPHQL_URL =
    "https://api.eonnext-kraken.energy/v1/graphql/";

export async function GET() {
    try {
        const token = await getKrakenToken();

        const query = `
  query {
    __type(name: "SmartFlexDispatch") {
      name
      kind
      fields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
`;

        const response = await fetch(KRAKEN_GRAPHQL_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `JWT ${token}`,
            },
            body: JSON.stringify({ query }),
            cache: "no-store",
        });

        const data = await response.json();

        return Response.json(data);
    } catch (error) {
        console.error("Kraken schema request failed:", error);

        return Response.json(
            {
                success: false,
                message:
                    error instanceof Error ? error.message : "Unknown Kraken error",
            },
            { status: 500 }
        );
    }
}