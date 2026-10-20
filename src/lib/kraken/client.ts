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
  let response: Response;
  try {
    response = await fetch(KRAKEN_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `JWT ${token}` } : {}),
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
  } catch {
    throw new Error("KRAKEN_TRANSPORT_FAILURE");
  }

  if (!response.ok) {
    throw new Error("KRAKEN_HTTP_FAILURE");
  }

  let result: GraphQLResponse<T>;
  try {
    result = await response.json() as GraphQLResponse<T>;
  } catch {
    throw new Error("KRAKEN_RESPONSE_INVALID");
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("KRAKEN_RESPONSE_INVALID");
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error("KRAKEN_GRAPHQL_REJECTED");
  }
  if (result.errors !== undefined && !Array.isArray(result.errors)) {
    throw new Error("KRAKEN_RESPONSE_INVALID");
  }

  if (!result.data) {
    throw new Error("KRAKEN_RESPONSE_INVALID");
  }

  return result.data;
}

export async function getKrakenToken(): Promise<string> {
  return obtainKrakenToken(captureKrakenAuthentication());
}

type KrakenAuthentication = { kind: "api-key"; apiKey: string }
  | { kind: "legacy-email-password"; email: string; password: string };
type KrakenReadConfiguration = KrakenAuthentication & { accountNumber: string; accountRef: string };
type KrakenExportReadConfiguration = KrakenAuthentication & { accountNumber: string; accountRef: string };

