/* Box UI uses the existing appState, storage, write queue, modes and detail panel. */
let boxDom;
let boxPendingWrites = 0;
const boxHarnessTimers = new Map();
const boxNodes = new Map(BOX_TEMPLATE.nodes.map(node => [node.id, node]));

function createInitialBoxState() {
    return { settings: { harness: "", revision: 0 }, setups: { checkpoint: { connections: [] }, container: { connections: [] } }, revision: "" };
}

function normalizeBoxState(value) {
    const initial = createInitialBoxState();
    if (!value || typeof value !== "object") return initial;
    return {
        settings: { harness: normalizeString(value.harness ?? value.settings?.harness), revision: Number(value.settings?.revision) || 0 },
        setups: Object.fromEntries(["checkpoint", "container"].map(setup => [setup, {
            connections: Array.isArray(value.setups?.[setup]?.connections) ? value.setups[setup].connections.map(item => ({ ...item })) : []
        }])),
        revision: value.revision || ""
    };
}

function portableBox(value) {
    const box = normalizeBoxState(value);
    if (!box.settings.harness && !Object.values(box.setups).some(setup => setup.connections.length)) return undefined;
    return {
        harness: box.settings.harness,
        setups: Object.fromEntries(Object.entries(box.setups).map(([key, setup]) => [key, {
            connections: setup.connections.map(item => Object.fromEntries(
                ["type", "name", "displayName", "node1", "role1", "node2", "role2", "notes"].map(field => [field, normalizeString(item[field])])
            ))
        }]))
    };
}

function validBoxImport(value) {
    if (value === undefined) return true;
    return isPlainObject(value) && isPlainObject(value.setups) && ["checkpoint", "container"].every(setup => {
        const items = value.setups[setup]?.connections;
        return Array.isArray(items) && items.every(item => isPlainObject(item)
            && BOX_TEMPLATE.types.includes(item.type) && normalizeString(item.name) && normalizeString(item.displayName)
            && boxNodes.has(item.node1) && boxNodes.has(item.node2) && item.node1 !== item.node2);
    });
}

function initializeBox() {
    boxDom = {
        view: document.getElementById("boxView"), board: document.getElementById("boxBoard"),
        chips: document.getElementById("boxChips"), add: document.getElementById("addBoxHardwareButton"),
        harness: document.getElementById("boxHarnessInput"), tabs: [...document.querySelectorAll("[data-layout-tab]")],
        table: document.getElementById("boxConnectionsTable"), tableTitle: document.getElementById("boxConnectionsTitle")
    };
    boxDom.tabs.forEach(button => button.addEventListener("click", () => switchHardwareLayout(button.dataset.layoutTab)));
    boxDom.add.addEventListener("click", () => openBoxEditor());
    boxDom.harness.addEventListener("input", scheduleBoxHarnessSave);
    boxDom.harness.addEventListener("blur", () => { boxDom.harness.value = boxDom.harness.value.trim(); });
    boxDom.board.innerHTML = createBoxBoardMarkup();
    boxDom.board.querySelectorAll("[data-box-node]").forEach(element => {
        const node = boxNodes.get(element.dataset.boxNode);
        element.addEventListener("click", () => selectBoxNode(node.id));
        element.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectBoxNode(node.id); }
        });
        element.addEventListener("mouseenter", event => showBoxNodeTooltip(node, event));
        element.addEventListener("focus", event => showBoxNodeTooltip(node, event));
        element.addEventListener("mousemove", moveTooltip);
        element.addEventListener("mouseleave", hideTooltip);
        element.addEventListener("blur", hideTooltip);
    });
}

