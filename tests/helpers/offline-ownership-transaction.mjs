// TEST ONLY: appended to the SQLite module by VM source instrumentation.
// No production offline writer/export, selectable provider or registry exists.
// This uses the SAME private transaction runner, exact-generation check and
// pair insertion as V1. Only the row/journal consistency profile differs.
export const offlineTransactionSource = `
export async function testCommitOfflineOwnership(databasePath, suppliedRecord, suppliedContext, suppliedGeneration) {
  return ownershipDatabaseTransaction(path.resolve(databasePath), '12345', async db => {
    const record = structuredClone(suppliedRecord), context = structuredClone(suppliedContext);
    const approved = structuredClone(suppliedGeneration);
    const site = context.energySiteId, zone = context.timeZone;
    if (site !== '12345' || record?.kind !== 'offline-v2-ownership-persistence'
        || context.previousLifecycle !== null || context.operations?.length !== 1)
      throw Error('OWNERSHIP_OFFLINE_FIRST_APPLY_REQUIRED');
    validateExactOwnershipGeneration(approved, null);
    const e = context.operations[0].evidence, intent = e.initial.intent;
    if (intent.kind !== 'apply' || intent.ownershipBefore !== null || intent.predecessor !== null
        || record.previousRecordId !== null || intent.origin !== null)
      throw Error('OWNERSHIP_OFFLINE_FIRST_APPLY_REQUIRED');
    if (approved.expectedAfter !== intent.ownershipAfterGeneration || record.lifecycle.generation !== approved.expectedAfter)
      throw Error('OWNERSHIP_GENERATION_CHANGED');
    // No inferred absence: both tables are inspected under BEGIN IMMEDIATE.
    const current = db.prepare('SELECT snapshot FROM ownership WHERE site=?').all(site);
    const prior = db.prepare('SELECT mutation,issuance,record FROM applied WHERE site=?').all(site);
    if (current.length || prior.length) throw Error('OWNERSHIP_GENERATION_CHANGED');
    const directory = path.resolve(path.dirname(databasePath), '../tesla-experiments');
    const config = { directory, durableRoot: path.resolve(directory, '..'), site };
    const admission = context.operations[0].context.ownershipAttributions?.[0]?.admission;
    // Fixture-only attribution evidence. This is NOT authentication or approval
    // permission, and is never registered with a production capability issuer.
    const fixtureAdmission = async (s, op, mutation) => {
      if (s !== site || op !== intent.operationId || mutation !== intent.mutationId || !admission)
        throw Error('OWNERSHIP_OFFLINE_ATTRIBUTION_MISSING');
      return structuredClone(admission);
    };
    const history = await readOfflineOperationHistory(config, fixtureAdmission);
    if (history.status !== 'available' || history.history.records.length !== 1
        || representationKey(history.history.records[0]) !== representationKey(e))
      throw Error('OWNERSHIP_OFFLINE_JOURNAL_CONFLICT');
    const contract = require('./ownership-persistence');
    const validate = (snapshot, applications) => contract.testValidateOfflinePersistence(
      snapshot, applications, site, zone, history.history, context);
    const checked = validate(record, [record]);
    if (checked.status !== 'validated') throw Error('OWNERSHIP_OFFLINE_REPRESENTATION_CONFLICT');
    const app = record.lifecycle.applications[0];
    if (app.runtime.namespace !== 'offline-simulated-operation'
        || app.ownership.beforeGeneration !== null || app.ownership.afterGeneration !== approved.expectedAfter
        || app.predecessorApplicationId !== null)
      throw Error('OWNERSHIP_OFFLINE_IDENTITY_CONFLICT');
    // Complete original and origin/journal links are validated by C5a/F1 above;
    // do not route V2 journals through the legacy V1 retained-journal guard.
    writeOwnershipPair(db, site, app.mutationId, app.runtime.issuanceKey, record, record);
    const rows = db.prepare('SELECT snapshot FROM ownership WHERE site=?').all(site);
    const applications = db.prepare('SELECT mutation,issuance,record FROM applied WHERE site=?').all(site);
    if (rows.length !== 1 || applications.length !== 1
        || applications[0].mutation !== app.mutationId || applications[0].issuance !== app.runtime.issuanceKey
        || representationKey(JSON.parse(rows[0].snapshot)) !== representationKey(record)
        || representationKey(JSON.parse(applications[0].record)) !== representationKey(record)
        || validate(JSON.parse(rows[0].snapshot), applications.map(r => JSON.parse(r.record))).status !== 'validated')
      throw Error('OWNERSHIP_PAIR_VERIFICATION_FAILED');
    // Re-read physical completion evidence before COMMIT. Any concurrent journal
    // loss, conflict or truncation rolls back BOTH table writes.
    const again = await readOfflineOperationHistory(config, fixtureAdmission);
    if (representationKey(again) !== representationKey(history)) throw Error('OWNERSHIP_OFFLINE_JOURNAL_CHANGED');
    return { status: 'persisted-offline', snapshot: structuredClone(record),
      ...persistenceOnly, mode: 'offline-test-only', authentication: 'fixtures-only' };
  });
}
`;

