"use strict";

/*
Hardware Setup Manager online multi-user branch
- App state is the single source of truth for project metadata, active setup, and positions.
- Persistence is isolated in the storage object and talks to the REST API.
- Export JSON intentionally excludes UI-only state and empty positions.
- Run generateDemoData() in the browser console if you want sample data for quick testing.
*/

const API_BASE = "/api";
const PROJECT_POLL_INTERVAL_MS = 3000;
const PROJECT_BROWSER_POLL_INTERVAL_MS = 5000;
const POSITION_ROWS = 22;
const POSITION_COLUMNS = 5;
const DEFAULT_PROJECT_NAME = "Untitled Project";
const MAX_CANOE_FILE_BYTES = 35 * 1024 * 1024;

const SETUP_LABELS = {
    checkpoint: "Checkpoint",
    container: "Container"
};

const INTERACTION_MODES = {
    view: "View",
    edit: "Edit"
};

const HARDWARE_TYPES = {
    squib: {
        label: "Squib",
        cssClass: "type-squib",
        colorVar: "--squib",
        borderVar: "--squib-border"
    },
    aod: {
        label: "AOD",
        cssClass: "type-aod",
        colorVar: "--aod",
        borderVar: "--aod-border"
    },
    sensor: {
        label: "Sensor",
        cssClass: "type-sensor",
        colorVar: "--sensor",
        borderVar: "--sensor-border"
    },
    physicalSwitch: {
        label: "Physical Switch",
        cssClass: "type-physical-switch",
        colorVar: "--physical-switch",
        borderVar: "--physical-switch-border"
    },
    mechanicalSwitch: {
        label: "Mechanical Switch",
        cssClass: "type-mechanical-switch",
        colorVar: "--mechanical-switch",
        borderVar: "--mechanical-switch-border"
    }
};

const SENSOR_CONTEXT_OPTIONS = ["UFS", "PASF", "PPSF", "PASM", "PCS", "PTS"];

const QUICK_ITEM_DEFAULTS = {
    sensor: {
        name: "Sensor",
        displayName: "SEN"
    },
    squib: {
        name: "Squib",
        displayName: "SQB"
    },
    aod: {
        name: "AOD",
        displayName: "AOD"
    },
    physicalSwitch: {
        name: "Physical Switch",
        displayName: "PSW"
    },
    mechanicalSwitch: {
        name: "Mechanical Switch",
        displayName: "MSW"
    }
};

const SWITCH_TOGGLE_TYPES = ["mechanicalSwitch", "physicalSwitch"];
const DEFAULT_CAN_CHANNELS = {
    can1: true,
    can2: false
};
const FIXED_POSITION_PRESETS = createFixedPositionPresets();
const MERGED_SENSOR_ROWS = createNumberSet(1, 12);
const MERGED_SENSOR_ALIAS_COLUMN = 2;
const BOARD_UTILITY_CELLS = {
    R01C3: {
        label: "KL30",
        title: "KL30",
        typeLabel: "Power",
        detail: "Battery supply position",
        cssClass: "utility-power utility-power-top",
        rowSpan: 1
    },
    R02C3: {
        label: "KL15",
        title: "KL15",
        typeLabel: "Power",
        detail: "Ignition supply position",
        cssClass: "utility-power utility-power-bottom",
        rowSpan: 1
    },
    R05C3: {
        label: "GND",
        title: "GND",
        typeLabel: "Ground",
        detail: "Ground position",
        cssClass: "utility-ground",
        rowSpan: 1
    },
    R06C3: {
        label: "CAN 1",
        title: "CAN 1",
        typeLabel: "CAN",
        detail: "CAN position spanning R06C3 and R07C3",
        cssClass: "utility-can",
        rowSpan: 2,
        channelKey: "can1",
        aliases: ["R07C3"]
    },
    R08C3: {
        label: "CAN 2",
        title: "CAN 2",
        typeLabel: "CAN",
        detail: "CAN position spanning R08C3 and R09C3",
        cssClass: "utility-can",
        rowSpan: 2,
        channelKey: "can2",
        aliases: ["R09C3"]
    }
};

const storage = {
    listFolders() {
        return apiRequest("/folders");
    },

    createFolder(data) {
        return apiRequest("/folders", {
            method: "POST",
            body: data || {}
        });
    },

    updateFolder(folderId, data) {
        return apiRequest(`/folders/${encodeURIComponent(folderId)}`, {
            method: "PATCH",
            body: data || {}
        });
    },

    deleteFolder(folderId) {
        return apiRequest(`/folders/${encodeURIComponent(folderId)}`, {
            method: "DELETE"
        });
    },

    listProjects() {
        return apiRequest("/projects");
    },

    createProject(data) {
        return apiRequest("/projects", {
            method: "POST",
            body: data || {}
        });
    },

    loadProject(projectId) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}`);
    },

    updateProject(projectId, data) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}`, {
            method: "PATCH",
            body: data
        });
    },

    deleteProject(projectId) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}`, {
            method: "DELETE"
        });
    },

    savePosition(projectId, setupType, positionId, data) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}/setups/${encodeURIComponent(setupType)}/positions/${encodeURIComponent(positionId)}`, {
            method: "PUT",
            body: data
        });
    },

    deletePosition(projectId, setupType, positionId, data) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}/setups/${encodeURIComponent(setupType)}/positions/${encodeURIComponent(positionId)}`, {
            method: "DELETE",
            body: data
        });
    },

    replaceSetup(projectId, setupType, data) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}/setups/${encodeURIComponent(setupType)}`, {
            method: "PUT",
            body: data
        });
    },

    getUpdates(projectId) {
        return apiRequest(`/projects/${encodeURIComponent(projectId)}/updates`);
    }
};

let appState = createInitialState();
let dom = {};
let currentProjectId = null;
let projectBrowserState = { projects: [], folders: [], query: "", currentFolderId: null, selectedItem: null, clipboard: null };
let positionElements = new Map();
let utilityElements = new Map();
let editorContext = null;
let boardClipboard = null;
let selectionDragStart = null;
let selectionDragMoved = false;
let suppressNextPositionClick = false;
let saveIndicatorTimer = null;
let projectNameDraft = "";
let undoStack = [];
let redoStack = [];
let historySnapshot = null;
const MAX_HISTORY_STEPS = 80;
let metadataSaveTimer = null;
let pollingTimer = null;
let projectBrowserPollingTimer = null;
let isApplyingRemoteUpdate = false;
let lastProjectRevision = null;

document.addEventListener("DOMContentLoaded", () => {
    initializeApp().catch((error) => {
        console.error(error);
        setSaveIndicator("Offline", "error");
        showToast("Server unavailable");
    });
});

async function initializeApp() {
    cacheDom();
    appState = createInitialState();
    historySnapshot = createHistorySnapshot(appState);
    createGrid();
    bindEvents();
    const projectId = getProjectIdFromUrl();
    if (projectId) {
        await openProject(projectId, { pushUrl: false });
    } else {
        await showProjectBrowser({ pushUrl: false });
    }
}

function cacheDom() {
    dom = {
        projectNameRegion: document.getElementById("projectNameRegion"),
        projectNameButton: document.getElementById("projectNameButton"),
        projectNameText: document.getElementById("projectNameText"),
        setupTabs: Array.from(document.querySelectorAll("[data-setup-tab]")),
        modeButtons: Array.from(document.querySelectorAll("[data-interaction-mode]")),
        projectInfoForm: document.getElementById("projectInfoForm"),
        projectFields: Array.from(document.querySelectorAll("[data-project-field]")),
        canoeAttachment: document.getElementById("canoeAttachment"),
        hardwareSearch: document.getElementById("hardwareSearch"),
        clearSearchButton: document.getElementById("clearSearchButton"),
        copySetupButton: document.getElementById("copySetupButton"),
        pasteSetupButton: document.getElementById("pasteSetupButton"),
        importButton: document.getElementById("importButton"),
        exportButton: document.getElementById("exportButton"),
        helpButton: document.getElementById("helpButton"),
        newProjectButton: document.getElementById("newProjectButton"),
        allProjectsButton: document.getElementById("allProjectsButton"),
        newFolderButton: document.getElementById("newFolderButton"),
        newProjectBrowserButton: document.getElementById("newProjectBrowserButton"),
        copySelectionButton: document.getElementById("copySelectionButton"),
        pasteSelectionButton: document.getElementById("pasteSelectionButton"),
        projectBrowser: document.getElementById("projectBrowser"),
        projectSearch: document.getElementById("projectSearch"),
        projectList: document.getElementById("projectList"),
        workspace: document.querySelector(".workspace"),
        importFileInput: document.getElementById("importFileInput"),
        canoeFileInput: document.getElementById("canoeFileInput"),
        saveIndicator: document.getElementById("saveIndicator"),
        saveIndicatorText: document.getElementById("saveIndicatorText"),
        mapHint: document.getElementById("mapHint"),
        searchStatus: document.getElementById("searchStatus"),
        mapScroll: document.getElementById("mapScroll"),
        hardwareGrid: document.getElementById("hardwareGrid"),
        setupSummary: document.getElementById("setupSummary"),
        positionDetailsContent: document.getElementById("positionDetailsContent"),
        modalOverlay: document.getElementById("modalOverlay"),
        modalContent: document.getElementById("modalContent"),
        toastRegion: document.getElementById("toastRegion"),
        hardwareTooltip: document.getElementById("hardwareTooltip"),
        positionContextMenu: document.getElementById("positionContextMenu")
    };
}

function bindEvents() {
    dom.projectNameButton.addEventListener("click", startProjectNameEdit);

    dom.setupTabs.forEach((button) => {
        button.addEventListener("click", () => switchSetup(button.dataset.setupTab));
    });

    dom.modeButtons.forEach((button) => {
        button.addEventListener("click", () => switchInteractionMode(button.dataset.interactionMode));
    });

    dom.projectFields.forEach((field) => {
        field.addEventListener("input", () => {
            if (!isEditMode()) {
                renderProjectInfo();
                return;
            }
            const key = field.dataset.projectField;
            appState.project[key] = field.value;
            saveToLocalStorage();
        });

        field.addEventListener("blur", () => {
            if (!isEditMode()) {
                renderProjectInfo();
                return;
            }
            const key = field.dataset.projectField;
            const trimmed = normalizeString(field.value);
            appState.project[key] = trimmed;
            field.value = trimmed;
            flushProjectSaveNow();
        });
    });

    if (dom.hardwareSearch) {
        dom.hardwareSearch.addEventListener("input", handleSearch);
    }
    if (dom.clearSearchButton) {
        dom.clearSearchButton.addEventListener("click", clearSearch);
    }
    dom.copySetupButton.addEventListener("click", copyCurrentSetup);
    dom.pasteSetupButton.addEventListener("click", pasteCopiedSetup);
    dom.copySelectionButton.addEventListener("click", copyBoardSelection);
    dom.pasteSelectionButton.addEventListener("click", () => pasteSelectionClipboard());
    dom.allProjectsButton.addEventListener("click", () => {
        projectBrowserState.currentFolderId = null;
        showProjectBrowser();
    });
    dom.newFolderButton.addEventListener("click", openNewFolderModal);
    dom.newProjectBrowserButton.addEventListener("click", createNewServerProject);

    dom.importButton.addEventListener("click", () => {
        if (currentProjectId && !isEditMode()) {
            showToast("Switch to Edit mode to import");
            return;
        }
        dom.importFileInput.click();
    });
    dom.exportButton.addEventListener("click", exportProject);
    dom.helpButton.addEventListener("click", openUsageGuide);
    dom.newProjectButton.addEventListener("click", requestNewProject);
    dom.importFileInput.addEventListener("change", importProject);
    dom.canoeFileInput.addEventListener("change", attachCanoeFile);

    dom.modalOverlay.addEventListener("click", (event) => {
        if (event.target === dom.modalOverlay) {
            closeModal();
        }
    });

    document.addEventListener("click", (event) => {
        if (!dom.positionContextMenu.hidden && dom.positionContextMenu.contains(event.target)) {
            return;
        }
        clearSelectionOnOutsideGridClick(event);
        if (!dom.positionContextMenu.hidden) {
            hidePositionContextMenu();
        }
    });

    document.addEventListener("scroll", hidePositionContextMenu, true);
    window.addEventListener("resize", hidePositionContextMenu);
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", () => {
        updatePollingState();
        updateProjectBrowserPollingState();
    });
    document.addEventListener("pointerup", endPositionDragSelection);
    dom.projectSearch.addEventListener("input", () => {
        projectBrowserState.query = dom.projectSearch.value;
        renderProjectBrowserList();
    });
    dom.projectList.addEventListener("contextmenu", openProjectBrowserContextMenu);

    document.addEventListener("keydown", (event) => {
        if (handleProjectBrowserKeyboardShortcut(event)) {
            return;
        }

        if (handleBoardKeyboardShortcut(event)) {
            return;
        }

        if (event.key !== "Escape") {
            return;
        }

        if (!dom.modalOverlay.hidden) {
            closeModal();
            return;
        }

        if (!dom.positionContextMenu.hidden) {
            hidePositionContextMenu();
            return;
        }

        if (editorContext) {
            closeHardwareEditor();
            return;
        }

        if (dom.projectNameRegion.querySelector(".project-name-form")) {
            cancelProjectNameEdit();
        }
    });
}

function createInitialState() {
    return {
        version: 1,
        activeSetup: "checkpoint",
        project: {
            name: DEFAULT_PROJECT_NAME,
            harness: "",
            ecuName: "",
            partNumber: "",
            calibrationId: "",
            canoeFile: null,
            notes: ""
        },
        setups: {
            checkpoint: createInitialSetup(),
            container: createInitialSetup()
        },
        boardOptions: {
            powerLinked: true
        },
        selectedPosition: null,
        selectedPositions: [],
        selectionAnchor: null,
        selectedRange: null,
        searchQuery: "",
        interactionMode: "view"
    };
}

function createInitialSetup() {
    return {
        positions: {},
        canChannels: { ...DEFAULT_CAN_CHANNELS }
    };
}

function createGrid() {
    positionElements = new Map();
    utilityElements = new Map();
    dom.hardwareGrid.innerHTML = "";

    const corner = document.createElement("div");
    corner.className = "grid-corner";
    corner.setAttribute("aria-hidden", "true");
    corner.style.gridColumn = "1";
    corner.style.gridRow = "1";
    dom.hardwareGrid.appendChild(corner);

    for (let column = 1; column <= POSITION_COLUMNS; column += 1) {
        const label = document.createElement("div");
        label.className = "column-label";
        label.textContent = String(column);
        label.style.gridColumn = String(column + 1);
        label.style.gridRow = "1";
        dom.hardwareGrid.appendChild(label);
    }

    for (let row = 1; row <= POSITION_ROWS; row += 1) {
        const rowLabel = document.createElement("div");
        rowLabel.className = "row-label";
        rowLabel.textContent = String(row).padStart(2, "0");
        rowLabel.style.gridColumn = "1";
        rowLabel.style.gridRow = String(row + 1);
        dom.hardwareGrid.appendChild(rowLabel);

        for (let column = 1; column <= POSITION_COLUMNS; column += 1) {
            if (shouldSkipVisualCell(row, column)) {
                continue;
            }

            const positionId = formatPositionId(row, column);
            const utility = getBoardUtility(positionId);
            if (utility) {
                createUtilityCell(positionId, row, column, utility);
                continue;
            }

            const button = document.createElement("button");
            button.type = "button";
            button.className = "position-cell";
            button.dataset.positionId = positionId;
            button.dataset.row = String(row);
            button.dataset.column = String(column);
            button.setAttribute("aria-label", positionId);
            placeGridCell(button, row, column, getVisualColumnSpan(row, column), 1);
            button.addEventListener("pointerdown", (event) => beginPositionDragSelection(event, positionId));
            button.addEventListener("pointerenter", () => extendPositionDragSelection(positionId));
            button.addEventListener("click", (event) => {
                if (suppressNextPositionClick) {
                    suppressNextPositionClick = false;
                    return;
                }
                selectPosition(positionId, {
                    range: event.shiftKey,
                    toggle: event.ctrlKey || event.metaKey
                });
            });
            button.addEventListener("contextmenu", (event) => openPositionContextMenu(event, positionId));
            button.addEventListener("mouseenter", (event) => showPositionTooltip(positionId, event));
            button.addEventListener("mousemove", moveTooltip);
            button.addEventListener("mouseleave", hideTooltip);
            button.addEventListener("focus", (event) => showPositionTooltip(positionId, event));
            button.addEventListener("blur", hideTooltip);
            positionElements.set(positionId, button);
            dom.hardwareGrid.appendChild(button);
        }
    }

    const powerLink = document.createElement("div");
    powerLink.className = "power-link-line";
    powerLink.setAttribute("aria-hidden", "true");
    placeGridCell(powerLink, 1, 3, 1, 2);
    dom.powerLinkLine = powerLink;
    dom.hardwareGrid.appendChild(powerLink);
}

function createUtilityCell(positionId, row, column, utility) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `position-cell board-utility-cell ${utility.cssClass}`;
    button.dataset.positionId = positionId;
    button.dataset.row = String(row);
    button.dataset.column = String(column);
    button.textContent = utility.label;
    button.setAttribute("aria-label", buildUtilityAriaLabel(positionId, utility));
    placeGridCell(button, row, column, 1, utility.rowSpan || 1);
    button.addEventListener("click", (event) => {
        if (suppressNextPositionClick) {
            suppressNextPositionClick = false;
            return;
        }
        selectPosition(positionId, {
            range: event.shiftKey,
            toggle: event.ctrlKey || event.metaKey
        });
    });
    button.addEventListener("contextmenu", (event) => openPositionContextMenu(event, positionId));
    button.addEventListener("mouseenter", (event) => showPositionTooltip(positionId, event));
    button.addEventListener("mousemove", moveTooltip);
    button.addEventListener("mouseleave", hideTooltip);
    button.addEventListener("focus", (event) => showPositionTooltip(positionId, event));
    button.addEventListener("blur", hideTooltip);
    utilityElements.set(positionId, button);
    dom.hardwareGrid.appendChild(button);
}

function placeGridCell(element, row, column, columnSpan, rowSpan) {
    element.style.gridColumn = `${column + 1} / span ${columnSpan}`;
    element.style.gridRow = `${row + 1} / span ${rowSpan}`;
}

function renderApp() {
    renderProjectName();
    renderProjectInfo();
    renderSetupTabs();
    renderInteractionMode();
    renderSearch();
    renderGrid();
    renderBoardClipboardControls();
    renderSetupSummary();
    renderPositionDetails();
}

async function apiRequest(path, options = {}) {
    const requestOptions = {
        method: options.method || "GET",
        headers: {
            "Accept": "application/json"
        }
    };

    if (Object.prototype.hasOwnProperty.call(options, "body")) {
        requestOptions.headers["Content-Type"] = "application/json";
        requestOptions.body = JSON.stringify(options.body || {});
    }

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, requestOptions);
    } catch (error) {
        const networkError = new Error("Server unavailable");
        networkError.status = 0;
        throw networkError;
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
        const error = new Error(data && data.message ? data.message : "Request failed");
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

function getProjectIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("project");
    return /^\d+$/.test(id || "") ? id : null;
}

async function handlePopState() {
    const projectId = getProjectIdFromUrl();
    if (projectId) {
        await openProject(projectId, { pushUrl: false });
    } else {
        await showProjectBrowser({ pushUrl: false });
    }
}

