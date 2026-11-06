// Capture visible desktop startup state through Electron's loopback debugging port in CI.
import fs from 'node:fs/promises';
import path from 'node:path';
const output = process.argv[2];
const pages = await (await fetch('http://127.0.0.1:49317/json/list')).json();
let index = 0;
for (const page of pages.filter(p => p.type === 'page')) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({data}) => { const result = JSON.parse(data); if (result.id) { const request = pending.get(result.id); pending.delete(result.id); if (request) result.error ? request.reject(new Error(JSON.stringify(result.error))) : request.resolve(result.result); } });
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
  const send = (method,params) => new Promise((resolve,reject) => { const requestId = ++id; pending.set(requestId,{resolve,reject}); socket.send(JSON.stringify({id:requestId,method,params})); });
  try {
    const state = await send('Runtime.evaluate', {expression:'JSON.stringify({url:location.href,title:document.title,text:document.body.innerText})', returnByValue:true});
    await fs.writeFile(path.join(output,`desktop-ui-${index}.json`), state.result.value || JSON.stringify(state));
    const capture = await send('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(output,`desktop-ui-${index}.png`),Buffer.from(capture.data,'base64'));
    console.log(`Captured renderer ${index}: ${page.title}`);
  } finally { socket.close(); }
  index++;
}
