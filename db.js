"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const BOX_TEMPLATE = require("./box-template");
const BOX_NODE_IDS = new Set(BOX_TEMPLATE.nodes.map(node => node.id));

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "hardware-setup.db");
const SETUP_TYPES = new Set(["checkpoint", "container"]);
const HARDWARE_TYPES = new Set(["squib", "aod", "sensor", "physicalSwitch", "mechanicalSwitch"]);
const POSITION_PATTERN = /^R(0[1-9]|1[0-9]|2[0-2])C[1-5]$/;
const DEFAULT_CAN_CHANNELS = { can1: true, can2: false };
const MAX_CANOE_FILE_BYTES = 35 * 1024 * 1024;

let db;

function openDatabase() {
    if (db) {
        return db;
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const existingDatabase = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
    db = new DatabaseSync(DB_PATH);
    // VACUUM INTO creates a transactionally consistent snapshot, including committed WAL data.
    // Fail startup before schema changes if the required backup cannot be created.
    if (existingDatabase && db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('box_project_settings', 'box_connections')").get().count !== 2) {
        try {
            const backupDir = path.join(__dirname, "backups");
            fs.mkdirSync(backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            db.prepare("VACUUM INTO ?").run(path.join(backupDir, `hardware-setup-before-box-${stamp}-${process.pid}.db`));
        } catch (error) {
            db.close();
            db = null;
            throw error;
        }
    }
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER,
            name TEXT NOT NULL DEFAULT 'Untitled Project',
            harness TEXT NOT NULL DEFAULT '',
            ecu_name TEXT NOT NULL DEFAULT '',
            part_number TEXT NOT NULL DEFAULT '',
            calibration_id TEXT NOT NULL DEFAULT '',
            canoe_file_name TEXT NOT NULL DEFAULT '',
            canoe_file_type TEXT NOT NULL DEFAULT '',
            canoe_file_size INTEGER NOT NULL DEFAULT 0,
            canoe_file_data TEXT NOT NULL DEFAULT '',
            canoe_file_updated_at TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            power_linked INTEGER NOT NULL DEFAULT 1,
            checkpoint_can1 INTEGER NOT NULL DEFAULT 1,
            checkpoint_can2 INTEGER NOT NULL DEFAULT 0,
            container_can1 INTEGER NOT NULL DEFAULT 1,
            container_can2 INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            setup_type TEXT NOT NULL CHECK (setup_type IN ('checkpoint', 'container')),
            position_id TEXT NOT NULL,
            items_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            UNIQUE(project_id, setup_type, position_id)
        );

        CREATE INDEX IF NOT EXISTS idx_positions_project_id ON positions(project_id);
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
    `);
    migrateDatabase(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_projects_folder_id ON projects(folder_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);");
    initializeBoxSchema(db);
    return db;
}

function initializeBoxSchema(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS box_project_settings (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            harness TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS box_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            setup_type TEXT NOT NULL CHECK (setup_type IN ('checkpoint', 'container')),
            type TEXT NOT NULL CHECK (type IN ('sensor', 'aod', 'physicalSwitch', 'mechanicalSwitch')),
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            node1 TEXT NOT NULL,
            role1 TEXT NOT NULL DEFAULT '',
            node2 TEXT NOT NULL,
            role2 TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            CHECK (node1 <> node2)
        );
        CREATE INDEX IF NOT EXISTS idx_box_connections_project_setup ON box_connections(project_id, setup_type);
    `);
}

function boxError(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function normalizeBoxConnection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw boxError("Invalid Box mapping");
    const item = Object.fromEntries(["type", "name", "displayName", "node1", "role1", "node2", "role2", "notes"]
        .map(key => [key, cleanString(value[key])]));
    if (!BOX_TEMPLATE.types.includes(item.type) || !item.name || !item.displayName) throw boxError("Type, hardware name and display name are required");
    if (!BOX_NODE_IDS.has(item.node1) || !BOX_NODE_IDS.has(item.node2) || item.node1 === item.node2) throw boxError("Choose two different Box sockets");
    return item;
}

function normalizeBoxImport(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== "object" || !value.setups) throw boxError("Invalid Box data");
    const setups = {};
    for (const setup of SETUP_TYPES) {
        const connections = value.setups[setup]?.connections;
        if (!Array.isArray(connections)) throw boxError("Invalid Box connections");
        setups[setup] = connections.map(normalizeBoxConnection);
    }
    return { harness: cleanString(value.harness ?? value.settings?.harness), setups };
}