function setEditorVisible(visible) {
    dom.projectBrowser.hidden = visible;
    dom.workspace.hidden = !visible;
    dom.allProjectsButton.hidden = !visible;
    dom.copySetupButton.hidden = !visible;
    dom.pasteSetupButton.hidden = !visible;
    dom.exportButton.hidden = !visible;
    dom.newProjectButton.hidden = visible;
    if (dom.hardwareSearch) {
        dom.hardwareSearch.closest(".search-field").hidden = !visible;
    }
    dom.setupTabs[0].parentElement.hidden = !visible;
    document.body.classList.toggle("is-project-browser", !visible);

    if (!visible) {
        dom.projectNameText.textContent = "All Projects";
        dom.projectNameButton.disabled = true;
        dom.projectNameButton.title = "Open a project to edit its name";
        dom.newProjectButton.hidden = false;
        dom.newProjectButton.disabled = false;
        dom.importButton.disabled = false;
        dom.newProjectButton.title = "Create a new project";
        dom.importButton.title = "Import project JSON";
    }
}

async function showProjectBrowser(options = {}) {
    stopProjectPolling();
    currentProjectId = null;
    appState = createInitialState();
    editorContext = null;
    if (!boardClipboard || boardClipboard.kind !== "setup") {
        boardClipboard = null;
    }
    clearSelectionState();
    setEditorVisible(false);
    setSaveIndicator("Syncing...", "saving");

    try {
        const [projectData, folderData] = await Promise.all([
            storage.listProjects(),
            storage.listFolders()
        ]);
        projectBrowserState.projects = projectData.projects || [];
        projectBrowserState.folders = folderData.folders || [];
        renderProjectBrowserList();
        startProjectBrowserPolling();
        setSaveIndicator("Online", "saved");
    } catch (error) {
        setSaveIndicator("Offline", "error");
        showToast("Server unavailable");
    }

    if (options.pushUrl !== false) {
        history.pushState({}, "", window.location.pathname);
    }
}

function renderProjectBrowserList() {
    const query = normalizeSearch(projectBrowserState.query);
    const currentFolder = getBrowserCurrentFolder();
    const folders = projectBrowserState.folders.filter((folder) => {
        if (!query) {
            return String(folder.parentFolderId || "") === String(projectBrowserState.currentFolderId || "");
        }
        return !query || normalizeSearch(folder.name).includes(query);
    });
    const projects = projectBrowserState.projects.filter((project) => {
        const folderName = getFolderName(project.folderId);
        const matchesQuery = !query || [
            project.name,
            project.ecuName,
            project.harness,
            project.partNumber,
            folderName
        ].some((value) => normalizeSearch(value).includes(query));
        const matchesFolder = query
            ? true
            : String(project.folderId || "") === String(projectBrowserState.currentFolderId || "");
        return matchesQuery && matchesFolder;
    });

    dom.projectList.innerHTML = "";
    renderProjectBrowserPath(currentFolder);

    if (!folders.length && !projects.length) {
        const empty = document.createElement("div");
        empty.className = "empty-projects";
        empty.textContent = projectBrowserState.projects.length || projectBrowserState.folders.length
            ? "No items matched your search."
            : "No projects yet. Create a folder or project to begin.";
        dom.projectList.appendChild(empty);
        return;
    }

    if (folders.length) {
        renderProjectGroup(query ? "Matching folders" : "Folders", folders.map(createFolderCard));
    }

    if (projects.length) {
        renderProjectGroup(query ? "Matching projects" : "Projects", projects.map(createProjectCard));
    }
}

function renderProjectBrowserPath(currentFolder) {
    const path = document.createElement("div");
    path.className = "project-browser-path";

    if (currentFolder) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "project-back-button";
        back.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 18-6-6 6-6"></path>
            </svg>
            <span>Back</span>
        `;
        back.addEventListener("click", () => openBrowserFolder(currentFolder.parentFolderId || null));
        path.appendChild(back);
    }

    const root = document.createElement("button");
    root.type = "button";
    root.className = "project-path-button";
    root.textContent = "All Projects";
    root.addEventListener("click", () => openBrowserFolder(null));
    root.addEventListener("contextmenu", (event) => openProjectBrowserContextMenu(event, true));
    root.addEventListener("dragover", (event) => event.preventDefault());
    root.addEventListener("drop", async (event) => {
        event.preventDefault();
        const projectId = event.dataTransfer.getData("text/project-id");
        if (projectId) {
            await moveProjectToFolder(projectId, null);
            return;
        }
        const folderId = event.dataTransfer.getData("text/folder-id");
        if (folderId) {
            await moveFolderToFolder(folderId, null);
        }
    });
    path.appendChild(root);

    if (currentFolder) {
        const separator = document.createElement("span");
        separator.className = "project-path-separator";
        separator.textContent = "/";
        const current = document.createElement("span");
        current.className = "project-path-current";
        current.textContent = currentFolder.name;
        path.append(separator, current);
    }

    dom.projectList.appendChild(path);
}

function renderProjectGroup(title, items) {
    const group = document.createElement("section");
    group.className = "project-group";

    const header = document.createElement("div");
    header.className = "project-group-header";
    header.innerHTML = `
        <span class="project-group-title">${escapeHtml(title)}</span>
        <span class="project-group-count">${items.length}</span>
    `;
    group.appendChild(header);
    items.forEach((item) => group.appendChild(item));
    dom.projectList.appendChild(group);
}

function createFolderCard(folder) {
    const card = createBrowserItemCard("folder", folder.id);
    card.classList.add("project-folder-card");
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/folder-id", String(folder.id));
        event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dblclick", () => openBrowserFolder(folder.id));
    card.addEventListener("contextmenu", (event) => openFolderContextMenu(event, folder));
    card.addEventListener("dragover", (event) => {
        event.preventDefault();
        card.classList.add("is-drop-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("is-drop-target"));
    card.addEventListener("drop", async (event) => {
        event.preventDefault();
        card.classList.remove("is-drop-target");
        const projectId = event.dataTransfer.getData("text/project-id");
        if (projectId) {
            await moveProjectToFolder(projectId, folder.id);
            return;
        }
        const folderId = event.dataTransfer.getData("text/folder-id");
        if (folderId) {
            await moveFolderToFolder(folderId, folder.id);
        }
    });

    const count = getProjectCountInFolder(folder.id);
    card.innerHTML = `
        <div class="project-item-icon" aria-hidden="true">
            <svg class="icon" viewBox="0 0 24 24">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
            </svg>
        </div>
        <div class="project-card-main">
            <h2 class="project-card-title">${escapeHtml(folder.name)}</h2>
            <div class="project-card-meta">
                <span>${count} project${count === 1 ? "" : "s"}</span>
                <span>Updated ${escapeHtml(formatRelativeTime(folder.updatedAt))}</span>
            </div>
        </div>
    `;
    return card;
}

function createProjectCard(project) {
    const card = createBrowserItemCard("project", project.id);
    card.draggable = true;
    card.addEventListener("dblclick", () => openProject(project.id));
    card.addEventListener("contextmenu", (event) => openProjectContextMenu(event, project));
    card.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/project-id", String(project.id));
        event.dataTransfer.effectAllowed = "move";
    });

    card.innerHTML = `
        <div class="project-item-icon" aria-hidden="true">
            <svg class="icon" viewBox="0 0 24 24">
                <path d="M6 3h8l4 4v14H6z"></path>
                <path d="M14 3v5h5"></path>
            </svg>
        </div>
        <div class="project-card-main">
            <h2 class="project-card-title">${escapeHtml(project.name || DEFAULT_PROJECT_NAME)}</h2>
            <div class="project-card-meta">
                <span>${escapeHtml(project.ecuName || "No ECU")}</span>
                <span>${escapeHtml(project.harness || "No harness")}</span>
                <span>${escapeHtml(getFolderName(project.folderId) || "Root")}</span>
                <span>Updated ${escapeHtml(formatRelativeTime(project.updatedAt))}</span>
            </div>
        </div>
    `;
    return card;
}

function createBrowserItemCard(kind, id) {
    const card = document.createElement("article");
    card.className = "project-card project-browser-item";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.dataset.browserKind = kind;
    card.dataset.browserId = String(id);
    card.addEventListener("click", () => selectProjectBrowserItem(kind, id));
    card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
            return;
        }
        if (kind === "folder") {
            openBrowserFolder(id);
        } else {
            openProject(id);
        }
    });
    return card;
}

function selectProjectBrowserItem(kind, id) {
    projectBrowserState.selectedItem = { kind, id: String(id) };
    renderProjectBrowserSelection();
}

function renderProjectBrowserSelection() {
    Array.from(dom.projectList.querySelectorAll(".project-browser-item")).forEach((item) => {
        const selected = projectBrowserState.selectedItem
            && item.dataset.browserKind === projectBrowserState.selectedItem.kind
            && item.dataset.browserId === projectBrowserState.selectedItem.id;
        item.classList.toggle("is-selected", Boolean(selected));
    });
}

function getBrowserCurrentFolder() {
    if (!projectBrowserState.currentFolderId) {
        return null;
    }
    return projectBrowserState.folders.find((folder) => String(folder.id) === String(projectBrowserState.currentFolderId)) || null;
}

function getFolderName(folderId) {
    if (!folderId) {
        return "";
    }
    const folder = projectBrowserState.folders.find((item) => String(item.id) === String(folderId));
    return folder ? folder.name : "";
}

function getProjectCountInFolder(folderId) {
    return projectBrowserState.projects.filter((project) => String(project.folderId || "") === String(folderId || "")).length;
}

function projectStateToBrowserSummary(projectState) {
    const project = projectState && projectState.project ? projectState.project : {};
    return {
        id: projectState.id,
        folderId: projectState.folderId || null,
        name: project.name || DEFAULT_PROJECT_NAME,
        harness: project.harness || "",
        ecuName: project.ecuName || "",
        partNumber: project.partNumber || "",
        canoeFile: normalizeCanoeFile(project.canoeFile),
        updatedAt: projectState.updatedAt || new Date().toISOString()
    };
}

function openBrowserFolder(folderId) {
    projectBrowserState.currentFolderId = folderId ? String(folderId) : null;
    projectBrowserState.selectedItem = null;
    renderProjectBrowserList();
}

function folderStateToBrowserSummary(folderState) {
    return {
        id: folderState.id,
        parentFolderId: folderState.parentFolderId || null,
        name: folderState.name,
        createdAt: folderState.createdAt || new Date().toISOString(),
        updatedAt: folderState.updatedAt || new Date().toISOString()
    };
}

function getSelectedBrowserItem() {
    if (!projectBrowserState.selectedItem || dom.projectBrowser.hidden) {
        return null;
    }

    if (projectBrowserState.selectedItem.kind === "folder") {
        const folder = projectBrowserState.folders.find((item) => String(item.id) === projectBrowserState.selectedItem.id);
        return folder ? { kind: "folder", value: folder } : null;
    }

    const project = projectBrowserState.projects.find((item) => String(item.id) === projectBrowserState.selectedItem.id);
    return project ? { kind: "project", value: project } : null;
}

function handleProjectBrowserKeyboardShortcut(event) {
    if (dom.projectBrowser.hidden) {
        return false;
    }
    if (isEditableShortcutTarget(event.target)) {
        return false;
    }

    const selected = getSelectedBrowserItem();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteBrowserItem(projectBrowserState.currentFolderId || null);
        return true;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selected) {
        event.preventDefault();
        copyBrowserItem(selected.kind, selected.value, "copy");
        return true;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x" && selected) {
        event.preventDefault();
        copyBrowserItem(selected.kind, selected.value, "cut");
        return true;
    }

    if (!selected || !["Enter", "F2", "Delete"].includes(event.key)) {
        return false;
    }

    event.preventDefault();
    if (event.key === "Enter") {
        if (selected.kind === "folder") {
            openBrowserFolder(selected.value.id);
        } else {
            openProject(selected.value.id);
        }
        return true;
    }

    if (event.key === "F2") {
        if (selected.kind === "folder") {
            openRenameFolderModal(selected.value);
        } else {
            openRenameProjectModal(selected.value);
        }
        return true;
    }

    if (selected.kind === "folder") {
        requestDeleteFolder(selected.value);
    } else {
        requestDeleteProject(selected.value);
    }
    return true;
}

function isEditableShortcutTarget(target) {
    if (!target || target === document.body) {
        return false;
    }
    return target.closest("input, textarea, select, [contenteditable='true']");
}

function openFolderContextMenu(event, folder) {
    event.preventDefault();
    event.stopPropagation();
    selectProjectBrowserItem("folder", folder.id);
    const moveOptions = [
        {
            label: "Root",
            handler: () => moveFolderToFolder(folder.id, null)
        },
        ...projectBrowserState.folders
            .filter((item) => String(item.id) !== String(folder.id))
            .map((item) => ({
                label: item.name,
                handler: () => moveFolderToFolder(folder.id, item.id)
            }))
    ];
    const actions = [
        {
            label: "Open",
            handler: () => openBrowserFolder(folder.id)
        },
        {
            label: "Copy",
            handler: () => copyBrowserItem("folder", folder, "copy")
        },
        {
            label: "Cut",
            handler: () => copyBrowserItem("folder", folder, "cut")
        },
        {
            label: "Paste",
            handler: () => pasteBrowserItem(folder.id),
            disabled: !projectBrowserState.clipboard
        },
        {
            label: "Duplicate",
            handler: () => duplicateFolder(folder)
        },
        {
            label: "Rename",
            handler: () => openRenameFolderModal(folder)
        },
        {
            label: "Move To",
            submenu: moveOptions
        },
        {
            label: "Delete Folder",
            className: "is-danger",
            handler: () => requestDeleteFolder(folder)
        }
    ].filter((action) => !action.disabled);
    renderPositionContextMenu(actions);
    placePositionContextMenu(event.clientX, event.clientY);
}

function openProjectContextMenu(event, project) {
    event.preventDefault();
    event.stopPropagation();
    selectProjectBrowserItem("project", project.id);
    const moveOptions = [
        {
            label: "Root",
            handler: () => moveProjectToFolder(project.id, null)
        },
        ...projectBrowserState.folders.map((folder) => ({
            label: folder.name,
            handler: () => moveProjectToFolder(project.id, folder.id)
        }))
    ];
    const actions = [
        {
            label: "Open",
            handler: () => openProject(project.id)
        },
        {
            label: "Copy",
            handler: () => copyBrowserItem("project", project, "copy")
        },
        {
            label: "Cut",
            handler: () => copyBrowserItem("project", project, "cut")
        },
        {
            label: "Paste",
            handler: () => pasteBrowserItem(projectBrowserState.currentFolderId || null),
            disabled: !projectBrowserState.clipboard
        },
        {
            label: "Duplicate",
            handler: () => duplicateProject(project, project.folderId || projectBrowserState.currentFolderId || null)
        },
        {
            label: "Rename",
            handler: () => openRenameProjectModal(project)
        },
        {
            label: "Move To",
            submenu: moveOptions
        },
        {
            label: "Export",
            handler: () => exportProjectById(project.id)
        },
        {
            label: "Delete Project",
            className: "is-danger",
            handler: () => requestDeleteProject(project)
        }
    ].filter((action) => !action.disabled);
    renderPositionContextMenu(actions);
    placePositionContextMenu(event.clientX, event.clientY);
}

function openProjectBrowserContextMenu(event, force = false) {
    if (!force && (event.target.closest(".project-browser-item") || event.target.closest(".project-browser-path"))) {
        return;
    }

    event.preventDefault();
    projectBrowserState.selectedItem = null;
    renderProjectBrowserSelection();
    const targetFolderId = projectBrowserState.currentFolderId || null;
    const actions = [
        {
            label: "New Folder",
            handler: openNewFolderModal
        },
        {
            label: "New Project",
            handler: createNewServerProject
        },
        {
            label: "Paste",
            handler: () => pasteBrowserItem(targetFolderId),
            disabled: !projectBrowserState.clipboard
        }
    ].filter((action) => !action.disabled);
    renderPositionContextMenu(actions);
    placePositionContextMenu(event.clientX, event.clientY);
}

function copyBrowserItem(kind, item, operation = "copy") {
    projectBrowserState.clipboard = {
        operation,
        kind,
        id: String(item.id),
        name: item.name || DEFAULT_PROJECT_NAME
    };
    const action = operation === "cut" ? "cut" : "copied";
    showToast(kind === "folder" ? `Folder ${action}` : `Project ${action}`);
}

async function pasteBrowserItem(targetFolderId) {
    if (!projectBrowserState.clipboard) {
        showToast("Nothing to paste");
        return;
    }

    if (projectBrowserState.clipboard.kind === "folder") {
        const folder = projectBrowserState.folders.find((item) => String(item.id) === projectBrowserState.clipboard.id);
        if (!folder) {
            showToast("Folder not found");
            return;
        }
        if (projectBrowserState.clipboard.operation === "cut") {
            if (await moveFolderToFolder(folder.id, targetFolderId)) {
                projectBrowserState.clipboard = null;
            }
        } else {
            await duplicateFolder(folder, targetFolderId);
        }
        return;
    }

    const project = projectBrowserState.projects.find((item) => String(item.id) === projectBrowserState.clipboard.id);
    if (!project) {
        showToast("Project not found");
        return;
    }
    if (projectBrowserState.clipboard.operation === "cut") {
        if (await moveProjectToFolder(project.id, targetFolderId)) {
            projectBrowserState.clipboard = null;
        }
        return;
    }

    await duplicateProject(project, targetFolderId);
}

async function duplicateProject(project, targetFolderId) {
    setSaveIndicator("Saving...", "saving");
    try {
        const data = await storage.loadProject(project.id);
        const payload = createExportData(data.project);
        payload.project.name = createCopyName(payload.project.name, projectBrowserState.projects.map((item) => item.name));
        payload.folderId = targetFolderId || null;
        const created = await storage.createProject(payload);
        projectBrowserState.projects.unshift(projectStateToBrowserSummary(created.project));
        renderProjectBrowserList();
        setSaveIndicator("Online", "saved");
        showToast("Project duplicated");
    } catch (error) {
        setSaveIndicator("Offline", "error");
        showToast("Failed to duplicate project");
    }
}

async function duplicateFolder(folder, targetParentFolderId = folder.parentFolderId || null) {
    setSaveIndicator("Saving...", "saving");
    try {
        const folderData = await storage.createFolder({
            name: createCopyName(folder.name, projectBrowserState.folders.map((item) => item.name)),
            parentFolderId: targetParentFolderId || null
        });
        const sourceProjects = projectBrowserState.projects.filter((project) => String(project.folderId || "") === String(folder.id));
        for (const project of sourceProjects) {
            const data = await storage.loadProject(project.id);
            const payload = createExportData(data.project);
            payload.project.name = createCopyName(payload.project.name, projectBrowserState.projects.map((item) => item.name));
            payload.folderId = folderData.folder.id;
            const created = await storage.createProject(payload);
            projectBrowserState.projects.unshift(projectStateToBrowserSummary(created.project));
        }
        projectBrowserState.folders.push(folderData.folder);
        projectBrowserState.folders.sort((a, b) => a.name.localeCompare(b.name));
        renderProjectBrowserList();
        setSaveIndicator("Online", "saved");
        showToast("Folder duplicated");
    } catch (error) {
        setSaveIndicator("Offline", "error");
        showToast("Failed to duplicate folder");
    }
}

async function moveFolderToFolder(folderId, parentFolderId) {
    if (String(folderId) === String(parentFolderId || "")) {
        showToast("Cannot move folder into itself");
        return false;
    }

    try {
        const folder = projectBrowserState.folders.find((item) => String(item.id) === String(folderId));
        const data = await storage.updateFolder(folderId, {
            name: folder ? folder.name : undefined,
            parentFolderId: parentFolderId || null
        });
        const index = projectBrowserState.folders.findIndex((item) => String(item.id) === String(folderId));
        if (index >= 0) {
            projectBrowserState.folders[index] = folderStateToBrowserSummary(data.folder);
        }
        renderProjectBrowserList();
        showToast(parentFolderId ? "Folder moved" : "Folder moved to Root");
        return true;
    } catch (error) {
        showToast("Failed to move folder");
        return false;
    }
}

function createCopyName(baseName, existingNames) {
    const base = normalizeString(baseName) || DEFAULT_PROJECT_NAME;
    const names = new Set((existingNames || []).map((name) => normalizeString(name).toLowerCase()));
    let candidate = `${base} Copy`;
    let index = 2;

    while (names.has(candidate.toLowerCase())) {
        candidate = `${base} Copy ${index}`;
        index += 1;
    }

    return candidate;
}

function openNewFolderModal() {
    openFolderNameModal({
        title: "New Folder",
        subtitle: "Create a folder to group sub-projects.",
        actionLabel: "Create Folder",
        fieldLabel: "Folder Name",
        initialValue: "",
        onSubmit: async (name) => {
            const data = await storage.createFolder({
                name,
                parentFolderId: projectBrowserState.currentFolderId || null
            });
            projectBrowserState.folders.push(folderStateToBrowserSummary(data.folder));
            projectBrowserState.folders.sort((a, b) => a.name.localeCompare(b.name));
            showToast("Folder created");
            closeModal();
            renderProjectBrowserList();
        }
    });
}

function openRenameFolderModal(folder) {
    openFolderNameModal({
        title: "Rename Folder",
        subtitle: "Update the folder name. Projects inside it will stay in place.",
        actionLabel: "Save",
        fieldLabel: "Folder Name",
        initialValue: folder.name,
        onSubmit: async (name) => {
            const data = await storage.updateFolder(folder.id, { name });
            const index = projectBrowserState.folders.findIndex((item) => String(item.id) === String(folder.id));
            if (index >= 0) {
                projectBrowserState.folders[index] = folderStateToBrowserSummary(data.folder);
            }
            projectBrowserState.folders.sort((a, b) => a.name.localeCompare(b.name));
            showToast("Folder renamed");
            closeModal();
            renderProjectBrowserList();
        }
    });
}

function openFolderNameModal(options) {
    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">${escapeHtml(options.title)}</h2>
                <p class="modal-subtitle">${escapeHtml(options.subtitle)}</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <form class="modal-form" id="folderForm">
            <div class="modal-body">
                <label class="modal-field">
                    <span>${escapeHtml(options.fieldLabel || "Name")}</span>
                    <input id="folderNameInput" type="text" autocomplete="off" value="${escapeAttribute(options.initialValue || "")}" required>
                </label>
                <div class="form-error" id="folderFormError" role="alert"></div>
            </div>
            <div class="modal-footer">
                <button class="secondary-button" type="button" data-modal-close>Cancel</button>
                <button class="action-button primary" type="submit">${escapeHtml(options.actionLabel)}</button>
            </div>
        </form>
    `);
    bindModalCloseButtons();

    const form = document.getElementById("folderForm");
    const input = document.getElementById("folderNameInput");
    const error = document.getElementById("folderFormError");
    input.focus();
    input.select();
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = normalizeString(input.value);
        if (!name) {
            error.textContent = "Folder name is required.";
            input.focus();
            return;
        }
        try {
            await options.onSubmit(name);
        } catch (errorResponse) {
            error.textContent = "Folder could not be saved.";
        }
    });
}

