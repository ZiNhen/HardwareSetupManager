"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "hardware-setup.db");
const SETUP_TYPES = new Set(["checkpoint", "container"]);
const HARDWARE_TYPES = new Set(["squib", "aod", "sensor", "physicalSwitch", "mechanicalSwitch"]);
const POSITION_PATTERN = /^R(0[1-9]|1[0-9]|2[0-2])C[1-5]$/;
const DEFAULT_CAN_CHANNELS = { can1: true, can2: false };

let db;

function openDatabase() {
    if (db) {
        return db;
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER,
            name TEXT NOT NULL DEFAULT 'Untitled Project',
            harness TEXT NOT NULL DEFAULT '',
            ecu_name TEXT NOT NULL DEFAULT '',
            part_number TEXT NOT NULL DEFAULT '',
            calibration_id TEXT NOT NULL DEFAULT '',
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
    return db;
}

function migrateDatabase(database) {
    const columns = database.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
    if (!columns.includes("folder_id")) {
        database.exec("ALTER TABLE projects ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;");
        database.exec("CREATE INDEX IF NOT EXISTS idx_projects_folder_id ON projects(folder_id);");
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

function normalizeProject(project = {}) {
    return {
        name: cleanString(project.name) || "Untitled Project",
        harness: cleanString(project.harness),
        ecuName: cleanString(project.ecuName),
        partNumber: cleanString(project.partNumber),
        calibrationId: cleanString(project.calibrationId),
        notes: cleanString(project.notes)
    };
}

function pickString(source, key, fallback) {
    return Object.prototype.hasOwnProperty.call(source, key) ? cleanString(source[key]) : fallback;
}

function normalizeProjectPatch(project = {}, existing) {
    const source = project && typeof project === "object" && !Array.isArray(project) ? project : {};
    return {
        name: pickString(source, "name", existing.name) || "Untitled Project",
        harness: pickString(source, "harness", existing.harness),
        ecuName: pickString(source, "ecuName", existing.ecu_name),
        partNumber: pickString(source, "partNumber", existing.part_number),
        calibrationId: pickString(source, "calibrationId", existing.calibration_id),
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
        .prepare("SELECT id, name, created_at, updated_at FROM folders ORDER BY name COLLATE NOCASE ASC")
        .all()
        .map((folder) => ({
            id: folder.id,
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

    const timestamp = nowSql();
    const result = openDatabase()
        .prepare("INSERT INTO folders (name, created_at, updated_at) VALUES (?, ?, ?)")
        .run(name, timestamp, timestamp);
    return {
        id: Number(result.lastInsertRowid),
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
    const timestamp = nowSql();
    openDatabase()
        .prepare("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, timestamp, id);

    return {
        id,
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
    const project = normalizeProject(payload.project || payload);
    const folderId = requireFolder(payload.folderId);
    const boardOptions = normalizeBoardOptions(payload.boardOptions);
    const checkpointCan = normalizeCanChannels(payload.setups && payload.setups.checkpoint && payload.setups.checkpoint.canChannels);
    const containerCan = normalizeCanChannels(payload.setups && payload.setups.container && payload.setups.container.canChannels);
    const projectId = runTransaction((database) => {
        const result = database.prepare(`
            INSERT INTO projects (
                folder_id, name, harness, ecu_name, part_number, calibration_id, notes,
                power_linked, checkpoint_can1, checkpoint_can2, container_can1, container_can2,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            folderId,
            project.name,
            project.harness,
            project.ecuName,
            project.partNumber,
            project.calibrationId,
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
        SET folder_id = ?, name = ?, harness = ?, ecu_name = ?, part_number = ?, calibration_id = ?, notes = ?,
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
