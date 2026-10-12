import { parseDispatchResponse, requireCompleteDispatches, type DispatchResponse, type KrakenPlannedDispatch } from "./dispatch-response";
import { createHash } from "node:crypto";
export type { KrakenPlannedDispatch } from "./dispatch-response";

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
  return obtainKrakenToken(captureKrakenAuthentication());
}

type KrakenAuthentication = { email: string; password: string };
type KrakenReadConfiguration = KrakenAuthentication & { accountNumber: string; accountRef: string };

function captureKrakenAuthentication(): KrakenAuthentication {
  const email = process.env.EON_EMAIL;
  const password = process.env.EON_PASSWORD;

  if (!email || !password) {
    throw new Error("E.ON credentials are not configured");
  }
  return { email, password };
}

function captureKrakenAccount(): Pick<KrakenReadConfiguration, "accountNumber" | "accountRef"> {
  const accountNumber = process.env.EON_ACCOUNT;
  if (!accountNumber) throw new Error("E.ON account number is not configured");
  return { accountNumber,
    accountRef: createHash("sha256").update(`eon-account\0${accountNumber}`).digest("hex") };
}

/** Stable, opaque schedule scope identity which does not require credentials. */
export function getKrakenAccountReference(): string {
  return captureKrakenAccount().accountRef;
}

function captureKrakenReadConfiguration(): KrakenReadConfiguration {
  return { ...captureKrakenAccount(), ...captureKrakenAuthentication() };
}

async function obtainKrakenToken({ email, password }: KrakenAuthentication): Promise<string> {
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

  preferenceSetting: {
    scheduleSettings: Array<{
      timeFrom: string | null;
      timeTo: string | null;
      timeStep: number;
      min: string | null;
      max: string | null;
      step: string;
    }>;
  } | null;
};

async function getKrakenDevicesFor(configuration: KrakenReadConfiguration): Promise<KrakenDevice[]> {
  const token = await obtainKrakenToken(configuration);
  const { accountNumber } = configuration;

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

        preferenceSetting {
          ... on FlexDevicePreferenceSetting {
            scheduleSettings {
              ... on FlexDevicePreferenceScheduleSetting {
                timeFrom
                timeTo
                timeStep
                min
                max
                step
              }
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

async function getKrakenImportTariffFor(configuration: KrakenReadConfiguration) {
  const token = await obtainKrakenToken(configuration);
  const data = await krakenGraphQL<{ account: { electricityAgreements: Array<Record<string, unknown>> } }>(`
    query {
      account(accountNumber: ${JSON.stringify(configuration.accountNumber)}) {
        electricityAgreements(active: true) {
          validFrom validTo ratesAgreedAt isRevoked
          meterPoint { mpan direction }
          tariff {
            __typename
            ... on HalfHourlyTariff {
              productCode tariffCode displayName fullName isExport
              standingCharge preVatStandingCharge
              unitRates { validFrom validTo value preVatValue rateType }
            }
          }
        }
      }
    }
  `, token);
  const electricityAgreements = data.account.electricityAgreements.map(agreement => {
    const meterPoint = agreement.meterPoint as { mpan?: unknown; direction?: unknown } | undefined;
    if (typeof meterPoint?.mpan !== "string" || typeof meterPoint.direction !== "string") return agreement;
    return { ...agreement, meterPoint: { direction: meterPoint.direction,
      meterPointRef: createHash("sha256").update(`eon-meter-point\0${meterPoint.mpan}`).digest("hex") } };
  });
  return { accountRef: configuration.accountRef, electricityAgreements };
}

export async function getKrakenDevices(): Promise<KrakenDevice[]> {
  return getKrakenDevicesFor(captureKrakenReadConfiguration());
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

async function getKrakenVehicleStatusFor(
  deviceId: string, configuration: KrakenReadConfiguration
): Promise<KrakenVehicleStatus> {
  const token = await obtainKrakenToken(configuration);
  const { accountNumber } = configuration;

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

export async function getKrakenVehicleStatus(deviceId: string): Promise<KrakenVehicleStatus> {
  return getKrakenVehicleStatusFor(deviceId, captureKrakenReadConfiguration());
}
// Existing consumers receive an array only after a complete validated response.
export async function getKrakenPlannedDispatches(deviceId: string): Promise<KrakenPlannedDispatch[]> {
  return requireCompleteDispatches(await getKrakenPlannedDispatchResponse(deviceId));
}

export async function getKrakenPlannedDispatchResponse(deviceId: string): Promise<DispatchResponse & { deviceId: string }> {
  try {
    return await getKrakenPlannedDispatchResponseFor(deviceId, captureKrakenAuthentication());
  } catch {
    return { status: "failed", code: "DISPATCH_RETRIEVAL_FAILED", deviceId };
  }
}

async function getKrakenPlannedDispatchResponseFor(
  deviceId: string, authentication: KrakenAuthentication
): Promise<DispatchResponse & { deviceId: string }> {
  try {
    const token = await obtainKrakenToken(authentication);

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

    const data = await krakenGraphQL<unknown>(query, token);
    return { ...parseDispatchResponse(data), deviceId };
  } catch {
    return { status: "failed", code: "DISPATCH_RETRIEVAL_FAILED", deviceId };
  }
}

/** One captured account/authentication context for a complete schedule refresh.
 * Raw account identity and credentials remain closed over and are never returned. */
export function createKrakenReadSession() {
  const configuration = captureKrakenReadConfiguration();
  return Object.freeze({
    accountRef: configuration.accountRef,
    getDevices: () => getKrakenDevicesFor(configuration),
    getImportTariff: () => getKrakenImportTariffFor(configuration),
    getVehicleStatus: (deviceId: string) => getKrakenVehicleStatusFor(deviceId, configuration),
    getPlannedDispatchResponse: (deviceId: string) =>
      getKrakenPlannedDispatchResponseFor(deviceId, configuration),
  });
}

export type KrakenPreferenceSchedule = {
  dayOfWeek: string;
  time: string;
  min: number | null;
  max: number;
};

export async function setKrakenVehiclePreferences(
  deviceId: string,
  schedules: KrakenPreferenceSchedule[]
) {
  const token = await getKrakenToken();

  const scheduleInput = schedules
    .map(
      (schedule) => `{
        dayOfWeek: ${schedule.dayOfWeek}
        time: "${schedule.time}"
        ${schedule.min !== null
          ? `min: ${schedule.min}`
          : ""
        }
        max: ${schedule.max}
      }`
    )
    .join("\n");

  const query = `
    mutation {
      setDevicePreferences(
        input: {
          deviceId: ${JSON.stringify(deviceId)}
          mode: CHARGE
          unit: PERCENTAGE
          schedules: [
            ${scheduleInput}
          ]
        }
      ) {
        __typename
      }
    }
  `;

  return krakenGraphQL(query, token);
}
