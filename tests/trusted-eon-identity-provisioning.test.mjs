import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as crypto from "node:crypto";

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/site/trusted-eon-identity-provisioning.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { exports, structuredClone, Object, Date, JSON, Error, process, require(name) {
  if (name === "server-only") return {};
  if (name === "node:crypto") return crypto;
  if (name === "node:fs") return fs;
  if (name === "node:path") return path;
  throw Error(name);
} });

const raw = { importAccount: "A-IMPORT-001", importMeterPoint: "1000000000012",
  exportAccount: "A-EXPORT-002", exportMeterPoint: "2000000000015" };
const create = (changes = {}) => exports.createTrustedEonIdentityProvision({ siteId: "home",
  provisionedAt: "2026-10-16T10:00:00.000Z", operational: { ...raw, ...(changes.operational ?? {}) },
  independentlyConfirmed: { ...raw, ...(changes.confirmed ?? {}) } });
const observed = provision => ({ siteId: "home", importAccountRef: provision.import.accountRef,
  importMeterPointRef: provision.import.meterPointRef, exportAccountRef: provision.export.accountRef,
  exportMeterPointRef: provision.export.meterPointRef });

test("uses the existing domain-separated account and meter-point references", () => {
  const provision = create();
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(provision.import.accountRef, hash(`eon-account\0${raw.importAccount}`));
  assert.equal(provision.export.accountRef, hash(`eon-account\0${raw.exportAccount}`));
  assert.equal(provision.import.meterPointRef, hash(`eon-meter-point\0${raw.importMeterPoint}`));
  assert.equal(provision.export.meterPointRef, hash(`eon-meter-point\0${raw.exportMeterPoint}`));
  for (const secret of Object.values(raw)) assert.ok(!JSON.stringify(provision).includes(secret));
});

test("requires independent exact operator confirmation and distinct household identities", () => {
  assert.throws(() => create({ confirmed: { importAccount: "other" } }), /OPERATOR_CONFIRMATION_MISMATCH/);
  assert.throws(() => create({ operational: { exportAccount: raw.importAccount }, confirmed: { exportAccount: raw.importAccount } }), /ACCOUNTS_NOT_DISTINCT/);
  assert.throws(() => create({ operational: { exportMeterPoint: raw.importMeterPoint }, confirmed: { exportMeterPoint: raw.importMeterPoint } }), /METER_POINTS_NOT_DISTINCT/);
});

test("rejects padded or malformed accounts and invalid MPAN syntax/checksums", () => {
  for (const account of [" ", ` ${raw.importAccount}`, `${raw.importAccount} `, "account_name", "account/one", "account\n"])
    assert.throws(() => create({ operational: { importAccount: account }, confirmed: { importAccount: account } }), /ACCOUNT_IDENTIFIER_INVALID/);
  for (const meterPoint of ["", "123", "1000000000019", "0000000000016", " 1000000000012", "1000000000012 ", "100000000001A"])
    assert.throws(() => create({ operational: { importMeterPoint: meterPoint }, confirmed: { importMeterPoint: meterPoint } }), /MPAN_INVALID/);
  const leadingZero = "0000000000010";
  const provision = create({ operational: { importMeterPoint: leadingZero }, confirmed: { importMeterPoint: leadingZero } });
  assert.equal(provision.import.meterPointRef, exports.eonMeterPointReference(leadingZero));
});

test("uses all twelve published MPAN checksum weights", () => {
  const independentlyCalculated = [
    "1000000000003", "0100000000005", "0010000000007", "0001000000002",
    "0000100000006", "0000010000008", "0000001000001", "0000000100007",
    "0000000010009", "0000000001004", "0000000000108", "0000000000010",
  ];
  for (const meterPoint of independentlyCalculated)
    assert.match(exports.eonMeterPointReference(meterPoint), /^[a-f0-9]{64}$/);
  assert.match(exports.eonMeterPointReference("1000000000012"), /^[a-f0-9]{64}$/);
  for (const meterPoint of ["1000000000019", "0000000000016"])
    assert.throws(() => exports.eonMeterPointReference(meterPoint), /MPAN_INVALID/);
});