function openRenameProjectModal(project) {
    openFolderNameModal({
        title: "Rename Project",
        subtitle: "Update the project name.",
        actionLabel: "Save",
        fieldLabel: "Project Name",
        initialValue: project.name || DEFAULT_PROJECT_NAME,
        onSubmit: async (name) => {
            const data = await storage.updateProject(project.id, { project: { name } });
            const index = projectBrowserState.projects.findIndex((item) => String(item.id) === String(project.id));
            if (index >= 0) {
                projectBrowserState.projects[index] = projectStateToBrowserSummary(data.project);
            }
            showToast("Project renamed");
            closeModal();
            renderProjectBrowserList();
        }
    });
}

function requestDeleteFolder(folder) {
    const count = getProjectCountInFolder(folder.id);
    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">Delete "${escapeHtml(folder.name)}"?</h2>
                <p class="modal-subtitle">${count ? `${count} project${count === 1 ? "" : "s"} will move back to Root.` : "This folder is empty."}</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <div class="modal-footer">
            <button class="secondary-button" type="button" data-modal-close>Cancel</button>
            <button class="danger-button" type="button" id="confirmDeleteFolderButton">Delete Folder</button>
        </div>
    `);
    bindModalCloseButtons();
    document.getElementById("confirmDeleteFolderButton").addEventListener("click", async () => {
        try {
            await storage.deleteFolder(folder.id);
            projectBrowserState.folders = projectBrowserState.folders.filter((item) => String(item.id) !== String(folder.id));
            projectBrowserState.projects = projectBrowserState.projects.map((project) => (
                String(project.folderId || "") === String(folder.id) ? { ...project, folderId: null } : project
            ));
            projectBrowserState.folders = projectBrowserState.folders.map((item) => (
                String(item.parentFolderId || "") === String(folder.id) ? { ...item, parentFolderId: null } : item
            ));
            if (String(projectBrowserState.currentFolderId || "") === String(folder.id)) {
                projectBrowserState.currentFolderId = null;
            }
            showToast("Folder deleted");
            closeModal();
            renderProjectBrowserList();
        } catch (error) {
            showToast("Failed to delete folder");
        }
    });
}

async function moveProjectToFolder(projectId, folderId) {
    try {
        const data = await storage.updateProject(projectId, { folderId: folderId || null });
        const index = projectBrowserState.projects.findIndex((project) => String(project.id) === String(projectId));
        if (index >= 0) {
            projectBrowserState.projects[index] = projectStateToBrowserSummary(data.project);
        }
        renderProjectBrowserList();
        showToast(folderId ? "Project moved" : "Project moved to Root");
        return true;
    } catch (error) {
        showToast("Failed to move project");
        return false;
    }
}

async function openProject(projectId, options = {}) {
    stopProjectBrowserPolling();
    stopProjectPolling();
    setSaveIndicator("Syncing...", "saving");

    try {
        const data = await storage.loadProject(projectId);
        currentProjectId = String(data.project.id);
        appState = normalizeState({
            ...data.project,
            activeSetup: appState.activeSetup,
            interactionMode: "view"
        });
        lastProjectRevision = data.project.revision || null;
        historySnapshot = createHistorySnapshot(appState);
        undoStack = [];
        redoStack = [];
        editorContext = null;
        if (!boardClipboard || boardClipboard.kind !== "setup") {
            boardClipboard = null;
        }
        clearSelectionState();
        setEditorVisible(true);
        renderApp();
        setSaveIndicator("Saved", "saved");
        startProjectPolling();
        if (options.pushUrl !== false) {
            history.pushState({ projectId: currentProjectId }, "", `${window.location.pathname}?project=${encodeURIComponent(currentProjectId)}`);
        }
    } catch (error) {
        currentProjectId = null;
        setSaveIndicator("Offline", "error");
        showToast(error.status === 404 ? "Project not found" : "Server unavailable");
        await showProjectBrowser({ pushUrl: options.pushUrl });
    }
}

async function createNewServerProject() {
    setSaveIndicator("Saving...", "saving");
    try {
        const data = await storage.createProject({
            project: createInitialState().project,
            folderId: projectBrowserState.currentFolderId || null
        });
        showToast("Project created");
        await openProject(data.project.id);
        switchInteractionMode("edit");
    } catch (error) {
        setSaveIndicator("Offline", "error");
        showToast("Failed to create project");
    }
}

function requestDeleteProject(project) {
    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">Delete "${escapeHtml(project.name || DEFAULT_PROJECT_NAME)}"?</h2>
                <p class="modal-subtitle">This will permanently remove the project and all hardware positions.</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <div class="modal-footer">
            <button class="secondary-button" type="button" data-modal-close>Cancel</button>
            <button class="danger-button" type="button" id="confirmDeleteProjectButton">Delete Project</button>
        </div>
    `);
    bindModalCloseButtons();
    document.getElementById("confirmDeleteProjectButton").addEventListener("click", async () => {
        await deleteProject(project.id);
        closeModal();
    });
}

async function deleteProject(projectId) {
    try {
        await storage.deleteProject(projectId);
        showToast("Project deleted");
        if (String(projectId) === currentProjectId) {
            await showProjectBrowser();
        } else {
            projectBrowserState.projects = projectBrowserState.projects.filter((project) => String(project.id) !== String(projectId));
            renderProjectBrowserList();
        }
    } catch (error) {
        showToast("Failed to delete project");
    }
}

function startProjectPolling() {
    stopProjectPolling();
    updatePollingState();
}

function stopProjectPolling() {
    window.clearInterval(pollingTimer);
    pollingTimer = null;
}

function startProjectBrowserPolling() {
    stopProjectBrowserPolling();
    updateProjectBrowserPollingState();
}

function stopProjectBrowserPolling() {
    window.clearInterval(projectBrowserPollingTimer);
    projectBrowserPollingTimer = null;
}

function updateProjectBrowserPollingState() {
    stopProjectBrowserPolling();
    if (currentProjectId || dom.projectBrowser.hidden || document.visibilityState === "hidden") {
        return;
    }

    projectBrowserPollingTimer = window.setInterval(refreshProjectBrowserItems, PROJECT_BROWSER_POLL_INTERVAL_MS);
}

async function refreshProjectBrowserItems() {
    if (currentProjectId || dom.projectBrowser.hidden || !dom.modalOverlay.hidden) {
        return;
    }

    try {
        const [projectData, folderData] = await Promise.all([
            storage.listProjects(),
            storage.listFolders()
        ]);
        projectBrowserState.projects = projectData.projects || [];
        projectBrowserState.folders = folderData.folders || [];
        if (projectBrowserState.currentFolderId && !getBrowserCurrentFolder()) {
            projectBrowserState.currentFolderId = null;
        }
        renderProjectBrowserList();
        setSaveIndicator("Online", "saved");
    } catch (error) {
        setSaveIndicator("Offline", "error");
    }
}

function updatePollingState() {
    stopProjectPolling();
    if (!currentProjectId || document.visibilityState === "hidden") {
        return;
    }

    pollingTimer = window.setInterval(pollProjectUpdates, PROJECT_POLL_INTERVAL_MS);
}

async function pollProjectUpdates() {
    if (!currentProjectId || isApplyingRemoteUpdate || !dom.modalOverlay.hidden) {
        return;
    }
    if (dom.projectInfoForm.contains(document.activeElement) || document.querySelector(".inline-editor")) {
        return;
    }

    try {
        const updates = await storage.getUpdates(currentProjectId);
        if (lastProjectRevision && updates.revision === lastProjectRevision) {
            return;
        }
        const data = await storage.loadProject(currentProjectId);
        applyRemoteProject(data.project);
    } catch (error) {
        setSaveIndicator("Offline", "error");
    }
}

function applyRemoteProject(projectData) {
    if (!projectData || String(projectData.id) !== String(currentProjectId)) {
        return;
    }

    isApplyingRemoteUpdate = true;
    appState = normalizeState({
        ...projectData,
        activeSetup: appState.activeSetup,
        interactionMode: appState.interactionMode
    });
    lastProjectRevision = projectData.revision || lastProjectRevision;
    clearSelectionState();
    editorContext = null;
    renderApp();
    setSaveIndicator("Synced", "saved");
    isApplyingRemoteUpdate = false;
}

function formatRelativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "recently";
    }

    const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) {
        return "just now";
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} hr ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderProjectName() {
    if (dom.projectNameRegion.querySelector(".project-name-form")) {
        return;
    }

    dom.projectNameText.textContent = normalizeString(appState.project.name) || DEFAULT_PROJECT_NAME;
    dom.projectNameButton.disabled = currentProjectId ? !isEditMode() : true;
    dom.projectNameButton.title = isEditMode() ? "Edit project name" : "Switch to Edit mode to edit project name";
}

function renderProjectInfo() {
    const readOnly = !isEditMode();
    dom.projectFields.forEach((field) => {
        field.readOnly = readOnly;
        field.setAttribute("aria-readonly", String(readOnly));
        field.classList.toggle("is-readonly", readOnly);
        if (document.activeElement === field) {
            return;
        }
        const key = field.dataset.projectField;
        field.value = appState.project[key] || "";
    });
    renderCanoeAttachment();
}

function renderCanoeAttachment() {
    if (!dom.canoeAttachment) {
        return;
    }

    const file = normalizeCanoeFile(appState.project.canoeFile);
    const editing = isEditMode();
    dom.canoeAttachment.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "canoe-summary";
    if (file) {
        summary.innerHTML = `
            <div class="canoe-file-main">
                <span class="canoe-file-name">${escapeHtml(file.name)}</span>
                <span class="canoe-file-meta">${escapeHtml(formatBytes(file.size))}${file.updatedAt ? ` · ${escapeHtml(formatDateTime(file.updatedAt))}` : ""}</span>
            </div>
        `;
    } else {
        summary.innerHTML = `
            <div class="canoe-file-main">
                <span class="canoe-file-name">No CANoe file attached</span>
                <span class="canoe-file-meta">Attach the CANoe file used for this project.</span>
            </div>
        `;
    }

    const actions = document.createElement("div");
    actions.className = "canoe-actions";

    if (file) {
        const downloadButton = document.createElement("button");
        downloadButton.className = "secondary-button";
        downloadButton.type = "button";
        downloadButton.textContent = "Download";
        downloadButton.addEventListener("click", downloadCanoeFile);
        actions.appendChild(downloadButton);
    }

    if (editing) {
        const attachButton = document.createElement("button");
        attachButton.className = "secondary-button";
        attachButton.type = "button";
        attachButton.textContent = file ? "Replace" : "Attach";
        attachButton.addEventListener("click", () => dom.canoeFileInput.click());
        actions.appendChild(attachButton);

        if (file) {
            const removeButton = document.createElement("button");
            removeButton.className = "danger-button";
            removeButton.type = "button";
            removeButton.textContent = "Remove";
            removeButton.addEventListener("click", removeCanoeFile);
            actions.appendChild(removeButton);
        }
    }

    dom.canoeAttachment.append(summary, actions);
}

function attachCanoeFile(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) {
        return;
    }

    if (!isEditMode()) {
        input.value = "";
        showToast("Switch to Edit mode to attach CANoe");
        return;
    }

    if (file.size > MAX_CANOE_FILE_BYTES) {
        input.value = "";
        showToast("CANoe file is too large");
        return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
        appState.project.canoeFile = {
            name: normalizeString(file.name),
            type: normalizeString(file.type),
            size: file.size,
            data: String(reader.result || ""),
            updatedAt: new Date().toISOString()
        };
        input.value = "";
        saveToLocalStorage();
        flushProjectSaveNow();
        renderProjectInfo();
        showToast("CANoe attached");
    });
    reader.addEventListener("error", () => {
        input.value = "";
        showToast("Failed to attach CANoe");
    });
    reader.readAsDataURL(file);
}