function createBoxBoardMarkup() {
    const groups = BOX_TEMPLATE.groups.map(group => `<rect class="box-group" x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="28"/>`).join("");
    const screws = [[30, 30], [1090, 30], [30, 790], [1090, 790]].map(([x, y]) =>
        `<g class="box-screw" transform="translate(${x} ${y})"><circle r="20"/><path d="M-9 -9 9 9 M-9 9 9 -9"/></g>`).join("");
    const switches = BOX_TEMPLATE.switches.map((item, index) => `<g class="box-switch" transform="translate(${item.x} ${item.y})" aria-hidden="true">
        <path class="box-switch-nut" d="M-14 -23 14 -23 25 0 14 23 -14 23 -25 0Z"/>
        <circle r="17"/><path class="box-switch-lever" d="M0 0 ${index % 3 === 0 ? -13 : 10} -27"/>
        <text y="64">${item.label}</text></g>`).join("");
    const nodes = BOX_TEMPLATE.nodes.map(node => `<g class="box-node box-socket-${node.color}" data-box-node="${node.id}" transform="translate(${node.x} ${node.y})"
        tabindex="0" role="button" aria-describedby="hardwareTooltip" aria-label="${escapeAttribute(`${node.id}, ${node.label}, ${BOX_TEMPLATE.colors[node.color]} ${node.kind}`)}">
        <circle class="box-node-ring" r="37"/><circle class="box-socket" r="30"/>
        <circle class="box-socket-hole" r="13"/><path class="box-contact" d="M-6 -8 -9 6 M7 -9 9 6"/>
        ${node.sharedLabel ? "" : `<text class="box-node-label" y="64">${node.label}</text>`}
        <g class="box-role" hidden transform="translate(${node.x < BOX_TEMPLATE.groups.find(group => group.id === node.group).switchX ? 53 : -53} 0)"><rect x="-27" y="-52" width="54" height="21" rx="4"/><text y="-37"></text></g>
        </g>`).join("");
    return `<svg viewBox="0 0 ${BOX_TEMPLATE.width} ${BOX_TEMPLATE.height}" role="group" aria-label="Box board, four physical groups" xmlns="http://www.w3.org/2000/svg">
        <rect class="box-enclosure" x="3" y="3" width="1114" height="814" rx="35"/>${screws}${groups}${switches}${nodes}
        <text class="box-shared-label" x="929" y="649">A48/B58/B6</text></svg>`;
}

function switchHardwareLayout(layout) {
    if (!["pbox", "box"].includes(layout) || layout === appState.activeLayout) return;
    appState.activeLayout = layout;
    appState.boxEditor = null;
    appState.selectedPosition = null;
    editorContext = null;
    clearSelectionState();
    endPositionDragSelection();
    hideTooltip();
    hidePositionContextMenu();
    renderApp();
}

function boxConnections() {
    return appState.box.setups[appState.activeSetup].connections;
}

function selectedBoxConnection() {
    return boxConnections().find(item => item.id === appState.selectedBoxHardware);
}

function renderBoxHarness() {
    if (!boxDom) return;
    boxDom.harness.readOnly = !isEditMode();
    if (document.activeElement !== boxDom.harness) boxDom.harness.value = appState.box.settings.harness;
}