test("wrong accounts, swapped MPANs and missing export evidence fail closed", () => {
  const provision = create(), correct = observed(provision);
  assert.equal(exports.verifyProvisionedEonIdentities(provision, correct).status, "verified");
  for (const [field, value, code] of [
    ["importAccountRef", "a".repeat(64), "TRUSTED_EON_IMPORT_ACCOUNT_MISMATCH"],
    ["exportAccountRef", "b".repeat(64), "TRUSTED_EON_EXPORT_ACCOUNT_MISMATCH"],
    ["importMeterPointRef", provision.export.meterPointRef, "TRUSTED_EON_IMPORT_METER_POINT_MISMATCH"],
    ["exportMeterPointRef", provision.import.meterPointRef, "TRUSTED_EON_EXPORT_METER_POINT_MISMATCH"],
    ["exportMeterPointRef", null, "TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE"],
  ]) { const result = exports.verifyProvisionedEonIdentities(provision, { ...correct, [field]: value });
    assert.equal(result.status, "blocked"); assert.ok(result.blockers.includes(code)); }
});

test("runtime substitution and a future account merger require re-provisioning", () => {
  const provision = create(), correct = observed(provision);
  const substitution = exports.verifyProvisionedEonIdentities(provision, { ...correct,
    importAccountRef: exports.eonAccountReference("substituted-runtime-account") });
  assert.ok(substitution.blockers.includes("TRUSTED_EON_IMPORT_ACCOUNT_MISMATCH"));
  const merger = exports.verifyProvisionedEonIdentities(provision, { ...correct,
    exportAccountRef: provision.import.accountRef });
  assert.ok(merger.blockers.includes("TRUSTED_EON_EXPORT_ACCOUNT_MISMATCH"));
});

const storage = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hep-eon-provision-")));
  fs.writeFileSync(path.join(root, ".hep-trusted-eon-identity-root"), "HEP_TRUSTED_EON_IDENTITY_ROOT_V1\n", { mode: 0o600 });
  return root; };