function downloadCanoeFile() {
    const file = normalizeCanoeFile(appState.project.canoeFile);
    if (!file) {
        showToast("No CANoe file attached");
        return;
    }

    const link = document.createElement("a");
    link.href = file.data;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function removeCanoeFile() {
    if (!isEditMode()) {
        showToast("Switch to Edit mode to remove CANoe");
        return;
    }

    appState.project.canoeFile = null;
    saveToLocalStorage();
    flushProjectSaveNow();
    renderProjectInfo();
    showToast("CANoe removed");
}

function renderSetupTabs() {
    dom.setupTabs.forEach((button) => {
        const isActive = button.dataset.setupTab === appState.activeSetup;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", String(isActive));
        button.tabIndex = isActive ? 0 : -1;
    });
}

function renderInteractionMode() {
    dom.modeButtons.forEach((button) => {
        const isActive = button.dataset.interactionMode === appState.interactionMode;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
    });

    const editing = isEditMode();
    const browsing = !currentProjectId;
    dom.projectNameButton.disabled = !editing;
    dom.projectNameButton.title = editing ? "Edit project name" : "Switch to Edit mode to edit project name";
    dom.importButton.disabled = currentProjectId ? !editing : false;
    dom.newProjectButton.hidden = Boolean(currentProjectId);
    dom.newProjectButton.disabled = currentProjectId ? true : false;
    dom.importButton.title = browsing || editing ? "Import project JSON" : "Switch to Edit mode to import";
    dom.newProjectButton.title = browsing || editing ? "Create a new project" : "Switch to Edit mode to create a new project";
}

function isEditMode() {
    return appState.interactionMode === "edit";
}

function renderSearch() {
    if (!dom.hardwareSearch || !dom.clearSearchButton) {
        return;
    }
    dom.hardwareSearch.value = appState.searchQuery;
    dom.clearSearchButton.hidden = !appState.searchQuery;
}

function renderGrid() {
    const positions = getActivePositions();
    const searchQuery = normalizeSearch(appState.searchQuery);
    const selectedSet = new Set(getSelectedPositionIds());
    const shouldShowActiveCell = isEditMode();
    let matchCount = 0;

    utilityElements.forEach((button, positionId) => {
        const utility = getBoardUtility(positionId);
        const matchesSearch = !searchQuery || utilityMatchesSearch(positionId, utility, searchQuery);
        if (searchQuery && matchesSearch) {
            matchCount += 1;
        }

        renderUtilityCell(button, positionId, utility);
        button.classList.toggle("is-selected", shouldShowActiveCell && appState.selectedPosition === positionId);
        button.classList.toggle("is-selection-member", selectedSet.has(positionId));
        button.classList.toggle("is-search-match", Boolean(searchQuery && matchesSearch));
        button.classList.toggle("is-search-dim", Boolean(searchQuery && !matchesSearch));
    });

    positionElements.forEach((button, positionId) => {
        const items = getPositionItems(positionId);
        const preset = getFixedPreset(positionId);

        const matchesSearch = !searchQuery || positionMatchesSearch(positionId, items, searchQuery, preset);
        if (searchQuery && matchesSearch) {
            matchCount += 1;
        }

        renderPosition(button, positionId, items, preset);
        button.classList.toggle("is-selected", shouldShowActiveCell && appState.selectedPosition === positionId);
        button.classList.toggle("is-selection-member", selectedSet.has(positionId));
        button.classList.toggle("is-search-match", Boolean(searchQuery && matchesSearch));
        button.classList.toggle("is-search-dim", Boolean(searchQuery && !matchesSearch));
    });

    renderMapHint(Boolean(searchQuery));
    if (searchQuery) {
        dom.searchStatus.textContent = `${matchCount} ${matchCount === 1 ? "position" : "positions"} matched`;
    } else {
        dom.searchStatus.textContent = "";
    }

    if (dom.powerLinkLine) {
        dom.powerLinkLine.hidden = !appState.boardOptions.powerLinked;
    }

    removeEmptyPositionRecords(positions);
    renderSetupSummary();
    renderBoardClipboardControls();
}

function renderUtilityCell(button, positionId, utility) {
    button.className = `position-cell board-utility-cell ${utility.cssClass}`;
    button.dataset.positionId = positionId;
    button.textContent = "";

    if (utility.typeLabel === "CAN") {
        const isActive = isCanChannelActive(utility.channelKey);
        const label = document.createElement("span");
        label.className = "utility-main-label";
        label.textContent = utility.label;

        const state = document.createElement("span");
        state.className = "utility-state";
        state.textContent = isActive ? "USED" : "OFF";

        button.append(label, state);
        button.classList.toggle("is-can-active", isActive);
        button.classList.toggle("is-can-inactive", !isActive);
    } else {
        button.textContent = utility.label;
    }

    button.setAttribute("aria-label", buildUtilityAriaLabel(positionId, utility));
    button.classList.toggle("is-power-separated", !appState.boardOptions.powerLinked && utility.typeLabel === "Power");
}

function renderMapHint(hasSearch) {
    const messages = {
        view: "View mode: click a position to view details",
        edit: "Edit mode: click, Shift-click, Ctrl-click, or drag to select cells"
    };
    dom.mapHint.textContent = messages[appState.interactionMode] || messages.view;
    dom.mapHint.classList.toggle("is-hidden", hasSearch);
}

function renderPosition(button, positionId, items, preset) {
    button.className = "position-cell";
    button.dataset.positionId = positionId;
    button.removeAttribute("data-preset-label");
    button.textContent = "";

    if (!items.length) {
        button.classList.add("is-empty");
        if (preset) {
            button.classList.add("has-fixed-preset", preset.cssClass);
            button.dataset.presetLabel = preset.marker;
            button.setAttribute("aria-label", `${getDisplayPositionLabel(positionId)}, empty, default ${getPresetLabel(preset)}`);
        } else {
            button.setAttribute("aria-label", `${getDisplayPositionLabel(positionId)}, empty`);
        }
        return;
    }

    const typeKey = getDominantType(items);
    const type = HARDWARE_TYPES[typeKey] || HARDWARE_TYPES.sensor;
    const allSensors = items.every((item) => item.type === "sensor");
    button.classList.add("is-filled", type.cssClass);
    button.classList.toggle("is-preset-exception", Boolean(preset && isPresetException(preset, items)));

    const firstRow = document.createElement("span");
    firstRow.className = "position-primary-row";

    const firstLine = document.createElement("span");
    firstLine.className = "position-line";
    firstLine.textContent = items[0].displayName || items[0].name;
    firstRow.appendChild(firstLine);

    if ((allSensors && items.length > 1) || (!allSensors && items.length > 2)) {
        const count = document.createElement("span");
        count.className = "position-count";
        count.textContent = `+${items.length - 1}`;
        firstRow.appendChild(count);
    }

    button.appendChild(firstRow);

    if (!allSensors && items.length === 2) {
        const row = document.createElement("span");
        row.className = "position-second-row";

        const secondLine = document.createElement("span");
        secondLine.className = "position-line";
        secondLine.textContent = items[1].displayName || items[1].name;
        row.appendChild(secondLine);

        button.appendChild(row);
    }

    button.setAttribute("aria-label", buildPositionAriaLabel(positionId, items));
}

function renderPositionDetails() {
    const container = dom.positionDetailsContent;
    container.innerHTML = "";

    if (!appState.selectedPosition) {
        const empty = document.createElement("div");
        empty.className = "empty-details";
        empty.textContent = "Select a position to view details";
        container.appendChild(empty);
        return;
    }

    const positionId = appState.selectedPosition;
    const selectedIds = getSelectedPositionIds();
    if (isEditMode() && selectedIds.length > 1 && selectedIds.includes(positionId)) {
        renderSelectionDetails(container);
        resetDetailsScroll();
        return;
    }

    const utility = getBoardUtility(positionId);
    if (utility) {
        renderUtilityDetails(container, positionId, utility);
        resetDetailsScroll();
        return;
    }

    const items = getPositionItems(positionId);

    if (editorContext && editorContext.positionId === positionId) {
        renderInlineHardwareEditor(container, positionId, items);
        resetDetailsScroll();
        return;
    }

    container.appendChild(createPositionHeader(positionId, items));

    if (!items.length) {
        const message = document.createElement("div");
        message.className = "empty-details";
        message.innerHTML = `<div><strong>${escapeHtml(getDisplayPositionLabel(positionId))}</strong><br>Empty position</div>`;
        container.appendChild(message);

        return;
    }

    if (items.length === 1) {
        renderSingleItemDetails(container, positionId, items[0]);
        return;
    }

    renderMultipleItemDetails(container, positionId, items);
    resetDetailsScroll();
}

function createPositionHeader(positionId, items) {
    const wrapper = document.createElement("div");
    wrapper.className = "position-title";

    const id = document.createElement("span");
    id.className = "position-id";
    id.textContent = getDisplayPositionLabel(positionId);
    wrapper.appendChild(id);

    if (items.length) {
        const pill = document.createElement("span");
        pill.className = "type-pill";
        const typeKey = getDominantType(items);
        const typeLabel = getPositionTypeLabel(items);
        setTypeVariables(pill, typeKey);
        pill.textContent = typeLabel;
        wrapper.appendChild(pill);
    }

    return wrapper;
}

function renderUtilityDetails(container, positionId, utility) {
    const header = document.createElement("div");
    header.className = "position-title";

    const id = document.createElement("span");
    id.className = "position-id";
    id.textContent = getDisplayPositionLabel(positionId);
    header.appendChild(id);

    const pill = document.createElement("span");
    pill.className = "type-pill utility-pill";
    pill.textContent = utility.typeLabel;
    header.appendChild(pill);
    container.appendChild(header);

    const details = document.createElement("div");
    details.className = "detail-list";
    details.appendChild(createDetailRow("Label", utility.title));
    details.appendChild(createDetailRow("Type", utility.typeLabel));
    details.appendChild(createDetailRow("Status", getUtilityStatusText(utility)));
    details.appendChild(createDetailRow("Notes", utility.detail));
    container.appendChild(details);

    if (isEditMode() && (utility.typeLabel === "Power" || utility.typeLabel === "CAN")) {
        const actions = [];

        if (utility.typeLabel === "Power") {
            actions.push({
                label: appState.boardOptions.powerLinked ? "Separate Sources" : "Link Sources",
                className: "secondary-button",
                handler: togglePowerLink
            });
        }

        if (utility.typeLabel === "CAN") {
            const isActive = isCanChannelActive(utility.channelKey);
            actions.push({
                label: isActive ? "Set Not Used" : "Set Used",
                className: "secondary-button",
                handler: () => toggleCanChannel(utility.channelKey)
            });
        }

        container.appendChild(createActionGroup(actions));
    }
}

function renderSingleItemDetails(container, positionId, item) {
    const details = document.createElement("div");
    details.className = "detail-list";
    details.appendChild(createDetailRow("Position", getDisplayPositionLabel(positionId)));
    details.appendChild(createDetailRow("Type", getTypeLabel(item.type)));
    details.appendChild(createDetailRow("Hardware Name", item.name));
    details.appendChild(createDetailRow("Display Name", item.displayName));
    details.appendChild(createDetailRow("Notes", item.notes || "-"));
    container.appendChild(details);

    const actions = [
        {
            label: "Copy Position Info",
            className: "secondary-button",
            handler: copyPositionInfo
        }
    ];


    if (isEditMode()) {
        actions.push(
            {
                label: "Edit",
                className: "ghost-button",
                handler: () => openHardwareEditor({ positionId, mode: "edit", itemIndex: 0 })
            },
            {
                label: "Clear Position",
                className: "danger-button",
                handler: () => clearPosition(positionId)
            }
        );
    }

    container.appendChild(createActionGroup(actions.filter(Boolean)));
}

function renderMultipleItemDetails(container, positionId, items) {
    const intro = document.createElement("div");
    intro.className = "detail-list";
    intro.appendChild(createDetailRow("Items", String(items.length)));
    container.appendChild(intro);

    const list = document.createElement("div");
    list.className = "sensor-list";

    items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "sensor-row";

        const main = document.createElement("div");
        main.className = "sensor-row-main";

        const name = document.createElement("p");
        name.className = "sensor-name";
        name.textContent = `${index + 1}. ${item.name}`;
        main.appendChild(name);

        const display = document.createElement("div");
        display.className = "sensor-display";
        display.textContent = item.displayName;
        main.appendChild(display);

        if (item.notes) {
            const notes = document.createElement("p");
            notes.className = "sensor-notes";
            notes.textContent = item.notes;
            main.appendChild(notes);
        }

        row.appendChild(main);

        if (isEditMode()) {
            const actions = createActionGroup([
                {
                    label: "Edit",
                    className: "ghost-button",
                    handler: () => openHardwareEditor({ positionId, mode: "edit", itemIndex: index })
                },
                {
                    label: "Delete",
                    className: "danger-button",
                    handler: () => removeSensor(positionId, index)
                }
            ]);
            actions.classList.add("sensor-actions");
            row.appendChild(actions);
        }
        list.appendChild(row);
    });

    container.appendChild(list);

    const actions = [
        {
            label: "Copy Position Info",
            className: "secondary-button",
            handler: copyPositionInfo
        }
    ];

    if (isEditMode()) {
        actions.push({
            label: "Clear Position",
            className: "danger-button",
            handler: () => clearPosition(positionId)
        });
    }

    container.appendChild(createActionGroup(actions));
}

function renderSelectionDetails(container) {
    const selectedIds = getSelectedPositionIds();
    const hardwareCount = selectedIds.reduce((total, positionId) => total + getPositionItems(positionId).length, 0);
    const bounds = getSelectionBounds(selectedIds);
    const rangeIds = bounds ? collectPositionIdsInRange(bounds) : [];
    const isContinuousRange = selectedIds.length > 1
        && rangeIds.length === selectedIds.length
        && selectedIds.every((positionId) => rangeIds.includes(positionId));
    const label = selectedIds.length === 1
        ? getDisplayPositionLabel(selectedIds[0])
        : isContinuousRange
            ? `${getDisplayPositionLabel(selectedIds[0])} to ${getDisplayPositionLabel(selectedIds[selectedIds.length - 1])}`
            : selectedIds.map(getDisplayPositionLabel).join(", ");

    const header = document.createElement("div");
    header.className = "position-title";

    const id = document.createElement("span");
    id.className = "position-id";
    id.textContent = "Selection";
    header.appendChild(id);

    const pill = document.createElement("span");
    pill.className = "type-pill";
    pill.textContent = `${selectedIds.length} positions`;
    header.appendChild(pill);
    container.appendChild(header);

    const details = document.createElement("div");
    details.className = "detail-list";
    details.appendChild(createDetailRow(isContinuousRange ? "Range" : "Cells", label));
    details.appendChild(createDetailRow("Hardware", String(hardwareCount)));
    const pasteTarget = getPasteTargetPositionId();
    details.appendChild(createDetailRow("Paste Target", pasteTarget ? getDisplayPositionLabel(pasteTarget) : "-"));
    container.appendChild(details);

    container.appendChild(createActionGroup([
        {
            label: "Copy Selection",
            className: "secondary-button",
            handler: copyBoardSelection
        },
        {
            label: "Paste Here",
            className: "secondary-button",
            handler: () => pasteSelectionClipboard()
        }
    ]));
}

function createDetailRow(label, value) {
    const row = document.createElement("div");
    row.className = "detail-row";

    const labelElement = document.createElement("div");
    labelElement.className = "detail-label";
    labelElement.textContent = label;
    row.appendChild(labelElement);

    const valueElement = document.createElement("div");
    valueElement.className = "detail-value";
    valueElement.textContent = value;
    row.appendChild(valueElement);

    return row;
}

function createActionGroup(actions) {
    const group = document.createElement("div");
    group.className = "detail-actions";

    actions.forEach((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = action.className;
        button.textContent = action.label;
        button.addEventListener("click", action.handler);
        group.appendChild(button);
    });

    return group;
}

function renderSetupSummary() {
    if (!dom.setupSummary) {
        return;
    }

    const summary = getSetupSummary(appState.activeSetup);
    const chips = [
        ["Hardware", summary.hardwareCount],
        ["Positions", summary.usedPositionCount],
        ["CAN", `${summary.activeCanCount}/2`],
        ["Squib", summary.typeCounts.squib],
        ["AOD", summary.typeCounts.aod],
        ["Sensor", summary.typeCounts.sensor],
        ["Phys SW", summary.typeCounts.physicalSwitch],
        ["Mech SW", summary.typeCounts.mechanicalSwitch]
    ];

    dom.setupSummary.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "summary-heading";

    const title = document.createElement("span");
    title.textContent = `${SETUP_LABELS[appState.activeSetup]} Summary`;
    heading.appendChild(title);

    const canStatus = document.createElement("span");
    canStatus.className = "summary-note";
    canStatus.textContent = `${summary.activeCanCount} CAN active`;
    heading.appendChild(canStatus);
    dom.setupSummary.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "summary-grid";
    chips.forEach(([label, value]) => {
        const item = document.createElement("div");
        item.className = "summary-chip";

        const valueElement = document.createElement("strong");
        valueElement.textContent = String(value);
        item.appendChild(valueElement);

        const labelElement = document.createElement("span");
        labelElement.textContent = label;
        item.appendChild(labelElement);

        grid.appendChild(item);
    });

    dom.setupSummary.appendChild(grid);
}

function getSetupSummary(setupName) {
    const setup = getSetupByName(setupName);
    const typeCounts = Object.keys(HARDWARE_TYPES).reduce((counts, typeKey) => {
        counts[typeKey] = 0;
        return counts;
    }, {});

    let hardwareCount = 0;
    let usedPositionCount = 0;

    Object.values(setup.positions).forEach((position) => {
        const items = Array.isArray(position.items) ? position.items : [];
        if (!items.length) {
            return;
        }

        usedPositionCount += 1;
        items.forEach((item) => {
            if (HARDWARE_TYPES[item.type]) {
                typeCounts[item.type] += 1;
                hardwareCount += 1;
            }
        });
    });

    const canChannels = getSetupCanChannels(setupName);
    const activeCanCount = Object.keys(DEFAULT_CAN_CHANNELS)
        .filter((channelKey) => Boolean(canChannels[channelKey]))
        .length;

    return {
        hardwareCount,
        usedPositionCount,
        activeCanCount,
        typeCounts
    };
}

function renderBoardClipboardControls() {
    const selectedIds = getSelectedPositionIds();
    const hasSelection = isEditMode() && selectedIds.length > 0;
    const hasSelectionClipboard = Boolean(boardClipboard && boardClipboard.kind === "selection");
    const hasSetupClipboard = Boolean(boardClipboard && boardClipboard.kind === "setup");

    dom.copySelectionButton.disabled = !hasSelection;
    dom.pasteSelectionButton.disabled = !isEditMode() || !hasSelectionClipboard || !getPasteTargetPositionId();

    dom.copySelectionButton.title = hasSelection ? "Copy selected hardware cells" : "Use Edit mode with click, Shift-click, Ctrl-click, or drag to choose cells";
    dom.pasteSelectionButton.title = hasSelectionClipboard ? "Paste copied cells at the selected target" : "Copy cells first";

    dom.pasteSetupButton.disabled = !isEditMode() || !hasSetupClipboard;
    dom.pasteSetupButton.classList.toggle("is-ready", isEditMode() && hasSetupClipboard);
    dom.pasteSetupButton.title = !isEditMode()
        ? "Switch to Edit mode to paste setup"
        : hasSetupClipboard
            ? `Paste ${SETUP_LABELS[boardClipboard.sourceSetup] || "copied"} setup here`
            : "Copy a setup first";
}

function beginPositionDragSelection(event, positionId) {
    if (!isEditMode() || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) {
        return;
    }

    event.preventDefault();
    hideTooltip();
    hidePositionContextMenu();
    selectionDragStart = positionId;
    selectionDragMoved = false;
    setSelectedRange(positionId, positionId);
}

function extendPositionDragSelection(positionId) {
    if (!selectionDragStart || !isEditMode()) {
        return;
    }

    if (positionId !== selectionDragStart) {
        selectionDragMoved = true;
    }

    setSelectedRange(selectionDragStart, positionId);
}

function endPositionDragSelection() {
    if (!selectionDragStart) {
        return;
    }

    if (selectionDragMoved) {
        suppressNextPositionClick = true;
        window.setTimeout(() => {
            suppressNextPositionClick = false;
        }, 0);
    }

    selectionDragStart = null;
    selectionDragMoved = false;
}

function setSelectedRange(startPositionId, endPositionId) {
    const range = createSelectionRange(startPositionId, endPositionId);
    if (!range) {
        return;
    }

    setSelectedPositions(collectPositionIdsInRange(range), endPositionId, {
        range,
        anchor: startPositionId
    });
}

function createSelectionRange(startPositionId, endPositionId) {
    const start = parsePositionId(startPositionId);
    const end = parsePositionId(endPositionId);
    if (!start || !end) {
        return null;
    }

    return createSelectionRangeFromCoordinates(start.row, start.column, end.row, end.column);
}

function createSelectionRangeFromCoordinates(startRow, startColumn, endRow, endColumn) {
    const minRow = Math.max(1, Math.min(startRow, endRow));
    const maxRow = Math.min(POSITION_ROWS, Math.max(startRow, endRow));
    const minColumn = Math.max(1, Math.min(startColumn, endColumn));
    const maxColumn = Math.min(POSITION_COLUMNS, Math.max(startColumn, endColumn));

    return {
        minRow,
        maxRow,
        minColumn,
        maxColumn
    };
}

function getSelectedPositionIds() {
    if (Array.isArray(appState.selectedPositions) && appState.selectedPositions.length) {
        return normalizeSelectedPositionIds(appState.selectedPositions);
    }

    if (appState.selectedRange) {
        return collectPositionIdsInRange(appState.selectedRange);
    }

    return [];
}

function collectPositionIdsInRange(range) {
    const ids = new Set();

    for (let row = range.minRow; row <= range.maxRow; row += 1) {
        for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
            const positionId = getCanonicalEditablePositionId(row, column);
            if (positionId) {
                ids.add(positionId);
            }
        }
    }

    return Array.from(ids).sort(comparePositionIds);
}

function isPositionInSelectedRange(positionId) {
    return getSelectedPositionIds().includes(positionId);
}

function clearBoardSelection() {
    clearSelectionState();
    editorContext = null;
    appState.selectedPosition = null;
    renderGrid();
    renderPositionDetails();
}

function clearSelectionState() {
    appState.selectedPositions = [];
    appState.selectionAnchor = null;
    appState.selectedRange = null;
}

function setSelectedPositions(positionIds, activePositionId, options = {}) {
    const ids = normalizeSelectedPositionIds(positionIds);
    appState.selectedPositions = ids;
    appState.selectedRange = options.range || null;
    appState.selectionAnchor = options.anchor === null
        ? null
        : getSelectablePositionId(options.anchor) || appState.selectionAnchor;

    if (!ids.length) {
        appState.selectionAnchor = null;
    } else if (!appState.selectionAnchor || !ids.includes(appState.selectionAnchor)) {
        appState.selectionAnchor = ids[0];
    }

    const activeId = getSelectablePositionId(activePositionId) || ids[ids.length - 1] || null;
    appState.selectedPosition = activeId;

    if (editorContext && (ids.length !== 1 || editorContext.positionId !== activeId)) {
        editorContext = null;
    }

    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
}

function selectSingleEditablePosition(positionId) {
    const selectableId = getSelectablePositionId(positionId);
    if (!selectableId) {
        return false;
    }

    setSelectedPositions([selectableId], selectableId, {
        anchor: selectableId
    });
    return true;
}

function addPositionToSelection(positionId) {
    const selectableId = getSelectablePositionId(positionId);
    if (!selectableId) {
        return false;
    }

    const nextIds = new Set(getSelectedPositionIds());
    nextIds.add(selectableId);
    setSelectedPositions(Array.from(nextIds), selectableId, {
        anchor: appState.selectionAnchor || selectableId
    });
    return true;
}

function removePositionFromSelection(positionId) {
    const selectableId = getSelectablePositionId(positionId);
    if (!selectableId) {
        return false;
    }

    const nextIds = getSelectedPositionIds().filter((id) => id !== selectableId);
    const nextAnchor = appState.selectionAnchor === selectableId
        ? nextIds[0] || null
        : appState.selectionAnchor;
    setSelectedPositions(nextIds, selectableId, {
        anchor: nextAnchor
    });
    return true;
}

function togglePositionSelection(positionId) {
    if (isPositionInSelectedRange(positionId)) {
        return removePositionFromSelection(positionId);
    }

    return addPositionToSelection(positionId);
}

function selectRangeToPosition(positionId) {
    const selectableId = getSelectablePositionId(positionId);
    if (!selectableId) {
        return false;
    }

    const anchor = getSelectablePositionId(appState.selectionAnchor)
        || getSelectablePositionId(appState.selectedPosition)
        || selectableId;
    setSelectedRange(anchor, selectableId);
    return true;
}