function renderBoxLayout() {
    if (!boxDom) return;
    const active = appState.activeLayout === "box";
    boxDom.view.hidden = !active;
    dom.mapScroll.hidden = active;
    dom.setupSummary.hidden = active;
    dom.mapHint.hidden = active;
    dom.searchStatus.hidden = active;
    document.querySelector(".legend").hidden = active;
    document.querySelector(".board-clipboard-tools").hidden = active;
    dom.copySetupButton.hidden = !currentProjectId || active;
    dom.pasteSetupButton.hidden = !currentProjectId || active;
    document.getElementById("positionDetailsTitle").textContent = active ? "Selected Hardware" : "Position Details";
    boxDom.tabs.forEach(button => {
        const selected = button.dataset.layoutTab === appState.activeLayout;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-selected", String(selected));
    });
    renderBoxHarness();
    if (!active) return;
    boxDom.add.hidden = !isEditMode();
    boxDom.add.disabled = Boolean(boxPendingWrites);
    const focusedChip = document.activeElement?.dataset.boxHardware;
    boxDom.chips.replaceChildren();
    boxConnections().forEach(item => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "box-chip";
        chip.dataset.boxHardware = String(item.id);
        chip.textContent = item.displayName;
        chip.title = item.name;
        chip.setAttribute("aria-pressed", String(item.id === appState.selectedBoxHardware));
        chip.addEventListener("click", () => selectBoxHardware(item.id));
        boxDom.chips.appendChild(chip);
    });
    const all = document.createElement("button");
    all.type = "button";
    all.className = "box-chip";
    all.dataset.boxHardware = "all";
    all.textContent = "Show All";
    all.setAttribute("aria-pressed", String(!appState.selectedBoxHardware && !appState.selectedBoxNode));
    all.addEventListener("click", () => selectBoxHardware(null));
    boxDom.chips.appendChild(all);
    if (focusedChip) [...boxDom.chips.children].find(button => button.dataset.boxHardware === focusedChip)?.focus();
    const selected = selectedBoxConnection();
    boxDom.board.querySelectorAll("[data-box-node]").forEach(element => {
        const id = element.dataset.boxNode;
        const endpoint = selected?.node1 === id ? 1 : selected?.node2 === id ? 2 : 0;
        element.classList.toggle("is-highlighted", Boolean(endpoint) || appState.selectedBoxNode === id);
        element.classList.toggle("is-dimmed", Boolean(selected) && !endpoint);
        element.setAttribute("aria-pressed", String(Boolean(endpoint) || appState.selectedBoxNode === id));
        const badge = element.querySelector(".box-role");
        badge.toggleAttribute("hidden", !endpoint);
        const role = endpoint ? selected[`role${endpoint}`] || String(endpoint) : "";
        badge.querySelector("text").textContent = role.length > 5 ? role.slice(0, 4) + "..." : role;
    });
    renderBoxConnections();
    renderBoxDetails();
}

function renderBoxConnections() {
    const focusedRow = document.activeElement?.dataset.boxRow;
    boxDom.tableTitle.textContent = `Hardware Connections (${SETUP_LABELS[appState.activeSetup]} - Box)`;
    const editable = isEditMode();
    boxDom.table.innerHTML = `<thead><tr><th scope="col">#</th><th scope="col">Hardware / Display Name</th><th scope="col">Type</th>
        <th scope="col">Endpoint 1 + Role</th><th scope="col">Endpoint 2 + Role</th><th scope="col">Notes</th>
        ${editable ? '<th scope="col" class="box-actions-heading">Actions</th>' : ''}</tr></thead>`;
    const body = boxDom.table.createTBody();
    boxConnections().forEach((item, index) => {
        const row = body.insertRow();
        row.dataset.boxRow = String(item.id);
        row.tabIndex = 0;
        row.classList.toggle("is-selected", item.id === appState.selectedBoxHardware);
        row.setAttribute("aria-current", String(item.id === appState.selectedBoxHardware));
        row.innerHTML = `<td>${index + 1}</td><td><strong>${escapeHtml(item.displayName)}</strong><span>${escapeHtml(item.name)}</span></td>
            <td>${escapeHtml(getTypeLabel(item.type))}</td><td>${escapeHtml(boxEndpointLabel(item.node1, item.role1))}</td>
            <td>${escapeHtml(boxEndpointLabel(item.node2, item.role2))}</td><td>${escapeHtml(item.notes || "-")}</td>`;
        row.addEventListener("click", () => selectBoxHardware(item.id));
        row.addEventListener("keydown", event => {
            if (event.target === row && ["Enter", " "].includes(event.key)) {
                event.preventDefault();
                selectBoxHardware(item.id);
            }
        });
        if (editable) {
            const actions = row.insertCell();
            [["Edit", () => openBoxEditor(item)], ["Delete", () => requestDeleteBoxHardware(item)]].forEach(([label, handler]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "box-table-action";
                button.textContent = label;
                button.setAttribute("aria-label", `${label} ${item.displayName}`);
                button.addEventListener("click", event => { event.stopPropagation(); handler(); });
                actions.appendChild(button);
            });
        }
    });
    if (!body.rows.length) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = editable ? 7 : 6;
        cell.textContent = "No hardware connections";
    }
    if (focusedRow) [...body.rows].find(row => row.dataset.boxRow === focusedRow)?.focus({ preventScroll: true });
}