test("provision store is private, refuses replacement and rejects malformed records", () => {
  const directory = storage();
  try { const file = path.join(directory, "identities.json"), provision = create();
    exports.writeTrustedEonIdentityProvision(directory, file, provision);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(JSON.stringify(exports.readTrustedEonIdentityProvision(directory, file))), JSON.parse(JSON.stringify(provision)));
    assert.throws(() => exports.writeTrustedEonIdentityProvision(directory, file, provision), /EEXIST/);
    const malformed = { ...JSON.parse(JSON.stringify(provision)), extra: true };
    assert.throws(() => exports.validateTrustedEonIdentityProvision(malformed), /PROVISION_INVALID/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("pre-existing temporary files are never removed and interrupted owned writes clean up", () => {
  const directory = storage(), file = path.join(directory, "identities.json"), temporary = path.join(directory, `.identities.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, "pre-existing-private-marker", { mode: 0o600 });
    assert.throws(() => exports.writeTrustedEonIdentityProvision(directory, file, create()), /EEXIST/);
    assert.equal(fs.readFileSync(temporary, "utf8"), "pre-existing-private-marker");
    fs.unlinkSync(temporary);
    const original = fs.writeFileSync; fs.writeFileSync = (...args) => {
      if (typeof args[0] === "number") throw Error("INJECTED_INTERRUPTED_WRITE");
      return original(...args);
    };
    try { assert.throws(() => exports.writeTrustedEonIdentityProvision(directory, file, create()), /INJECTED_INTERRUPTED_WRITE/); }
    finally { fs.writeFileSync = original; }
    assert.equal(fs.existsSync(temporary), false); assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("reads and writes require a canonical approved root outside Git repositories", () => {
  const directory = storage(), provision = create();
  try {
    const file = path.join(directory, "identities.json"); exports.writeTrustedEonIdentityProvision(directory, file, provision);
    const outside = storage();
    try { assert.throws(() => exports.readTrustedEonIdentityProvision(outside, file), /OUTSIDE_APPROVED_ROOT/); }
    finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const alias = `${directory}-alias`; fs.symlinkSync(directory, alias, "dir");
    try { assert.throws(() => exports.readTrustedEonIdentityProvision(alias, path.join(alias, "identities.json")), /ROOT_UNTRUSTED/); }
    finally { fs.unlinkSync(alias); }
    const realNested = path.join(directory, "real"); fs.mkdirSync(realNested, { mode: 0o700 });
    const nestedAlias = path.join(directory, "alias"); fs.symlinkSync(realNested, nestedAlias, "dir");
    assert.throws(() => exports.readTrustedEonIdentityProvision(directory, path.join(nestedAlias, "identities.json")), /DIRECTORY_UNTRUSTED/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("root and descendant directories require current-user ownership and mode 0700", () => {
  for (const mode of [0o777, 0o755, 0o770]) {
    const root = storage();
    try {
      fs.chmodSync(root, mode);
      assert.throws(() => exports.writeTrustedEonIdentityProvision(root, path.join(root, "identities.json"), create()),
        /DIRECTORY_PERMISSIONS_UNSAFE/);
    } finally { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
  }
  const secureRoot = storage();
  try {
    const secure = path.join(secureRoot, "secure"); fs.mkdirSync(secure, { mode: 0o700 });
    exports.writeTrustedEonIdentityProvision(secureRoot, path.join(secure, "identities.json"), create());
    const insecure = path.join(secureRoot, "insecure"); fs.mkdirSync(insecure, { mode: 0o750 });
    assert.throws(() => exports.writeTrustedEonIdentityProvision(secureRoot, path.join(insecure, "identities.json"), create()),
      /DIRECTORY_PERMISSIONS_UNSAFE/);
  } finally { fs.rmSync(secureRoot, { recursive: true, force: true }); }
});

test("reads fail closed after directory permissions become insecure", () => {
  const root = storage(), nested = path.join(root, "nested"); fs.mkdirSync(nested, { mode: 0o700 });
  const file = path.join(nested, "identities.json");
  try {
    exports.writeTrustedEonIdentityProvision(root, file, create());
    fs.chmodSync(nested, 0o755);
    assert.throws(() => exports.readTrustedEonIdentityProvision(root, file), /DIRECTORY_PERMISSIONS_UNSAFE/);
    fs.chmodSync(nested, 0o700); fs.chmodSync(root, 0o770);
    assert.throws(() => exports.readTrustedEonIdentityProvision(root, file), /DIRECTORY_PERMISSIONS_UNSAFE/);
  } finally { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

test("ownership mismatch fails closed where uid inspection is available", () => {
  if (typeof process.getuid !== "function") return;
  const root = storage(), file = path.join(root, "identities.json"), original = fs.lstatSync;
  try {
    fs.lstatSync = (...args) => {
      const stat = original(...args);
      return args[0] === root ? { ...stat, uid: stat.uid + 1,
        isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() } : stat;
    };
    assert.throws(() => exports.writeTrustedEonIdentityProvision(root, file, create()), /DIRECTORY_PERMISSIONS_UNSAFE/);
  } finally { fs.lstatSync = original; fs.rmSync(root, { recursive: true, force: true }); }
});

test("repository, nested repository and worktree storage are rejected", () => {
  for (const gitKind of ["directory", "file"]) {
    const root = storage(), nested = path.join(root, "nested"); fs.mkdirSync(nested, { mode: 0o700 });
    if (gitKind === "directory") fs.mkdirSync(path.join(root, ".git"));
    else fs.writeFileSync(path.join(root, ".git"), "gitdir: /synthetic/worktree\n");
    try { assert.throws(() => exports.writeTrustedEonIdentityProvision(root, path.join(nested, "identities.json"), create()), /GIT_STORAGE_FORBIDDEN/); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const root = storage(), nestedRepository = path.join(root, "nested-repository"); fs.mkdirSync(nestedRepository, { mode: 0o700 }); fs.mkdirSync(path.join(nestedRepository, ".git"));
  try { assert.throws(() => exports.writeTrustedEonIdentityProvision(root, path.join(nestedRepository, "identities.json"), create()), /GIT_STORAGE_FORBIDDEN/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("malformed JSON produces a fixed content-free diagnostic", () => {
  const directory = storage(), file = path.join(directory, "identities.json"), marker = "SYNTHETIC_PRIVATE_MARKER";
  try { fs.writeFileSync(file, `{${marker}`, { mode: 0o600 });
    assert.throws(() => exports.readTrustedEonIdentityProvision(directory, file), error =>
      error instanceof Error && error.message === "TRUSTED_EON_PROVISION_JSON_INVALID" && !error.message.includes(marker));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("fixed prices and caller annotations are outside the identity verifier", () => {
  const provision = create(), input = { ...observed(provision), exportMeterPointRef: null,
    fixedExportPrice: 0.175, trusted: true, accountLabel: "matching" };
  const result = exports.verifyProvisionedEonIdentities(provision, input);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE"));
});