function normalizeSelectedPositionIds(positionIds) {
    if (!Array.isArray(positionIds)) {
        return [];
    }

    const ids = new Set();
    positionIds.forEach((positionId) => {
        const selectableId = getSelectablePositionId(positionId);
        if (selectableId) {
            ids.add(selectableId);
        }
    });

    return Array.from(ids).sort(comparePositionIds);
}

function getSelectablePositionId(positionId) {
    if (!isValidPositionId(positionId)) {
        return null;
    }

    const coords = parsePositionId(positionId);
    if (!coords) {
        return null;
    }

    return getCanonicalEditablePositionId(coords.row, coords.column);
}

function getSelectionBounds(positionIds) {
    const coords = normalizeSelectedPositionIds(positionIds)
        .map(parsePositionId)
        .filter(Boolean);

    if (!coords.length) {
        return null;
    }

    return coords.reduce((bounds, item) => ({
        minRow: Math.min(bounds.minRow, item.row),
        maxRow: Math.max(bounds.maxRow, item.row),
        minColumn: Math.min(bounds.minColumn, item.column),
        maxColumn: Math.max(bounds.maxColumn, item.column)
    }), {
        minRow: coords[0].row,
        maxRow: coords[0].row,
        minColumn: coords[0].column,
        maxColumn: coords[0].column
    });
}

function createSelectionRangeFromPositionIds(positionIds) {
    const bounds = getSelectionBounds(positionIds);
    return bounds ? createSelectionRangeFromCoordinates(bounds.minRow, bounds.minColumn, bounds.maxRow, bounds.maxColumn) : null;
}

function focusPositionForContextMenu(positionId) {
    if (editorContext && editorContext.positionId !== positionId) {
        editorContext = null;
    }

    appState.selectedPosition = null;
    if (getBoardUtility(positionId) || !isEditMode()) {
        clearSelectionState();
    }

    appState.selectedPosition = positionId;
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
}

async function copyBoardSelection() {
    const selectedIds = getSelectedPositionIds();
    if (!selectedIds.length) {
        showToast("No selection to copy");
        return;
    }

    const bounds = getSelectionBounds(selectedIds);
    if (!bounds) {
        showToast("No selection to copy");
        return;
    }

    const positions = getActivePositions();
    const cells = selectedIds
        .map((positionId) => {
            const position = positions[positionId];
            const items = position && Array.isArray(position.items) ? normalizeItems(position.items) : [];
            const coords = parsePositionId(positionId);
            return {
                rowOffset: coords.row - bounds.minRow,
                columnOffset: coords.column - bounds.minColumn,
                items: cloneItems(items)
            };
        })
        .filter(Boolean);

    boardClipboard = {
        kind: "selection",
        sourceSetup: appState.activeSetup,
        rowSpan: bounds.maxRow - bounds.minRow + 1,
        columnSpan: bounds.maxColumn - bounds.minColumn + 1,
        cells
    };

    renderBoardClipboardControls();
    const copied = await copyTextToClipboard(generateSelectionText(selectedIds));
    showToast(copied ? "Selection copied" : "Selection copied for paste");
}

function pasteSelectionClipboard() {
    const targetPositionId = getPasteTargetPositionId();
    pasteSelectionAt(targetPositionId);
}

function pasteSelectionAt(targetPositionId) {
    if (!boardClipboard || boardClipboard.kind !== "selection") {
        showToast("Nothing to paste");
        return;
    }

    const target = parsePositionId(targetPositionId);
    if (!target) {
        showToast("Select a target position");
        return;
    }

    const positions = getActivePositions();
    let pastedCount = 0;
    const pastedIds = [];
    const savedIds = [];
    const deletedIds = [];
    const deleteRevisionMap = {};

    boardClipboard.cells.forEach((cell) => {
        const row = target.row + cell.rowOffset;
        const column = target.column + cell.columnOffset;
        const destinationId = getCanonicalEditablePositionId(row, column);
        if (!destinationId) {
            return;
        }

        const revision = getPositionRevision(appState.activeSetup, destinationId);
        if (cell.items.length) {
            positions[destinationId] = {
                items: cloneItems(cell.items),
                revision
            };
            savedIds.push(destinationId);
        } else {
            deleteRevisionMap[destinationId] = revision;
            delete positions[destinationId];
            deletedIds.push(destinationId);
        }

        cleanupPosition(destinationId);
        pastedIds.push(destinationId);
        pastedCount += 1;
    });

    if (!pastedCount) {
        showToast("Selection could not be pasted here");
        return;
    }

    const targetId = getCanonicalEditablePositionId(target.row, target.column);
    appState.selectedPosition = targetId || pastedIds[0] || null;
    appState.selectedPositions = normalizeSelectedPositionIds(pastedIds);
    appState.selectedRange = createSelectionRangeFromPositionIds(pastedIds);
    appState.selectionAnchor = targetId || appState.selectedPositions[0] || null;

    hideTooltip();
    if (savedIds.length) {
        persistPositionsToServer(savedIds);
    }
    if (deletedIds.length) {
        persistDeletedPositionsToServer(deletedIds, deleteRevisionMap);
    }
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Selection pasted");
}

function getPasteTargetPositionId() {
    const selectedIds = getSelectedPositionIds();
    const selectedPosition = getSelectablePositionId(appState.selectedPosition);

    if (selectedPosition) {
        return selectedPosition;
    }

    if (selectedIds.length) {
        return selectedIds[0];
    }

    return null;
}

function generateSelectionText(positionIds) {
    const lines = [
        `${appState.project.name || DEFAULT_PROJECT_NAME}`,
        `Setup: ${SETUP_LABELS[appState.activeSetup]}`,
        "Selection:",
        ""
    ];

    positionIds.forEach((positionId) => {
        if (getPositionItems(positionId).length) {
            lines.push(generatePositionText(positionId));
        }
    });

    return lines.join("\n");
}

function selectPosition(positionId, options = {}) {
    hidePositionContextMenu();

    if (editorContext && editorContext.positionId !== positionId) {
        editorContext = null;
    }

    const utility = getBoardUtility(positionId);
    if (utility) {
        editorContext = null;
        clearSelectionState();
        appState.selectedPosition = positionId;
        renderGrid();
        renderPositionDetails();
        resetDetailsScroll();
        return;
    }

    if (isEditMode() && !options.skipAction) {
        if (options.range) {
            selectRangeToPosition(positionId);
            return;
        }

        if (options.toggle) {
            togglePositionSelection(positionId);
            return;
        }

        selectSingleEditablePosition(positionId);
        return;
    }

    clearSelectionState();
    appState.selectedPosition = positionId;
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
}

function openEditorForPosition(positionId) {
    if (getBoardUtility(positionId)) {
        showToast("Fixed board position");
        return;
    }

    const items = getPositionItems(positionId);
    const preset = getFixedPreset(positionId);

    if (!items.length) {
        openHardwareEditor({
            positionId,
            mode: "create",
            initialType: getInitialTypeFromPreset(preset)
        });
        return;
    }

    openHardwareEditor({ positionId, mode: "edit", itemIndex: 0 });
}

function quickToggleFixedPosition(positionId) {
    const preset = getFixedPreset(positionId);
    if (!preset) {
        return false;
    }

    if (preset.kind === "switch") {
        return quickToggleSwitchPosition(positionId);
    }

    return quickToggleSinglePresetPosition(positionId, preset.type);
}

function setPositionsToQuickType(positionIds, type) {
    if (!HARDWARE_TYPES[type]) {
        return;
    }

    const ids = normalizeSelectedPositionIds(positionIds);
    if (!ids.length) {
        showToast("No editable position selected");
        return;
    }

    const positions = getActivePositions();
    ids.forEach((positionId) => {
        positions[positionId] = {
            items: [createQuickItem(type)],
            revision: getPositionRevision(appState.activeSetup, positionId)
        };
        cleanupPosition(positionId);
    });

    editorContext = null;
    appState.selectedPositions = ids;
    appState.selectedPosition = ids[ids.length - 1];
    appState.selectedRange = createSelectionRangeFromPositionIds(ids);
    appState.selectionAnchor = ids[0];
    hideTooltip();
    persistPositionsToServer(ids);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware saved");
}

function clearPositions(positionIds) {
    const ids = normalizeSelectedPositionIds(positionIds);
    if (!ids.length) {
        showToast("No editable position selected");
        return;
    }

    const positions = getActivePositions();
    const revisionMap = {};
    ids.forEach((positionId) => {
        revisionMap[positionId] = getPositionRevision(appState.activeSetup, positionId);
        delete positions[positionId];
    });

    editorContext = null;
    appState.selectedPositions = ids;
    appState.selectedPosition = ids[ids.length - 1];
    appState.selectedRange = createSelectionRangeFromPositionIds(ids);
    appState.selectionAnchor = ids[0];
    hideTooltip();
    persistDeletedPositionsToServer(ids, revisionMap);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware removed");
}

function quickToggleSinglePresetPosition(positionId, type) {
    const positions = getActivePositions();
    const items = getPositionItems(positionId);
    const revision = getPositionRevision(appState.activeSetup, positionId);

    if (!items.length) {
        positions[positionId] = { items: [createQuickItem(type)], revision };
        persistPositionChange(positionId);
        return true;
    }

    if (items.length === 1 && isQuickItem(items[0], type)) {
        delete positions[positionId];
        persistPositionChange(positionId);
        return true;
    }

    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    return false;
}

function quickToggleSwitchPosition(positionId) {
    const positions = getActivePositions();
    const items = getPositionItems(positionId);
    const revision = getPositionRevision(appState.activeSetup, positionId);

    if (!items.length) {
        positions[positionId] = { items: [createQuickItem("mechanicalSwitch")], revision };
        persistPositionChange(positionId);
        return true;
    }

    if (items.length !== 1 || !isSwitchType(items[0].type)) {
        renderGrid();
        renderPositionDetails();
        resetDetailsScroll();
        return false;
    }

    if (items[0].type === "physicalSwitch") {
        delete positions[positionId];
        persistPositionChange(positionId);
        return true;
    }

    const nextType = "physicalSwitch";
    const nextItem = isQuickItem(items[0], items[0].type)
        ? createQuickItem(nextType)
        : { ...items[0], type: nextType };
    positions[positionId] = { items: [nextItem], revision };
    persistPositionChange(positionId);
    return true;
}

function persistPositionChange(positionId) {
    appState.selectedPosition = positionId;
    if (isEditMode()) {
        appState.selectedPositions = [positionId];
        appState.selectionAnchor = positionId;
        appState.selectedRange = null;
    }
    cleanupPosition(positionId);
    hideTooltip();
    persistPositionsToServer([positionId]);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
}

function switchSetup(setupName) {
    if (!SETUP_LABELS[setupName] || appState.activeSetup === setupName) {
        return;
    }

    hideTooltip();
    appState.activeSetup = setupName;
    appState.selectedPosition = null;
    editorContext = null;
    clearSelectionState();
    renderApp();
    resetDetailsScroll();
}

function switchInteractionMode(mode) {
    if (!INTERACTION_MODES[mode] || appState.interactionMode === mode) {
        return;
    }

    hidePositionContextMenu();
    hideTooltip();
    appState.interactionMode = mode;
    if (mode !== "edit") {
        editorContext = null;
        clearSelectionState();
    }
    renderInteractionMode();
    renderProjectName();
    renderProjectInfo();
    renderGrid();
    renderPositionDetails();
}

function handleSearch() {
    if (!dom.hardwareSearch) {
        return;
    }
    appState.searchQuery = dom.hardwareSearch.value;
    renderSearch();
    renderGrid();
}

function clearSearch() {
    appState.searchQuery = "";
    renderSearch();
    renderGrid();
    if (dom.hardwareSearch) {
        dom.hardwareSearch.focus();
    }
}

function cutBoardSelection() {
    const selectedIds = getSelectedPositionIds();
    if (!selectedIds.length) {
        showToast("No selection to cut");
        return;
    }

    const idsToClear = [...selectedIds];
    copyBoardSelection().then(() => {
        clearPositions(idsToClear);
        showToast("Selection cut");
    });
}

function clearSelectionOnOutsideGridClick(event) {
    if (!isEditMode() || !getSelectedPositionIds().length) {
        return;
    }

    const keepSelectionAreas = [
        dom.mapScroll,
        dom.positionContextMenu,
        document.querySelector(".board-clipboard-tools"),
        document.querySelector(".inline-editor")
    ].filter(Boolean);

    if (keepSelectionAreas.some((element) => element.contains(event.target))) {
        return;
    }

    clearBoardSelection();
}

function handleBoardKeyboardShortcut(event) {
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target.isContentEditable;

    if (isTyping || !dom.modalOverlay.hidden || (!event.ctrlKey && !event.metaKey)) {
        return false;
    }

    const key = event.key.toLowerCase();
    if (key === "z") {
        event.preventDefault();
        undoLastChange();
        return true;
    }

    if (key === "y") {
        event.preventDefault();
        redoLastChange();
        return true;
    }

    if (key === "c" && isEditMode() && getSelectedPositionIds().length) {
        event.preventDefault();
        copyBoardSelection();
        return true;
    }

    if (key === "x" && isEditMode() && getSelectedPositionIds().length) {
        event.preventDefault();
        cutBoardSelection();
        return true;
    }

    if (key === "v" && isEditMode() && boardClipboard && boardClipboard.kind === "selection") {
        event.preventDefault();
        pasteSelectionClipboard();
        return true;
    }

    return false;
}

function openPositionContextMenu(event, positionId) {
    event.preventDefault();
    hideTooltip();
    focusPositionForContextMenu(positionId);

    const utility = getBoardUtility(positionId);
    if (utility) {
        renderUtilityContextMenu(utility);
        placePositionContextMenu(event.clientX, event.clientY);
        return;
    }

    const items = getPositionItems(positionId);
    const preset = getFixedPreset(positionId);
    const selectedIds = getSelectedPositionIds();
    const positionIsSelected = isPositionInSelectedRange(positionId);
    const targetIds = isEditMode() && positionIsSelected && selectedIds.length > 1
        ? selectedIds
        : [positionId];
    const targetLabel = targetIds.length > 1 ? `${targetIds.length} Selected` : "Position";
    const actions = [];

    if (isEditMode() && shouldShowSetPositionSubmenu(preset)) {
        actions.push(createSetPositionSubmenuAction(preset, targetIds, items));
    }

    if (isEditMode() && targetIds.length > 1) {
        actions.push({
            label: "Clear Selected Hardware",
            className: "is-danger",
            handler: () => clearPositions(targetIds)
        });
    }

    if (isEditMode()) {
        actions.push({
            label: items.length ? "Edit" : "Add Hardware",
            handler: () => openEditorForPosition(positionId)
        });

        if (items.length > 1 && items.every((item) => item.type === "sensor")) {
            actions.push({
                label: "Edit Sensor",
                submenu: items.map((item, index) => ({
                    label: item.displayName || item.name || `Sensor ${index + 1}`,
                    handler: () => openHardwareEditor({ positionId, mode: "edit", itemIndex: index })
                }))
            });
        }

    }

    if (isEditMode() && boardClipboard && boardClipboard.kind === "selection") {
        actions.push({
            label: "Paste Here",
            handler: () => pasteSelectionAt(positionId)
        });
    }

    if (isEditMode() && isPositionInSelectedRange(positionId)) {
        actions.push({
            label: "Copy Selection",
            handler: copyBoardSelection
        });
    }


    if (items.length) {
        actions.push(
            {
                label: "Copy Position Info",
                handler: copyPositionInfo
            },
            isEditMode() ? {
                label: "Clear Position",
                className: "is-danger",
                handler: () => clearPosition(positionId)
            } : null
        );
    }

    renderPositionContextMenu(actions.filter(Boolean), preset);
    placePositionContextMenu(event.clientX, event.clientY);
}

function renderUtilityContextMenu(utility) {
    dom.positionContextMenu.innerHTML = "";

    const hint = document.createElement("div");
    hint.className = "context-menu-hint";
    hint.textContent = `${utility.title} - fixed board position`;
    dom.positionContextMenu.appendChild(hint);

    if (!isEditMode()) {
        const readOnlyHint = document.createElement("div");
        readOnlyHint.className = "context-menu-hint";
        readOnlyHint.textContent = "Switch to Edit mode to change this position.";
        dom.positionContextMenu.appendChild(readOnlyHint);
        return;
    }

    if (utility.typeLabel === "Power") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "context-menu-button";
        button.setAttribute("role", "menuitem");
        button.textContent = appState.boardOptions.powerLinked ? "Separate Sources" : "Link Sources";
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            hidePositionContextMenu();
            togglePowerLink();
        });
        dom.positionContextMenu.appendChild(button);
    }

    if (utility.typeLabel === "CAN") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "context-menu-button";
        button.setAttribute("role", "menuitem");
        button.textContent = isCanChannelActive(utility.channelKey) ? "Set Not Used" : "Set Used";
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            hidePositionContextMenu();
            toggleCanChannel(utility.channelKey);
        });
        dom.positionContextMenu.appendChild(button);
    }
}

function shouldShowSetPositionSubmenu(preset) {
    return Boolean(preset && (preset.type || preset.kind === "switch"));
}

function createSetPositionSubmenuAction(preset, targetIds, items) {
    if (preset.kind === "switch") {
        return {
            label: "Set Position To",
            submenu: [
                {
                    label: "Mechanical Switch",
                    handler: () => setPositionsToQuickType(targetIds, "mechanicalSwitch")
                },
                {
                    label: "Physical Switch",
                    handler: () => setPositionsToQuickType(targetIds, "physicalSwitch")
                }
            ]
        };
    }

    if (preset.type !== "sensor") {
        return {
            label: "Set Position To",
            submenu: [
                {
                    label: getTypeLabel(preset.type),
                    handler: () => setPositionsToQuickType(targetIds, preset.type)
                }
            ]
        };
    }

    const hasSensor = items.length && items.every((item) => item.type === "sensor");
    return {
        label: hasSensor ? "Add Sensor" : "Set Position To",
        submenu: SENSOR_CONTEXT_OPTIONS.map((displayName) => ({
            label: displayName,
            handler: () => addSensorOptionToPositions(targetIds, displayName)
        }))
    };
}

function addSensorOptionToPositions(positionIds, displayName) {
    const ids = normalizeSelectedPositionIds(positionIds);
    if (!ids.length) {
        showToast("No editable position selected");
        return;
    }

    const positions = getActivePositions();
    ids.forEach((positionId) => {
        const revision = getPositionRevision(appState.activeSetup, positionId);
        const existing = positions[positionId] && Array.isArray(positions[positionId].items)
            ? normalizeItems(positions[positionId].items)
            : [];
        const sensorItem = {
            type: "sensor",
            name: displayName,
            displayName,
            notes: ""
        };

        positions[positionId] = {
            items: existing.length && existing.every((item) => item.type === "sensor")
                ? [...existing, sensorItem]
                : [sensorItem],
            revision
        };
        cleanupPosition(positionId);
    });

    editorContext = null;
    appState.selectedPositions = ids;
    appState.selectedPosition = ids[ids.length - 1];
    appState.selectedRange = createSelectionRangeFromPositionIds(ids);
    appState.selectionAnchor = ids[0];
    hideTooltip();
    persistPositionsToServer(ids);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware saved");
}

