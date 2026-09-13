"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const backupDir = path.join(rootDir, "backups");
const dbPath = path.join(dataDir, "hardware-setup.db");

function timestampForFile(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join("-") + "-" + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join("");
}

async function runBackup() {
    if (!fs.existsSync(dbPath)) {
        console.error("[ERROR] Database not found:", dbPath);
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `hardware-setup-${timestampForFile()}.db`);
    const source = new DatabaseSync(dbPath);

    try {
        source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        await backup(source, backupPath);
        console.log(`[INFO] Backup created: ${backupPath}`);
    } finally {
        source.close();
    }
}

runBackup().catch((error) => {
    console.error("[ERROR] Backup failed:", error.message);
    process.exitCode = 1;
});