function selectBoxHardware(id) {
    appState.selectedBoxHardware = id;
    appState.selectedBoxNode = null;
    appState.boxEditor = null;
    hideTooltip();
    renderBoxLayout();
}

function selectBoxNode(id) {
    const matches = boxConnections().filter(item => item.node1 === id || item.node2 === id);
    if (matches.length === 1) { selectBoxHardware(matches[0].id); return; }
    appState.selectedBoxNode = id;
    appState.selectedBoxHardware = null;
    appState.boxEditor = null;
    renderBoxLayout();
}

function showBoxNodeTooltip(node, event) {
    const matches = boxConnections().filter(item => item.node1 === node.id || item.node2 === node.id);
    dom.hardwareTooltip.innerHTML = `<strong>${escapeHtml(node.id)}</strong><div>${escapeHtml(node.label)} | ${BOX_TEMPLATE.colors[node.color]} ${node.kind}</div>
        ${matches.map(item => `<div>${escapeHtml(item.displayName)} - ${escapeHtml(item.name)} (${escapeHtml(getTypeLabel(item.type))})</div>`).join("") || "<div>Unmapped</div>"}`;
    dom.hardwareTooltip.hidden = false;
    if (event.type === "focus") {
        const rect = event.currentTarget.getBoundingClientRect();
        moveTooltip({ clientX: rect.right, clientY: rect.top });
    } else moveTooltip(event);
}

function boxEndpointLabel(id, role) {
    const node = boxNodes.get(id);
    return node ? `${node.label} (${node.group})${role ? ` | ${role}` : ""}` : id;
}

function renderBoxDetails() {
    const container = dom.positionDetailsContent;
    container.replaceChildren();
    if (appState.boxEditor && isEditMode()) { renderBoxEditor(container); return; }
    const selected = selectedBoxConnection();
    const node = boxNodes.get(appState.selectedBoxNode);
    if (!selected) {
        if (node) {
            container.append(createDetailRow("Node", node.id), createDetailRow("Label", node.label), createDetailRow("Socket", `${BOX_TEMPLATE.colors[node.color]} ${node.kind}`));
            const matches = boxConnections().filter(item => item.node1 === node.id || item.node2 === node.id);
            container.append(createActionGroup(matches.map(item => ({ label: item.displayName, className: "secondary-button", handler: () => selectBoxHardware(item.id) }))));
        } else {
            const empty = document.createElement("div");
            empty.className = "empty-details";
            empty.textContent = "Select hardware to view its Box mapping";
            container.appendChild(empty);
        }
        return;
    }
    const details = document.createElement("div");
    details.className = "detail-list";
    [["Hardware Name", selected.name], ["Display Name", selected.displayName], ["Type", getTypeLabel(selected.type)],
        ["Endpoint 1", boxEndpointLabel(selected.node1, selected.role1)], ["Endpoint 2", boxEndpointLabel(selected.node2, selected.role2)],
        ["Box Harness", appState.box.settings.harness || "-"], ["Notes", selected.notes || "-"]]
        .forEach(([label, value]) => details.appendChild(createDetailRow(label, value)));
    container.appendChild(details);
    if (isEditMode()) container.appendChild(createActionGroup([
        { label: "Edit", className: "secondary-button", handler: () => openBoxEditor(selected) },
        { label: "Delete", className: "danger-button", handler: () => requestDeleteBoxHardware(selected) }
    ]));
}