function renderPositionContextMenu(actions, preset) {
    dom.positionContextMenu.innerHTML = "";

    if (preset) {
        const hint = document.createElement("div");
        hint.className = "context-menu-hint";
        hint.textContent = `Default: ${getPresetLabel(preset)}`;
        dom.positionContextMenu.appendChild(hint);
    }

    if (!actions.length) {
        const hint = document.createElement("div");
        hint.className = "context-menu-hint";
        hint.textContent = "Switch to Edit mode to add or change hardware.";
        dom.positionContextMenu.appendChild(hint);
    }

    actions.forEach((action) => {
        if (action.submenu) {
            dom.positionContextMenu.appendChild(createContextSubmenu(action));
            return;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = `context-menu-button ${action.className || ""}`.trim();
        button.setAttribute("role", "menuitem");
        button.textContent = action.label;
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            hidePositionContextMenu();
            action.handler();
        });
        dom.positionContextMenu.appendChild(button);
    });
}

function createContextSubmenu(action) {
    const wrapper = document.createElement("div");
    wrapper.className = "context-menu-submenu";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = `context-menu-button ${action.className || ""}`.trim();
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "true");
    trigger.innerHTML = `<span>${escapeHtml(action.label)}</span><span class="context-menu-arrow">&rsaquo;</span>`;
    wrapper.appendChild(trigger);

    const panel = document.createElement("div");
    panel.className = "context-submenu-panel";
    panel.setAttribute("role", "menu");
    action.submenu.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `context-menu-button ${item.className || ""}`.trim();
        button.setAttribute("role", "menuitem");
        button.textContent = item.label;
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            hidePositionContextMenu();
            item.handler();
        });
        panel.appendChild(button);
    });
    wrapper.appendChild(panel);

    return wrapper;
}

function placePositionContextMenu(clientX, clientY) {
    dom.positionContextMenu.hidden = false;

    const offset = 8;
    const rect = dom.positionContextMenu.getBoundingClientRect();
    let x = clientX + offset;
    let y = clientY + offset;

    if (x + rect.width > window.innerWidth - 10) {
        x = clientX - rect.width - offset;
    }

    if (y + rect.height > window.innerHeight - 10) {
        y = clientY - rect.height - offset;
    }

    dom.positionContextMenu.style.left = `${Math.max(10, x)}px`;
    dom.positionContextMenu.style.top = `${Math.max(10, y)}px`;

    const firstButton = dom.positionContextMenu.querySelector("button");
    if (firstButton) {
        firstButton.focus();
    }
}

function hidePositionContextMenu() {
    if (!dom.positionContextMenu || dom.positionContextMenu.hidden) {
        return;
    }

    dom.positionContextMenu.hidden = true;
    dom.positionContextMenu.innerHTML = "";
}

function openHardwareEditor(options) {
    const positionId = options.positionId;
    if (getBoardUtility(positionId)) {
        showToast("Fixed board position");
        return;
    }

    const items = getPositionItems(positionId);
    const existingItem = options.mode === "edit" && Number.isInteger(options.itemIndex)
        ? items[options.itemIndex]
        : null;
    const fixedType = options.fixedType || (options.mode === "addSensor" ? "sensor" : null);
    const requestedType = fixedType || (existingItem && existingItem.type) || options.initialType || "squib";
    const initialType = HARDWARE_TYPES[requestedType] ? requestedType : "squib";

    if (appState.interactionMode !== "edit") {
        appState.interactionMode = "edit";
        appState.selectedRange = null;
        renderInteractionMode();
    }

    editorContext = {
        positionId,
        mode: options.mode,
        itemIndex: Number.isInteger(options.itemIndex) ? options.itemIndex : null,
        selectedType: initialType,
        fixedType
    };

    appState.selectedPosition = positionId;
    appState.selectedPositions = [positionId];
    appState.selectionAnchor = positionId;
    appState.selectedRange = null;
    hideTooltip();
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
}

function renderInlineHardwareEditor(container, positionId, items) {
    const existingItem = editorContext.mode === "edit" && Number.isInteger(editorContext.itemIndex)
        ? items[editorContext.itemIndex]
        : null;
    const title = getEditorTitle(editorContext.mode);
    const subtitle = editorContext.mode === "addSensor"
        ? `${getDisplayPositionLabel(positionId)} - Sensor`
        : getDisplayPositionLabel(positionId);
    const nameValue = existingItem ? existingItem.name : "";
    const displayValue = existingItem ? existingItem.displayName : "";
    const notesValue = existingItem ? existingItem.notes : "";
    const typePicker = renderTypePicker(editorContext.selectedType, Boolean(editorContext.fixedType));

    const wrapper = document.createElement("div");
    wrapper.className = "inline-editor";
    wrapper.innerHTML = `
        <div class="inline-editor-header">
            <div>
                <h3>${escapeHtml(title)}</h3>
                <p class="modal-subtitle">${escapeHtml(subtitle)}</p>
            </div>
        </div>
        <form class="inline-editor-form" id="hardwareEditorForm" novalidate>
            <div class="modal-field">
                <div class="fieldset-label">Hardware Type</div>
                ${typePicker}
            </div>
            <label class="modal-field">
                <span class="form-label">Hardware Name</span>
                <input id="hardwareNameInput" name="hardwareName" type="text" autocomplete="off" value="${escapeAttribute(nameValue)}" required>
            </label>
            <label class="modal-field">
                <span class="form-label">Display Name</span>
                <input id="displayNameInput" name="displayName" type="text" autocomplete="off" value="${escapeAttribute(displayValue)}" required>
                <span class="field-help" id="displayNameHelp">Short names keep the map easier to scan.</span>
            </label>
            <label class="modal-field">
                <span class="form-label">Notes</span>
                <textarea id="hardwareNotesInput" name="notes" rows="4">${escapeHtml(notesValue)}</textarea>
            </label>
            <div class="form-error" id="hardwareFormError" role="alert"></div>
            <div class="inline-editor-footer">
                <button class="secondary-button" type="button" data-editor-cancel>Cancel</button>
                <button class="action-button primary" type="submit">Save</button>
            </div>
        </form>
    `;

    container.appendChild(wrapper);
    bindHardwareEditorEvents();
}

function getEditorTitle(mode) {
    if (mode === "edit") {
        return "Edit Hardware";
    }

    if (mode === "addSensor") {
        return "Add Sensor";
    }

    return "Add Hardware";
}

function renderTypePicker(selectedType, isLocked) {
    const choices = Object.keys(HARDWARE_TYPES).map((typeKey) => {
        const type = HARDWARE_TYPES[typeKey];
        const selectedClass = typeKey === selectedType ? " is-selected" : "";
        const disabled = isLocked ? " aria-disabled=\"true\"" : "";
        return `
            <button class="type-choice${selectedClass}" type="button" data-type-choice="${escapeAttribute(typeKey)}"${disabled}>
                <span class="type-swatch" style="--type-color: var(${type.colorVar}); --type-border: var(${type.borderVar});"></span>
                <span>${escapeHtml(type.label)}</span>
            </button>
        `;
    }).join("");

    return `<div class="type-picker" role="group" aria-label="Hardware type">${choices}</div>`;
}

function bindHardwareEditorEvents() {
    const form = document.getElementById("hardwareEditorForm");
    if (!form || form.dataset.bound === "true") {
        return;
    }

    form.dataset.bound = "true";
    const nameInput = document.getElementById("hardwareNameInput");
    const displayInput = document.getElementById("displayNameInput");
    const displayHelp = document.getElementById("displayNameHelp");

    const cancelButton = form.querySelector("[data-editor-cancel]");
    if (cancelButton) {
        cancelButton.addEventListener("click", closeHardwareEditor);
    }

    Array.from(form.querySelectorAll("[data-type-choice]")).forEach((button) => {
        button.addEventListener("click", () => {
            if (button.getAttribute("aria-disabled") === "true") {
                return;
            }
            editorContext.selectedType = button.dataset.typeChoice;
            form.querySelectorAll("[data-type-choice]").forEach((choice) => {
                choice.classList.toggle("is-selected", choice === button);
            });
        });
    });

    if (displayInput && displayHelp) {
        displayInput.addEventListener("input", () => {
            displayHelp.classList.toggle("is-warning", displayInput.value.trim().length > 12);
            displayHelp.textContent = displayInput.value.trim().length > 12
                ? "This display name will be shortened visually on the map."
                : "Short names keep the map easier to scan.";
        });
    }

    form.addEventListener("submit", saveHardware);
    setTimeout(() => {
        const focusTarget = nameInput && nameInput.value ? displayInput : nameInput;
        if (focusTarget) {
            focusTarget.focus();
        }
    }, 0);
}

function closeHardwareEditor() {
    editorContext = null;
    renderPositionDetails();
    resetDetailsScroll();
}

function saveHardware(event) {
    event.preventDefault();

    if (!editorContext) {
        return;
    }

    const form = event.currentTarget;
    const error = document.getElementById("hardwareFormError");
    const nameInput = form.elements.hardwareName;
    const displayInput = form.elements.displayName;
    const notesInput = form.elements.notes;
    const name = normalizeString(nameInput.value);
    const displayName = normalizeString(displayInput.value);
    const notes = normalizeString(notesInput.value);

    if (!name || !displayName) {
        error.textContent = "Hardware Name and Display Name are required.";
        if (!name) {
            nameInput.focus();
        } else {
            displayInput.focus();
        }
        return;
    }

    const type = editorContext.fixedType || editorContext.selectedType;
    const item = { type, name, displayName, notes };
    const savedPositionId = editorContext.positionId;
    const positions = getActivePositions();
    const position = positions[savedPositionId] || { items: [] };

    if (editorContext.mode === "addSensor") {
        position.items.push(item);
    } else if (editorContext.mode === "edit" && Number.isInteger(editorContext.itemIndex)) {
        position.items[editorContext.itemIndex] = item;
    } else {
        position.items = [item];
    }

    positions[savedPositionId] = {
        items: normalizeItems(position.items),
        revision: getPositionRevision(appState.activeSetup, savedPositionId)
    };

    cleanupPosition(savedPositionId);
    appState.selectedPosition = savedPositionId;
    editorContext = null;
    persistPositionsToServer([savedPositionId]);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware saved");
}

function clearPosition(positionId) {
    const positions = getActivePositions();
    const revisionMap = {
        [positionId]: getPositionRevision(appState.activeSetup, positionId)
    };
    delete positions[positionId];
    editorContext = null;
    focusAfterHardwareChange(positionId);
    hideTooltip();
    persistDeletedPositionsToServer([positionId], revisionMap);
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware removed");
}

function removeSensor(positionId, index) {
    const positions = getActivePositions();
    const position = positions[positionId];
    if (!position || !Array.isArray(position.items)) {
        return;
    }

    const revision = getPositionRevision(appState.activeSetup, positionId);
    position.items.splice(index, 1);
    cleanupPosition(positionId);
    editorContext = null;
    focusAfterHardwareChange(positionId);
    hideTooltip();
    if (getActivePositions()[positionId]) {
        persistPositionsToServer([positionId]);
    } else {
        persistDeletedPositionsToServer([positionId], { [positionId]: revision });
    }
    renderGrid();
    renderPositionDetails();
    resetDetailsScroll();
    showToast("Hardware removed");
}

function focusAfterHardwareChange(positionId) {
    const selectableId = getSelectablePositionId(positionId);
    if (!isEditMode() || !selectableId) {
        clearSelectionState();
        appState.selectedPosition = null;
        return;
    }

    const selectedIds = getSelectedPositionIds();
    if (selectedIds.includes(selectableId)) {
        appState.selectedPositions = selectedIds;
        appState.selectedPosition = selectableId;
        appState.selectionAnchor = appState.selectionAnchor || selectableId;
        appState.selectedRange = selectedIds.length > 1
            ? createSelectionRangeFromPositionIds(selectedIds)
            : null;
        return;
    }

    appState.selectedPositions = [selectableId];
    appState.selectedPosition = selectableId;
    appState.selectionAnchor = selectableId;
    appState.selectedRange = null;
}

function resetDetailsScroll() {
    dom.positionDetailsContent.scrollTop = 0;
}

function cleanupPosition(positionId) {
    const positions = getActivePositions();
    if (!positions[positionId] || !Array.isArray(positions[positionId].items) || !positions[positionId].items.length) {
        delete positions[positionId];
        return;
    }

    const revision = Number(positions[positionId].revision);
    const updatedAt = positions[positionId].updatedAt || "";
    positions[positionId] = {
        items: normalizeItems(positions[positionId].items)
    };
    if (Number.isInteger(revision) && revision > 0) {
        positions[positionId].revision = revision;
    }
    if (updatedAt) {
        positions[positionId].updatedAt = updatedAt;
    }

    if (!positions[positionId].items.length) {
        delete positions[positionId];
    }
}

function getActivePositions() {
    return getActiveSetup().positions;
}

function getActiveSetup() {
    return getSetupByName(appState.activeSetup);
}

function getSetupByName(setupName) {
    if (!appState.setups[setupName]) {
        appState.setups[setupName] = createInitialSetup();
    }

    if (!appState.setups[setupName].positions || !isPlainObject(appState.setups[setupName].positions)) {
        appState.setups[setupName].positions = {};
    }

    if (!appState.setups[setupName].canChannels || !isPlainObject(appState.setups[setupName].canChannels)) {
        appState.setups[setupName].canChannels = { ...DEFAULT_CAN_CHANNELS };
    }

    return appState.setups[setupName];
}

function getSetupCanChannels(setupName = appState.activeSetup) {
    const setup = getSetupByName(setupName);
    setup.canChannels = normalizeCanChannels(setup.canChannels);
    return setup.canChannels;
}

function isCanChannelActive(channelKey, setupName = appState.activeSetup) {
    const channels = getSetupCanChannels(setupName);
    return Boolean(channels[channelKey]);
}

function toggleCanChannel(channelKey) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CAN_CHANNELS, channelKey)) {
        return;
    }

    const channels = getSetupCanChannels();
    channels[channelKey] = !channels[channelKey];
    hideTooltip();
    saveToLocalStorage();
    renderGrid();
    renderPositionDetails();
    showToast(channels[channelKey] ? "CAN channel enabled" : "CAN channel disabled");
}

function getPositionItems(positionId) {
    const position = getActivePositions()[positionId];
    return position && Array.isArray(position.items) ? position.items : [];
}

function getPositionRevision(setupType, positionId) {
    const setup = getSetupByName(setupType);
    const position = setup.positions[positionId];
    return position && Number.isInteger(position.revision) ? position.revision : null;
}

function applyServerPosition(position) {
    if (!position || !SETUP_LABELS[position.setupType] || !isValidPositionId(position.positionId)) {
        return;
    }

    const setup = getSetupByName(position.setupType);
    setup.positions[position.positionId] = {
        items: normalizeItems(position.items),
        revision: Number(position.revision) || 1,
        updatedAt: position.updatedAt || ""
    };
}

async function persistPositionsToServer(positionIds, setupType = appState.activeSetup) {
    if (!currentProjectId) {
        return;
    }

    recordHistorySnapshot();
    setSaveIndicator("Saving...", "saving");
    try {
        for (const positionId of normalizeSelectedPositionIds(positionIds)) {
            const items = getSetupByName(setupType).positions[positionId]
                ? normalizeItems(getSetupByName(setupType).positions[positionId].items)
                : [];
            const data = await storage.savePosition(currentProjectId, setupType, positionId, {
                items,
                revision: getPositionRevision(setupType, positionId) || 0
            });
            if (data && data.position) {
                applyServerPosition(data.position);
            }
        }
        setSaveIndicator("Saved", "saved");
    } catch (error) {
        await handlePositionSaveError(error);
    }
}

async function persistDeletedPositionsToServer(positionIds, revisionMap = {}, setupType = appState.activeSetup) {
    if (!currentProjectId) {
        return;
    }

    recordHistorySnapshot();
    setSaveIndicator("Saving...", "saving");
    try {
        for (const positionId of normalizeSelectedPositionIds(positionIds)) {
            await storage.deletePosition(currentProjectId, setupType, positionId, {
                revision: revisionMap[positionId] == null ? 0 : revisionMap[positionId]
            });
        }
        setSaveIndicator("Saved", "saved");
    } catch (error) {
        await handlePositionSaveError(error);
    }
}

async function handlePositionSaveError(error) {
    if (error.status === 409) {
        setSaveIndicator("Conflict", "error");
        showToast("Conflict detected");
        await reloadCurrentProject();
        return;
    }

    setSaveIndicator("Failed to save", "error");
    showToast(error.status === 0 ? "Server unavailable" : "Failed to save");
}

async function reloadCurrentProject() {
    if (!currentProjectId) {
        return;
    }

    try {
        const data = await storage.loadProject(currentProjectId);
        applyRemoteProject(data.project);
    } catch (error) {
        setSaveIndicator("Offline", "error");
    }
}

function getCanonicalEditablePositionId(row, column) {
    if (row < 1 || row > POSITION_ROWS || column < 1 || column > POSITION_COLUMNS) {
        return null;
    }

    if (MERGED_SENSOR_ROWS.has(row) && column === MERGED_SENSOR_ALIAS_COLUMN) {
        return formatPositionId(row, 1);
    }

    const positionId = formatPositionId(row, column);
    if (getBoardUtility(positionId) || isUtilityAliasPosition(positionId)) {
        return null;
    }

    return positionId;
}

function shouldSkipVisualCell(row, column) {
    if (MERGED_SENSOR_ROWS.has(row) && column === MERGED_SENSOR_ALIAS_COLUMN) {
        return true;
    }

    const positionId = formatPositionId(row, column);
    return isUtilityAliasPosition(positionId);
}

function isUtilityAliasPosition(positionId) {
    return Object.values(BOARD_UTILITY_CELLS).some((utility) => {
        return Array.isArray(utility.aliases) && utility.aliases.includes(positionId);
    });
}

function getVisualColumnSpan(row, column) {
    return MERGED_SENSOR_ROWS.has(row) && column === 1 ? 2 : 1;
}

function getBoardUtility(positionId) {
    return BOARD_UTILITY_CELLS[positionId] || null;
}

function getDisplayPositionLabel(positionId) {
    const utility = getBoardUtility(positionId);
    if (utility && Array.isArray(utility.aliases) && utility.aliases.length) {
        return `${positionId}-${utility.aliases[utility.aliases.length - 1]}`;
    }

    const match = /^R(\d{2})C1$/.exec(positionId);
    if (match && MERGED_SENSOR_ROWS.has(Number(match[1]))) {
        return `${positionId}-C2`;
    }

    return positionId;
}

function buildUtilityAriaLabel(positionId, utility) {
    const linkStatus = utility.typeLabel === "Power"
        ? `, ${appState.boardOptions.powerLinked ? "linked" : "separated"}`
        : "";
    const canStatus = utility.typeLabel === "CAN"
        ? `, ${isCanChannelActive(utility.channelKey) ? "used" : "not used"}`
        : "";
    return `${getDisplayPositionLabel(positionId)}, ${utility.title}, ${utility.typeLabel}, fixed${linkStatus}${canStatus}`;
}

function getUtilityStatusText(utility) {
    if (utility.typeLabel === "Power") {
        return appState.boardOptions.powerLinked ? "KL30 and KL15 linked" : "KL30 and KL15 separated";
    }

    if (utility.typeLabel === "CAN") {
        return isCanChannelActive(utility.channelKey) ? "Used in this setup" : "Not used in this setup";
    }

    return "Fixed board position";
}

function togglePowerLink() {
    appState.boardOptions.powerLinked = !appState.boardOptions.powerLinked;
    hideTooltip();
    saveToLocalStorage();
    renderGrid();
    renderPositionDetails();
    showToast(appState.boardOptions.powerLinked ? "Power sources linked" : "Power sources separated");
}

function utilityMatchesSearch(positionId, utility, query) {
    const fields = [
        positionId,
        getDisplayPositionLabel(positionId),
        utility.label,
        utility.title,
        utility.typeLabel,
        utility.detail,
        utility.typeLabel === "Power" ? "source kl30 kl15 power supply" : "",
        utility.typeLabel === "Ground" ? "gnd ground" : "",
        utility.typeLabel === "CAN" ? `can communication ${isCanChannelActive(utility.channelKey) ? "used active on" : "not used inactive off"}` : ""
    ];

    return fields.some((field) => normalizeSearch(field).includes(query));
}