function rowToBoxConnection(row) {
    return { id: row.id, type: row.type, name: row.name, displayName: row.display_name,
        node1: row.node1, role1: row.role1, node2: row.node2, role2: row.role2,
        notes: row.notes, revision: row.revision, updatedAt: row.updated_at };
}

function getBox(projectId) {
    const project = requireProject(projectId);
    const settings = openDatabase().prepare("SELECT * FROM box_project_settings WHERE project_id = ?").get(project.id);
    const rows = openDatabase().prepare("SELECT * FROM box_connections WHERE project_id = ? ORDER BY id").all(project.id);
    return {
        settings: { harness: settings?.harness || "", revision: settings?.revision || 0 },
        setups: Object.fromEntries([...SETUP_TYPES].map(setup => [setup, { connections: rows.filter(row => row.setup_type === setup).map(rowToBoxConnection) }])),
        revision: JSON.stringify([settings?.revision || 0, ...rows.map(row => [row.id, row.revision])])
    };
}

function assertBoxRevision(payload, current) {
    if (!Number.isInteger(payload?.revision) || payload.revision !== current) throw boxError("Box data changed on another device. Reload and try again.", 409);
}

function updateBoxSettings(projectId, payload) {
    const project = requireProject(projectId);
    return runTransaction(database => {
        const row = database.prepare("SELECT revision FROM box_project_settings WHERE project_id = ?").get(project.id);
        assertBoxRevision(payload, row?.revision || 0);
        database.prepare(`INSERT INTO box_project_settings (project_id, harness, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET harness = excluded.harness, revision = revision + 1, updated_at = excluded.updated_at`)
            .run(project.id, cleanString(payload.harness), nowSql());
        return getBox(project.id);
    });
}

function insertBoxConnection(database, projectId, setup, item) {
    return database.prepare(`INSERT INTO box_connections
        (project_id, setup_type, type, name, display_name, node1, role1, node2, role2, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, setup, item.type, item.name, item.displayName, item.node1, item.role1, item.node2, item.role2, item.notes, nowSql());
}

function saveBoxConnection(projectId, setupType, connectionId, payload) {
    const project = requireProject(projectId);
    const setup = assertSetupType(setupType);
    const item = normalizeBoxConnection(payload);
    return runTransaction(database => {
        if (connectionId === null) {
            insertBoxConnection(database, project.id, setup, item);
        } else {
            const row = database.prepare("SELECT * FROM box_connections WHERE id = ? AND project_id = ? AND setup_type = ?")
                .get(assertProjectId(connectionId), project.id, setup);
            if (!row) throw boxError("Box mapping not found", 404);
            assertBoxRevision(payload, row.revision);
            database.prepare(`UPDATE box_connections SET type = ?, name = ?, display_name = ?, node1 = ?, role1 = ?, node2 = ?, role2 = ?,
                notes = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
                .run(item.type, item.name, item.displayName, item.node1, item.role1, item.node2, item.role2, item.notes, nowSql(), row.id);
        }
        return getBox(project.id);
    });
}

function deleteBoxConnection(projectId, setupType, connectionId, payload) {
    const project = requireProject(projectId);
    const setup = assertSetupType(setupType);
    return runTransaction(database => {
        const row = database.prepare("SELECT * FROM box_connections WHERE id = ? AND project_id = ? AND setup_type = ?")
            .get(assertProjectId(connectionId), project.id, setup);
        if (!row) throw boxError("Box mapping not found", 404);
        assertBoxRevision(payload, row.revision);
        database.prepare("DELETE FROM box_connections WHERE id = ?").run(row.id);
        return getBox(project.id);
    });
}

