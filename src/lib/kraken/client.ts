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
    const errorBody = await response.text();
    throw new Error(`Kraken HTTP error ${response.status}: ${errorBody}`);
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
export type KrakenDevice = {
  id: string;
  name: string;
  deviceType: string;
  provider: string;
  vehicleBatterySize: string | null;
  chargePointPowerOutput: string | null;
  preferences: {
    schedules: Array<{
      dayOfWeek: string;
      time: string;
      min: number | null;
      max: number | null;
      upperLimit: number | null;
    }>;
  } | null;
};

export async function getKrakenDevices(): Promise<KrakenDevice[]> {
  const token = await getKrakenToken();

  const accountNumber = process.env.EON_ACCOUNT;

  if (!accountNumber) {
    throw new Error("E.ON account number is not configured");
  }

  const query = `
  query {
    devices(accountNumber: ${JSON.stringify(accountNumber)}) {
      id
      name
      deviceType
      provider
      ... on SmartFlexVehicle {
        vehicleBatterySize
        chargePointPowerOutput
        preferences {
          ... on SmartFlexDevicePreferences {
            schedules {
              dayOfWeek
              time
              min
              max
              upperLimit
            }
          }
        }
      }
    }
  }
`;

  const data = await krakenGraphQL<{
    devices: KrakenDevice[];
  }>(query, token);

  return data.devices;
}

export type KrakenVehicleStatus = {
  currentState: string | null;
  isSuspended: boolean | null;
  stateOfCharge: {
    value: number | null;
  } | null;
  activePower: {
    value: number | null;
  } | null;
  stateOfChargeLimit: {
    value: number | null;
  } | null;
};

export async function getKrakenVehicleStatus(
  deviceId: string
): Promise<KrakenVehicleStatus> {
  const token = await getKrakenToken();

  const accountNumber = process.env.EON_ACCOUNT;

  if (!accountNumber) {
    throw new Error("E.ON account number is not configured");
  }

  const query = `
  query {
    devices(
      accountNumber: ${JSON.stringify(accountNumber)}
      deviceId: ${JSON.stringify(deviceId)}
    ) {
      status {
        currentState
        isSuspended
        ... on SmartFlexVehicleStatus {
          stateOfCharge {
            value
          }
          activePower {
            value
          }
          stateOfChargeLimit {
            __typename
          }
        }
      }
    }
  }
`;

  const data = await krakenGraphQL<{
    devices: Array<{
      status: KrakenVehicleStatus;
    }>;
  }>(query, token);

  const device = data.devices[0];

  if (!device) {
    throw new Error(`Kraken returned no device for ${deviceId}`);
  }

  return device.status;
}
export type KrakenPlannedDispatch = {
  start: string;
  end: string;
  type: string;
  energyAddedKwh: string | null;
};

export async function getKrakenPlannedDispatches(
  deviceId: string
): Promise<KrakenPlannedDispatch[]> {
  const token = await getKrakenToken();

  const query = `
    query {
      flexPlannedDispatches(deviceId: ${JSON.stringify(deviceId)}) {
        start
        end
        type
        energyAddedKwh
      }
    }
  `;

  const data = await krakenGraphQL<{
    flexPlannedDispatches: KrakenPlannedDispatch[];
  }>(query, token);

  return data.flexPlannedDispatches ?? [];
}