function migrateVisualPositionData(state) {
    Object.values(state.setups).forEach((setup) => {
        mergePositionItems(setup.positions, 1, 12, 2, 1);
    });
}

function mergePositionItems(positions, startRow, endRow, sourceColumn, targetColumn) {
    for (let row = startRow; row <= endRow; row += 1) {
        const sourceId = formatPositionId(row, sourceColumn);
        const targetId = formatPositionId(row, targetColumn);
        const source = positions[sourceId];

        if (!source || !Array.isArray(source.items) || !source.items.length) {
            delete positions[sourceId];
            continue;
        }

        const target = positions[targetId] && Array.isArray(positions[targetId].items)
            ? positions[targetId]
            : { items: [] };
        target.items = normalizeItems([...target.items, ...source.items]);
        if (target.items.length) {
            positions[targetId] = target;
        }
        delete positions[sourceId];
    }
}

function createFixedPositionPresets() {
    const presets = {};

    addPresetRange(presets, [1], 1, 12, createPreset("sensor", "SEN"));
    addPresetRange(presets, [4, 5], 1, 16, createPreset("squib", "SQB"));
    addPresetRange(presets, [1], 13, 16, createPreset("aod", "AOD"));
    addPresetRange(presets, [1], 18, 20, createSwitchPreset());
    addPresetRange(presets, [2], 13, 16, createSwitchPreset());
    addPresetRange(presets, [2], 18, 20, createSwitchPreset());
    addPresetRange(presets, [3], 12, 16, createSwitchPreset());
    addPresetRange(presets, [3], 18, 21, createSwitchPreset());

    return presets;
}

function addPresetRange(presets, columns, startRow, endRow, preset) {
    for (let row = startRow; row <= endRow; row += 1) {
        columns.forEach((column) => {
            presets[formatPositionId(row, column)] = { ...preset };
        });
    }
}

function createPreset(type, marker) {
    return {
        kind: "single",
        type,
        marker,
        cssClass: `preset-${type === "physicalSwitch" || type === "mechanicalSwitch" ? "switch" : type}`
    };
}

function createSwitchPreset() {
    return {
        kind: "switch",
        marker: "SW",
        cssClass: "preset-switch"
    };
}

function getFixedPreset(positionId) {
    return FIXED_POSITION_PRESETS[positionId] || null;
}

function getPresetLabel(preset) {
    if (!preset) {
        return "Custom";
    }

    if (preset.kind === "switch") {
        return "Switch";
    }

    return getTypeLabel(preset.type);
}

function getInitialTypeFromPreset(preset) {
    if (!preset) {
        return "squib";
    }

    return preset.kind === "switch" ? "mechanicalSwitch" : preset.type;
}

function createQuickItem(type) {
    const defaults = QUICK_ITEM_DEFAULTS[type] || QUICK_ITEM_DEFAULTS.squib;
    return {
        type,
        name: defaults.name,
        displayName: defaults.displayName,
        notes: ""
    };
}

function isQuickItem(item, type) {
    const defaults = QUICK_ITEM_DEFAULTS[type];
    if (!defaults) {
        return false;
    }

    return item.type === type
        && item.name === defaults.name
        && item.displayName === defaults.displayName
        && !item.notes;
}

function isSwitchType(type) {
    return SWITCH_TOGGLE_TYPES.includes(type);
}

function isPresetException(preset, items) {
    if (!preset || !items.length) {
        return false;
    }

    if (preset.kind === "switch") {
        return !items.every((item) => isSwitchType(item.type));
    }

    return !items.every((item) => item.type === preset.type);
}

function generatePositionText(positionId) {
    const items = getPositionItems(positionId);
    const displayPositionId = getDisplayPositionLabel(positionId);
    if (!items.length) {
        return `${displayPositionId} | Empty`;
    }

    if (items.length === 1) {
        const item = items[0];
        return `${displayPositionId} | ${getTypeLabel(item.type)} | ${item.displayName} | ${item.name}`;
    }

    const allSensors = items.every((item) => item.type === "sensor");
    const typeLabel = allSensors ? "Sensor" : getPositionTypeLabel(items);
    const itemText = items
        .map((item) => `${item.displayName} - ${item.name}`)
        .join("; ");

    return `${displayPositionId} | ${typeLabel} | ${itemText}`;
}

function generateSetupText(setupName) {
    const normalized = createExportData(appState);
    const setup = normalized.setups[setupName];
    const setupLabel = SETUP_LABELS[setupName] || setupName;
    const lines = [
        normalized.project.name || DEFAULT_PROJECT_NAME,
        `Setup: ${setupLabel}`,
        "",
        `Harness: ${normalized.project.harness || "-"}`,
        `ECU: ${normalized.project.ecuName || "-"}`,
        `Part Number: ${normalized.project.partNumber || "-"}`,
        `Calibration ID: ${normalized.project.calibrationId || "-"}`,
        `CANoe: ${normalized.project.canoeFile ? normalized.project.canoeFile.name : "-"}`,
        `CAN Channels: ${generateCanSummaryText(setupName)}`
    ];

    if (normalized.project.notes) {
        lines.push(`Notes: ${normalized.project.notes}`);
    }

    lines.push("");

    const positionIds = getSortedPositionIds().filter((positionId) => {
        const position = setup.positions[positionId];
        return position && Array.isArray(position.items) && position.items.length;
    });

    if (!positionIds.length) {
        lines.push("No hardware positions recorded.");
        return lines.join("\n");
    }

    positionIds.forEach((positionId) => {
        lines.push(generatePositionTextFromPositions(positionId, setup.positions));
    });

    return lines.join("\n");
}

function generatePositionTextFromPositions(positionId, positions) {
    const position = positions[positionId];
    const items = position && Array.isArray(position.items) ? position.items : [];
    const displayPositionId = getDisplayPositionLabel(positionId);

    if (!items.length) {
        return `${displayPositionId} | Empty`;
    }

    if (items.length === 1) {
        const item = items[0];
        return `${displayPositionId} | ${getTypeLabel(item.type)} | ${item.displayName} | ${item.name}`;
    }

    const allSensors = items.every((item) => item.type === "sensor");
    const typeLabel = allSensors ? "Sensor" : getPositionTypeLabel(items);
    return `${displayPositionId} | ${typeLabel} | ${items.map((item) => `${item.displayName} - ${item.name}`).join("; ")}`;
}

function generateCanSummaryText(setupName) {
    const channels = getSetupCanChannels(setupName);
    return [
        `CAN 1 ${channels.can1 ? "Used" : "Not used"}`,
        `CAN 2 ${channels.can2 ? "Used" : "Not used"}`
    ].join("; ");
}

async function copyPositionInfo() {
    if (!appState.selectedPosition || !getPositionItems(appState.selectedPosition).length) {
        return;
    }

    const copied = await copyTextToClipboard(generatePositionText(appState.selectedPosition));
    showToast(copied ? "Position copied" : "Copy unavailable");
}

async function copyCurrentSetup() {
    const setupName = appState.activeSetup;
    boardClipboard = {
        kind: "setup",
        sourceSetup: setupName,
        setup: cloneSetup(appState.setups[setupName])
    };
    renderBoardClipboardControls();

    const copied = await copyTextToClipboard(generateSetupText(setupName));
    showToast(copied ? `${SETUP_LABELS[setupName]} setup copied` : `${SETUP_LABELS[setupName]} setup ready to paste`);
}

function pasteCopiedSetup() {
    if (!isEditMode()) {
        showToast("Switch to Edit mode to paste setup");
        return;
    }

    if (!boardClipboard || boardClipboard.kind !== "setup") {
        showToast("Nothing to paste");
        return;
    }

    if (activeSetupHasData()) {
        openPasteSetupConfirmation();
        return;
    }

    applySetupPaste();
}

function openPasteSetupConfirmation() {
    const sourceLabel = SETUP_LABELS[boardClipboard.sourceSetup] || "Copied";
    const targetLabel = SETUP_LABELS[appState.activeSetup] || "current";

    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">Paste setup into ${escapeHtml(targetLabel)}?</h2>
                <p class="modal-subtitle">This will replace the current ${escapeHtml(targetLabel)} hardware map and CAN channel states with the copied ${escapeHtml(sourceLabel)} setup.</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <div class="modal-footer">
            <button class="secondary-button" type="button" data-modal-close>Cancel</button>
            <button class="action-button primary" type="button" id="confirmPasteSetupButton">Paste Setup</button>
        </div>
    `);

    Array.from(document.querySelectorAll("[data-modal-close]")).forEach((button) => {
        button.addEventListener("click", closeModal);
    });
    document.getElementById("confirmPasteSetupButton").addEventListener("click", () => {
        applySetupPaste();
        closeModal();
    });
}

async function applySetupPaste() {
    appState.setups[appState.activeSetup] = cloneSetup(boardClipboard.setup);
    appState.selectedPosition = null;
    editorContext = null;
    clearSelectionState();
    hideTooltip();
    renderApp();
    setSaveIndicator("Saving...", "saving");
    try {
        const data = await storage.replaceSetup(currentProjectId, appState.activeSetup, appState.setups[appState.activeSetup]);
        appState.setups[appState.activeSetup] = normalizeSetup(data.setup);
        await reloadCurrentProject();
        showToast("Setup pasted");
    } catch (error) {
        setSaveIndicator("Failed to save", "error");
        showToast("Failed to save");
    }
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            return fallbackCopyText(text);
        }
    }

    return fallbackCopyText(text);
}

function fallbackCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-999px";
    textarea.style.left = "-999px";
    document.body.appendChild(textarea);
    textarea.select();

    try {
        return document.execCommand("copy");
    } catch (error) {
        return false;
    } finally {
        textarea.remove();
    }
}

function exportProject() {
    const data = createExportData(appState);
    downloadProjectJson(data);
    showToast("Project exported");
}

async function exportProjectById(projectId) {
    try {
        const data = await storage.loadProject(projectId);
        downloadProjectJson(createExportData(normalizeState(data.project)));
        showToast("Project exported");
    } catch (error) {
        showToast("Failed to export project");
    }
}

function downloadProjectJson(data) {
    const content = JSON.stringify(data, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const filename = `${sanitizeFilename(data.project.name || DEFAULT_PROJECT_NAME)}.json`;

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function importProject(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";

    if (currentProjectId && !isEditMode()) {
        showToast("Switch to Edit mode to import");
        return;
    }

    if (!file) {
        return;
    }

    const reader = new FileReader();

    reader.onerror = () => showToast("Invalid setup file");
    reader.onload = async () => {
        try {
            const data = JSON.parse(String(reader.result));
            const normalized = validateImportedData(data);

            if (!normalized) {
                showToast("Invalid setup file");
                return;
            }

            setSaveIndicator("Saving...", "saving");
            const created = await storage.createProject({
                ...createExportData(normalized),
                folderId: projectBrowserState.currentFolderId || null
            });
            showToast("Project imported");
            await openProject(created.project.id);
        } catch (error) {
            showToast("Invalid setup file");
        }
    };

    reader.readAsText(file);
}

function openUsageGuide() {
    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">Usage Guide</h2>
                <p class="modal-subtitle">Core workflows in Hardware Setup Manager.</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <div class="modal-body">
            <div class="guide-list">
                <section class="guide-section">
                    <h3>Project Browser</h3>
                    <p>Folders and projects behave like a lightweight file explorer. Use Back to return to the parent folder or All Projects, click once to select, double-click or press Enter to open, Ctrl+C copies, Ctrl+X cuts, Ctrl+V pastes, F2 renames, Delete removes, and right-click opens actions such as Copy, Cut, Paste, Duplicate, Rename, and Move To. The browser refreshes automatically while it is open.</p>
                </section>
                <section class="guide-section">
                    <h3>View mode</h3>
                    <p>Click any grid cell to inspect its details. View mode does not change hardware data.</p>
                </section>
                <section class="guide-section">
                    <h3>Edit mode</h3>
                    <p>Click a cell to select it. Shift-click selects a range, Ctrl-click adds or removes a cell, and dragging selects multiple adjacent cells. Click outside the grid to clear the current selection.</p>
                </section>
                <section class="guide-section">
                    <h3>Context menu</h3>
                    <p>Right-click a cell to edit hardware details, copy position info, paste a copied selection, clear hardware, or open Set Position To for fixed hardware positions.</p>
                </section>
                <section class="guide-section">
                    <h3>Keyboard shortcuts</h3>
                    <p>Use Ctrl+C to copy selected cells, Ctrl+X to cut, Ctrl+V to paste, Ctrl+Z to undo, and Ctrl+Y to redo.</p>
                </section>
                <section class="guide-section">
                    <h3>Checkpoint / Container</h3>
                    <p>The two setup maps are independent. Use Copy Setup, switch tabs, then Paste Setup to create a working copy and continue editing.</p>
                </section>
                <section class="guide-section">
                    <h3>CAN / Power</h3>
                    <p>CAN 1 is used by default and CAN 2 is off by default. In Edit mode, use Position Details or the right-click menu to change CAN and power source states.</p>
                </section>
                <section class="guide-section">
                    <h3>Local data</h3>
                    <p>Projects autosave to the shared server database. Export JSON for backup or sharing, and Import JSON to create a new shared project.</p>
                </section>
            </div>
        </div>
        <div class="modal-footer">
            <button class="action-button primary" type="button" data-modal-close>Got it</button>
        </div>
    `);

    bindModalCloseButtons();
}

function validateImportedData(data) {
    if (!isPlainObject(data) || !isPlainObject(data.project) || !isPlainObject(data.setups)) {
        return null;
    }

    const checkpoint = data.setups.checkpoint;
    const container = data.setups.container;
    if (!isPlainObject(checkpoint) || !isPlainObject(container)) {
        return null;
    }

    if (!isPlainObject(checkpoint.positions) || !isPlainObject(container.positions)) {
        return null;
    }

    return normalizeState({
        version: 1,
        activeSetup: "checkpoint",
        project: data.project,
        setups: data.setups,
        boardOptions: data.boardOptions,
        selectedPosition: null,
        selectedPositions: [],
        selectionAnchor: null,
        selectedRange: null,
        searchQuery: ""
    });
}

function requestNewProject() {
    if (currentProjectId && !isEditMode()) {
        showToast("Switch to Edit mode to create a new project");
        return;
    }

    openModal(`
        <div class="modal-header">
            <div>
                <h2 id="modalTitle">Create a new project?</h2>
                <p class="modal-subtitle">This creates a new shared project on the server. Export the current one first if you want a separate JSON backup.</p>
            </div>
            <button class="modal-close" type="button" data-modal-close aria-label="Close dialog">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                </svg>
            </button>
        </div>
        <div class="modal-footer">
            <button class="secondary-button" type="button" data-modal-close>Cancel</button>
            <button class="action-button primary" type="button" id="confirmNewProjectButton">Create New</button>
        </div>
    `);

    Array.from(document.querySelectorAll("[data-modal-close]")).forEach((button) => {
        button.addEventListener("click", closeModal);
    });
    document.getElementById("confirmNewProjectButton").addEventListener("click", () => {
        createNewServerProject();
        closeModal();
    });
}

function resetProject() {
    createNewServerProject();
}

function saveToLocalStorage(options = {}) {
    if (!options.skipHistory) {
        recordHistorySnapshot();
    }

    scheduleProjectSave();
}

function scheduleProjectSave() {
    if (!currentProjectId || isApplyingRemoteUpdate) {
        return;
    }

    setSaveIndicator("Saving...", "saving");
    window.clearTimeout(metadataSaveTimer);
    metadataSaveTimer = window.setTimeout(flushProjectSave, 700);
}

function flushProjectSaveNow() {
    window.clearTimeout(metadataSaveTimer);
    return flushProjectSave();
}

async function flushProjectSave() {
    if (!currentProjectId || isApplyingRemoteUpdate) {
        return;
    }

    const projectId = currentProjectId;
    try {
        const data = await storage.updateProject(projectId, buildProjectSavePayload());
        if (String(projectId) === String(currentProjectId) && data && data.project) {
            lastProjectRevision = data.project.revision || lastProjectRevision;
        }
        setSaveIndicator("Saved", "saved");
    } catch (error) {
        setSaveIndicator("Failed to save", "error");
        showToast("Failed to save");
    }
}

function buildProjectSavePayload() {
    return {
        project: normalizeProject(appState.project),
        boardOptions: normalizeBoardOptions(appState.boardOptions),
        setups: {
            checkpoint: {
                canChannels: normalizeCanChannels(appState.setups.checkpoint && appState.setups.checkpoint.canChannels)
            },
            container: {
                canChannels: normalizeCanChannels(appState.setups.container && appState.setups.container.canChannels)
            }
        }
    };
}

function createHistorySnapshot(state) {
    return JSON.stringify(createExportData(state));
}

function recordHistorySnapshot() {
    const nextSnapshot = createHistorySnapshot(appState);
    if (historySnapshot === null) {
        historySnapshot = nextSnapshot;
        return;
    }

    if (nextSnapshot === historySnapshot) {
        return;
    }

    undoStack.push(historySnapshot);
    if (undoStack.length > MAX_HISTORY_STEPS) {
        undoStack.shift();
    }
    redoStack = [];
    historySnapshot = nextSnapshot;
}

function restoreHistorySnapshot(snapshot) {
    let data;
    try {
        data = JSON.parse(snapshot);
    } catch (error) {
        return false;
    }

    const restored = normalizeState({
        ...data,
        activeSetup: appState.activeSetup,
        interactionMode: appState.interactionMode
    });

    appState.project = restored.project;
    appState.setups = restored.setups;
    appState.boardOptions = restored.boardOptions;
    appState.searchQuery = "";
    appState.selectedPosition = null;
    editorContext = null;
    clearSelectionState();
    historySnapshot = createHistorySnapshot(appState);
    persistFullProjectReplacement();
    renderApp();
    return true;
}

async function persistFullProjectReplacement() {
    if (!currentProjectId) {
        return;
    }

    setSaveIndicator("Saving...", "saving");
    try {
        await storage.updateProject(currentProjectId, buildProjectSavePayload());
        await storage.replaceSetup(currentProjectId, "checkpoint", appState.setups.checkpoint);
        await storage.replaceSetup(currentProjectId, "container", appState.setups.container);
        await reloadCurrentProject();
        setSaveIndicator("Saved", "saved");
    } catch (error) {
        setSaveIndicator("Failed to save", "error");
        showToast("Failed to save");
    }
}

function undoLastChange() {
    if (!undoStack.length) {
        showToast("Nothing to undo");
        return;
    }

    redoStack.push(createHistorySnapshot(appState));
    const previousSnapshot = undoStack.pop();
    if (restoreHistorySnapshot(previousSnapshot)) {
        showToast("Undo");
    }
}

function redoLastChange() {
    if (!redoStack.length) {
        showToast("Nothing to redo");
        return;
    }

    undoStack.push(createHistorySnapshot(appState));
    const nextSnapshot = redoStack.pop();
    if (restoreHistorySnapshot(nextSnapshot)) {
        showToast("Redo");
    }
}

function loadFromLocalStorage() {
    return null;
}

function setSaveIndicator(text, state) {
    dom.saveIndicatorText.textContent = text;
    dom.saveIndicator.classList.toggle("is-saving", state === "saving");
    dom.saveIndicator.classList.toggle("is-error", state === "error");
}

function createStoredData(data) {
    return {
        ...createExportData(data),
        activeSetup: SETUP_LABELS[data.activeSetup] ? data.activeSetup : "checkpoint",
        interactionMode: INTERACTION_MODES[data.interactionMode] ? data.interactionMode : "view"
    };
}

function createExportData(data) {
    const normalized = normalizeState(data);
    return {
        version: 1,
        project: normalized.project,
        setups: {
            checkpoint: createPortableSetup(normalized.setups.checkpoint),
            container: createPortableSetup(normalized.setups.container)
        },
        boardOptions: normalized.boardOptions
    };
}

