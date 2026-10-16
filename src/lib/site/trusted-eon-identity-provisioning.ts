import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REFERENCE = /^[a-f0-9]{64}$/;
const ROOT_MARKER = ".hep-trusted-eon-identity-root";
const ROOT_MARKER_CONTENT = "HEP_TRUSTED_EON_IDENTITY_ROOT_V1\n";
const MPAN_WEIGHTS = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];
const timestamp = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
const reference = (domain: "eon-account" | "eon-meter-point", value: string) =>
    createHash("sha256").update(`${domain}\0${value}`).digest("hex");
const accountIdentifier = (value: unknown): value is string => typeof value === "string"
    && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);
const mpan = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{13}$/.test(value)) return false;
    const checksum = value.slice(0, 12).split("").reduce((sum, digit, index) =>
        sum + Number(digit) * MPAN_WEIGHTS[index], 0) % 11 % 10;
    return checksum === Number(value[12]);
};

export const eonAccountReference = (value: string) => {
    if (!accountIdentifier(value)) throw Error("TRUSTED_EON_ACCOUNT_IDENTIFIER_INVALID");
    return reference("eon-account", value);
};
export const eonMeterPointReference = (value: string) => {
    if (!mpan(value)) throw Error("TRUSTED_EON_MPAN_INVALID");
    return reference("eon-meter-point", value);
};

export type TrustedEonIdentityProvision = {
    version: 1;
    siteId: string;
    provisionedAt: string;
    confirmationMethod: "independent-operator-entry";
    import: { accountRef: string; meterPointRef: string };
    export: { accountRef: string; meterPointRef: string };
};

type RawIdentities = { importAccount: string; importMeterPoint: string; exportAccount: string; exportMeterPoint: string };

/** Creates an opaque provisioning record only when a separately entered operator
 * confirmation exactly matches the operational identifiers captured for the run. */
export function createTrustedEonIdentityProvision(input: {
    siteId: string;
    provisionedAt: string;
    operational: RawIdentities;
    independentlyConfirmed: RawIdentities;
}): TrustedEonIdentityProvision {
    if (!text(input.siteId) || !timestamp(input.provisionedAt)) throw Error("TRUSTED_EON_PROVISION_REQUEST_INVALID");
    const names: Array<keyof RawIdentities> = ["importAccount", "importMeterPoint", "exportAccount", "exportMeterPoint"];
    if (names.some(name => input.operational[name] !== input.independentlyConfirmed[name]))
        throw Error("TRUSTED_EON_OPERATOR_CONFIRMATION_MISMATCH");
    if (!accountIdentifier(input.operational.importAccount) || !accountIdentifier(input.operational.exportAccount))
        throw Error("TRUSTED_EON_ACCOUNT_IDENTIFIER_INVALID");
    if (!mpan(input.operational.importMeterPoint) || !mpan(input.operational.exportMeterPoint))
        throw Error("TRUSTED_EON_MPAN_INVALID");
    if (input.operational.importAccount === input.operational.exportAccount)
        throw Error("TRUSTED_EON_ACCOUNTS_NOT_DISTINCT");
    if (input.operational.importMeterPoint === input.operational.exportMeterPoint)
        throw Error("TRUSTED_EON_METER_POINTS_NOT_DISTINCT");
    return Object.freeze(structuredClone({ version: 1 as const, siteId: input.siteId,
        provisionedAt: input.provisionedAt, confirmationMethod: "independent-operator-entry" as const,
        import: { accountRef: eonAccountReference(input.operational.importAccount),
            meterPointRef: eonMeterPointReference(input.operational.importMeterPoint) },
        export: { accountRef: eonAccountReference(input.operational.exportAccount),
            meterPointRef: eonMeterPointReference(input.operational.exportMeterPoint) } }));
}

export function validateTrustedEonIdentityProvision(value: unknown): TrustedEonIdentityProvision {
    if (!object(value) || !exactKeys(value, ["version", "siteId", "provisionedAt", "confirmationMethod", "import", "export"])
        || value.version !== 1 || !text(value.siteId) || !timestamp(value.provisionedAt)
        || value.confirmationMethod !== "independent-operator-entry" || !object(value.import) || !object(value.export)
        || !exactKeys(value.import, ["accountRef", "meterPointRef"]) || !exactKeys(value.export, ["accountRef", "meterPointRef"]))
        throw Error("TRUSTED_EON_PROVISION_INVALID");
    const refs = [value.import.accountRef, value.import.meterPointRef, value.export.accountRef, value.export.meterPointRef];
    if (!refs.every(item => typeof item === "string" && REFERENCE.test(item))
        || value.import.accountRef === value.export.accountRef || value.import.meterPointRef === value.export.meterPointRef)
        throw Error("TRUSTED_EON_PROVISION_INVALID");
    return Object.freeze(structuredClone(value)) as TrustedEonIdentityProvision;
}

