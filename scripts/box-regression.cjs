const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

module.exports = async function testBox({ page, api, check, base, sandbox, writes, child }) {
    const project = (await api('/projects', { folderId: child.id, project: { name: 'Box Test', harness: 'P-Box original' } })).project;
    const id = project.id;
    const boxPath = `/projects/${id}/box`;
    const layout = name => page.locator(`[data-layout-tab="${name}"]`).click();
    const setup = name => page.locator(`[data-setup-tab="${name}"]`).click();
    const mode = name => page.locator(`[data-interaction-mode="${name}"]`).click();
    const load = async () => { await page.goto(`${base}/?project=${id}`); await page.locator('.workspace').waitFor({ state: 'visible' }); };
    const fill = async (name, node1, node2) => {
        await page.locator('#boxName').fill(name + ' hardware');
        await page.locator('#boxDisplayName').fill(name);
        await page.locator('#boxEditorForm [name="node1"]').selectOption(node1);
        await page.locator('#boxEditorForm [name="node2"]').selectOption(node2);
    };
    const save = async () => {
        await page.locator('#boxEditorForm button[type="submit"]').click();
        await page.locator('#boxEditorForm').waitFor({ state: 'hidden' });
    };
    let first;
    await check('Box legacy defaults / fixed template / navigation and selection do not write', async () => {
        await load();
        const before = writes.length;
        await layout('box'); await layout('pbox'); await layout('box');
        assert.equal(await page.locator('[data-box-node]').count(), 56);
        assert.equal(await page.locator('.box-group').count(), 4);
        assert.equal(await page.locator('.box-switch').count(), 26);
        const canonical = [
            'B15:W A9:W B16:W A20:W B17:W A21:W B18:W A22:W B20:W A25:W B33:W A26:W B38:W A33:W',
            'B70:W A38:W B56:W A39:W B57:W B19:W B59:BK A10:BK B60:BL A11:BL B52:BK A12:BK B51:BL A13:BL',
            'B63:BK A23:BK B64:BL A24:BL B13:BK A35:BK B14:BL A34:BL B49:BK B66:BK B50:BL B65:BL B31:BK A36:BK',
            'B32:BL A37:BL B67:BK A49:BK B68:BL A50:BL B34:BK B62:BK B33:BL B61:BL'
        ];
        const actual = await page.evaluate(() => BOX_TEMPLATE.groups.map(group => BOX_TEMPLATE.nodes
            .filter(node => node.group === group.id && !node.sharedLabel && node.color !== 'R')
            .map(node => `${node.label}:${node.color}`).join(' ')));
        assert.deepEqual(actual, canonical);
        assert.equal(await page.locator('[data-box-node="G2-B19"]').getAttribute('class'), 'box-node box-socket-W');
        assert.equal(await page.locator('[data-box-node="G2-A10"]').getAttribute('class'), 'box-node box-socket-BK');
        assert.deepEqual(await page.evaluate(() => BOX_TEMPLATE.switches.map(item => item.label)), Array.from({ length: 26 }, (_, i) => `SW${i + 1}`));
        assert.equal(await page.locator('.box-shared-label').textContent(), 'A48/B58/B6');
        assert.equal(await page.locator('.box-socket-R').count(), 2);
        await page.locator('[data-box-node="G4-SPECIAL-L"]').click();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /A48\/B58\/B6/);
        await page.locator('#boxChips').getByRole('button', { name: 'Show All', exact: true }).click();
        await page.waitForTimeout(750);
        assert.equal(writes.length, before);
        assert.equal(await page.locator('#boxHarnessInput').inputValue(), '');
        assert.equal(await page.locator('#addBoxHardwareButton').isVisible(), false);
        const box = (await api(boxPath, undefined, 'GET')).box;
        assert.equal(box.settings.revision, 0);
        assert.deepEqual(box.setups.checkpoint.connections, []);
        assert.equal(await page.locator('#boxConnectionsTitle').textContent(), 'Hardware Connections (Checkpoint - Box)');
        assert.match(await page.locator('#boxConnectionsTable').innerText(), /No hardware connections/);
    });
    await check('Box new Sensor defaults / other types and custom roles remain editable', async () => {
        const before = writes.length;
        await mode('edit'); await page.locator('#addBoxHardwareButton').click();
        const field = name => page.locator(`#boxEditorForm [name="${name}"]`);
        assert.equal(await field('role1').inputValue(), '+');
        assert.equal(await field('role2').inputValue(), '-');
        for (const type of ['aod', 'physicalSwitch', 'mechanicalSwitch']) {
            await field('type').selectOption(type);
            assert.equal(await field('role1').inputValue(), '');
            assert.equal(await field('role2').inputValue(), '');
        }
        await field('type').selectOption('sensor');
        assert.equal(await field('role1').inputValue(), '+');
        assert.equal(await field('role2').inputValue(), '-');
        await field('role1').fill('signal'); await field('role2').fill('');
        await field('type').selectOption('aod'); await field('type').selectOption('sensor');
        assert.equal(await field('role1').inputValue(), 'signal');
        assert.equal(await field('role2').inputValue(), '');
        await page.locator('#cancelBoxEditor').click();
        assert.equal(writes.length, before);
    });
    await check('Box CRUD / role highlight / socket colors / hover and focus', async () => {
        const legacy = (await api(`/projects/${id}`, undefined, 'GET')).project;
        await mode('edit'); await page.locator('#addBoxHardwareButton').click();
        await fill('FIS', 'G2-B59', 'G2-B59');
        const before = writes.length;
        await page.locator('#boxEditorForm button[type="submit"]').click();
        assert.match(await page.locator('#boxFormError').innerText(), /different/);
        assert.equal(writes.length, before);
        await page.locator('#boxEditorForm [name="node2"]').selectOption('G2-A10'); await save();
        first = (await api(boxPath, undefined, 'GET')).box.setups.checkpoint.connections[0];
        assert.equal(first.role1, '+'); assert.equal(first.role2, '-');
        const socket = page.locator('[data-box-node="G2-A10"] .box-socket');
        const color = await socket.evaluate(element => getComputedStyle(element).fill);
        const readOnlyStart = writes.length;
        await page.locator('#boxChips').getByRole('button', { name: 'Show All', exact: true }).click();
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        await page.waitForTimeout(200);
        assert.equal(await page.locator('.box-node.is-highlighted').count(), 2);
        assert.equal(await page.locator('.box-node.is-dimmed').count(), 54);
        assert.ok(await page.locator('.box-node.is-dimmed').first().evaluate(element => Number(getComputedStyle(element).opacity) <= 0.31));
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'FIS');
        assert.equal(await socket.evaluate(element => getComputedStyle(element).fill), color);
        assert.equal(await page.locator('[data-box-node="G2-B59"] .box-role text').textContent(), '+');
        await page.locator('[data-box-node="G2-A10"]').focus();
        assert.match(await page.locator('#hardwareTooltip').innerText(), /G2-A10.*\n.*Black Socket/);
        assert.match(await page.locator('#hardwareTooltip').innerText(), /FIS/);
        await page.locator('[data-box-node="G2-B59"]').hover();
        assert.match(await page.locator('#hardwareTooltip').innerText(), /Black Socket/);
        assert.equal(writes.length, readOnlyStart);
        await page.locator('#positionDetailsContent').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#boxEditorForm [name="notes"]').fill('Revised mapping'); await save();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Revised mapping/);
        assert.deepEqual((await api(`/projects/${id}`, undefined, 'GET')).project, legacy, 'Box edit touched P-Box project data');
    });
    await check('Box connection table selection / keyboard / edit / delete / existing roles', async () => {
        const table = page.locator('#boxConnectionsTable');
        const firstRow = table.locator(`[data-box-row="${first.id}"]`);
        const before = writes.length;
        await page.locator('#boxChips').getByRole('button', { name: 'Show All', exact: true }).click();
        await firstRow.click();
        const highlights = () => page.locator('.box-node.is-highlighted').evaluateAll(nodes => nodes.map(node => node.dataset.boxNode).sort());
        assert.deepEqual(await highlights(), ['G2-A10', 'G2-B59']);
        assert.equal(await page.locator('#boxChips [aria-pressed="true"]').textContent(), 'FIS');
        assert.match(await firstRow.innerText(), /Revised mapping/);
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Front|FIS hardware/);
        assert.equal(await firstRow.getAttribute('aria-current'), 'true');
        await page.locator('#boxChips').getByRole('button', { name: 'Show All', exact: true }).click();
        await firstRow.focus(); await page.keyboard.press('Enter');
        assert.deepEqual(await highlights(), ['G2-A10', 'G2-B59']);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.boxRow), String(first.id));
        await mode('view');
        assert.equal(await table.getByRole('button').count(), 0);
        await firstRow.click();
        assert.deepEqual(await highlights(), ['G2-A10', 'G2-B59']);
        await layout('pbox'); assert.equal(await table.isVisible(), false); await layout('box');
        assert.equal(writes.length, before);

        const data = await api(`${boxPath}/checkpoint/connections`, { type: 'sensor', name: 'Existing sensor', displayName: 'OLD', node1: 'G1-B15', role1: '', node2: 'G1-A9', role2: 'custom', notes: 'Keep roles' });
        const existing = data.box.setups.checkpoint.connections.at(-1);
        await page.evaluate(() => pollProjectUpdates()); await mode('edit');
        const row = table.locator(`[data-box-row="${existing.id}"]`);
        const selectionStart = writes.length;
        await row.click();
        assert.deepEqual(await highlights(), ['G1-A9', 'G1-B15']);
        assert.equal(await page.locator('#boxChips [aria-pressed="true"]').textContent(), 'OLD');
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        assert.equal(await firstRow.getAttribute('aria-current'), 'true');
        assert.equal(await row.getAttribute('aria-current'), 'false');
        assert.deepEqual(await highlights(), ['G2-A10', 'G2-B59']);
        assert.equal(writes.length, selectionStart);
        await row.getByRole('button', { name: 'Edit OLD', exact: true }).click();
        assert.equal(await page.locator('#boxEditorForm [name="role1"]').inputValue(), '');
        assert.equal(await page.locator('#boxEditorForm [name="role2"]').inputValue(), 'custom');
        await page.locator('#boxEditorForm [name="type"]').selectOption('aod');
        await page.locator('#boxEditorForm [name="type"]').selectOption('sensor');
        assert.equal(await page.locator('#boxEditorForm [name="role1"]').inputValue(), '');
        await page.locator('#boxEditorForm [name="notes"]').fill('Edited from table'); await save();
        assert.match(await row.innerText(), /Edited from table/);
        const saved = (await api(boxPath, undefined, 'GET')).box.setups.checkpoint.connections.find(item => item.id === existing.id);
        assert.equal(saved.role1, ''); assert.equal(saved.role2, 'custom');
        await row.getByRole('button', { name: 'Delete OLD', exact: true }).click();
        await page.locator('#confirmDeleteBox').click(); await page.locator('#modalOverlay').waitFor({ state: 'hidden' });
        assert.equal(await row.count(), 0);
        assert.equal(await table.locator('[data-box-row]').count(), 1);
    });
    await check('Box setup separation and independent harness persistence', async () => {
        await page.locator('#boxHarnessInput').fill('Box harness 42');
        await page.waitForTimeout(950);
        assert.equal(await page.locator('[data-project-field="harness"]').inputValue(), 'P-Box original');
        await setup('container');
        assert.equal(await page.locator('#boxConnectionsTitle').textContent(), 'Hardware Connections (Container - Box)');
        assert.equal(await page.locator('#boxConnectionsTable [data-box-row]').count(), 0);
        assert.equal(await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).count(), 0);
        await page.locator('#addBoxHardwareButton').click(); await fill('DBS', 'G1-B33', 'G4-B33');
        await page.locator('#boxEditorForm [name="type"]').selectOption('mechanicalSwitch');
        await page.locator('#boxEditorForm [name="role1"]').fill('COM');
        await page.locator('#boxEditorForm [name="role2"]').fill('NO'); await save();
        await page.reload(); await page.locator('.workspace').waitFor({ state: 'visible' }); await layout('box');
        assert.equal(await page.locator('#boxHarnessInput').inputValue(), 'Box harness 42');
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Revised mapping/);
        await setup('container'); await page.locator('#boxChips').getByRole('button', { name: 'DBS', exact: true }).click();
        assert.match(await page.locator('#boxConnectionsTable').innerText(), /COM/);
        assert.match(await page.locator('#boxConnectionsTable').innerText(), /NO/);
        assert.doesNotMatch(await page.locator('#boxConnectionsTable').innerText(), /FIS/);
        assert.match(await page.locator('#positionDetailsContent').innerText(), /B33 \(G1\).*\n/);
        assert.equal(await page.locator('#positionDetailsContent').getByRole('button', { name: 'Edit', exact: true }).count(), 0);
    });
    await check('Box polling / stale revision conflicts preserve newer data', async () => {
        await setup('checkpoint');
        const current = (await api(boxPath, undefined, 'GET')).box.setups.checkpoint.connections[0];
        await api(`${boxPath}/checkpoint/connections/${current.id}`, { ...current, name: 'Remote hardware' }, 'PATCH');
        const stale = await fetch(`${base}/api${boxPath}/checkpoint/connections/${current.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, name: 'Stale hardware' })
        });
        assert.equal(stale.status, 409);
        await page.evaluate(() => pollProjectUpdates());
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Remote hardware/);
        assert.equal(await page.evaluate(() => appState.activeLayout), 'box');
    });
    await check('Box responsive screenshots / P-Box still fits both viewports', async () => {
        for (const [width, height] of [[1366, 768], [1920, 1080]]) {
            await page.setViewportSize({ width, height });
            await page.locator('#boxChips').getByRole('button', { name: 'Show All', exact: true }).click();
            await page.waitForTimeout(220);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const board = await page.locator('.box-board-scroll').boundingBox();
            assert.ok(board.y + board.height <= height && board.width > 480);
            const table = await page.locator('.box-connections-scroll').boundingBox();
            assert.ok(table.y + table.height <= height && table.height > 40, 'connection table must remain visible and scrollable');
            await page.locator('.box-board-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
            const bottomNode = await page.locator('[data-box-node="G4-B55"]').boundingBox();
            assert.ok(bottomNode.y + bottomNode.height <= board.y + board.height, 'bottom power socket must be reachable by scrolling');
            await page.locator('.box-board-scroll').evaluate(element => { element.scrollTop = 0; });
            await page.screenshot({ path: path.join(sandbox, `box-${width}.png`) });
            await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
            await page.waitForTimeout(220);
            await page.screenshot({ path: path.join(sandbox, `box-selected-${width}.png`) });
            await mode('edit');
            assert.equal(await page.locator('#boxConnectionsTable').getByRole('button', { name: 'Edit FIS', exact: true }).isVisible(), true);
            await page.screenshot({ path: path.join(sandbox, `box-table-edit-${width}.png`) });
            await mode('view');
            await layout('pbox');
            assert.equal(await page.locator('#mapScroll').isVisible(), true);
            await layout('box');
        }
    });
    await check('Box additive JSON export/import and deletion survive reload', async () => {
        const download = page.waitForEvent('download'); await page.locator('#exportButton').click();
        const json = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
        assert.equal(json.project.harness, 'P-Box original');
        assert.equal(json.box.harness, 'Box harness 42');
        assert.equal(json.box.setups.checkpoint.connections.length, 1);
        assert.equal(json.box.setups.container.connections.length, 1);
        await mode('edit');
        await page.locator('#importFileInput').setInputFiles({ name: 'box.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
        await page.waitForFunction(id => currentProjectId !== String(id), id);
        await layout('box');
        assert.equal(await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).count(), 1);
        await load(); await layout('box'); await mode('edit');
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        await page.locator('#positionDetailsContent').getByRole('button', { name: 'Delete', exact: true }).click();
        await page.locator('#confirmDeleteBox').click(); await page.locator('#modalOverlay').waitFor({ state: 'hidden' });
        await page.reload(); await page.locator('.workspace').waitFor({ state: 'visible' }); await layout('box');
        assert.equal(await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).count(), 0);
        await setup('container');
        assert.equal(await page.locator('#boxChips').getByRole('button', { name: 'DBS', exact: true }).count(), 1);
        const before = writes.length;
        await page.locator('#allProjectsButton').click(); await page.locator('.project-path-current').waitFor();
        assert.equal(await page.locator('.project-path-current').innerText(), 'Child');
        assert.equal(writes.length, before);
    });
};
