import {test,expect} from '@playwright/test';
test.describe.configure({mode:'serial'});
test('frozen original frontend connects to TypeScript backend and synchronizes with new frontend',async({browser,request})=>{
    const links=await(await request.get('http://127.0.0.1:8767')).json();
    const desktop=await browser.newContext(),mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    try{const old=await desktop.newPage(),current=await mobile.newPage();await old.goto(links.legacy);await current.goto(links.online);
        for(const page of [old,current])await expect(page.getByRole('status',{name:'服务连接状态',exact:true})).toHaveText('服务已连接');
        await old.getByLabel('业务 COM',{exact:true}).click();await old.getByLabel('业务 COM',{exact:true}).fill('COM91');await expect(current.getByLabel('业务 COM',{exact:true})).toHaveValue('COM91');
        await current.reload();await expect(current.getByLabel('业务 COM',{exact:true})).toHaveValue('COM91');
        await old.getByRole('button',{name:'打开配置面板',exact:true}).click();await expect(old.getByRole('dialog',{name:'设备配置面板',exact:true})).toBeVisible();
        await old.screenshot({path:'../artifacts/legacy-config.png',fullPage:true});
    }finally{await desktop.close();await mobile.close();}
});
test('frozen frontend can read, preview, save and export through unchanged API',async({page,request})=>{
    await request.post('http://127.0.0.1:8767',{data:{action:'mock-config'}});
    const links=await(await request.get('http://127.0.0.1:8767')).json();await page.goto(links.legacy);
    await expect(page.getByRole('status',{name:'服务连接状态',exact:true})).toHaveText('服务已连接');
    const result=await page.evaluate(async()=>{const api=(window as any).pywebview.api;const read=await api.read_device();if(!read.ok)return{read};const config={...read.data,baud:2000000};const preview=await api.preview_save(config,{},[]);const backup=await api.backup_config(config);const saved=await api.save_device(config,{},[],preview.data?.epoch);const after=await api.poll(0);return{read,preview,backup,saved,after};});
    expect(result.read.ok).toBe(true);expect(result.preview.data.changes).toContainEqual({field:'baud',value:'2000000'});expect(result.backup.data.config.baud).toBe(2000000);expect(result.saved.data.saved).toBe(true);expect(result.after.data.baseline).toBeNull();
});
