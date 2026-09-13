"use strict";

const express = require("express");
const path = require("node:path");
const db = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const app = express();

db.openDatabase();

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

app.use((request, response, next) => {
    if (/^\/(\.git|data|backups|node_modules|scripts)(\/|$)/i.test(request.path)
        || /^\/(server\.js|db\.js|package(?:-lock)?\.json|README\.md|start-server\.bat)$/i.test(request.path)) {
        response.status(404).send("Not found");
        return;
    }
    next();
});

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

app.get("/api/health", (request, response) => {
    response.json({ status: "ok", database: "ok" });
});

app.get("/api/folders", asyncRoute((request, response) => {
    response.json({ folders: db.listFolders() });
}));

app.post("/api/folders", asyncRoute((request, response) => {
    const folder = db.createFolder(request.body || {});
    console.log(`[INFO] Folder created: ${folder.id} ${folder.name}`);
    response.status(201).json({ folder });
}));

app.patch("/api/folders/:folderId", asyncRoute((request, response) => {
    response.json({ folder: db.updateFolder(request.params.folderId, request.body || {}) });
}));

app.delete("/api/folders/:folderId", asyncRoute((request, response) => {
    db.deleteFolder(request.params.folderId);
    console.log(`[INFO] Folder deleted: ${request.params.folderId}`);
    response.status(204).end();
}));

app.get("/api/projects", asyncRoute((request, response) => {
    response.json({ projects: db.listProjects() });
}));

app.post("/api/projects", asyncRoute((request, response) => {
    const project = db.createProject(request.body || {});
    console.log(`[INFO] Project created: ${project.id} ${project.project.name}`);
    response.status(201).json({ project });
}));

app.get("/api/projects/:projectId", asyncRoute((request, response) => {
    response.json({ project: db.getProject(request.params.projectId) });
}));

app.patch("/api/projects/:projectId", asyncRoute((request, response) => {
    response.json({ project: db.updateProject(request.params.projectId, request.body || {}) });
}));

app.delete("/api/projects/:projectId", asyncRoute((request, response) => {
    db.deleteProject(request.params.projectId);
    console.log(`[INFO] Project deleted: ${request.params.projectId}`);
    response.status(204).end();
}));

app.get("/api/projects/:projectId/updates", asyncRoute((request, response) => {
    response.json(db.getUpdates(request.params.projectId));
}));

app.put("/api/projects/:projectId/setups/:setupType", asyncRoute((request, response) => {
    const setup = db.replaceSetup(request.params.projectId, request.params.setupType, request.body || {});
    response.json({ setup });
}));

app.put("/api/projects/:projectId/setups/:setupType/positions/:positionId", asyncRoute((request, response) => {
    const position = db.upsertPosition(
        request.params.projectId,
        request.params.setupType,
        request.params.positionId,
        request.body || {}
    );
    response.json({ position });
}));

app.delete("/api/projects/:projectId/setups/:setupType/positions/:positionId", asyncRoute((request, response) => {
    db.deletePosition(
        request.params.projectId,
        request.params.setupType,
        request.params.positionId,
        request.body || {}
    );
    response.status(204).end();
}));

const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/style.css", "style.css"],
    ["/script.js", "script.js"]
]);

app.get(["/", "/index.html", "/style.css", "/script.js"], (request, response) => {
    const file = staticFiles.get(request.path);
    response.sendFile(path.join(__dirname, file));
});

app.get(/.*/, (request, response) => {
    response.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, request, response, next) => {
    const status = Number(error.status) || 500;
    const code = status === 409 ? "conflict"
        : status === 404 ? "not_found"
            : status === 400 ? "bad_request"
                : "server_error";

    if (status >= 500) {
        console.error("[ERROR]", error.message);
    }

    response.status(status).json({
        error: code,
        message: status >= 500 ? "Server error" : error.message,
        latest: error.latest || undefined
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("Hardware Setup Manager");
    console.log(`[INFO] Server running on http://localhost:${PORT}`);
    console.log(`[INFO] Database: ${db.DB_PATH}`);
});