function createPortableSetup(setup) {
    const normalized = normalizeSetup(setup);
    return {
        positions: clonePositions(normalized.positions),
        canChannels: normalizeCanChannels(normalized.canChannels)
    };
}

function normalizeState(data) {
    const initial = createInitialState();
    const source = isPlainObject(data) ? data : {};

    const normalized = {
        version: 1,
        activeSetup: SETUP_LABELS[source.activeSetup] ? source.activeSetup : initial.activeSetup,
        project: normalizeProject(source.project),
        setups: normalizeSetups(source.setups),
        boardOptions: normalizeBoardOptions(source.boardOptions),
        selectedPosition: isValidPositionId(source.selectedPosition) ? source.selectedPosition : null,
        selectedPositions: normalizeSelectedPositionIds(source.selectedPositions),
        selectionAnchor: getSelectablePositionId(source.selectionAnchor),
        selectedRange: normalizeSelectedRange(source.selectedRange),
        searchQuery: typeof source.searchQuery === "string" ? source.searchQuery : "",
        interactionMode: INTERACTION_MODES[source.interactionMode] ? source.interactionMode : initial.interactionMode
    };

    if (!normalized.selectedPositions.length && normalized.selectedRange) {
        normalized.selectedPositions = collectPositionIdsInRange(normalized.selectedRange);
    }

    if (!normalized.selectedPositions.length) {
        normalized.selectionAnchor = null;
        normalized.selectedRange = null;
    } else if (!normalized.selectionAnchor || !normalized.selectedPositions.includes(normalized.selectionAnchor)) {
        normalized.selectionAnchor = normalized.selectedPositions[0];
    }

    migrateVisualPositionData(normalized);
    return normalized;
}

function normalizeProject(project) {
    const source = isPlainObject(project) ? project : {};
    const name = normalizeString(source.name) || DEFAULT_PROJECT_NAME;

    return {
        name,
        harness: normalizeString(source.harness),
        ecuName: normalizeString(source.ecuName),
        partNumber: normalizeString(source.partNumber),
        calibrationId: normalizeString(source.calibrationId),
        canoeFile: normalizeCanoeFile(source.canoeFile),
        notes: normalizeString(source.notes)
    };
}

function normalizeCanoeFile(file) {
    if (!isPlainObject(file)) {
        return null;
    }

    const name = normalizeString(file.name);
    const data = normalizeString(file.data);
    if (!name || !data) {
        return null;
    }

    const size = Number(file.size);
    return {
        name,
        type: normalizeString(file.type),
        size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
        data,
        updatedAt: normalizeString(file.updatedAt)
    };
}

function normalizeSetups(setups) {
    const source = isPlainObject(setups) ? setups : {};
    return {
        checkpoint: normalizeSetup(source.checkpoint),
        container: normalizeSetup(source.container)
    };
}

function normalizeSetup(setup) {
    const source = isPlainObject(setup) ? setup : {};
    return {
        positions: normalizePositions(source.positions),
        canChannels: normalizeCanChannels(source.canChannels)
    };
}

function normalizeBoardOptions(boardOptions) {
    const source = isPlainObject(boardOptions) ? boardOptions : {};
    return {
        powerLinked: typeof source.powerLinked === "boolean" ? source.powerLinked : true
    };
}

function normalizeCanChannels(canChannels) {
    const source = isPlainObject(canChannels) ? canChannels : {};
    return Object.keys(DEFAULT_CAN_CHANNELS).reduce((channels, channelKey) => {
        channels[channelKey] = typeof source[channelKey] === "boolean"
            ? source[channelKey]
            : DEFAULT_CAN_CHANNELS[channelKey];
        return channels;
    }, {});
}

function normalizeSelectedRange(range) {
    if (!isPlainObject(range)) {
        return null;
    }

    const minRow = Number(range.minRow);
    const maxRow = Number(range.maxRow);
    const minColumn = Number(range.minColumn);
    const maxColumn = Number(range.maxColumn);

    if (![minRow, maxRow, minColumn, maxColumn].every(Number.isInteger)) {
        return null;
    }

    return createSelectionRangeFromCoordinates(minRow, minColumn, maxRow, maxColumn);
}

function normalizePositions(positions) {
    const normalized = {};
    if (!isPlainObject(positions)) {
        return normalized;
    }

    Object.keys(positions).forEach((positionId) => {
        if (!isValidPositionId(positionId)) {
            return;
        }

        const sourcePosition = positions[positionId];
        const items = normalizeItems(sourcePosition && sourcePosition.items);
        if (items.length) {
            const revision = Number(sourcePosition && sourcePosition.revision);
            normalized[positionId] = { items };
            if (Number.isInteger(revision) && revision > 0) {
                normalized[positionId].revision = revision;
            }
            if (sourcePosition && sourcePosition.updatedAt) {
                normalized[positionId].updatedAt = normalizeString(sourcePosition.updatedAt);
            }
        }
    });

    return normalized;
}

function normalizeItems(items) {
    if (!Array.isArray(items)) {
        return [];
    }

    return items.reduce((result, item) => {
        if (!isPlainObject(item) || !HARDWARE_TYPES[item.type]) {
            return result;
        }

        const name = normalizeString(item.name);
        const displayName = normalizeString(item.displayName);
        const finalName = name || displayName;
        const finalDisplayName = displayName || makeDisplayNameFromName(name);

        if (!finalName || !finalDisplayName) {
            return result;
        }

        result.push({
            type: item.type,
            name: finalName,
            displayName: finalDisplayName,
            notes: normalizeString(item.notes)
        });
        return result;
    }, []);
}

function cloneSetup(setup) {
    const normalized = normalizeSetup(setup);
    return {
        positions: clonePositions(normalized.positions),
        canChannels: normalizeCanChannels(normalized.canChannels)
    };
}

function clonePositions(positions) {
    const cloned = {};
    Object.keys(positions || {}).forEach((positionId) => {
        const items = normalizeItems(positions[positionId] && positions[positionId].items);
        if (items.length) {
            cloned[positionId] = {
                items: cloneItems(items)
            };
        }
    });
    return cloned;
}

function cloneItems(items) {
    return normalizeItems(items).map((item) => ({ ...item }));
}

function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeSearch(value) {
    return normalizeString(value).toLowerCase();
}

function removeEmptyPositionRecords(positions) {
    Object.keys(positions).forEach((positionId) => {
        const position = positions[positionId];
        if (!position || !Array.isArray(position.items) || !position.items.length) {
            delete positions[positionId];
        }
    });
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createNumberSet(start, end) {
    const values = new Set();
    for (let value = start; value <= end; value += 1) {
        values.add(value);
    }
    return values;
}

function isValidPositionId(positionId) {
    return /^R(0[1-9]|1[0-9]|2[0-2])C[1-5]$/.test(positionId);
}

function formatPositionId(row, column) {
    return `R${String(row).padStart(2, "0")}C${column}`;
}

function parsePositionId(positionId) {
    const match = /^R(0[1-9]|1[0-9]|2[0-2])C([1-5])$/.exec(positionId || "");
    if (!match) {
        return null;
    }

    return {
        row: Number(match[1]),
        column: Number(match[2])
    };
}

function comparePositionIds(a, b) {
    const first = parsePositionId(a);
    const second = parsePositionId(b);
    if (!first || !second) {
        return String(a).localeCompare(String(b));
    }

    return first.row === second.row
        ? first.column - second.column
        : first.row - second.row;
}

function getSortedPositionIds() {
    const ids = [];
    for (let row = 1; row <= POSITION_ROWS; row += 1) {
        for (let column = 1; column <= POSITION_COLUMNS; column += 1) {
            ids.push(formatPositionId(row, column));
        }
    }
    return ids;
}

function getTypeLabel(typeKey) {
    return HARDWARE_TYPES[typeKey] ? HARDWARE_TYPES[typeKey].label : "Unknown";
}

function getDominantType(items) {
    if (!items.length) {
        return "sensor";
    }

    const firstType = items[0].type;
    const allSame = items.every((item) => item.type === firstType);
    return allSame ? firstType : firstType;
}

function getPositionTypeLabel(items) {
    if (!items.length) {
        return "Empty";
    }

    const firstType = items[0].type;
    const allSame = items.every((item) => item.type === firstType);
    if (allSame) {
        return getTypeLabel(firstType);
    }

    return "Mixed";
}

function setTypeVariables(element, typeKey) {
    const type = HARDWARE_TYPES[typeKey] || HARDWARE_TYPES.sensor;
    element.style.setProperty("--type-color", `var(${type.colorVar})`);
    element.style.setProperty("--type-border", `var(${type.borderVar})`);
}

function buildPositionAriaLabel(positionId, items) {
    if (!items.length) {
        return `${getDisplayPositionLabel(positionId)}, empty`;
    }

    const typeLabel = getPositionTypeLabel(items);
    const names = items.map((item) => `${item.displayName}, ${item.name}`).join("; ");
    return `${getDisplayPositionLabel(positionId)}, ${typeLabel}, ${names}`;
}

function positionMatchesSearch(positionId, items, query, preset = getFixedPreset(positionId)) {
    const positionIds = [positionId, getDisplayPositionLabel(positionId), ...getPositionSearchAliases(positionId)];
    if (positionIds.some((id) => normalizeSearch(id).includes(query))) {
        return true;
    }

    if (!items.length && preset) {
        const presetFields = [
            getPresetLabel(preset),
            preset.kind,
            preset.type || "",
            preset.marker || "",
            preset.kind === "switch" ? "mechanical physical switch" : ""
        ];
        if (presetFields.some((field) => normalizeSearch(field).includes(query))) {
            return true;
        }
    }

    return items.some((item) => {
        const fields = [
            item.name,
            item.displayName,
            item.type,
            getTypeLabel(item.type)
        ];
        return fields.some((field) => normalizeSearch(field).includes(query));
    });
}

function getPositionSearchAliases(positionId) {
    const aliases = [];
    const mergedMatch = /^R(\d{2})C1$/.exec(positionId);
    if (mergedMatch && MERGED_SENSOR_ROWS.has(Number(mergedMatch[1]))) {
        aliases.push(`R${mergedMatch[1]}C2`);
    }

    const utility = getBoardUtility(positionId);
    if (utility && Array.isArray(utility.aliases)) {
        aliases.push(...utility.aliases);
    }

    return aliases;
}

function showPositionTooltip(positionId, event) {
    const items = getPositionItems(positionId);
    const preset = getFixedPreset(positionId);
    const utility = getBoardUtility(positionId);

    if (utility) {
        dom.hardwareTooltip.innerHTML = createUtilityTooltipHtml(positionId, utility);
        dom.hardwareTooltip.hidden = false;
        moveTooltip(event);
        return;
    }

    if (!items.length) {
        if (!preset) {
            hideTooltip();
            return;
        }

        dom.hardwareTooltip.innerHTML = createPresetTooltipHtml(positionId, preset);
        dom.hardwareTooltip.hidden = false;
        moveTooltip(event);
        return;
    }

    dom.hardwareTooltip.innerHTML = createTooltipHtml(positionId, items);
    dom.hardwareTooltip.hidden = false;
    moveTooltip(event);
}

function createPresetTooltipHtml(positionId, preset) {
    const extra = preset.kind === "switch"
        ? "Right-click in Edit mode for switch options"
        : `Right-click in Edit mode to set ${getPresetLabel(preset)}`;

    return `
        <p class="tooltip-title">${escapeHtml(getDisplayPositionLabel(positionId))}</p>
        <p class="tooltip-subtitle">Default: ${escapeHtml(getPresetLabel(preset))}</p>
        <p class="tooltip-subtitle">${escapeHtml(extra)}</p>
    `;
}

function createUtilityTooltipHtml(positionId, utility) {
    return `
        <p class="tooltip-title">${escapeHtml(getDisplayPositionLabel(positionId))}</p>
        <p class="tooltip-subtitle">${escapeHtml(utility.title)}</p>
        <p class="tooltip-subtitle">${escapeHtml(getUtilityStatusText(utility))}</p>
    `;
}

function createTooltipHtml(positionId, items) {
    if (items.length === 1) {
        const item = items[0];
        return `
            <p class="tooltip-title">${escapeHtml(item.name)}</p>
            <p class="tooltip-subtitle">${escapeHtml(getTypeLabel(item.type))}</p>
            <p class="tooltip-subtitle">${escapeHtml(getDisplayPositionLabel(positionId))}</p>
        `;
    }

    const allSensors = items.every((item) => item.type === "sensor");
    const subtitle = allSensors ? `${items.length} Sensors` : `${items.length} Items`;
    const list = items.map((item) => `
        <div class="tooltip-item">${escapeHtml(item.displayName)} - ${escapeHtml(item.name)}</div>
    `).join("");

    return `
        <p class="tooltip-title">${escapeHtml(getDisplayPositionLabel(positionId))}</p>
        <p class="tooltip-subtitle">${escapeHtml(subtitle)}</p>
        <div class="tooltip-list">${list}</div>
    `;
}

function moveTooltip(event) {
    if (dom.hardwareTooltip.hidden) {
        return;
    }

    const offset = 14;
    const tooltipRect = dom.hardwareTooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let x = event.clientX + offset;
    let y = event.clientY + offset;

    if (x + tooltipRect.width > viewportWidth - 10) {
        x = event.clientX - tooltipRect.width - offset;
    }

    if (y + tooltipRect.height > viewportHeight - 10) {
        y = event.clientY - tooltipRect.height - offset;
    }

    dom.hardwareTooltip.style.left = `${Math.max(10, x)}px`;
    dom.hardwareTooltip.style.top = `${Math.max(10, y)}px`;
}

function hideTooltip() {
    dom.hardwareTooltip.hidden = true;
}

function openModal(html) {
    dom.modalContent.innerHTML = html;
    dom.modalOverlay.hidden = false;
    requestAnimationFrame(() => dom.modalOverlay.classList.add("is-open"));
}

function bindModalCloseButtons() {
    Array.from(document.querySelectorAll("[data-modal-close]")).forEach((button) => {
        button.addEventListener("click", closeModal);
    });
}

function closeModal() {
    editorContext = null;
    dom.modalOverlay.classList.remove("is-open");
    window.setTimeout(() => {
        dom.modalOverlay.hidden = true;
        dom.modalContent.innerHTML = "";
    }, 160);
}

function startProjectNameEdit() {
    if (!isEditMode()) {
        showToast("Switch to Edit mode to edit project name");
        return;
    }

    projectNameDraft = normalizeString(appState.project.name) || DEFAULT_PROJECT_NAME;
    dom.projectNameRegion.innerHTML = `
        <form class="project-name-form" id="projectNameForm">
            <input class="project-name-input" id="projectNameInput" type="text" value="${escapeAttribute(projectNameDraft)}" aria-label="Project name">
        </form>
    `;

    const form = document.getElementById("projectNameForm");
    const input = document.getElementById("projectNameInput");

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveProjectNameEdit();
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            cancelProjectNameEdit();
        }
    });
    input.addEventListener("blur", saveProjectNameEdit);
    input.focus();
    input.select();
}

function saveProjectNameEdit() {
    const input = document.getElementById("projectNameInput");
    if (!input) {
        return;
    }

    const name = normalizeString(input.value) || DEFAULT_PROJECT_NAME;
    appState.project.name = name;
    restoreProjectNameButton();
    flushProjectSaveNow();
    renderProjectName();
}

function cancelProjectNameEdit() {
    appState.project.name = projectNameDraft;
    restoreProjectNameButton();
    renderProjectName();
}

function restoreProjectNameButton() {
    dom.projectNameRegion.innerHTML = `
        <button class="project-name-button" id="projectNameButton" type="button" aria-label="Edit project name">
            <span id="projectNameText"></span>
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
            </svg>
        </button>
    `;
    dom.projectNameButton = document.getElementById("projectNameButton");
    dom.projectNameText = document.getElementById("projectNameText");
    dom.projectNameButton.addEventListener("click", startProjectNameEdit);
}

function hasProjectData() {
    const normalized = createExportData(appState);
    const project = normalized.project;
    const hasMetadata = project.name !== DEFAULT_PROJECT_NAME
        || project.harness
        || project.ecuName
        || project.partNumber
        || project.calibrationId
        || project.canoeFile
        || project.notes;
    const hasPositions = Object.keys(normalized.setups.checkpoint.positions).length > 0
        || Object.keys(normalized.setups.container.positions).length > 0;
    const hasCustomCan = hasCustomCanChannels(normalized.setups.checkpoint.canChannels)
        || hasCustomCanChannels(normalized.setups.container.canChannels);

    return Boolean(hasMetadata || hasPositions || hasCustomCan);
}

function activeSetupHasData() {
    const setup = cloneSetup(appState.setups[appState.activeSetup]);
    return Object.keys(setup.positions).length > 0 || hasCustomCanChannels(setup.canChannels);
}

function hasCustomCanChannels(canChannels) {
    const channels = normalizeCanChannels(canChannels);
    return Object.keys(DEFAULT_CAN_CHANNELS).some((channelKey) => {
        return channels[channelKey] !== DEFAULT_CAN_CHANNELS[channelKey];
    });
}

function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    dom.toastRegion.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("is-visible"));

    window.setTimeout(() => {
        toast.classList.remove("is-visible");
        window.setTimeout(() => toast.remove(), 200);
    }, 2300);
}

function sanitizeFilename(name) {
    const cleaned = normalizeString(name)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");
    return cleaned || "Untitled_Project";
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) {
        return "Unknown size";
    }

    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const decimals = unitIndex === 0 || size >= 10 ? 0 : 1;
    return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function makeDisplayNameFromName(name) {
    const words = normalizeString(name).split(/\s+/).filter(Boolean);
    if (!words.length) {
        return "";
    }

    const initials = words.map((word) => word.charAt(0).toUpperCase()).join("");
    return initials.slice(0, 8) || words[0].slice(0, 8).toUpperCase();
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
    return escapeHtml(value);
}

function generateDemoData() {
    return normalizeState({
        version: 1,
        activeSetup: "checkpoint",
        project: {
            name: "EPS PROJECT GEN 5",
            harness: "Harness 08",
            ecuName: "ACU Gen 5",
            partNumber: "123456789",
            calibrationId: "CAL_001",
            notes: ""
        },
        setups: {
            checkpoint: {
                positions: {
                    R02C1: {
                        items: [
                            { type: "squib", name: "Driver Airbag", displayName: "DAB", notes: "" }
                        ]
                    },
                    R02C2: {
                        items: [
                            { type: "squib", name: "Passenger Airbag", displayName: "PAB", notes: "" }
                        ]
                    },
                    R03C2: {
                        items: [
                            { type: "sensor", name: "Front Impact Sensor", displayName: "FIS", notes: "" },
                            { type: "sensor", name: "Side Impact Sensor", displayName: "SIS", notes: "" }
                        ]
                    },
                    R05C4: {
                        items: [
                            { type: "physicalSwitch", name: "Ignition Switch", displayName: "IGN", notes: "" }
                        ]
                    },
                    R07C5: {
                        items: [
                            { type: "mechanicalSwitch", name: "Driver Buckle Switch", displayName: "DBS", notes: "" }
                        ]
                    }
                }
            },
            container: {
                positions: {
                    R04C1: {
                        items: [
                            { type: "squib", name: "Passenger Airbag", displayName: "PAB", notes: "" }
                        ]
                    },
                    R08C2: {
                        items: [
                            { type: "sensor", name: "Pressure Sensor", displayName: "PS", notes: "" }
                        ]
                    },
                    R10C4: {
                        items: [
                            { type: "mechanicalSwitch", name: "Passenger Buckle Switch", displayName: "PBS", notes: "" }
                        ]
                    }
                }
            }
        }
    });
}

window.generateDemoData = generateDemoData;
