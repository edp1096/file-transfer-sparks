import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Exercises real browser key/mouse events against the actual UI, with isolated in-memory listings.
export async function runKeyboardChecks({ call, evaluate, waitFor }) {
    const press = async (key, modifiers = 0, repeat = false) => {
        const code = key === ' ' ? 'Space' : key.length === 1 ? 'Key' + key.toUpperCase() : key;
        const virtual = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32, Escape: 27, Enter: 13, Backspace: 8, Delete: 46, Tab: 9, F5: 116 }[key] || key.toUpperCase().charCodeAt(0);
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtual, autoRepeat: repeat });
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtual });
        await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    };
    const order = id => evaluate(`[...document.getElementById(${JSON.stringify(id)}).querySelectorAll('[data-name]')].map(r=>r.dataset.name)`);
    const state = id => evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});return {
        cursor:document.getElementById(el.getAttribute('aria-activedescendant'))?.dataset.name ?? null,
        selected:[...el.querySelectorAll('[aria-selected="true"]')].map(r=>r.dataset.name),
        checked:[...el.querySelectorAll('[data-name]')].filter(r=>r.querySelector('input').checked).map(r=>r.dataset.name),
        model:${id === 'listA' ? '[...S.selA]' : id === 'listB' ? '[...S.selB]' : id === 'bkList' ? 'BK.items.filter(i=>i.selected).map(i=>i.name)' : 'BK.bkupItems.filter(i=>i.selected).map(i=>i.name)'},
        focus:document.activeElement.id};})()`);
    const expect = async (id, cursor, selected) => {
        const actual = await state(id);
        assert.equal(actual.cursor, cursor, id + ': cursor');
        assert.deepEqual([...actual.selected].sort(), [...selected].sort(), id + ': visible selection');
        assert.deepEqual([...actual.model].sort(), [...selected].sort(), id + ': action selection');
        assert.deepEqual([...actual.checked].sort(), [...selected].sort(), id + ': checkbox state');
    };
    const focus = id => evaluate(`ListNavigation.get(${JSON.stringify(id)}).focus()`);
    const click = async (id, index, modifiers = 0, checkbox = false) => {
        const point = await evaluate(`(()=>{const row=document.getElementById(${JSON.stringify(id)}).querySelectorAll('[data-name]')[${index}];const el=${checkbox ? 'row.querySelector("input")' : 'row.querySelector(".file-name-cell,.bk-row-name")'};const r=el.getBoundingClientRect();return {x:r.x+Math.min(r.width/2,40),y:r.y+r.height/2};})()`);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, modifiers, ...point });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, modifiers, ...point });
        await evaluate('Promise.resolve()');
    };
    await evaluate(`window.keyboardSaved={s:{...S},bk:{...BK},listRemote,execSSH,confirm,loadPanel,loadPanelDiskInfo,bkLoadList,bkLoadBackupList,bkListDocker,bkListGGUF,getHomeDir};
        S.srvA={id:8001,alias:'Keyboard A',sshHost:'fixture'};S.srvB={id:8002,alias:'Keyboard B',sshHost:'fixture'};
        S.pathA='/fixture';S.pathB='/fixture-b';S.panelModeA=S.panelModeB='files';S.busy=false;S.deleting=false;
        S.sortA={col:'name',dir:1};S.sortB={col:'name',dir:1};
        S.filesA=[{name:'folder',isDir:true,size:0,mtime:1},...[1,2,3,4,5,6].map(n=>({name:'0'+n+'.txt',isDir:false,size:n,mtime:n})),{name:'odd [#] "한글".txt',isDir:false,size:8,mtime:8}];
        S.filesB=S.filesA.map(f=>({...f}));S.selA=new Set();S.selB=new Set();
        execSSH=async()=>({exitCode:0,stdOut:'',stdErr:''});window.deletePrompts=0;confirm=()=>{deletePrompts++;return false;};
        switchTab('file');renderList('A');renderList('B');`);
    try {
        const names = await order('listA');
        await focus('listA'); await expect('listA', names[0], []);
        await press('ArrowDown'); await expect('listA', names[1], [names[1]]);
        await press('ArrowDown', 2); await expect('listA', names[2], [names[1]]);
        await press(' ', 2); await expect('listA', names[2], [names[1], names[2]]);
        await press(' ', 2, true); await expect('listA', names[2], [names[1], names[2]]);
        await press('ArrowDown', 8); await expect('listA', names[3], [names[2], names[3]]);
        await press('ArrowUp', 8); await expect('listA', names[2], [names[2]]);
        await press('Escape'); await expect('listA', names[2], []);
        await press(' '); await expect('listA', names[2], [names[2]]);
        await press(' '); await expect('listA', names[2], []);
        // Shift+Space selects from the anchor, while Ctrl+Shift ranges shrink back to their baseline.
        await click('listA', 1); await click('listA', 4, 2);
        await press('ArrowDown', 10); await expect('listA', names[5], [names[1], names[4], names[5]]);
        await press('ArrowUp', 10); await expect('listA', names[4], [names[1], names[4]]);
        await press('ArrowDown', 2); await press(' ', 8); await expect('listA', names[5], [names[4], names[5]]);
        await click('listA', 2); await expect('listA', names[2], [names[2]]);
        await click('listA', 6, 2); await expect('listA', names[6], [names[2], names[6]]);
        await click('listA', 4, 8); await expect('listA', names[4], names.slice(4, 7));
        await click('listA', 7, 0, true); await expect('listA', names[7], [...names.slice(4, 7), names[7]]);
        await click('listA', 7, 0, true); await expect('listA', names[7], names.slice(4, 7));
        assert.equal((await state('listA')).focus, 'listA');
        assert.equal(await evaluate('document.getElementById("chkAllA").indeterminate'), true);
        await press('a', 2); await expect('listA', names[7], names);
        assert.equal(await evaluate('document.getElementById("chkAllA").checked'), true);
        await press('a', 10); await expect('listA', names[7], []);
        await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ㅁ',code:'KeyA',ctrlKey:true,bubbles:true,cancelable:true}))`);
        await expect('listA', names[7], names);await press('Escape');
        assert.equal(await evaluate('document.getElementById("chkAllA").indeterminate'), false);
        await press(' '); const selectedA = names[7];
        await press('ArrowRight'); await expect('listB', names[0], []);
        await press('ArrowDown'); await press('ArrowLeft'); await expect('listA', names[7], [selectedA]);
        await press('ArrowRight', 2); await expect('listB', names[1], [names[1]]);
        // Tab treats each list as a single stop, not every row/checkbox.
        await focus('listA'); await press('Tab');
        assert.equal(await evaluate('document.activeElement.id'), 'pathB');
        await press('Tab', 8); assert.equal(await evaluate('document.activeElement.id'), 'listA');
        // Sorted/background renders retain the focused item and the name-based range anchor.
        await click('listA', 2);
        await evaluate(`S.sortA={col:'name',dir:-1};renderList('A')`);
        await expect('listA', names[2], [names[2]]);
        const reversed = await order('listA'), at = reversed.indexOf(names[2]);
        await press('ArrowDown', 8); await expect('listA', reversed[at + 1], [names[2], reversed[at + 1]]);
        await evaluate(`S.filesA.forEach(f=>{f.dirSizeLoaded=true});renderList('A')`);
        assert.equal((await state('listA')).focus, 'listA');
        await press('ArrowUp', 8); await expect('listA', names[2], [names[2]]);
        // Text input shortcuts, IME events and modal focus never select background rows.
        await evaluate(`const pathInput=document.getElementById('pathA');pathInput.value='/folder with spaces';pathInput.focus()`);
        await press('a', 2);
        assert.deepEqual(await evaluate(`[document.activeElement.selectionStart,document.activeElement.selectionEnd]`), [0, 19]);
        await press('ArrowDown'); await expect('listA', names[2], [names[2]]);
        await focus('listA');
        await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',isComposing:true,bubbles:true}))`);
        await expect('listA', names[2], [names[2]]);
        await evaluate(`document.getElementById('btnAddServer').click()`);
        await waitFor(() => evaluate(`document.activeElement.id==='fAlias'`), 'server dialog focus');
        await press('a', 2); await expect('listA', names[2], [names[2]]);
        await press('Tab', 8); assert.equal(await evaluate(`document.activeElement.closest('.modal-overlay')?.id`), 'serverModal');
        await press('Escape'); assert.equal(await evaluate('document.activeElement.id'), 'listA');
        await evaluate(`document.getElementById('btnKeyboardHelp').click()`);
        await waitFor(() => evaluate(`document.activeElement.id==='btnKeyboardHelpClose'`), 'help dialog');
        await press('Tab'); assert.equal(await evaluate('document.activeElement.id'), 'btnKeyboardHelpClose');
        await press('Escape'); assert.equal(await evaluate('document.activeElement.id'), 'listA');
        await press('Delete'); await press('Delete', 0, true);
        assert.equal(await evaluate('deletePrompts'), 1);
        await evaluate('S.busy=true'); await press('Escape'); await press('a', 2); await press(' '); await press('Delete');
        await expect('listA', names[2], [names[2]]); assert.equal(await evaluate('deletePrompts'), 1);
        await evaluate('S.busy=false'); await press('Escape'); await press('Delete'); assert.equal(await evaluate('deletePrompts'), 1);
        await evaluate(`S.filesA=[];renderList('A')`);
        for (const key of ['Home','End','ArrowDown',' ','Escape','Delete']) await press(key);
        await press('a',2);await expect('listA',null,[]);assert.equal(await evaluate('deletePrompts'),1);
        // Page navigation scrolls the list at application zoom, and Ctrl preserves selection.
        await evaluate(`S.filesA=Array.from({length:100},(_,i)=>({name:String(i).padStart(3,'0')+'.txt',isDir:false,size:i}));S.sortA={col:'name',dir:1};renderList('A')`);
        const many = await order('listA'); await press('Home'); await press('PageDown', 2);
        const paged = await state('listA'); assert.ok(many.indexOf(paged.cursor) > 1); assert.deepEqual(paged.selected, [many[0]]);
        await press('End', 2); await expect('listA', many.at(-1), [many[0]]);
        assert.ok(await evaluate(`document.getElementById('listA').scrollTop`) > 0);
        await press(' '); await press('Home', 10); await expect('listA', many[0], many);
        // Directory navigation restores the parent cursor; Enter on a file never starts a transfer.
        await evaluate(`S.pathA='/fixture';S.filesA=[{name:'folder',isDir:true},{name:'file.txt',isDir:false}];S.selA=new Set();renderList('A');window.navigationCalls=0;
            listRemote=async(srv,path)=>{navigationCalls++;return path==='/fixture/folder'?[{name:'inside.txt',isDir:false}]:[{name:'folder',isDir:true},{name:'file.txt',isDir:false}]};`);
        await press('Home'); await press('Enter');
        await waitFor(() => evaluate(`S.pathA==='/fixture/folder'&&!ListNavigation.get('listA').state.loading`), 'folder open');
        await expect('listA', 'inside.txt', []);
        await press('Enter'); assert.equal(await evaluate('navigationCalls'), 1); assert.equal(await evaluate('S.busy'), false);
        await press('Backspace'); await waitFor(() => evaluate(`S.pathA==='/fixture'&&!ListNavigation.get('listA').state.loading`), 'parent folder');
        await expect('listA', 'folder', []);
        await press('Backspace', 0, true); assert.equal(await evaluate('navigationCalls'), 2);
        // An older directory request must not overwrite a newer listing or cursor.
        await evaluate(`window.pendingOld=null;listRemote=async(srv,path)=>path==='/old'?new Promise(resolve=>pendingOld=resolve):[{name:'new.txt',isDir:false}];S.pathA='/old';window.oldLoad=loadPanel('A');S.pathA='/new';loadPanel('A')`);
        await waitFor(() => evaluate(`S.filesA[0]?.name==='new.txt'`), 'new listing');
        await evaluate(`pendingOld([{name:'stale.txt',isDir:false}]);oldLoad`); await expect('listA', 'new.txt', []);
        // A slow connection attempt cannot replace the server selected more recently.
        await evaluate(`S.servers=[{id:9101,alias:'Old',sshHost:'old'},{id:9102,alias:'New',sshHost:'new'}];populateSelects();
            execSSH=async(srv,cmd)=>srv.id===9101?new Promise(resolve=>window.oldPing=resolve):({stdOut:'__CONN_OK__',stdErr:'',exitCode:0});
            getHomeDir=async()=>'/server-new';listRemote=async()=>[{name:'connected.txt',isDir:false}];
            document.getElementById('selectA').value='9101';window.firstConnection=onSelectServer('A');document.getElementById('selectA').value='9102';onSelectServer('A')`);
        await evaluate(`oldPing({stdOut:'',stdErr:'old failure',exitCode:1});firstConnection`);
        assert.deepEqual(await evaluate(`[S.srvA.id,S.pathA]`),[9102,'/server-new']);await expect('listA','connected.txt',[]);
        await evaluate(`execSSH=async()=>({exitCode:0,stdOut:'',stdErr:''})`);
        // Docker image lists share exactly the same selection behavior.
        await evaluate(`S.panelModeA='docker';S.dockerA=['image:a','image:b','image:c'].map(name=>({name,meta:'1 GB'}));S.selA=new Set();renderDockerList('A')`);
        await focus('listA'); await press(' '); await press('ArrowDown', 8); await expect('listA', 'image:b', ['image:a', 'image:b']);
        await press('Escape'); await expect('listA', 'image:b', []);
        // Clicking a scrolled row must not reveal the old keyboard cursor first,
        // which used to move the row away between mousedown and click and clear selection.
        await evaluate(`S.dockerA=Array.from({length:100},(_,i)=>({name:'image:'+String(i).padStart(3,'0'),meta:'1 GB'}));S.selA=new Set();
            ListNavigation.get('listA').setCursor('image:000');renderDockerList('A');document.getElementById('pathA').focus();
            document.getElementById('listA').scrollTop=document.getElementById('listA').scrollHeight`);
        const dockerScroll = await evaluate(`document.getElementById('listA').scrollTop`);
        await click('listA', 99); await expect('listA', 'image:099', ['image:099']);
        assert.ok(await evaluate(`document.getElementById('listA').scrollTop`) >= dockerScroll - 1);
        await evaluate(`S.dockerA=['image:a','image:b','image:c'].map(name=>({name,meta:'1 GB'}));S.selA=new Set();
            ListNavigation.get('listA').setCursor('image:b');renderDockerList('A')`);
        // All backup sub-tabs and both panes, including late responses from a previous sub-tab.
        await evaluate(`BK.srv={id:8003,alias:'Backup',sshHost:'fixture',ssds:[{mount:'/ssd',device:'/dev/fixture'}]};BK.busy=false;bkUpdateState();BK.ssdStates[0].mounted=true;BK.activeSsdIdx=0;
            bkLoadList=async()=>{BK.items=['one','two','three','four'].map(name=>({name:BK.subTab+'-'+name,selected:false}));bkRenderList();ListNavigation.get('bkList').finishLoad()};
            bkLoadBackupList=async()=>{BK.bkupItems=['one','two','three','four'].map(name=>({name:BK.subTab+'-'+name,selected:false}));bkRenderBkupList();ListNavigation.get('bkBkupList').finishLoad()};
            BK.subTab='docker';bkLoadList();bkLoadBackupList();`);
        await focus('listA'); await press('Tab', 2); assert.equal((await state('bkList')).focus, 'bkList');
        for (const tab of ['docker', 'hf', 'gguf']) {
            await evaluate(`bkSwitchSubTab(${JSON.stringify(tab)})`);
            await focus('bkList'); const items = await order('bkList');
            await press('Home'); await press('ArrowDown', 8); await expect('bkList', items[1], items.slice(0, 2));
            await press('ArrowRight'); await press('End', 2); await press(' '); await expect('bkBkupList', items[3], [items[3]]);
            await press('ArrowLeft'); await expect('bkList', items[1], items.slice(0, 2));
            await press('a', 2); await expect('bkList', items[1], items); await expect('bkBkupList', items[3], [items[3]]);
            await press('Escape'); await expect('bkList', items[1], []);
        }
        await press('Tab', 2); assert.equal((await state('listA')).focus, 'listA');
        await expect('listA', 'image:b', []);
        await press('Tab', 10); await expect('bkList', 'gguf-two', []);
        await evaluate(`bkSwitchSubTab('hf')`);await focus('bkList');await expect('bkList','hf-two',[]);
        await evaluate(`bkSwitchSubTab('gguf')`);await focus('bkList');await expect('bkList','gguf-two',[]);
        await press('ArrowRight');await press(' ');await press('Delete');await press('Delete',0,true);
        assert.equal(await evaluate('deletePrompts'),2);
        // The top-level and backup tab bars use one Tab stop and support arrow-key switching.
        await evaluate(`document.getElementById('tabBackup').focus()`); await press('ArrowLeft');
        assert.equal(await evaluate(`document.activeElement.id`), 'tabFileTransfer');
        await press('ArrowRight'); await press('ArrowDown'); assert.equal((await state('bkBkupList')).focus, 'bkBkupList');
        await expect('bkBkupList', 'gguf-four', ['gguf-four']);
        await evaluate(`document.getElementById('bkTabGGUF').focus()`);
        await press('ArrowLeft'); await press('ArrowDown');
        assert.equal(await evaluate('BK.subTab'), 'hf');
        await press(' '); await press('ArrowDown',8);
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await fs.mkdir('.tmp', { recursive: true }); await fs.writeFile('.tmp/keyboard-ui.png', Buffer.from(shot.data, 'base64'));
        await evaluate(`bkLoadList=keyboardSaved.bkLoadList;bkListDocker=()=>new Promise(resolve=>window.oldBackupResolve=resolve);bkListGGUF=async()=>[{name:'new-model.gguf',selected:false}];BK.subTab='docker';window.oldBackup=bkLoadList();BK.subTab='gguf';bkLoadList()`);
        await waitFor(() => evaluate(`BK.items[0]?.name==='new-model.gguf'`), 'new backup listing');
        await evaluate(`oldBackupResolve([{name:'stale-image',selected:false}]);oldBackup`);
        await expect('bkList', 'new-model.gguf', []);
    } finally {
        await evaluate(`Object.assign(S,keyboardSaved.s);Object.assign(BK,keyboardSaved.bk);
            ({listRemote,execSSH,confirm,loadPanel,loadPanelDiskInfo,bkLoadList,bkLoadBackupList,bkListDocker,bkListGGUF,getHomeDir}=keyboardSaved);
            populateSelects();switchTab('file');renderPanelList('A');renderPanelList('B');bkRenderList();bkRenderBkupList();`);
    }
    console.log('PASS: keyboard selection, cursor preservation, mouse modifiers, dialogs, navigation, stale loads and all list modes');
}
