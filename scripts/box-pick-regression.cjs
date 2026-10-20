const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function testBoxPicking({ page, api, check, base, sandbox, writes, child, expectedConsoleErrors }) {
    const project = (await api('/projects', { folderId: child.id, project: { name: 'Box autosave' } })).project;
    const other = (await api('/projects', { project: { name: 'Other destination' } })).project;
    const id = project.id;
    const boxPath = `/projects/${id}/box`;
    const node = id => page.locator(`[data-box-node="${id}"]`);
    const field = name => page.locator(`#boxEditorForm [name="${name}"]`);
    const draft = () => page.evaluate(() => appState.boxEditor?.draft);
    const box = async () => (await api(boxPath, undefined, 'GET')).box;
    const layout = value => page.locator(`[data-layout-tab="${value}"]`).click();
    const setup = value => page.locator(`[data-setup-tab="${value}"]`).click();
    const row = item => page.locator(`#boxConnectionsTable [data-box-row="${item.id}"]`);
    const load = async (projectId = id) => {
        await page.goto(`${base}/?project=${projectId}`);
        await page.locator('.workspace').waitFor({ state: 'visible' });
        await layout('box');
        await page.locator('[data-interaction-mode="edit"]').click();
    };
    const add = async (type = 'sensor', preset = 'UFS') => {
        await page.locator('#addBoxHardwareButton').click();
        if (type === 'sensor') await page.locator('#boxSensorPreset').selectOption(preset);
        else await field('type').selectOption(type);
    };
    const saved = async () => {
        await page.locator('#boxEditorForm').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => boxPendingWrites === 0);
    };
    const expectWrites = (start, method, suffix) => assert.deepEqual(writes.slice(start), [`${method} ${base}/api${boxPath}${suffix}`]);
    const expectConflict = item => expectedConsoleErrors.push({
        url: `${base}/api${boxPath}/checkpoint/connections/${item.id}`,
        text: 'Failed to load resource: the server responded with a status of 409 (Conflict)', seen: 0
    });
    let sensor, mechanical, physical, legacy;

    await check('Box shared catalogs / hardware choice and unfinished picks never write', async () => {
        await load();
        const before = writes.length;
        await page.locator('#addBoxHardwareButton').click();
        const catalog = await page.evaluate(() => SENSOR_CONTEXT_OPTIONS.map(createSensorPreset));
        const pbox = await page.evaluate(() => createSetPositionSubmenuAction({ type: 'sensor' }, ['R01C1'], []).submenu.map(item => item.label));
        assert.deepEqual(await page.locator('#boxSensorPreset option').evaluateAll(items => items.slice(1).map(item => item.value)), pbox);
        for (const preset of catalog) {
            await page.locator('#boxSensorPreset').selectOption(preset.displayName);
            assert.equal(await field('name').inputValue(), preset.name);
            assert.equal(await field('displayName').inputValue(), preset.displayName);
            assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), 'node1');
        }
        for (const type of ['aod', 'physicalSwitch', 'mechanicalSwitch']) {
            await field('type').selectOption(type);
            const expected = await page.evaluate(type => createQuickItem(type), type);
            assert.equal(await field('name').inputValue(), expected.name);
            assert.equal(await field('displayName').inputValue(), expected.displayName);
            assert.equal(await page.locator('#boxSensorPresetField').isVisible(), false);
        }
        assert.equal(await field('type').locator('option[value="squib"]').count(), 0);
        await page.locator('#cancelBoxEditor').click();
        await add(); await node('G2-B59').click();
        assert.match(await page.locator('#boxPickStatus').innerText(), /Select Negative \(-\) for UFS/);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#boxEditorForm').isVisible(), true);
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), null);
        await page.locator('#cancelBoxEditor').click();
        await add(); await setup('container');
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await add(); await layout('pbox'); await layout('box');
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await add(); await page.evaluate(projectId => openProject(projectId), other.id);
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        await load();
        assert.equal(writes.length, before);
        assert.equal((await box()).setups.checkpoint.connections.length, 0);
    });

    await check('Box sequential + then - / duplicate rejection / exactly one POST / keyboard', async () => {
        const before = writes.length;
        await add();
        assert.match(await page.locator('#boxPickStatus').innerText(), /Select Positive \(\+\) for UFS/);
        assert.equal(await page.locator('#boxEditorForm button[type="submit"]').isVisible(), false);
        await node('G2-B59').click();
        assert.equal(writes.length, before);
        assert.equal((await draft()).node1, 'G2-B59');
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), 'node2');
        await node('G2-B59').click();
        assert.equal((await draft()).node2, '');
        assert.match(await page.locator('#boxFormError').innerText(), /different/);
        await node('G2-A10').focus(); await page.keyboard.press('Enter'); await saved();
        expectWrites(before, 'POST', '/checkpoint/connections');
        sensor = (await box()).setups.checkpoint.connections[0];
        assert.deepEqual([sensor.node1, sensor.node2, sensor.role1, sensor.role2], ['G2-B59', 'G2-A10', '+', '-']);
        assert.match(await row(sensor).innerText(), /B59.*\+/);
        await load();
        assert.match(await row(sensor).innerText(), /UFS/);
    });

    await check('Box one-node Mechanical and Physical Switch autosave; double/repeated input writes once', async () => {
        let before = writes.length;
        await add('mechanicalSwitch');
        assert.equal(await page.locator('[data-box-endpoint="node2"]').isVisible(), false);
        await node('G1-B15').dblclick(); await saved();
        expectWrites(before, 'POST', '/checkpoint/connections');
        mechanical = (await box()).setups.checkpoint.connections.at(-1);
        assert.deepEqual([mechanical.node2, mechanical.role1, mechanical.role2], ['', '', '']);
        assert.equal(await page.locator('.box-node.is-highlighted').count(), 1);
        assert.equal(await page.locator('.box-role:not([hidden])').count(), 0);
        before = writes.length;
        await add('physicalSwitch'); await node('G1-B16').click();
        assert.equal(writes.length, before);
        await node('G1-A20').focus();
        await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space'); await saved();
        expectWrites(before, 'POST', '/checkpoint/connections');
        physical = (await box()).setups.checkpoint.connections.at(-1);
        assert.equal(physical.type, 'physicalSwitch');
        await add('aod'); await node('G4-B37').click(); await node('G4-B55').click(); await saved();
    });

    await check('Box selected endpoint re-pick / rollback / one PATCH / custom roles', async () => {
        await row(sensor).click(); await page.waitForTimeout(320);
        let before = writes.length;
        await node(sensor.node1).click();
        assert.equal(await node(sensor.node1).evaluate(el => el.classList.contains('is-replacing')), true);
        assert.equal(writes.length, before);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => appState.boxEditor), null);
        assert.equal(await node(sensor.node1).getAttribute('aria-pressed'), 'true');
        assert.equal(writes.length, before);
        await node(sensor.node1).click(); await node('G1-B17').click(); await saved();
        expectWrites(before, 'PATCH', `/checkpoint/connections/${sensor.id}`);
        sensor = (await box()).setups.checkpoint.connections.find(item => item.id === sensor.id);
        assert.equal(sensor.node2, 'G2-A10');
        await row(sensor).getByRole('button', { name: 'Edit UFS' }).click();
        await field('role1').fill('signal'); await field('role2').fill('return');
        await page.locator('#boxEditorForm button[type="submit"]').click(); await saved();
        await page.waitForTimeout(320);
        before = writes.length;
        await node('G2-A10').click(); await node('G1-A21').click(); await saved();
        expectWrites(before, 'PATCH', `/checkpoint/connections/${sensor.id}`);
        sensor = (await box()).setups.checkpoint.connections.find(item => item.id === sensor.id);
        assert.deepEqual([sensor.node1, sensor.node2, sensor.role1, sensor.role2], ['G1-B17', 'G1-A21', 'signal', 'return']);
    });

    await check('Box pending writes are captured across setup/layout/project changes', async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const url = `${base}/api${boxPath}/checkpoint/connections`;
        await page.route(url, async route => { if (route.request().method() === 'POST') await held; await route.continue(); });
        const before = writes.length;
        const count = (await box()).setups.checkpoint.connections.length;
        try {
            await add('sensor', 'PASM'); await node('G3-B63').click(); await node('G3-A23').click();
            await page.waitForFunction(() => boxPendingWrites === 1);
            await node('G3-A23').dispatchEvent('click', { detail: 1 });
            await node('G3-B64').dispatchEvent('keydown', { key: 'Enter', repeat: true });
            await setup('container'); await layout('pbox');
            await page.evaluate(projectId => openProject(projectId), other.id);
            release();
            await page.waitForFunction(() => boxPendingWrites === 0);
            assert.equal(await page.evaluate(() => currentProjectId), String(other.id));
            expectWrites(before, 'POST', '/checkpoint/connections');
            assert.equal((await box()).setups.checkpoint.connections.length, count + 1);
            assert.equal((await box()).setups.container.connections.length, 0);
            assert.equal((await api(`/projects/${other.id}/box`, undefined, 'GET')).box.setups.checkpoint.connections.length, 0);
        } finally { release(); await page.unroute(url); }
        await load();
    });

    await check('Box stale autosave conflict never overwrites remote edit; draft survives polling', async () => {
        await row(sensor).click(); await node(sensor.node1).click();
        const remote = await api(`${boxPath}/checkpoint/connections/${sensor.id}`, { ...sensor, notes: 'Remote edit' }, 'PATCH');
        await page.evaluate(() => pollProjectUpdates());
        assert.equal(await page.evaluate(() => appState.boxEditor.pickTarget), 'node1');
        expectConflict(sensor);
        const conflict = page.waitForResponse(response => response.status() === 409);
        await node('G1-B18').click(); await conflict;
        await page.waitForFunction(() => !boxPendingWrites);
        assert.equal((await draft()).node1, 'G1-B18');
        assert.match(await page.locator('#boxFormError').innerText(), /changed/);
        assert.deepEqual(await box(), remote.box);
        await page.keyboard.press('Escape');
        await page.evaluate(() => pollProjectUpdates());
        sensor = (await box()).setups.checkpoint.connections.find(item => item.id === sensor.id);
    });

    await check('Box categories / P-M accessibility / Overview occupancy and polarity preserve socket colors', async () => {
        const shared = { type: 'sensor', name: 'Shared sensor', displayName: 'SHARED', node1: mechanical.node1, node2: physical.node1, role1: '+', role2: '-', notes: '' };
        await api(`${boxPath}/checkpoint/connections`, shared);
        await page.evaluate(() => pollProjectUpdates());
        assert.deepEqual(await page.locator('[data-box-category]').evaluateAll(rows => rows.map(row => row.dataset.boxCategory)), ['Sensors', 'AOD', 'Switches']);
        const switches = page.locator('[data-box-category="Switches"]');
        assert.equal(await switches.locator('.box-switch-badge').count(), 2);
        for (const [item, badge] of [[physical, 'P'], [mechanical, 'M']]) {
            const chip = switches.locator(`[data-box-hardware="${item.id}"]`);
            assert.equal(await chip.locator('.box-switch-badge').textContent(), badge);
            assert.match(await chip.getAttribute('aria-label'), new RegExp(item.type === 'physicalSwitch' ? 'Physical Switch' : 'Mechanical Switch'));
            assert.match(await chip.getAttribute('title'), /Switch/);
        }
        const before = writes.length;
        const fills = () => page.locator('.box-socket').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill));
        const originalColors = await fills();
        await page.locator('#boxChips [data-box-hardware="all"]').click();
        await page.waitForTimeout(40);
        assert.equal(await page.locator('#boxConnectionLines path').count(), 0);
        assert.equal(await page.locator('.box-role:not([hidden])').count(), 0);
        const occupied = new Set((await box()).setups.checkpoint.connections.flatMap(item => [item.node1, item.node2]).filter(Boolean));
        assert.equal(await page.locator('.box-node.is-occupied').count(), occupied.size);
        await node(mechanical.node1).hover();
        assert.match(await page.locator('#hardwareTooltip').innerText(), /Mechanical Switch/);
        assert.match(await page.locator('#hardwareTooltip').innerText(), /SHARED.*Sensor.*\+/);
        await node(mechanical.node1).focus();
        assert.match(await page.locator('#hardwareTooltip').innerText(), /Shared sensor/);
        await row(physical).click();
        assert.equal(await node(physical.node1).locator('.box-role').getAttribute('class'), 'box-role is-positive');
        assert.equal(await node(physical.node2).locator('.box-role').getAttribute('class'), 'box-role is-negative');
        const positive = await node(physical.node1).locator('.box-role rect').evaluate(el => getComputedStyle(el).fill);
        const negative = await node(physical.node2).locator('.box-role rect').evaluate(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke }));
        assert.equal(positive, 'rgb(206, 37, 55)');
        assert.equal(negative.fill, 'rgb(32, 35, 34)');
        assert.equal(negative.stroke, 'rgb(250, 250, 246)');
        assert.deepEqual(await fills(), originalColors);
        assert.equal(writes.length, before);
    });

    await check('Box selected lines follow actual chip and sockets after scroll/resize', async () => {
        await load();
        const verifyLines = async item => {
            await page.waitForTimeout(50);
            const chip = await page.locator(`#boxChips [data-box-hardware="${item.id}"]`).boundingBox();
            const lines = page.locator('#boxConnectionLines path');
            assert.equal(await lines.count(), item.node2 ? 2 : 1);
            for (const target of ['node1', 'node2']) {
                if (!item[target]) continue;
                const socket = await node(item[target]).locator('.box-socket').boundingBox();
                const anchor = JSON.parse(await page.locator(`[data-box-line="${target}"]`).getAttribute('data-anchor'));
                const expected = [chip.x + chip.width / 2, chip.y + chip.height, socket.x + socket.width / 2, socket.y + socket.height / 2];
                anchor.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1, 'line must use measured chip/socket centers'));
            }
        };
        const before = writes.length;
        for (const [width, height] of [[1366, 768], [1920, 1080]]) {
            await page.setViewportSize({ width, height });
            await row(physical).click();
            await page.locator(`#boxChips [data-box-hardware="${physical.id}"]`).scrollIntoViewIfNeeded();
            await verifyLines(physical);
            await page.locator('.box-board-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
            await verifyLines(physical);
            await page.locator('.box-board-scroll').evaluate(el => { el.scrollTop = 0; });
            await row(mechanical).click(); await verifyLines(mechanical);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            assert.equal(await page.locator('#boxConnectionLines').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
            await page.screenshot({ path: path.join(sandbox, `box-autosave-${width}.png`) });
            await page.locator('#boxChips [data-box-hardware="all"]').click(); await page.waitForTimeout(30);
            assert.equal(await page.locator('#boxConnectionLines path').count(), 0);
        }
        assert.equal(writes.length, before);
    });

    await check('Box legacy Mechanical retained until explicit remap; one/two node JSON round trip', async () => {
        const data = await api(`${boxPath}/container/connections`, { type: 'mechanicalSwitch', name: 'Legacy', displayName: 'OLD', node1: 'G4-B33', node2: 'G1-B33', role1: 'COM', role2: 'NO', notes: '' });
        legacy = data.box.setups.container.connections[0];
        await setup('container'); await page.evaluate(() => pollProjectUpdates());
        await row(legacy).getByRole('button', { name: 'Edit OLD' }).click();
        await field('notes').fill('Metadata edit'); await page.locator('#boxEditorForm button[type="submit"]').click(); await saved();
        legacy = (await box()).setups.container.connections[0];
        assert.deepEqual([legacy.node1, legacy.node2, legacy.role1, legacy.role2], ['G4-B33', 'G1-B33', 'COM', 'NO']);
        const exported = await page.evaluate(() => createExportData(appState));
        assert.equal(exported.box.setups.checkpoint.connections.find(item => item.type === 'mechanicalSwitch').node2, '');
        assert.equal(exported.box.setups.container.connections[0].node2, 'G1-B33');
        assert.ok(await page.evaluate(data => Boolean(validateImportedData(data)), exported));
        const imported = (await api('/projects', exported)).project;
        const restored = (await api(`/projects/${imported.id}/box`, undefined, 'GET')).box;
        assert.equal(restored.setups.checkpoint.connections.find(item => item.type === 'mechanicalSwitch').node2, '');
        assert.equal(restored.setups.container.connections[0].node2, 'G1-B33');
        await page.waitForTimeout(320);
        const before = writes.length;
        await row(legacy).click(); await node(legacy.node1).click(); await page.keyboard.press('Escape');
        assert.equal(writes.length, before);
        assert.equal((await box()).setups.container.connections[0].node2, 'G1-B33');
        await node(legacy.node1).click();
        assert.match(await page.locator('#boxPickStatus').innerText(), /remap to one socket/);
        await node('G4-B32').click(); await saved();
        expectWrites(before, 'PATCH', `/container/connections/${legacy.id}`);
        assert.deepEqual([(await box()).setups.container.connections[0].node1, (await box()).setups.container.connections[0].node2], ['G4-B32', '']);
        await load(); await setup('container');
        assert.equal((await box()).setups.container.connections[0].node2, '');
        const noWrite = writes.length;
        await page.locator('#allProjectsButton').click(); await page.locator('.project-path-current').waitFor();
        await page.waitForTimeout(50);
        assert.equal(await page.locator('#boxConnectionLines path').count(), 0);
        assert.equal(writes.length, noWrite);
    });
};