function openBoxEditor(item = null) {
    if (!isEditMode() || boxPendingWrites) return;
    appState.boxEditor = { projectId: currentProjectId, setup: appState.activeSetup, item: item ? { ...item } : null };
    renderBoxDetails();
    document.getElementById("boxName").focus();
}

function renderBoxEditor(container) {
    const item = appState.boxEditor.item || { type: "sensor", role1: "+", role2: "-" };
    const options = selected => `<option value="">Select socket</option>` + BOX_TEMPLATE.nodes.map(node =>
        `<option value="${node.id}"${node.id === selected ? " selected" : ""}>${escapeHtml(node.label)} (${node.group}, ${BOX_TEMPLATE.colors[node.color]})</option>`).join("");
    const field = (label, key, id = key) => `<label class="modal-field"><span class="form-label">${label}</span><input id="${id}" name="${key}" value="${escapeAttribute(item[key] || "")}" ${["name", "displayName"].includes(key) ? "required" : ""}></label>`;
    container.innerHTML = `<form class="inline-editor-form box-editor" id="boxEditorForm">
        <h3>${item.id ? "Edit" : "Add"} Hardware</h3>
        <label class="modal-field"><span class="form-label">Hardware Type</span><select name="type">${BOX_TEMPLATE.types.map(type => `<option value="${type}"${type === item.type ? " selected" : ""}>${getTypeLabel(type)}</option>`).join("")}</select></label>
        ${field("Hardware Name", "name", "boxName")}${field("Display Name", "displayName", "boxDisplayName")}
        <label class="modal-field"><span class="form-label">Endpoint 1</span><select name="node1" required>${options(item.node1)}</select></label>
        ${field("Endpoint 1 Role", "role1")}
        <label class="modal-field"><span class="form-label">Endpoint 2</span><select name="node2" required>${options(item.node2)}</select></label>
        ${field("Endpoint 2 Role", "role2")}
        <label class="modal-field"><span class="form-label">Notes</span><textarea name="notes" rows="3">${escapeHtml(item.notes || "")}</textarea></label>
        <div class="form-error" role="alert" id="boxFormError"></div>
        <div class="inline-editor-footer"><button type="button" class="secondary-button" id="cancelBoxEditor">Cancel</button><button type="submit" class="action-button primary">Save</button></div>
        </form>`;
    document.getElementById("cancelBoxEditor").addEventListener("click", () => { appState.boxEditor = null; renderBoxDetails(); });
    const form = document.getElementById("boxEditorForm");
    if (!appState.boxEditor.item) {
        const editedRoles = new Set();
        ["role1", "role2"].forEach(key => form.elements[key].addEventListener("input", () => editedRoles.add(key)));
        form.elements.type.addEventListener("change", () => {
            ["role1", "role2"].forEach((key, index) => {
                if (!editedRoles.has(key)) form.elements[key].value = form.elements.type.value === "sensor" ? ["+", "-"][index] : "";
            });
        });
    }
    form.addEventListener("submit", saveBoxHardware);
}

async function saveBoxHardware(event) {
    event.preventDefault();
    const editor = appState.boxEditor;
    if (!editor || !isEditMode() || boxPendingWrites) return;
    const form = event.currentTarget;
    const payload = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
    if (!payload.name || !payload.displayName || !boxNodes.has(payload.node1) || !boxNodes.has(payload.node2) || payload.node1 === payload.node2) {
        document.getElementById("boxFormError").textContent = "Enter both names and choose two different sockets.";
        return;
    }
    if (editor.item) payload.revision = editor.item.revision;
    form.querySelectorAll("button").forEach(button => { button.disabled = true; });
    boxPendingWrites++;
    setSaveIndicator("Saving...", "saving");
    try {
        const data = await queueProjectWrite(() => storage.saveBoxConnection(editor.projectId, editor.setup, editor.item?.id, payload));
        if (currentProjectId === editor.projectId) {
            applyBoxResponse(data.box);
            if (appState.boxEditor === editor) {
                appState.boxEditor = null;
                appState.selectedBoxHardware = editor.item?.id || data.box.setups[editor.setup].connections.at(-1)?.id;
            }
            renderBoxLayout();
            setSaveIndicator("Saved", "saved");
        }
        showToast("Box hardware saved");
    } catch (error) {
        showToast(getSaveErrorMessage(error));
        setSaveIndicator(error.status === 409 ? "Conflict" : "Failed to save", "error");
        if (currentProjectId === editor.projectId && appState.boxEditor === editor) {
            document.getElementById("boxFormError").textContent = getSaveErrorMessage(error);
            form.querySelectorAll("button").forEach(button => { button.disabled = false; });
        }
    } finally {
        boxPendingWrites--;
        boxDom.add.disabled = Boolean(boxPendingWrites);
    }
}