function captureKrakenAuthentication(): KrakenAuthentication {
  const apiKey = process.env.EON_KRAKEN_API_KEY;
  if (apiKey !== undefined) {
    if (!apiKey || apiKey !== apiKey.trim() || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new Error("KRAKEN_API_KEY_INVALID");
    }
    return { kind: "api-key", apiKey };
  }
  const email = process.env.EON_EMAIL;
  const password = process.env.EON_PASSWORD;

  if (!email || !password) {
    throw new Error("E.ON credentials are not configured");
  }
  return { kind: "legacy-email-password", email, password };
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

/** Opaque configured export-account identity; no credentials or raw account ID escape. */
export function getKrakenExportAccountReference(): string | null {
  const accountNumber = process.env.EON_EXPORT_ACCOUNT;
  return accountNumber
    ? createHash("sha256").update(`eon-account\0${accountNumber}`).digest("hex")
    : null;
}

function captureKrakenReadConfiguration(): KrakenReadConfiguration {
  return { ...captureKrakenAccount(), ...captureKrakenAuthentication() };
}

function captureKrakenExportConfiguration(authentication: KrakenAuthentication): KrakenExportReadConfiguration | null {
  const accountNumber = process.env.EON_EXPORT_ACCOUNT;
  if (!accountNumber) return null;
  return { ...authentication, accountNumber,
    accountRef: createHash("sha256").update(`eon-account\0${accountNumber}`).digest("hex") };
}

async function obtainKrakenToken(authentication: KrakenAuthentication): Promise<string> {
  const input = authentication.kind === "api-key"
    ? `APIKey: ${JSON.stringify(authentication.apiKey)}`
    : `email: ${JSON.stringify(authentication.email)}\n        password: ${JSON.stringify(authentication.password)}`;
  const query = `
  mutation {
    obtainKrakenToken(
      input: {
        ${input}
      }
    ) {
      token
    }
  }
`;

  const exchange = () => krakenGraphQL<{
    obtainKrakenToken: {
      token: string;
    };
  }>(query);

  if (authentication.kind === "legacy-email-password") {
    const data = await exchange();
    return data.obtainKrakenToken.token;
  }

  try {
    const data = await exchange();
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("KRAKEN_AUTH_RESPONSE_INVALID");
    const exchangeResult = Object.getOwnPropertyDescriptor(data, "obtainKrakenToken");
    if (!exchangeResult || !("value" in exchangeResult) || !exchangeResult.value
        || typeof exchangeResult.value !== "object" || Array.isArray(exchangeResult.value))
      throw new Error("KRAKEN_AUTH_RESPONSE_INVALID");
    const tokenResult = Object.getOwnPropertyDescriptor(exchangeResult.value, "token");
    if (!tokenResult || !("value" in tokenResult) || typeof tokenResult.value !== "string")
      throw new Error("KRAKEN_AUTH_RESPONSE_INVALID");
    const token = tokenResult.value;
    const segments = typeof token === "string" ? token.split(".") : [];
    const validCompactJwt = segments.length === 3 && segments.every((segment) =>
      segment.length > 0 && segment.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(segment));
    if (!validCompactJwt || token === authentication.apiKey
        || token !== token.trim() || /[\u0000-\u001f\u007f]/.test(token))
      throw new Error("KRAKEN_AUTH_TOKEN_INVALID");
    return token;
  } catch (error) {
    // Authentication responses can include provider-controlled text. Never let
    // credentials, response bodies or GraphQL details cross this boundary.
    const authFailureCodes = {
      KRAKEN_TRANSPORT_FAILURE: "KRAKEN_AUTH_TRANSPORT_FAILURE",
      KRAKEN_HTTP_FAILURE: "KRAKEN_AUTH_HTTP_FAILURE",
      KRAKEN_GRAPHQL_REJECTED: "KRAKEN_AUTH_GRAPHQL_REJECTED",
      KRAKEN_RESPONSE_INVALID: "KRAKEN_AUTH_RESPONSE_INVALID",
      KRAKEN_AUTH_RESPONSE_INVALID: "KRAKEN_AUTH_RESPONSE_INVALID",
      KRAKEN_AUTH_TOKEN_INVALID: "KRAKEN_AUTH_TOKEN_INVALID",
    } as const;
    let message: string | undefined;
    try {
      const descriptor = error instanceof Error
        ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
        message = descriptor.value;
    } catch {
      // Unsafe exception metadata is never exposed or used for classification.
    }
    const code = message !== undefined && Object.hasOwn(authFailureCodes, message)
      ? authFailureCodes[message as keyof typeof authFailureCodes] : undefined;
    throw new Error(code ?? "KRAKEN_AUTHENTICATION_FAILED");
  }
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

async function getKrakenDevicesFor(configuration: KrakenReadConfiguration, suppliedToken?: Promise<string>): Promise<KrakenDevice[]> {
  const token = await (suppliedToken ?? obtainKrakenToken(configuration));
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

async function getKrakenImportTariffFor(configuration: KrakenReadConfiguration, suppliedToken?: Promise<string>) {
  const token = await (suppliedToken ?? obtainKrakenToken(configuration));
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

async function getKrakenExportTariffFor(configuration: KrakenExportReadConfiguration, suppliedToken?: Promise<string>) {
  const token = await (suppliedToken ?? obtainKrakenToken(configuration));
  const data = await krakenGraphQL<{ account: { electricityAgreements: Array<Record<string, unknown>> } }>(`
    query {
      account(accountNumber: ${JSON.stringify(configuration.accountNumber)}) {
        electricityAgreements(active: true) {
          validFrom validTo isRevoked
          meterPoint { direction }
          tariff {
            __typename
            ... on StandardTariff {
              productCode tariffCode displayName fullName isExport unitRate preVatUnitRate
            }
          }
        }
      }
    }
  `, token);
  return { accountRef: configuration.accountRef, rateUnit: "p/kWh",
    electricityAgreements: data.account.electricityAgreements };
}

export async function getKrakenDevices(): Promise<KrakenDevice[]> {
  return getKrakenDevicesFor(captureKrakenReadConfiguration());
}

export type KrakenVehicleStatus = {
  currentState: string | null;
  isSuspended: boolean | null;
  stateOfCharge: {
    value: string | null;
  } | null;
  activePower: {
    value: string | null;
  } | null;
  stateOfChargeLimit: {
    value: number | null;
  } | null;
};

async function getKrakenVehicleStatusFor(
  deviceId: string, configuration: KrakenReadConfiguration, suppliedToken?: Promise<string>
): Promise<KrakenVehicleStatus> {
  const token = await (suppliedToken ?? obtainKrakenToken(configuration));
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
  deviceId: string, authentication: KrakenAuthentication, suppliedToken?: Promise<string>
): Promise<DispatchResponse & { deviceId: string }> {
  try {
    const token = await (suppliedToken ?? obtainKrakenToken(authentication));

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
  const exportConfiguration = captureKrakenExportConfiguration(configuration);
  // One lazy authentication exchange is shared by every read in this snapshot.
  const token = obtainKrakenToken(configuration);
  return Object.freeze({
    accountRef: configuration.accountRef,
    exportAccountRef: exportConfiguration?.accountRef ?? null,
    getDevices: () => getKrakenDevicesFor(configuration, token),
    getImportTariff: () => getKrakenImportTariffFor(configuration, token),
    getExportTariff: () => exportConfiguration
      ? getKrakenExportTariffFor(exportConfiguration, token)
      : Promise.reject(Error("E.ON export account is not configured")),
    getVehicleStatus: (deviceId: string) => getKrakenVehicleStatusFor(deviceId, configuration, token),
    getPlannedDispatchResponse: (deviceId: string) =>
      getKrakenPlannedDispatchResponseFor(deviceId, configuration, token),
    getHistoricalImportRates: async (period: { start: string; end: string }) => {
      const jwt = await token;
      const source = await krakenGraphQL<{ account: { electricityAgreements: Array<{ meterPoint?: { mpan?: unknown; direction?: unknown } }> } }>(`
        query { account(accountNumber: ${JSON.stringify(configuration.accountNumber)}) {
          electricityAgreements(active: true) { meterPoint { mpan direction } }
        } }
      `, jwt);
      const agreements = source.account.electricityAgreements;
      if (agreements.length !== 1 || agreements[0].meterPoint?.direction !== "IMPORT"
          || typeof agreements[0].meterPoint.mpan !== "string") throw Error("HISTORICAL_RATE_METER_POINT_UNAVAILABLE");
      const mpxn = agreements[0].meterPoint.mpan;
      type HistoricalEdge = { cursor: string; node: { value: unknown; validFrom: unknown; validTo: unknown } };
      type HistoricalConnection = { edges: HistoricalEdge[]; totalCount: number; edgeCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      const edges: HistoricalEdge[] = [];
      let after: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const response: { applicableRates: HistoricalConnection } = await krakenGraphQL<{ applicableRates: HistoricalConnection }>(`
          query { applicableRates(accountNumber: ${JSON.stringify(configuration.accountNumber)} mpxn: ${JSON.stringify(mpxn)}
            startAt: ${JSON.stringify(period.start)} endAt: ${JSON.stringify(period.end)} first: 100${after ? ` after: ${JSON.stringify(after)}` : ""}) {
            edges { cursor node { value validFrom validTo } }
            pageInfo { hasNextPage endCursor }
            totalCount edgeCount
          } }
        `, jwt);
        const connection: HistoricalConnection = response.applicableRates;
        if (!connection || !Array.isArray(connection.edges) || connection.edgeCount !== connection.edges.length
            || !Number.isInteger(connection.totalCount) || connection.totalCount < 0) throw Error("HISTORICAL_RATE_PAGINATION_INVALID");
        for (const edge of connection.edges) {
          if (typeof edge.cursor !== "string" || !edge.cursor || cursors.has(edge.cursor)) throw Error("HISTORICAL_RATE_CURSOR_INVALID");
          cursors.add(edge.cursor); edges.push(structuredClone(edge));
        }
        if (!connection.pageInfo.hasNextPage) {
          if (edges.length !== connection.totalCount) throw Error("HISTORICAL_RATE_PAGINATION_INCOMPLETE");
          return { accountRef: configuration.accountRef,
            meterPointRef: createHash("sha256").update(`eon-meter-point\0${mpxn}`).digest("hex"), complete: true, edges };
        }
        if (typeof connection.pageInfo.endCursor !== "string" || !connection.pageInfo.endCursor
            || connection.pageInfo.endCursor === after) throw Error("HISTORICAL_RATE_CURSOR_INVALID");
        after = connection.pageInfo.endCursor;
      }
      throw Error("HISTORICAL_RATE_PAGINATION_INCOMPLETE");
    },
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
