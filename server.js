"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const db = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const BODY_LIMIT_BYTES = 80 * 1024 * 1024;

db.openDatabase();

function sendJson(response, data, status = 200) {
    const body = JSON.stringify(data);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "X-Content-Type-Options": "nosniff"
    });
    response.end(body);
}

function sendText(response, text, status = 200) {
    response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "X-Content-Type-Options": "nosniff"
    });
    response.end(text);
}

function sendNoContent(response) {
    response.writeHead(204, {
        "X-Content-Type-Options": "nosniff"
    });
    response.end();
}

function createLightProjectResponse(project) {
    if (!project || !project.project) {
        return project;
    }

    const canoeFile = project.project.canoeFile
        ? { ...project.project.canoeFile, data: "" }
        : null;

    return {
        ...project,
        project: {
            ...project.project,
            canoeFile
        }
    };
}

function sendError(response, error) {
    const status = Number(error.status) || 500;
    const code = status === 409 ? "conflict"
        : status === 404 ? "not_found"
            : status === 400 ? "bad_request"
                : status === 413 ? "payload_too_large"
                    : "server_error";

    if (status >= 500) {
        console.error("[ERROR]", error.message);
    }

    sendJson(response, {
        error: code,
        message: status >= 500 ? "Server error" : error.message,
        latest: error.latest || undefined
    }, status);
}

function getContentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".html") {
        return "text/html; charset=utf-8";
    }
    if (extension === ".css") {
        return "text/css; charset=utf-8";
    }
    if (extension === ".js") {
        return "text/javascript; charset=utf-8";
    }
    return "application/octet-stream";
}

function isBlockedPath(pathname) {
    return /^\/(\.git|data|backups|node_modules|nodejs|scripts|logs)(\/|$)/i.test(pathname)
        || /^\/(server\.js|db\.js|package(?:-lock)?\.json|README\.md|start(?:-background|-server)?\.bat|stop-server\.bat)$/i.test(pathname);
}

function sendFile(response, fileName) {
    const filePath = path.join(__dirname, fileName);
    fs.readFile(filePath, (error, data) => {
        if (error) {
            sendText(response, "Not found", 404);
            return;
        }

        response.writeHead(200, {
            "Content-Type": getContentType(filePath),
            "Content-Length": data.length,
            "X-Content-Type-Options": "nosniff"
        });
        response.end(data);
    });
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > BODY_LIMIT_BYTES) {
                const error = new Error("Request body is too large");
                error.status = 413;
                reject(error);
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => {
            if (!chunks.length) {
                resolve({});
                return;
            }

            const text = Buffer.concat(chunks).toString("utf8");
            try {
                resolve(text ? JSON.parse(text) : {});
            } catch (error) {
                const parseError = new Error("Invalid JSON body");
                parseError.status = 400;
                reject(parseError);
            }
        });

        request.on("error", reject);
    });
}

function matchRoute(pathname, pattern) {
    const pathParts = pathname.split("/").filter(Boolean);
    const patternParts = pattern.split("/").filter(Boolean);
    if (pathParts.length !== patternParts.length) {
        return null;
    }

    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const expected = patternParts[index];
        const actual = pathParts[index];
        if (expected.startsWith(":")) {
            params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
            return null;
        }
    }

    return params;
}

async function handleApiRequest(request, response, pathname) {
    const method = request.method || "GET";

    if (method === "GET" && pathname === "/api/health") {
        sendJson(response, { status: "ok", database: "ok" });
        return;
    }

    if (method === "GET" && pathname === "/api/folders") {
        sendJson(response, { folders: db.listFolders() });
        return;
    }

    if (method === "POST" && pathname === "/api/folders") {
        const folder = db.createFolder(await readRequestBody(request));
        console.log(`[INFO] Folder created: ${folder.id} ${folder.name}`);
        sendJson(response, { folder }, 201);
        return;
    }

    let params = matchRoute(pathname, "/api/folders/:folderId");
    if (params && method === "PATCH") {
        const folder = db.updateFolder(params.folderId, await readRequestBody(request));
        sendJson(response, { folder });
        return;
    }
    if (params && method === "DELETE") {
        db.deleteFolder(params.folderId);
        console.log(`[INFO] Folder deleted: ${params.folderId}`);
        sendNoContent(response);
        return;
    }

    if (method === "GET" && pathname === "/api/projects") {
        sendJson(response, { projects: db.listProjects() });
        return;
    }

    if (method === "POST" && pathname === "/api/projects") {
        const project = db.createProject(await readRequestBody(request));
        console.log(`[INFO] Project created: ${project.id} ${project.project.name}`);
        sendJson(response, { project: createLightProjectResponse(project) }, 201);
        return;
    }

    params = matchRoute(pathname, "/api/projects/:projectId/updates");
    if (params && method === "GET") {
        sendJson(response, db.getUpdates(params.projectId));
        return;
    }

    params = matchRoute(pathname, "/api/projects/:projectId/setups/:setupType");
    if (params && method === "PUT") {
        const setup = db.replaceSetup(params.projectId, params.setupType, await readRequestBody(request));
        sendJson(response, { setup });
        return;
    }

    params = matchRoute(pathname, "/api/projects/:projectId/setups/:setupType/positions/:positionId");
    if (params && method === "PUT") {
        const position = db.upsertPosition(
            params.projectId,
            params.setupType,
            params.positionId,
            await readRequestBody(request)
        );
        sendJson(response, { position });
        return;
    }
    if (params && method === "DELETE") {
        db.deletePosition(
            params.projectId,
            params.setupType,
            params.positionId,
            await readRequestBody(request)
        );
        sendNoContent(response);
        return;
    }

    params = matchRoute(pathname, "/api/projects/:projectId");
    if (params && method === "GET") {
        sendJson(response, { project: db.getProject(params.projectId) });
        return;
    }
    if (params && method === "PATCH") {
        const project = db.updateProject(params.projectId, await readRequestBody(request));
        sendJson(response, { project: createLightProjectResponse(project) });
        return;
    }
    if (params && method === "DELETE") {
        db.deleteProject(params.projectId);
        console.log(`[INFO] Project deleted: ${params.projectId}`);
        sendNoContent(response);
        return;
    }

    const error = new Error("Not found");
    error.status = 404;
    throw error;
}

function handleStaticRequest(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, "Method not allowed", 405);
        return;
    }

    if (isBlockedPath(pathname)) {
        sendText(response, "Not found", 404);
        return;
    }

    const staticFiles = new Map([
        ["/", "index.html"],
        ["/index.html", "index.html"],
        ["/style.css", "style.css"],
        ["/script.js", "script.js"]
    ]);

    sendFile(response, staticFiles.get(pathname) || "index.html");
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
        handleApiRequest(request, response, pathname).catch((error) => sendError(response, error));
        return;
    }

    handleStaticRequest(request, response, pathname);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Hardware Setup Manager");
    console.log(`[INFO] Server running on http://localhost:${PORT}`);
    console.log(`[INFO] Database: ${db.DB_PATH}`);
});