// TEST ONLY / read-only F4a-style inspection. The context is an independent
// documentary checkpoint, not a recovered receipt, live token or authentication.
export const offlineRecoverySource = `
export async function testReadOfflineOwnership(databasePath, suppliedContext) {
  let db;
  const blocked = code => ({ status: 'blocked', code, ...persistenceOnly,
    mode: 'offline-test-only', authentication: 'fixtures-only' });
  try {
    guard();
    const context = structuredClone(suppliedContext);
    if (!context || context.operations?.length !== 1 || context.previousLifecycle !== null)
      return blocked('OWNERSHIP_OFFLINE_RECOVERY_CONTEXT_MISSING');
    const site = context.energySiteId, zone = context.timeZone, file = path.resolve(databasePath);
    if (!siteId(site)) return blocked('OWNERSHIP_SITE_INVALID');
    legacy(file, site);
    if (!exists(file)) return blocked('OWNERSHIP_OFFLINE_DATABASE_MISSING');
    db = connect(file, false).db; db.exec('BEGIN'); schema(db, false);
    const rows = db.prepare('SELECT snapshot FROM ownership WHERE site=?').all(site);
    const applications = db.prepare('SELECT mutation,issuance,record FROM applied WHERE site=?').all(site);
    if (rows.length !== 1 || applications.length !== 1) return blocked('OWNERSHIP_OFFLINE_HISTORY_INCOMPLETE');
    const current = JSON.parse(rows[0].snapshot), records = applications.map(r => JSON.parse(r.record));
    const app = records[0]?.lifecycle?.applications?.at(-1);
    if (!app || applications[0].mutation !== app.mutationId || applications[0].issuance !== app.runtime?.issuanceKey)
      return blocked('OWNERSHIP_OFFLINE_COLUMN_CONFLICT');
    const entry = context.operations[0], intent = entry.evidence.initial.intent;
    const admission = entry.context.ownershipAttributions?.[0]?.admission;
    const fixtureAdmission = async (s, op, mutation) => {
      if (s !== site || op !== intent.operationId || mutation !== intent.mutationId || !admission)
        throw Error('OWNERSHIP_OFFLINE_ATTRIBUTION_MISSING');
      return structuredClone(admission);
    };
    const directory = path.resolve(path.dirname(file), '../tesla-experiments');
    const config = { directory, durableRoot: path.resolve(directory, '..'), site };
    const journal = await readOfflineOperationHistory(config, fixtureAdmission);
    if (journal.status !== 'available') return blocked('OWNERSHIP_OFFLINE_JOURNAL_UNAVAILABLE');
    const contract = require('./ownership-persistence');
    const checked = contract.testValidateOfflinePersistence(current, records, site, zone, journal.history, context);
    if (checked.status !== 'validated') return blocked(checked.code);
    // Independent reference checkpoint + physical rows/journal establish only
    // offline documentary consistency. Never hydrate a runtime registry.
    if (contract.validatePersistedOwnershipHistory(current, records, site, zone, journal.history).status !== 'rejected')
      return blocked('OWNERSHIP_OFFLINE_PRODUCTION_ISOLATION_FAILED');
    const again = await readOfflineOperationHistory(config, fixtureAdmission);
    if (representationKey(again) !== representationKey(journal)) return blocked('OWNERSHIP_OFFLINE_JOURNAL_CHANGED');
    db.exec('COMMIT'); db.close(); db = undefined;
    return { status: 'consistent-offline-storage', current: structuredClone(current), records: structuredClone(records),
      ...persistenceOnly, mode: 'offline-test-only', authentication: 'fixtures-only' };
  } catch { return blocked('OWNERSHIP_OFFLINE_RECOVERY_INVALID'); }
  finally { if (db) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} } }
}
`;
