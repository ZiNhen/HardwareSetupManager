// No production database is opened. The legacy schema and WAL fixture live under OS temp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-box-db-'));
fs.writeFileSync(path.join(sandbox, 'legacy-db.js'), execFileSync('git', ['show', 'fix/ui-polish:db.js'], { cwd: root }));
for (const file of ['db.js', 'box-template.js']) fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
const legacy = require(path.join(sandbox, 'legacy-db.js'));
const oldConnection = legacy.openDatabase();
const parent = legacy.createFolder({ name: 'Existing parent' });
const child = legacy.createFolder({ name: 'Existing child', parentFolderId: parent.id });
const project = legacy.createProject({ folderId: child.id, project: { name: 'Realistic legacy', harness: 'Original harness', notes: 'Keep verbatim' } });
legacy.upsertPosition(project.id, 'checkpoint', 'R02C4', { items: [{ type: 'squib', name: 'Driver Airbag', displayName: 'DAB' }], revision: 0 });
legacy.upsertPosition(project.id, 'container', 'R01C1', { items: [{ type: 'sensor', name: 'Front', displayName: 'FIS' }, { type: 'sensor', name: 'Side', displayName: 'SIS' }], revision: 0 });
const snapshot = database => JSON.stringify(['folders', 'projects', 'positions'].map(table => ({
    schema: database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table).sql,
    rows: database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    sequence: database.prepare('SELECT * FROM sqlite_sequence WHERE name = ?').get(table)
})));
const before = snapshot(oldConnection);
const store = require(path.join(sandbox, 'db.js'));
let database;
try {
    assert.ok(fs.existsSync(path.join(sandbox, 'data', 'hardware-setup.db-wal')), 'fixture must have an active WAL');
    database = store.openDatabase();
    assert.equal(snapshot(database), before, 'schema initialization changed existing rows/schema/IDs/sequences');
    const backups = fs.readdirSync(path.join(sandbox, 'backups'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(sandbox, 'backups', backups[0]), { readOnly: true });
    assert.equal(snapshot(backup), before, 'backup must contain committed WAL data');
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'box_%'").get().n, 0);
    backup.close();
    console.log('PASS consistent pre-schema backup and unchanged legacy schema/rows/IDs/relationships');

    assert.deepEqual(store.getProject(project.id), legacy.getProject(project.id));
    assert.equal(store.getBox(project.id).settings.revision, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM box_project_settings').get().n, 0, 'GET must not create defaults');
    const settings = store.updateBoxSettings(project.id, { harness: 'Box only', revision: 0 });
    assert.throws(() => store.updateBoxSettings(project.id, { harness: 'stale', revision: 0 }), error => error.status === 409);
    assert.equal(settings.settings.harness, 'Box only');
    const item = { type: 'sensor', name: 'Front Impact Sensor', displayName: 'FIS', node1: 'G2-B59', role1: '+', node2: 'G2-A10', role2: '-', notes: '' };
    let box = store.saveBoxConnection(project.id, 'checkpoint', null, item);
    const saved = box.setups.checkpoint.connections[0];
    assert.equal(box.setups.container.connections.length, 0);
    box = store.saveBoxConnection(project.id, 'checkpoint', saved.id, { ...item, name: 'Edited', revision: saved.revision });
    assert.equal(box.setups.checkpoint.connections[0].id, saved.id, 'edit must not recreate a mapping');
    assert.throws(() => store.saveBoxConnection(project.id, 'checkpoint', saved.id, { ...item, revision: saved.revision }), error => error.status === 409);
    assert.throws(() => store.deleteBoxConnection(project.id, 'checkpoint', saved.id, { revision: saved.revision }), error => error.status === 409);
    for (const invalid of [{ ...item, node1: 'R01C1' }, { ...item, node1: item.node2 }, { ...item, type: 'squib' }, { ...item, name: ' ' }]) {
        assert.throws(() => store.saveBoxConnection(project.id, 'checkpoint', null, invalid), error => error.status === 400);
    }
    store.saveBoxConnection(project.id, 'container', null, { ...item, type: 'mechanicalSwitch', node1: 'G1-B33', node2: 'G4-B33' });
    store.deleteBoxConnection(project.id, 'checkpoint', saved.id, { revision: 2 });
    assert.equal(store.getBox(project.id).setups.container.connections.length, 1);
    assert.equal(snapshot(database), before, 'Box CRUD changed legacy records');
    console.log('PASS Box CRUD, validation, independent setups/harnesses, optimistic conflicts, no legacy writes');

    database.close(); database = null;
    delete require.cache[require.resolve(path.join(sandbox, 'db.js'))];
    database = require(path.join(sandbox, 'db.js')).openDatabase();
    assert.equal(fs.readdirSync(path.join(sandbox, 'backups')).length, 1, 'idempotent startup must not repeat schema backups');
    assert.equal(snapshot(database), before);
    console.log('PASS idempotent initialization');
} finally {
    if (database) database.close();
    oldConnection.close();
}
console.log('Temporary database: ' + sandbox);

const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-box-backup-failure-'));
for (const file of ['legacy-db.js', 'db.js', 'box-template.js']) fs.copyFileSync(path.join(sandbox, file), path.join(blocked, file));
const blockedLegacy = require(path.join(blocked, 'legacy-db.js'));
const blockedDatabase = blockedLegacy.openDatabase();
try {
    blockedLegacy.createProject({ project: { name: 'Must remain intact' } });
    const unchanged = snapshot(blockedDatabase);
    fs.writeFileSync(path.join(blocked, 'backups'), 'Deliberate backup-directory obstruction');
    assert.throws(() => require(path.join(blocked, 'db.js')).openDatabase());
    assert.equal(snapshot(blockedDatabase), unchanged);
    assert.equal(blockedDatabase.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'box_%'").get().n, 0);
    console.log('PASS backup failure prevents all Box schema changes');
} finally { blockedDatabase.close(); }