function migrateDatabase(database) {
    const projectColumns = database.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
    if (!projectColumns.includes("folder_id")) {
        database.exec("ALTER TABLE projects ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;");
        database.exec("CREATE INDEX IF NOT EXISTS idx_projects_folder_id ON projects(folder_id);");
    }
    if (!projectColumns.includes("canoe_file_name")) {
        database.exec("ALTER TABLE projects ADD COLUMN canoe_file_name TEXT NOT NULL DEFAULT '';");
    }
    if (!projectColumns.includes("canoe_file_type")) {
        database.exec("ALTER TABLE projects ADD COLUMN canoe_file_type TEXT NOT NULL DEFAULT '';");
    }
    if (!projectColumns.includes("canoe_file_size")) {
        database.exec("ALTER TABLE projects ADD COLUMN canoe_file_size INTEGER NOT NULL DEFAULT 0;");
    }
    if (!projectColumns.includes("canoe_file_data")) {
        database.exec("ALTER TABLE projects ADD COLUMN canoe_file_data TEXT NOT NULL DEFAULT '';");
    }
    if (!projectColumns.includes("canoe_file_updated_at")) {
        database.exec("ALTER TABLE projects ADD COLUMN canoe_file_updated_at TEXT NOT NULL DEFAULT '';");
    }
    const folderColumns = database.prepare("PRAGMA table_info(folders)").all().map((column) => column.name);
    if (!folderColumns.includes("parent_id")) {
        database.exec("ALTER TABLE folders ADD COLUMN parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;");
        database.exec("CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);");
    }
}

function nowSql() {
    return new Date().toISOString();
}

function runTransaction(fn) {
    const database = openDatabase();
    database.exec("BEGIN IMMEDIATE;");
    try {
        const result = fn(database);
        database.exec("COMMIT;");
        return result;
    } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
    }
}

function boolToInt(value) {
    return value ? 1 : 0;
}

function intToBool(value) {
    return Number(value) === 1;
}

function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function createPayloadTooLargeError() {
    const error = new Error("CANoe file is too large. Maximum size is 35 MB.");
    error.status = 413;
    return error;
}

function getDataUrlByteSize(data) {
    const commaIndex = data.indexOf(",");
    if (data.startsWith("data:") && commaIndex >= 0) {
        const header = data.slice(0, commaIndex).toLowerCase();
        const body = data.slice(commaIndex + 1).replace(/\s/g, "");
        if (header.includes(";base64")) {
            const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
            return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
        }
        return Buffer.byteLength(decodeURIComponent(body), "utf8");
    }

    return Buffer.byteLength(data, "utf8");
}

function normalizeCanoeFile(file = null) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
        return null;
    }

    const name = cleanString(file.name);
    const data = cleanString(file.data);
    if (!name || !data) {
        return null;
    }

    const size = Number(file.size);
    const dataSize = getDataUrlByteSize(data);
    const normalizedSize = Number.isFinite(size) && size > 0 ? Math.round(size) : dataSize;
    if (normalizedSize > MAX_CANOE_FILE_BYTES || dataSize > MAX_CANOE_FILE_BYTES) {
        throw createPayloadTooLargeError();
    }

    return {
        name,
        type: cleanString(file.type),
        size: normalizedSize,
        data,
        updatedAt: cleanString(file.updatedAt) || nowSql()
    };
}

function getCanoeFileFromRow(row, includeData = true) {
    if (!row || !row.canoe_file_name) {
        return null;
    }

    return {
        name: row.canoe_file_name,
        type: row.canoe_file_type,
        size: Number(row.canoe_file_size) || 0,
        data: includeData ? row.canoe_file_data : "",
        updatedAt: row.canoe_file_updated_at
    };
}

function normalizeProject(project = {}) {
    const canoeFile = normalizeCanoeFile(project.canoeFile);
    return {
        name: cleanString(project.name) || "Untitled Project",
        harness: cleanString(project.harness),
        ecuName: cleanString(project.ecuName),
        partNumber: cleanString(project.partNumber),
        calibrationId: cleanString(project.calibrationId),
        canoeFile,
        notes: cleanString(project.notes)
    };
}

function pickString(source, key, fallback) {
    return Object.prototype.hasOwnProperty.call(source, key) ? cleanString(source[key]) : fallback;
}

function normalizeProjectPatch(project = {}, existing) {
    const source = project && typeof project === "object" && !Array.isArray(project) ? project : {};
    const hasCanoeFile = Object.prototype.hasOwnProperty.call(source, "canoeFile");
    return {
        name: pickString(source, "name", existing.name) || "Untitled Project",
        harness: pickString(source, "harness", existing.harness),
        ecuName: pickString(source, "ecuName", existing.ecu_name),
        partNumber: pickString(source, "partNumber", existing.part_number),
        calibrationId: pickString(source, "calibrationId", existing.calibration_id),
        canoeFile: hasCanoeFile ? normalizeCanoeFile(source.canoeFile) : getCanoeFileFromRow(existing),
        notes: pickString(source, "notes", existing.notes)
    };
}

