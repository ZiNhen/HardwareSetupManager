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
        await page.locator('#boxEditorForm [name="role1"]').fill('+');
        await page.locator('#boxEditorForm [name="role2"]').fill('-');
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
            'B70:W A38:W B56:W A39:W B57:W B19:BK B59:BK A10:BL B60:BL A11:BL B52:BK A12:BK B51:BL A13:BL',
            'B63:BK A23:BK B64:BL A24:BL B13:BK A35:BK B14:BL A34:BL B49:BK B66:BK B50:BL B65:BL B31:BK A36:BK',
            'B32:BL A37:BL B67:BK A49:BK B68:BL A50:BL B34:BK B62:BK B33:BL B61:BL'
        ];
        const actual = await page.evaluate(() => BOX_TEMPLATE.groups.map(group => BOX_TEMPLATE.nodes
            .filter(node => node.group === group.id && !node.sharedLabel && node.color !== 'R')
            .map(node => `${node.label}:${node.color}`).join(' ')));
        assert.deepEqual(actual, canonical);
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
        assert.match(await page.locator('#hardwareTooltip').innerText(), /G2-A10.*\n.*Blue Socket/);
        assert.match(await page.locator('#hardwareTooltip').innerText(), /FIS/);
        await page.locator('[data-box-node="G2-B59"]').hover();
        assert.match(await page.locator('#hardwareTooltip').innerText(), /Black Socket/);
        assert.equal(writes.length, readOnlyStart);
        await page.locator('#positionDetailsContent').getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('#boxEditorForm [name="notes"]').fill('Revised mapping'); await save();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Revised mapping/);
        assert.deepEqual((await api(`/projects/${id}`, undefined, 'GET')).project, legacy, 'Box edit touched P-Box project data');
    });
    await check('Box setup separation and independent harness persistence', async () => {
        await page.locator('#boxHarnessInput').fill('Box harness 42');
        await page.waitForTimeout(950);
        assert.equal(await page.locator('[data-project-field="harness"]').inputValue(), 'P-Box original');
        await setup('container');
        assert.equal(await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).count(), 0);
        await page.locator('#addBoxHardwareButton').click(); await fill('DBS', 'G1-B33', 'G4-B33');
        await page.locator('#boxEditorForm [name="type"]').selectOption('mechanicalSwitch'); await save();
        await page.reload(); await page.locator('.workspace').waitFor({ state: 'visible' }); await layout('box');
        assert.equal(await page.locator('#boxHarnessInput').inputValue(), 'Box harness 42');
        await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
        assert.match(await page.locator('#positionDetailsContent').innerText(), /Revised mapping/);
        await setup('container'); await page.locator('#boxChips').getByRole('button', { name: 'DBS', exact: true }).click();
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
            await page.screenshot({ path: path.join(sandbox, `box-${width}.png`) });
            await page.locator('#boxChips').getByRole('button', { name: 'FIS', exact: true }).click();
            await page.waitForTimeout(220);
            await page.screenshot({ path: path.join(sandbox, `box-selected-${width}.png`) });
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
