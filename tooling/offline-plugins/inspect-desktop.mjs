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
  socket.addEventListener('message', ({data}) => { const result = JSON.parse(data); if (result.id) { const request = pending.get(result.id); pending.delete(result.id); if (request) { clearTimeout(request.timer); result.error ? request.reject(new Error(JSON.stringify(result.error))) : request.resolve(result.result); } } });
  await Promise.race([new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); }),new Promise((_,reject)=>setTimeout(()=>reject(new Error('CDP connection timed out')),10000).unref())]);
  const send = (method,params) => new Promise((resolve,reject) => { const requestId = ++id; const timer = setTimeout(()=>{pending.delete(requestId);reject(new Error(`${method} timed out`));},10000); pending.set(requestId,{resolve,reject,timer}); socket.send(JSON.stringify({id:requestId,method,params})); });
  try {
    const state = await send('Runtime.evaluate', {expression:'JSON.stringify({url:location.href,title:document.title,text:document.body.innerText})', returnByValue:true});
    await fs.writeFile(path.join(output,`desktop-ui-${index}.json`), state.result.value || JSON.stringify(state));
    // Hidden, not-yet-ready Electron renderers may not answer screenshot requests.
    try {
      const capture = await send('Page.captureScreenshot',{format:'png'});
      await fs.writeFile(path.join(output,`desktop-ui-${index}.png`),Buffer.from(capture.data,'base64'));
    } catch (error) { await fs.writeFile(path.join(output,`desktop-capture-${index}.txt`),error.message); }
    console.log(`Captured renderer ${index}: ${page.title}`);
  } catch (error) {
    await fs.writeFile(path.join(output,`desktop-ui-${index}-error.txt`),error.message);
    console.log(`Renderer ${index} inspection: ${error.message}`);
  } finally { socket.close(); }
  index++;
}
// A hidden renderer may not complete the WebSocket close handshake.
process.exit(0);