function normalizeFolderId(value) {
    if (value === null || value === "" || value === undefined) {
        return null;
    }
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) {
        const error = new Error("Invalid folder ID");
        error.status = 400;
        throw error;
    }
    return id;
}

function normalizeBoardOptions(boardOptions = {}) {
    return {
        powerLinked: typeof boardOptions.powerLinked === "boolean" ? boardOptions.powerLinked : true
    };
}

function normalizeCanChannels(canChannels = {}) {
    return {
        can1: typeof canChannels.can1 === "boolean" ? canChannels.can1 : DEFAULT_CAN_CHANNELS.can1,
        can2: typeof canChannels.can2 === "boolean" ? canChannels.can2 : DEFAULT_CAN_CHANNELS.can2
    };
}

function normalizeItems(items) {
    if (!Array.isArray(items)) {
        return [];
    }

    return items.reduce((result, item) => {
        if (!item || typeof item !== "object" || !HARDWARE_TYPES.has(item.type)) {
            return result;
        }

        const name = cleanString(item.name);
        const displayName = cleanString(item.displayName);
        const finalName = name || displayName;
        const finalDisplayName = displayName || finalName.slice(0, 6).toUpperCase();

        if (!finalName || !finalDisplayName) {
            return result;
        }

        result.push({
            type: item.type,
            name: finalName,
            displayName: finalDisplayName,
            notes: cleanString(item.notes)
        });
        return result;
    }, []);
}

function assertProjectId(projectId) {
    const id = Number(projectId);
    if (!Number.isInteger(id) || id < 1) {
        const error = new Error("Invalid project ID");
        error.status = 400;
        throw error;
    }
    return id;
}

function assertSetupType(setupType) {
    if (!SETUP_TYPES.has(setupType)) {
        const error = new Error("Invalid setup type");
        error.status = 400;
        throw error;
    }
    return setupType;
}

function assertPositionId(positionId) {
    if (!POSITION_PATTERN.test(positionId || "")) {
        const error = new Error("Invalid position ID");
        error.status = 400;
        throw error;
    }
    return positionId;
}

