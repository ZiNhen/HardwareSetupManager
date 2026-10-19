const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function testBoxPicking({ page, api, check, base, sandbox, writes, child, expectedConsoleErrors }) {
    const project = (await api('/projects', { folderId: child.id, project: { name: 'Box endpoint drafts' } })).project;
    const other = (await api('/projects', { project: { name: 'Other draft destination' } })).project;
    const id = project.id;
    const boxPath = `/projects/${id}/box`;
    const node = id => page.locator(`[data-box-node="${id}"]`);
    const field = name => page.locator(`#boxEditorForm [name="${name}"]`);
    const picker = target => page.locator(`[data-box-pick="${target}"]`);
    const draft = () => page.evaluate(() => appState.boxEditor?.draft);
    const box = async () => (await api(boxPath, undefined, 'GET')).box;
    const layout = value => page.locator(`[data-layout-tab="${value}"]`).click();
    const setup = value => page.locator(`[data-setup-tab="${value}"]`).click();
    const load = async (projectId = id) => {
        await page.goto(`${base}/?project=${projectId}`);
        await page.locator('.workspace').waitFor({ state: 'visible' });
        await layout('box');
        await page.locator('[data-interaction-mode="edit"]').click();
    };
    const add = () => page.locator('#addBoxHardwareButton').click();
    const pick = async (target, socket, key = null) => {
        await picker(target).click();
        if (key) { await node(socket).focus(); await page.keyboard.press(key); }
        else await node(socket).click();
    };
    const save = async () => {
        await page.locator('#boxEditorForm button[type="submit"]').click();
        await page.locator('#boxEditorForm').waitFor({ state: 'hidden' });
    };

    await check('Box presets share P-Box catalog and fill the same names', async () => {
        await load(); await add();
        const before = writes.length;
        const catalog = await page.evaluate(() => SENSOR_CONTEXT_OPTIONS.map(createSensorPreset));
        const pbox = await page.evaluate(() => createSetPositionSubmenuAction({ type: 'sensor' }, ['R01C1'], []).submenu.map(item => item.label));
        const options = await page.locator('#boxSensorPreset option').evaluateAll(items => items.slice(1).map(item => item.value));
        assert.deepEqual(options, pbox);
        assert.deepEqual(options, catalog.map(item => item.displayName));
        for (const preset of catalog) {
            await page.locator('#boxSensorPreset').selectOption(preset.displayName);
            assert.equal(await field('name').inputValue(), preset.name);
            assert.equal(await field('displayName').inputValue(), preset.displayName);
        }
        assert.equal(await field('role1').inputValue(), '+');
        assert.equal(await field('role2').inputValue(), '-');
        for (const type of ['aod', 'physicalSwitch', 'mechanicalSwitch']) {
            await field('type').selectOption(type);
            assert.equal(await page.locator('#boxSensorPresetField').isVisible(), false);
        }
        assert.equal(await field('type').locator('option[value="squib"]').count(), 0);
        await page.locator('#cancelBoxEditor').click();
        assert.equal(writes.length, before);
    });

    await check('Box click-pick / keyboard / duplicate rejection / Escape / Cancel are draft-only', async () => {
        const before = writes.length;
        const original = await box();
        await add(); await page.locator('#boxSensorPreset').selectOption('UFS');
        await field('notes').fill('Keep this draft while picking');
        await picker('node1').click();
        assert.match(await page.locator('#boxPickStatus').innerText(), /Selecting Positive \(\+\)/);
        assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-box-node')), true);
        await node('G2-B59').click();
        assert.equal((await draft()).node1, 'G2-B59');
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), null);
        assert.equal(await page.locator('[data-box-endpoint="node1"] .box-endpoint-value').textContent(), 'B59 (G2)');
        await pick('node2', 'G2-B59');
        assert.equal((await draft()).node2, '');
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), 'node2');
        assert.match(await page.locator('#boxFormError').innerText(), /different/);
        await node('G2-A10').focus(); await page.keyboard.press('Enter');
        assert.equal((await draft()).node2, 'G2-A10');
        assert.equal(await page.locator('.box-node.is-highlighted').count(), 2);
        assert.equal(await node('G2-B59').locator('.box-role text').textContent(), '+');
        assert.equal(await node('G2-A10').locator('.box-role text').textContent(), '-');
        await pick('node1', 'G1-B15', 'Space');
        assert.equal((await draft()).node1, 'G1-B15');
        assert.equal(await node('G2-B59').getAttribute('aria-pressed'), 'false');
        await picker('node2').click(); await page.keyboard.press('Escape');
        assert.equal(await page.locator('#boxEditorForm').isVisible(), true);
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), null);
        assert.equal(await page.locator('#boxPickStatus').isVisible(), false);
        assert.equal(await field('notes').inputValue(), 'Keep this draft while picking');
        await node('G3-B63').click();
        assert.equal((await draft()).node1, 'G1-B15', 'unarmed socket click must not discard or modify the draft');
        await page.locator('#cancelBoxEditor').click();
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        assert.equal(writes.length, before);
        assert.deepEqual(await box(), original);
    });

    await check('Box picked Save persists / table stays synchronized / existing roles preserved', async () => {
        await add(); await page.locator('#boxSensorPreset').selectOption('PASF');
        await pick('node1', 'G2-B59'); await pick('node2', 'G2-A10'); await save();
        let saved = (await box()).setups.checkpoint.connections[0];
        assert.deepEqual([saved.node1, saved.node2, saved.role1, saved.role2], ['G2-B59', 'G2-A10', '+', '-']);
        await load();
        const row = page.locator(`#boxConnectionsTable [data-box-row="${saved.id}"]`);
        assert.match(await row.innerText(), /PASF/);
        await row.getByRole('button', { name: 'Edit PASF' }).click();
        await field('role1').fill('signal'); await field('role2').fill(''); await save();
        saved = (await box()).setups.checkpoint.connections[0];
        await row.getByRole('button', { name: 'Edit PASF' }).click();
        await pick('node1', 'G1-B16');
        assert.equal(await field('role1').inputValue(), 'signal');
        assert.equal(await field('role2').inputValue(), '');
        await save();
        const changed = (await box()).setups.checkpoint.connections[0];
        assert.equal(changed.id, saved.id);
        assert.deepEqual([changed.node1, changed.role1, changed.role2], ['G1-B16', 'signal', '']);
        assert.match(await row.innerText(), /B16 \(G1\) \| signal/);
        await setup('container'); await add();
        await field('type').selectOption('aod');
        await field('name').fill('AOD draft'); await field('displayName').fill('AOD');
        await field('role1').fill('out'); await field('role2').fill('return');
        await pick('node1', 'G4-B37'); await pick('node2', 'G4-B55', 'Space'); await save();
        const both = await box();
        assert.equal(both.setups.checkpoint.connections.length, 1);
        assert.equal(both.setups.container.connections[0].type, 'aod');
        assert.equal(both.setups.container.connections[0].role1, 'out');
        assert.deepEqual(both.setups.checkpoint.connections[0], changed);
        for (const type of ['physicalSwitch', 'mechanicalSwitch']) {
            const before = writes.length;
            await add(); await field('type').selectOption(type);
            await pick('node1', 'G1-B15'); await pick('node2', 'G1-A9');
            assert.equal((await draft()).type, type);
            await page.locator('#cancelBoxEditor').click();
            assert.equal(writes.length, before);
        }
    });

    await check('Box draft navigation and polling never autosave; conflicts retain draft', async () => {
        await setup('checkpoint');
        const before = writes.length;
        const original = await box();
        const startDraft = async () => { await add(); await field('name').fill('Unsaved'); await picker('node1').click(); };
        await startDraft(); await node('G2-A10').click();
        assert.equal((await draft()).name, 'Unsaved', 'picking a mapped socket must not select its saved hardware');
        assert.equal((await draft()).node1, 'G2-A10');
        await setup('container');
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await startDraft(); await layout('pbox'); await layout('box');
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await startDraft();
        await page.evaluate(async projectId => openProject(projectId), other.id);
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await load(); await page.waitForTimeout(800);
        assert.equal(writes.length, before);
        assert.deepEqual(await box(), original);
        const saved = original.setups.checkpoint.connections[0];
        await page.locator(`#boxConnectionsTable [data-box-row="${saved.id}"]`).getByRole('button', { name: 'Edit PASF' }).click();
        await field('notes').fill('Local draft'); await picker('node2').click();
        const remote = await api(`${boxPath}/checkpoint/connections/${saved.id}`, { ...saved, notes: 'Remote edit' }, 'PATCH');
        await page.evaluate(() => pollProjectUpdates());
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), 'node2');
        assert.equal(await field('notes').inputValue(), 'Local draft');
        await node('G1-A20').click();
        // A stale Save must keep the draft and leave the other user's data intact.
        expectedConsoleErrors.push({
            url: `${base}/api${boxPath}/checkpoint/connections/${saved.id}`,
            text: 'Failed to load resource: the server responded with a status of 409 (Conflict)', seen: 0
        });
        const conflict = page.waitForResponse(response => response.status() === 409);
        await page.locator('#boxEditorForm button[type="submit"]').click(); await conflict;
        await page.waitForFunction(() => document.getElementById('boxFormError').textContent.length > 0);
        assert.equal(await field('notes').inputValue(), 'Local draft');
        assert.deepEqual(await box(), remote.box);
        await page.locator('#cancelBoxEditor').click();
        await page.evaluate(() => pollProjectUpdates());
    });

    await check('Box picker responsive and keyboard accessible at both desktop sizes', async () => {
        await load();
        for (const [width, height] of [[1366, 768], [1920, 1080]]) {
            await page.setViewportSize({ width, height }); await add();
            await page.locator('#boxSensorPreset').selectOption('PTS');
            await pick('node1', 'G2-B59'); await picker('node2').click();
            assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-box-node')), true);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const status = await page.locator('#boxPickStatus').boundingBox();
            assert.ok(status.y >= 0 && status.y + status.height <= height);
            await page.screenshot({ path: path.join(sandbox, `box-pick-${width}.png`) });
            await node('G2-A10').focus(); await page.keyboard.press('Enter');
            assert.equal(await page.locator('.box-node.is-highlighted').count(), 2);
            await page.locator('#cancelBoxEditor').click();
        }
    });
};
