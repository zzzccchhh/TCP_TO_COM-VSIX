import { installPluginConnection } from './lan';
declare global { interface Window { acquireVsCodeApi?: () => {postMessage(message: unknown): void}; } }
if(typeof window.acquireVsCodeApi==='function'){
    const vscode=window.acquireVsCodeApi();let sequence=0;
    const pending=new Map<string,{resolve:(reply:any)=>void,timer:ReturnType<typeof setTimeout>}>();
    window.addEventListener('message',event=>{const message=event.data;if(message?.kind==='reply'){const item=pending.get(message.id);if(item){clearTimeout(item.timer);pending.delete(message.id);item.resolve(message.reply);}}else if(message?.kind==='reconnect'){for(const item of pending.values()){clearTimeout(item.timer);item.resolve({ok:false,error:'服务连接已改变，请重试'});}pending.clear();installPluginConnection();window.dispatchEvent(new Event('pywebviewready'));}});
    window.pywebview={api:new Proxy({}, {get:(_,method:string)=>(...args:any[])=>new Promise(resolve=>{const id=String(++sequence);const timer=setTimeout(()=>{pending.delete(id);resolve({ok:false,error:'插件后端响应超时，请检查服务状态'});},45000);pending.set(id,{resolve,timer});vscode.postMessage({kind:'call',id,method,args});})})};
    window.addEventListener('tcp2com-download',((event:CustomEvent)=>vscode.postMessage({kind:'download',...event.detail})) as EventListener);
    installPluginConnection();
}
