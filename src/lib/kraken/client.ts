const KRAKEN_GRAPHQL_URL =
  "https://api.eonnext-kraken.energy/v1/graphql/";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

async function krakenGraphQL<T>(
  query: string,
  token?: string
): Promise<T> {
  const response = await fetch(KRAKEN_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `JWT ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Kraken HTTP error: ${response.status}`);
  }

  const result: GraphQLResponse<T> = await response.json();

  if (result.errors?.length) {
    throw new Error(
      `Kraken GraphQL error: ${result.errors
        .map((error) => error.message)
        .join(", ")}`
    );
  }

  if (!result.data) {
    throw new Error("Kraken returned no data");
  }

  return result.data;
}

export async function getKrakenToken(): Promise<string> {
  const email = process.env.EON_EMAIL;
  const password = process.env.EON_PASSWORD;

  if (!email || !password) {
    throw new Error("E.ON credentials are not configured");
  }

  const query = `
    mutation {
      obtainKrakenToken(
        input: {
          email: ${JSON.stringify(email)}
          password: ${JSON.stringify(password)}
        }
      ) {
        token
      }
    }
  `;

  const data = await krakenGraphQL<{
    obtainKrakenToken: {
      token: string;
    };
  }>(query);

  return data.obtainKrakenToken.token;
}