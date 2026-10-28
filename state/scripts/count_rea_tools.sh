#!/bin/bash
# Count the REA MCP tools and measure their schema size via JSON-RPC.
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"count","version":"1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | timeout 60 /usr/local/bin/node /usr/local/bin/rea mcp 2>/dev/null | \
/usr/local/bin/node -e "
let buf='';
process.stdin.on('data',c=>buf+=c);
process.stdin.on('end',()=>{
  for (const line of buf.split('\n')) {
    if(!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch(e){ continue; }
    if (m.id === 2 && m.result && m.result.tools) {
      const t = m.result.tools;
      const sizes = t.map(x => Buffer.byteLength(JSON.stringify({type:'function',function:x}),'utf8'));
      const total = sizes.reduce((a,b)=>a+b,0);
      console.log('REA MCP TOOL COUNT:', t.length);
      console.log('REA MCP SCHEMA BYTES: ' + total.toLocaleString() + '  (~' + Math.round(total/4).toLocaleString() + ' tokens)');
      const pairs = t.map((x,i)=>[sizes[i],x.name]).sort((a,b)=>b[0]-a[0]);
      console.log('');
      console.log('TOP 10 LARGEST:');
      pairs.slice(0,10).forEach(([b,n])=>console.log('  ' + String(b).padStart(8) + ' B  ' + n));
      console.log('');
      console.log('SMALLEST 3:');
      pairs.slice(-3).forEach(([b,n])=>console.log('  ' + String(b).padStart(8) + ' B  ' + n));
    }
  }
});
"
