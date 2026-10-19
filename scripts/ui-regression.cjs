// Run with Node and Playwright available through NODE_PATH. Uses only a temporary DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

async function main() {
    const root = path.resolve(__dirname, '..');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-ui-'));
    for (const file of ['server.js', 'db.js', 'index.html', 'script.js', 'style.css', 'box-template.js', 'box.js']) {
        fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
    }
    const net = require('node:net');
    const portProbe = net.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--no-warnings', path.join(sandbox, 'server.js')], {
        env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let browser;
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Test server startup timeout')), 10000);
            server.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
            server.once('error', reject);
        });
        async function api(route, data, method = 'POST') {
            const response = await fetch(base + '/api' + route, {
                method, headers: { 'Content-Type': 'application/json' },
                body: data === undefined ? undefined : JSON.stringify(data)
            });
            assert.ok(response.ok, `${method} ${route}: ${await response.clone().text()}`);
            return response.json();
        }
        const parent = (await api('/folders', { name: 'Parent' })).folder;
        const child = (await api('/folders', { name: 'Child', parentFolderId: parent.id })).folder;
        const source = (await api('/projects', { project: { name: 'Source' }, folderId: child.id })).project;
        const target = (await api('/projects', { project: { name: 'Target' }, folderId: parent.id })).project;
        const sensor = name => ({ type: 'sensor', name, displayName: name, notes: '' });
        await api(`/projects/${source.id}/setups/checkpoint/positions/R01C1`, { items: [sensor('UFS'), sensor('PASF')], revision: 0 }, 'PUT');
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await context.newPage();
        page.setDefaultTimeout(4000);
        const errors = [];
        const writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
        const cell = id => page.locator(`[data-position-id="${id}"]`);
        const mode = value => page.locator(`[data-interaction-mode="${value}"]`).click();
        const open = async (id = source.id) => {
            await page.goto(`${base}/?project=${id}`);
            await page.locator('.workspace').waitFor({ state: 'visible' });
        };
        const selected = () => page.evaluate(() => getSelectedPositionIds());
        const failures = [];
        async function check(name, run) {
            try { await run(); console.log('PASS ' + name); }
            catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
        }
        await check('direct URL / reload / parent Back is read-only', async () => {
            await open();
            await page.reload();
            await page.locator('.workspace').waitFor({ state: 'visible' });
            await mode('edit');
            await page.locator('[data-project-field="ecuName"]').focus();
            const before = writes.length;
            await page.locator('#allProjectsButton').click();
            await page.locator('.project-path-current').waitFor();
            assert.equal(await page.locator('.project-path-current').innerText(), 'Child');
            await page.locator('.project-back-button').click();
            assert.equal(await page.locator('.project-path-current').innerText(), 'Parent');
            await page.locator('.project-back-button').click();
            assert.equal(await page.locator('.project-path-current').count(), 0);
            await page.waitForTimeout(800);
            assert.equal(writes.length, before, 'Back or unchanged field blur wrote to DB');
            await page.locator('.project-folder-card').filter({ hasText: 'Parent' }).dblclick();
            await page.locator('.project-folder-card').filter({ hasText: 'Child' }).dblclick();
            await page.locator('.project-card').filter({ hasText: 'Source' }).dblclick();
            await page.locator('.workspace').waitFor({ state: 'visible' });
            const openedFromFolder = writes.length;
            await page.locator('#allProjectsButton').click();
            await page.locator('.project-path-current').waitFor();
            assert.equal(await page.locator('.project-path-current').innerText(), 'Child');
            assert.equal(writes.length, openedFromFolder);
            await open(); await page.locator('#allProjectsButton').click();
            await page.locator('.project-path-current').waitFor();
            assert.equal(await page.locator('.project-path-current').innerText(), 'Child');
        });
        await check('View blocks undo and metadata edits', async () => {
            await open(); await mode('edit');
            await page.locator('[data-project-field="ecuName"]').fill('ECU test');
            await page.waitForTimeout(900);
            await mode('view');
            const before = writes.length;
            await page.keyboard.press('Control+z'); await page.waitForTimeout(500);
            assert.equal(writes.length, before, 'View undo wrote to DB');
            assert.equal(await page.locator('[data-project-field="ecuName"]').getAttribute('readonly'), '');
            await cell('R01C1').click(); assert.deepEqual(await selected(), []);
        });
        await check('click / Ctrl / Shift / drag selection and setup isolation', async () => {
            await open(); await mode('edit');
            await cell('R02C4').click(); await cell('R03C5').click({ modifiers: ['Control'] });
            assert.equal((await selected()).length, 2);
            await cell('R03C5').click({ modifiers: ['Control'] });
            assert.equal((await selected()).length, 1);
            assert.equal(await cell('R03C5').evaluate(element => element.classList.contains('is-selected')), false);
            await cell('R02C4').click(); await cell('R04C5').click({ modifiers: ['Shift'] });
            assert.equal((await selected()).length, 6);
            const a = await cell('R02C4').boundingBox(), b = await cell('R04C5').boundingBox();
            await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
            assert.equal((await selected()).length, 6);
            await page.locator('[data-setup-tab="container"]').click();
            assert.equal(await page.evaluate(() => getPositionItems('R01C1').length), 0);
            await page.locator('[data-setup-tab="checkpoint"]').click();
            assert.match(await cell('R01C1').innerText(), /UFS/);
        });
        await check('multiple sensors: editor type, save, delete and tooltip', async () => {
            await open(); await mode('edit'); await cell('R01C1').click();
            await page.locator('.sensor-actions').nth(1).getByRole('button', { name: 'Edit', exact: true }).click();
            await page.locator('#hardwareNameInput').fill('Pressure updated');
            await page.locator('[data-type-choice="sensor"]').click();
            await page.locator('#displayNameInput').fill('PPS');
            await page.locator('#hardwareEditorForm').getByRole('button', { name: 'Save', exact: true }).click();
            await page.waitForTimeout(350); await cell('R01C1').click();
            assert.match(await page.locator('#positionDetailsContent').innerText(), /Pressure updated/);
            await page.locator('.sensor-actions').nth(1).getByRole('button', { name: 'Delete', exact: true }).click();
            await page.waitForTimeout(350); await cell('R01C1').hover();
            assert.match(await page.locator('#hardwareTooltip').innerText(), /UFS/);
        });
        await check('context submenu stays in viewport', async () => {
            await open(); await mode('edit');
            await page.evaluate(() => { openPositionContextMenu({ preventDefault() {}, clientX: innerWidth - 15, clientY: innerHeight - 15 }, 'R01C1'); });
            await page.locator('.context-menu-submenu > button').first().hover();
            const box = await page.locator('.context-submenu-panel').first().boundingBox();
            assert.ok(box && box.x >= 0 && box.x + box.width <= 1366 && box.y + box.height <= 768, JSON.stringify(box));
            await page.locator('.context-submenu-panel').getByRole('menuitem', { name: 'PTS', exact: true }).click();
            await page.waitForTimeout(300);
        });
        await check('rapid modal close/reopen; modal blocks browser Delete', async () => {
            await page.goto(base); await page.locator('#projectList .project-browser-item').first().click();
            await page.locator('#newFolderButton').click();
            await page.locator('#modalTitle').click(); await page.keyboard.press('Delete');
            assert.match(await page.locator('#modalTitle').innerText(), /folder/i);
            assert.doesNotMatch(await page.locator('#modalTitle').innerText(), /delete/i);
            await page.evaluate(() => { closeModal(); openUsageGuide(); });
            await page.waitForTimeout(250);
            assert.equal(await page.locator('#modalOverlay').isVisible(), true);
            for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
            assert.ok(await page.evaluate(() => dom.modalContent.contains(document.activeElement)));
            await page.keyboard.press('Escape');
        });
        await check('selection copy survives project navigation; setup paste targets captured tab', async () => {
            await open(); await mode('edit'); await cell('R01C1').click(); await page.keyboard.press('Control+c');
            await page.waitForTimeout(100);
            await page.locator('#allProjectsButton').click(); await page.locator('#projectList').waitFor({ state: 'visible' });
            await page.evaluate(id => openProject(id), target.id); await mode('edit');
            await cell('R02C1').click(); assert.equal(await page.locator('#pasteSelectionButton').isEnabled(), true);
            await page.keyboard.press('Control+v'); await page.waitForTimeout(350);
            assert.match(await cell('R02C1').innerText(), /UFS/);
            await page.locator('#copySetupButton').click();
            await page.locator('[data-setup-tab="container"]').click();
            await page.route('**/setups/container', async route => {
                const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 350));
                await route.fulfill({ response });
            });
            await page.locator('#pasteSetupButton').click();
            await page.locator('[data-setup-tab="checkpoint"]').click(); await page.waitForTimeout(650);
            assert.equal(await page.evaluate(() => appState.activeSetup), 'checkpoint');
            assert.match(await cell('R02C1').innerText(), /UFS/);
            await page.locator('[data-setup-tab="container"]').click();
            assert.match(await cell('R02C1').innerText(), /UFS/);
            await page.unroute('**/setups/container');
            await page.evaluate(id => openProject(id), source.id);
            await page.locator('[data-setup-tab="checkpoint"]').click();
            await page.locator('#copySetupButton').click();
            await page.locator('#allProjectsButton').click();
            await page.locator('#projectList').waitFor({ state: 'visible' });
            await page.evaluate(id => openProject(id), target.id); await mode('edit');
            await page.locator('[data-setup-tab="container"]').click();
            await page.locator('#pasteSetupButton').click();
            await page.locator('#confirmPasteSetupButton').click();
            await page.waitForTimeout(500);
            assert.match(await cell('R01C1').innerText(), /UFS/);
        });
        await check('project search; overflow and scroll at desktop sizes', async () => {
            await page.goto(base); await page.locator('#projectSearch').fill('Source');
            assert.equal(await page.locator('.project-card').count(), 1);
            for (const width of [1366, 1920]) {
                await page.setViewportSize({ width, height: width === 1366 ? 768 : 1080 });
                await open();
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.waitForTimeout(250);
                await page.screenshot({ path: path.join(sandbox, `editor-${width}.png`) });
            }
        });
        await check('large folder list scrolls to the last item', async () => {
            for (let i = 0; i < 35; i++) await api('/folders', { name: `Folder ${String(i).padStart(2, '0')}` });
            await page.setViewportSize({ width: 1366, height: 768 });
            await page.goto(base); await page.locator('#projectList .project-folder-card').last().waitFor();
            const box = await page.locator('#projectList').boundingBox();
            assert.ok(box.y + box.height <= 768, `list bottom ${box.y + box.height}`);
            await page.locator('#projectList').hover(); await page.mouse.wheel(0, 4000);
            await page.waitForTimeout(200);
            assert.ok(await page.locator('#projectList').evaluate(element => element.scrollTop > 0));
        });
        await check('in-flight multi-position save remains in its original project', async () => {
            await open(); await mode('edit');
            await page.route('**/positions/R06C1', async route => {
                const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 400));
                await route.fulfill({ response });
            });
            await page.evaluate(() => addSensorOptionToPositions(['R06C1', 'R07C1'], 'PCS'));
            await page.evaluate(id => openProject(id), target.id);
            await page.waitForTimeout(700);
            await page.unroute('**/positions/R06C1');
            const saved = (await api(`/projects/${source.id}`, undefined, 'GET')).project;
            const other = (await api(`/projects/${target.id}`, undefined, 'GET')).project;
            assert.ok(saved.setups.checkpoint.positions.R07C1, 'source second cell not saved');
            assert.equal(other.setups.checkpoint.positions.R07C1, undefined, 'target project was modified');
        });
        await check('rapid sensor additions preserve every item', async () => {
            await open(); await mode('edit');
            await page.evaluate(() => {
                addSensorOptionToPositions(['R09C1'], 'UFS');
                addSensorOptionToPositions(['R09C1'], 'PASF');
                addSensorOptionToPositions(['R09C1'], 'PCS');
            });
            await page.waitForTimeout(800);
            const saved = (await api(`/projects/${source.id}`, undefined, 'GET')).project;
            assert.equal(saved.setups.checkpoint.positions.R09C1.items.length, 3);
        });
        await check('debounced metadata saves survive editing a different project', async () => {
            await open(); await mode('edit');
            await page.locator('[data-project-field="harness"]').fill('Source harness');
            await page.evaluate(id => openProject(id), target.id); await mode('edit');
            await page.locator('[data-project-field="harness"]').fill('Target harness');
            await page.waitForTimeout(900);
            const a = (await api(`/projects/${source.id}`, undefined, 'GET')).project;
            const b = (await api(`/projects/${target.id}`, undefined, 'GET')).project;
            assert.equal(a.project.harness, 'Source harness');
            assert.equal(b.project.harness, 'Target harness');
        });
        await check('paste followed immediately by sensor edit keeps both changes', async () => {
            await open(); await mode('edit');
            await page.locator('#copySetupButton').click();
            await page.locator('[data-setup-tab="container"]').click();
            await page.route('**/setups/container', async route => {
                const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 300));
                await route.fulfill({ response });
            });
            const request = page.waitForRequest(request => request.url().endsWith('/setups/container') && request.method() === 'PUT');
            await page.evaluate(() => { void applySetupPaste(); });
            await request;
            await page.evaluate(() => addSensorOptionToPositions(['R01C1'], 'PPSF'));
            await page.waitForTimeout(700); await page.unroute('**/setups/container');
            const saved = (await api(`/projects/${source.id}`, undefined, 'GET')).project;
            assert.ok(saved.setups.container.positions.R01C1.items.some(item => item.displayName === 'PPSF'));
        });
        await check('cut / undo / redo preserve multiple sensor items', async () => {
            await open(); await mode('edit'); await cell('R09C1').click();
            await page.keyboard.press('Control+x'); await page.waitForTimeout(350);
            assert.equal(await page.evaluate(() => getPositionItems('R09C1').length), 0);
            await page.keyboard.press('Control+z'); await page.waitForTimeout(350);
            assert.equal(await page.evaluate(() => getPositionItems('R09C1').length), 3);
            await page.keyboard.press('Control+y'); await page.waitForTimeout(350);
            assert.equal(await page.evaluate(() => getPositionItems('R09C1').length), 0);
            await cell('R10C1').click(); await page.keyboard.press('Control+v'); await page.waitForTimeout(350);
            assert.equal(await page.evaluate(() => getPositionItems('R10C1').length), 3);
        });
        await check('undo cancels superseded metadata autosave', async () => {
            await open(); await mode('edit');
            await page.locator('[data-project-field="notes"]').fill('Undo before debounce');
            await cell('R01C1').click(); await page.keyboard.press('Control+z');
            await page.waitForTimeout(1000);
            const saved = (await api(`/projects/${source.id}`, undefined, 'GET')).project;
            assert.equal(saved.project.notes, '');
        });
        await check('rapid project opens keep the newest destination', async () => {
            await page.route(`**/api/projects/${source.id}`, async route => {
                const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 300));
                await route.fulfill({ response });
            });
            await page.evaluate(async ids => { await Promise.all([openProject(ids[0]), openProject(ids[1])]); }, [source.id, target.id]);
            assert.equal(await page.evaluate(() => currentProjectId), String(target.id));
            await page.unroute(`**/api/projects/${source.id}`);
        });
        await check('multi-user polling updates without disrupting an open editor', async () => {
            await open(); await mode('edit');
            await cell('R01C1').click({ button: 'right' });
            await page.locator('#positionContextMenu').getByRole('menuitem', { name: 'Edit', exact: true }).click();
            await page.locator('#hardwareNameInput').fill('Draft still here');
            await api(`/projects/${source.id}/setups/container/positions/R04C4`, {
                items: [{ type: 'squib', name: 'Remote', displayName: 'REMOTE', notes: '' }], revision: 0
            }, 'PUT');
            await page.evaluate(() => pollProjectUpdates());
            assert.equal(await page.locator('#hardwareNameInput').inputValue(), 'Draft still here');
            await page.keyboard.press('Escape'); await mode('view');
            await page.evaluate(() => pollProjectUpdates());
            await page.locator('[data-setup-tab="container"]').click();
            assert.match(await cell('R04C4').innerText(), /REMOTE/);
        });
        await check('JSON export/import retains both setups and multiple sensors', async () => {
            await open();
            const downloadPromise = page.waitForEvent('download'); await page.locator('#exportButton').click();
            const downloaded = await downloadPromise;
            const json = JSON.parse(fs.readFileSync(await downloaded.path(), 'utf8'));
            assert.equal(json.setups.checkpoint.positions.R10C1.items.length, 3);
            assert.equal(json.setups.container.positions.R04C4.items[0].displayName, 'REMOTE');
            const originalId = source.id;
            await mode('edit');
            await page.locator('#importFileInput').setInputFiles({ name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
            await page.waitForFunction(id => currentProjectId && currentProjectId !== String(id), originalId);
            assert.equal(await page.evaluate(() => appState.setups.checkpoint.positions.R10C1.items.length), 3);
            const before = writes.length;
            await mode('edit');
            await page.locator('#importFileInput').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
            await page.waitForTimeout(250); assert.equal(writes.length, before);
        });
        await require('./box-regression.cjs')({ page, api, check, base, sandbox, writes, child });
        await check('no browser console errors', async () => assert.deepEqual(errors, []));
        console.log('Screenshots and isolated test DB: ' + sandbox);
        assert.deepEqual(failures, [], 'Failed checks');
    } finally {
        if (browser) await browser.close();
        server.kill();
        await once(server, 'exit');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