function getProjectRow(projectId) {
    const id = assertProjectId(projectId);
    return openDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function requireProject(projectId) {
    const project = getProjectRow(projectId);
    if (!project) {
        const error = new Error("Project not found");
        error.status = 404;
        throw error;
    }
    return project;
}

function toProjectSummary(row) {
    return {
        id: row.id,
        folderId: row.folder_id,
        name: row.name,
        harness: row.harness,
        ecuName: row.ecu_name,
        partNumber: row.part_number,
        calibrationId: row.calibration_id,
        canoeFile: getCanoeFileFromRow(row, false),
        notes: row.notes,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function rowToState(row, positionRows = []) {
    const state = {
        version: 1,
        id: row.id,
        folderId: row.folder_id,
        revision: row.revision,
        updatedAt: row.updated_at,
        project: {
            name: row.name,
            harness: row.harness,
            ecuName: row.ecu_name,
            partNumber: row.part_number,
            calibrationId: row.calibration_id,
            canoeFile: getCanoeFileFromRow(row),
            notes: row.notes
        },
        boardOptions: {
            powerLinked: intToBool(row.power_linked)
        },
        setups: {
            checkpoint: {
                positions: {},
                canChannels: {
                    can1: intToBool(row.checkpoint_can1),
                    can2: intToBool(row.checkpoint_can2)
                }
            },
            container: {
                positions: {},
                canChannels: {
                    can1: intToBool(row.container_can1),
                    can2: intToBool(row.container_can2)
                }
            }
        }
    };

    positionRows.forEach((position) => {
        const setup = state.setups[position.setup_type];
        if (!setup) {
            return;
        }

        setup.positions[position.position_id] = {
            items: normalizeItems(JSON.parse(position.items_json)),
            revision: position.revision,
            updatedAt: position.updated_at
        };
    });

    return state;
}

function listProjects() {
    const rows = openDatabase()
        .prepare("SELECT * FROM projects ORDER BY updated_at DESC, id DESC")
        .all();
    return rows.map(toProjectSummary);
}

function listFolders() {
    return openDatabase()
        .prepare("SELECT id, parent_id, name, created_at, updated_at FROM folders ORDER BY name COLLATE NOCASE ASC")
        .all()
        .map((folder) => ({
            id: folder.id,
            parentFolderId: folder.parent_id,
            name: folder.name,
            createdAt: folder.created_at,
            updatedAt: folder.updated_at
        }));
}

function createFolder(payload = {}) {
    const name = cleanString(payload.name);
    if (!name) {
        const error = new Error("Folder name is required");
        error.status = 400;
        throw error;
    }

    const parentFolderId = requireFolder(payload.parentFolderId);
    const timestamp = nowSql();
    const result = openDatabase()
        .prepare("INSERT INTO folders (parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(parentFolderId, name, timestamp, timestamp);
    return {
        id: Number(result.lastInsertRowid),
        parentFolderId,
        name,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

function updateFolder(folderId, payload = {}) {
    const id = assertProjectId(folderId);
    const existing = openDatabase().prepare("SELECT * FROM folders WHERE id = ?").get(id);
    if (!existing) {
        const error = new Error("Folder not found");
        error.status = 404;
        throw error;
    }

    const name = cleanString(payload.name) || existing.name;
    const parentFolderId = Object.prototype.hasOwnProperty.call(payload, "parentFolderId")
        ? requireFolder(payload.parentFolderId)
        : existing.parent_id;
    if (parentFolderId === id || isFolderDescendant(parentFolderId, id)) {
        const error = new Error("Folder cannot be moved into itself");
        error.status = 400;
        throw error;
    }

    const timestamp = nowSql();
    openDatabase()
        .prepare("UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?")
        .run(parentFolderId, name, timestamp, id);

    return {
        id,
        parentFolderId,
        name,
        createdAt: existing.created_at,
        updatedAt: timestamp
    };
}

function deleteFolder(folderId) {
    const id = assertProjectId(folderId);
    const result = openDatabase().prepare("DELETE FROM folders WHERE id = ?").run(id);
    if (!result.changes) {
        const error = new Error("Folder not found");
        error.status = 404;
        throw error;
    }
}

function requireFolder(folderId) {
    const id = normalizeFolderId(folderId);
    if (id === null) {
        return null;
    }

    const folder = openDatabase().prepare("SELECT * FROM folders WHERE id = ?").get(id);
    if (!folder) {
        const error = new Error("Folder not found");
        error.status = 404;
        throw error;
    }
    return id;
}

function isFolderDescendant(folderId, ancestorId) {
    let currentId = normalizeFolderId(folderId);
    while (currentId !== null) {
        if (currentId === ancestorId) {
            return true;
        }
        const folder = openDatabase().prepare("SELECT parent_id FROM folders WHERE id = ?").get(currentId);
        currentId = folder ? normalizeFolderId(folder.parent_id) : null;
    }
    return false;
}

function getProject(projectId) {
    const row = requireProject(projectId);
    const positions = openDatabase()
        .prepare("SELECT setup_type, position_id, items_json, revision, updated_at FROM positions WHERE project_id = ?")
        .all(row.id);
    return rowToState(row, positions);
}

function touchProject(projectId) {
    openDatabase()
        .prepare("UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(nowSql(), projectId);
}

function createProject(payload = {}) {
    const box = normalizeBoxImport(payload.box);
    const project = normalizeProject(payload.project || payload);
    const folderId = requireFolder(payload.folderId);
    const boardOptions = normalizeBoardOptions(payload.boardOptions);
    const checkpointCan = normalizeCanChannels(payload.setups && payload.setups.checkpoint && payload.setups.checkpoint.canChannels);
    const containerCan = normalizeCanChannels(payload.setups && payload.setups.container && payload.setups.container.canChannels);
    const projectId = runTransaction((database) => {
        const result = database.prepare(`
            INSERT INTO projects (
                folder_id, name, harness, ecu_name, part_number, calibration_id,
                canoe_file_name, canoe_file_type, canoe_file_size, canoe_file_data, canoe_file_updated_at,
                notes,
                power_linked, checkpoint_can1, checkpoint_can2, container_can1, container_can2,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            folderId,
            project.name,
            project.harness,
            project.ecuName,
            project.partNumber,
            project.calibrationId,
            project.canoeFile ? project.canoeFile.name : "",
            project.canoeFile ? project.canoeFile.type : "",
            project.canoeFile ? project.canoeFile.size : 0,
            project.canoeFile ? project.canoeFile.data : "",
            project.canoeFile ? project.canoeFile.updatedAt : "",
            project.notes,
            boolToInt(boardOptions.powerLinked),
            boolToInt(checkpointCan.can1),
            boolToInt(checkpointCan.can2),
            boolToInt(containerCan.can1),
            boolToInt(containerCan.can2),
            nowSql(),
            nowSql()
        );
        const projectId = Number(result.lastInsertRowid);

        ["checkpoint", "container"].forEach((setupType) => {
            const positions = payload.setups && payload.setups[setupType] && payload.setups[setupType].positions;
            if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
                return;
            }
            Object.keys(positions).forEach((positionId) => {
                if (!POSITION_PATTERN.test(positionId)) {
                    return;
                }
                const items = normalizeItems(positions[positionId] && positions[positionId].items);
                if (items.length) {
                    database.prepare(`
                        INSERT INTO positions (project_id, setup_type, position_id, items_json, revision, updated_at)
                        VALUES (?, ?, ?, ?, 1, ?)
                    `).run(projectId, setupType, positionId, JSON.stringify(items), nowSql());
                }
            });
        });

        if (box) {
            if (box.harness) database.prepare("INSERT INTO box_project_settings (project_id, harness, updated_at) VALUES (?, ?, ?)").run(projectId, box.harness, nowSql());
            for (const setup of SETUP_TYPES) {
                box.setups[setup].forEach(item => insertBoxConnection(database, projectId, setup, item));
            }
        }
        touchProject(projectId);
        return projectId;
    });

    return getProject(projectId);
}

function updateProject(projectId, payload = {}) {
    const id = assertProjectId(projectId);
    const existing = requireProject(id);
    const project = normalizeProjectPatch(payload.project || {}, existing);
    const boardOptions = payload.boardOptions
        ? normalizeBoardOptions(payload.boardOptions)
        : { powerLinked: intToBool(existing.power_linked) };
    const checkpointCan = payload.setups && payload.setups.checkpoint
        ? normalizeCanChannels(payload.setups.checkpoint.canChannels)
        : { can1: intToBool(existing.checkpoint_can1), can2: intToBool(existing.checkpoint_can2) };
    const containerCan = payload.setups && payload.setups.container
        ? normalizeCanChannels(payload.setups.container.canChannels)
        : { can1: intToBool(existing.container_can1), can2: intToBool(existing.container_can2) };
    const folderId = Object.prototype.hasOwnProperty.call(payload, "folderId")
        ? requireFolder(payload.folderId)
        : existing.folder_id;

    openDatabase().prepare(`
        UPDATE projects
        SET folder_id = ?, name = ?, harness = ?, ecu_name = ?, part_number = ?, calibration_id = ?,
            canoe_file_name = ?, canoe_file_type = ?, canoe_file_size = ?, canoe_file_data = ?, canoe_file_updated_at = ?,
            notes = ?,
            power_linked = ?, checkpoint_can1 = ?, checkpoint_can2 = ?, container_can1 = ?, container_can2 = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
    `).run(
        folderId,
        project.name,
        project.harness,
        project.ecuName,
        project.partNumber,
        project.calibrationId,
        project.canoeFile ? project.canoeFile.name : "",
        project.canoeFile ? project.canoeFile.type : "",
        project.canoeFile ? project.canoeFile.size : 0,
        project.canoeFile ? project.canoeFile.data : "",
        project.canoeFile ? project.canoeFile.updatedAt : "",
        project.notes,
        boolToInt(boardOptions.powerLinked),
        boolToInt(checkpointCan.can1),
        boolToInt(checkpointCan.can2),
        boolToInt(containerCan.can1),
        boolToInt(containerCan.can2),
        nowSql(),
        id
    );

    return getProject(id);
}

function deleteProject(projectId) {
    const id = assertProjectId(projectId);
    const result = openDatabase().prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (!result.changes) {
        const error = new Error("Project not found");
        error.status = 404;
        throw error;
    }
}

function getPosition(projectId, setupType, positionId) {
    return openDatabase().prepare(`
        SELECT * FROM positions WHERE project_id = ? AND setup_type = ? AND position_id = ?
    `).get(projectId, setupType, positionId);
}

function upsertPosition(projectId, setupType, positionId, payload = {}) {
    const id = assertProjectId(projectId);
    const setup = assertSetupType(setupType);
    const position = assertPositionId(positionId);
    requireProject(id);

    const items = normalizeItems(payload.items);
    if (!items.length) {
        return deletePosition(id, setup, position, payload);
    }

    const expectedRevision = payload.revision == null ? null : Number(payload.revision);
    const existing = getPosition(id, setup, position);
    if (existing && expectedRevision !== null && existing.revision !== expectedRevision) {
        const error = new Error("Position conflict");
        error.status = 409;
        error.latest = rowToPosition(existing);
        throw error;
    }
    if (!existing && expectedRevision !== null && expectedRevision > 0) {
        const error = new Error("Position conflict");
        error.status = 409;
        throw error;
    }

    runTransaction((database) => {
        const timestamp = nowSql();
        if (existing) {
            database.prepare(`
                UPDATE positions
                SET items_json = ?, revision = revision + 1, updated_at = ?
                WHERE id = ?
            `).run(JSON.stringify(items), timestamp, existing.id);
        } else {
            database.prepare(`
                INSERT INTO positions (project_id, setup_type, position_id, items_json, revision, updated_at)
                VALUES (?, ?, ?, ?, 1, ?)
            `).run(id, setup, position, JSON.stringify(items), timestamp);
        }
        touchProject(id);
    });

    return rowToPosition(getPosition(id, setup, position));
}

function deletePosition(projectId, setupType, positionId, payload = {}) {
    const id = assertProjectId(projectId);
    const setup = assertSetupType(setupType);
    const position = assertPositionId(positionId);
    requireProject(id);
    const expectedRevision = payload.revision == null ? null : Number(payload.revision);
    const existing = getPosition(id, setup, position);

    if (existing && expectedRevision !== null && existing.revision !== expectedRevision) {
        const error = new Error("Position conflict");
        error.status = 409;
        error.latest = rowToPosition(existing);
        throw error;
    }

    runTransaction((database) => {
        database.prepare("DELETE FROM positions WHERE project_id = ? AND setup_type = ? AND position_id = ?")
            .run(id, setup, position);
        touchProject(id);
    });
}

function replaceSetup(projectId, setupType, setupPayload = {}) {
    const id = assertProjectId(projectId);
    const setup = assertSetupType(setupType);
    requireProject(id);
    const positions = setupPayload.positions && typeof setupPayload.positions === "object" && !Array.isArray(setupPayload.positions)
        ? setupPayload.positions
        : {};
    const canChannels = normalizeCanChannels(setupPayload.canChannels);
    runTransaction((database) => {
        if (setup === "checkpoint") {
            database.prepare("UPDATE projects SET checkpoint_can1 = ?, checkpoint_can2 = ? WHERE id = ?")
                .run(boolToInt(canChannels.can1), boolToInt(canChannels.can2), id);
        } else {
            database.prepare("UPDATE projects SET container_can1 = ?, container_can2 = ? WHERE id = ?")
                .run(boolToInt(canChannels.can1), boolToInt(canChannels.can2), id);
        }

        database.prepare("DELETE FROM positions WHERE project_id = ? AND setup_type = ?").run(id, setup);
        Object.keys(positions).forEach((positionId) => {
            if (!POSITION_PATTERN.test(positionId)) {
                return;
            }
            const items = normalizeItems(positions[positionId] && positions[positionId].items);
            if (!items.length) {
                return;
            }
            database.prepare(`
                INSERT INTO positions (project_id, setup_type, position_id, items_json, revision, updated_at)
                VALUES (?, ?, ?, ?, 1, ?)
            `).run(id, setup, positionId, JSON.stringify(items), nowSql());
        });
        touchProject(id);
    });

    return getProject(id).setups[setup];
}

function getUpdates(projectId) {
    const project = requireProject(projectId);
    const positions = openDatabase()
        .prepare("SELECT setup_type, position_id, revision, updated_at FROM positions WHERE project_id = ?")
        .all(project.id);
    return {
        id: project.id,
        revision: project.revision,
        updatedAt: project.updated_at,
        positions
    };
}

function rowToPosition(row) {
    return {
        setupType: row.setup_type,
        positionId: row.position_id,
        items: normalizeItems(JSON.parse(row.items_json)),
        revision: row.revision,
        updatedAt: row.updated_at
    };
}

module.exports = {
    getBox,
    updateBoxSettings,
    saveBoxConnection,
    deleteBoxConnection,
    DB_PATH,
    openDatabase,
    listFolders,
    createFolder,
    updateFolder,
    deleteFolder,
    listProjects,
    createProject,
    getProject,
    updateProject,
    deleteProject,
    upsertPosition,
    deletePosition,
    replaceSetup,
    getUpdates
};