function requestDeleteBoxHardware(item) {
    if (!isEditMode() || boxPendingWrites) return;
    const projectId = currentProjectId;
    const setup = appState.activeSetup;
    openModal(`<div class="modal-header"><h2 id="modalTitle">Delete ${escapeHtml(item.displayName)}?</h2></div>
        <div class="modal-footer"><button type="button" class="secondary-button" data-modal-close>Cancel</button><button type="button" class="danger-button" id="confirmDeleteBox">Delete</button></div>`);
    bindModalCloseButtons();
    document.getElementById("confirmDeleteBox").addEventListener("click", async event => {
        event.currentTarget.disabled = true;
        boxPendingWrites++;
        try {
            const data = await queueProjectWrite(() => storage.deleteBoxConnection(projectId, setup, item.id, item.revision));
            if (currentProjectId === projectId) { applyBoxResponse(data.box); appState.selectedBoxHardware = null; renderBoxLayout(); }
            closeModal();
            showToast("Box hardware removed");
        } catch (error) {
            showToast(getSaveErrorMessage(error));
            closeModal();
        } finally { boxPendingWrites--; boxDom.add.disabled = Boolean(boxPendingWrites); }
    });
}

function applyBoxResponse(box) {
    const draft = boxHarnessTimers.has(currentProjectId) ? appState.box.settings.harness : null;
    appState.box = normalizeBoxState(box);
    if (draft !== null) appState.box.settings.harness = draft;
    renderBoxHarness();
}

function scheduleBoxHarnessSave() {
    if (!isEditMode() || !currentProjectId) return;
    const projectId = currentProjectId;
    const settings = appState.box.settings;
    settings.harness = boxDom.harness.value;
    const harness = settings.harness.trim();
    clearTimeout(boxHarnessTimers.get(projectId));
    setSaveIndicator("Saving...", "saving");
    boxHarnessTimers.set(projectId, setTimeout(async () => {
        boxHarnessTimers.delete(projectId);
        boxPendingWrites++;
        try {
            const data = await queueProjectWrite(() => storage.updateBoxSettings(projectId, { harness, revision: settings.revision }));
            settings.revision = data.box.settings.revision;
            if (currentProjectId === projectId) { applyBoxResponse(data.box); setSaveIndicator("Saved", "saved"); }
        } catch (error) {
            setSaveIndicator(error.status === 409 ? "Conflict" : "Failed to save", "error");
            showToast(getSaveErrorMessage(error));
        } finally { boxPendingWrites--; }
    }, 700));
}

async function pollBoxUpdates(projectId) {
    if (boxPendingWrites || boxHarnessTimers.size || appState.boxEditor) return;
    const data = await storage.loadBox(projectId);
    if (projectId !== currentProjectId || boxPendingWrites || boxHarnessTimers.size || appState.boxEditor) return;
    if (data.box.revision !== appState.box.revision) {
        applyBoxResponse(data.box);
        if (!selectedBoxConnection()) appState.selectedBoxHardware = null;
        renderBoxLayout();
    }
}