function approvedStorage(approvedRoot: string, file: string) {
    try {
        if (!path.isAbsolute(approvedRoot) || !path.isAbsolute(file)) throw Error("TRUSTED_EON_PROVISION_PATH_INVALID");
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        if (uid === null) throw Error("TRUSTED_EON_PROVISION_OWNERSHIP_UNAVAILABLE");
        const rootStat = fs.lstatSync(approvedRoot), canonicalRoot = fs.realpathSync(approvedRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonicalRoot !== approvedRoot)
            throw Error("TRUSTED_EON_PROVISION_ROOT_UNTRUSTED");
        if (rootStat.uid !== uid || (rootStat.mode & 0o777) !== 0o700)
            throw Error("TRUSTED_EON_PROVISION_DIRECTORY_PERMISSIONS_UNSAFE");
        const marker = path.join(approvedRoot, ROOT_MARKER), markerStat = fs.lstatSync(marker);
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== uid
            || (markerStat.mode & 0o777) !== 0o600
            || fs.readFileSync(marker, "utf8") !== ROOT_MARKER_CONTENT)
            throw Error("TRUSTED_EON_PROVISION_ROOT_UNAPPROVED");
        const directory = path.dirname(file), directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
            throw Error("TRUSTED_EON_PROVISION_DIRECTORY_UNTRUSTED");
        const relative = path.relative(approvedRoot, directory);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw Error("TRUSTED_EON_PROVISION_OUTSIDE_APPROVED_ROOT");
        const descendants = relative ? relative.split(path.sep) : [];
        let component = approvedRoot;
        for (const descendant of descendants) {
            component = path.join(component, descendant);
            const stat = fs.lstatSync(component);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
                throw Error("TRUSTED_EON_PROVISION_DIRECTORY_PERMISSIONS_UNSAFE");
        }
        for (let current = directory; ; current = path.dirname(current)) {
            try { fs.lstatSync(path.join(current, ".git"));
                throw Error("TRUSTED_EON_PROVISION_GIT_STORAGE_FORBIDDEN");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            if (current === path.parse(current).root) break;
        }
        return { directory };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("TRUSTED_EON_")) throw error;
        throw Error("TRUSTED_EON_PROVISION_PATH_UNAVAILABLE");
    }
}

/** Refuses replacement. The operator must separately approve and mark a private
 * root outside every Git repository before this function is called. */
export function writeTrustedEonIdentityProvision(approvedRoot: string, file: string,
    provision: TrustedEonIdentityProvision): void {
    const validated = validateTrustedEonIdentityProvision(provision);
    const { directory } = approvedStorage(approvedRoot, file);
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
    let descriptor: number | null = null;
    let createdTemporary = false;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o600);
        createdTemporary = true;
        fs.writeFileSync(descriptor, `${JSON.stringify(validated)}\n`, "utf8");
        fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = null;
        fs.linkSync(temporary, file);
        const directoryDescriptor = fs.openSync(directory, "r");
        try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
        if (createdTemporary) try { fs.unlinkSync(temporary); } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
    }
}

export function readTrustedEonIdentityProvision(approvedRoot: string, file: string): TrustedEonIdentityProvision {
    approvedStorage(approvedRoot, file);
    const stat = fs.lstatSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid
        || (stat.mode & 0o777) !== 0o600) throw Error("TRUSTED_EON_PROVISION_FILE_UNTRUSTED");
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw Error("TRUSTED_EON_PROVISION_JSON_INVALID"); }
    return validateTrustedEonIdentityProvision(parsed);
}

export function verifyProvisionedEonIdentities(provision: TrustedEonIdentityProvision, observed: {
    siteId: string;
    importAccountRef: string | null;
    importMeterPointRef: string | null;
    exportAccountRef: string | null;
    exportMeterPointRef: string | null;
}) {
    const expected = validateTrustedEonIdentityProvision(provision), blockers: string[] = [];
    if (observed.siteId !== expected.siteId) blockers.push("TRUSTED_EON_SITE_MISMATCH");
    if (observed.importAccountRef !== expected.import.accountRef) blockers.push("TRUSTED_EON_IMPORT_ACCOUNT_MISMATCH");
    if (observed.importMeterPointRef !== expected.import.meterPointRef) blockers.push("TRUSTED_EON_IMPORT_METER_POINT_MISMATCH");
    if (observed.exportAccountRef !== expected.export.accountRef) blockers.push("TRUSTED_EON_EXPORT_ACCOUNT_MISMATCH");
    if (observed.exportMeterPointRef === null) blockers.push("TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE");
    else if (observed.exportMeterPointRef !== expected.export.meterPointRef) blockers.push("TRUSTED_EON_EXPORT_METER_POINT_MISMATCH");
    return Object.freeze({ status: blockers.length ? "blocked" as const : "verified" as const,
        blockers: Object.freeze(blockers.sort()) });
}
