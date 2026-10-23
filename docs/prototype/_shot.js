const http=require('http');const {spawn}=require('child_process');const path=require('path');const fs=require('fs');
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';const PORT=9411;
const URL='file:///D:/projects/zero-waste-p4/docs/prototype/index.html';
const OUTDIR=__dirname;
function get(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}
(async()=>{
const W=parseInt(process.argv[2]||'1280'),H=parseInt(process.argv[3]||'900');
const TAG=process.argv[4]||'shot';const MOBILE=process.argv[5]==='mobile';
const child=spawn(CHROME,['--headless=new','--disable-gpu','--hide-scrollbars','--no-sandbox','--disable-crash-reporter',`--remote-debugging-port=${PORT}`,'--window-size='+W+','+H,'--user-data-dir='+(process.env.SHOT_PROFILE||path.join(require('os').tmpdir(),'dsh-cdp-profile')),'about:blank'],{stdio:'ignore'});
let tabs=null;for(let i=0;i<50;i++){try{tabs=JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));break;}catch(e){await new Promise(r=>setTimeout(r,400));}}
if(!tabs){console.log('NO_TABS');child.kill();process.exit(1);}
const t=tabs.find(x=>x.type==='page');const WebSocket=require('ws');const ws=new WebSocket(t.webSocketDebuggerUrl,{perMessageDeflate:false});
let id=0;const p=new Map();ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&p.has(o.id)){p.get(o.id)(o);p.delete(o.id);}});
const send=(m,q={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:q}));});
await new Promise(r=>ws.on('open',r));
await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:MOBILE?2:1,mobile:MOBILE});
await send('Page.enable');await send('Page.navigate',{url:URL});await new Promise(r=>setTimeout(r,4000));
const info=await send('Runtime.evaluate',{expression:`(()=>{const b=document.body;return JSON.stringify({h:b.scrollHeight,sw:b.scrollWidth,cw:document.documentElement.clientWidth});})()`,returnByValue:true});
console.log('PAGE '+info.result.result.value);
const H2=JSON.parse(info.result.result.value).h;
const res=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:W,height:H2,scale:1}});
fs.writeFileSync(path.join(OUTDIR,TAG+'.png'),Buffer.from(res.result.data,'base64'));
console.log('OK '+TAG+' '+W+'x'+H2);
ws.close();child.kill();process.exit(0);})();
