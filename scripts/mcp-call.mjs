// Calls a running kt-mcp directly, the same way an AI client does, for debugging.
// Needs a valid access token in KT_TOKEN. Tokens are stored only as hashes, so
// take one from a client you connected yourself (e.g. MCP Inspector shows it):
//
//   node scripts/mcp-call.mjs list                      # tool names + input schemas
//   node scripts/mcp-call.mjs search_food '{"query":"vejce"}'

const token = process.env.KT_TOKEN;
if (!token) {
  console.error('KT_TOKEN is not set');
  process.exit(2);
}
const url = process.env.KT_URL ?? 'http://127.0.0.1:8092/mcp';
const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error('usage: mcp-call.mjs list | <tool> [json-args]');
  process.exit(2);
}

let id = 0;
async function rpc(method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const body = line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null;
  if (res.status !== 200 || body?.error) throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`);
  return body.result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '0' } });

if (tool === 'list') {
  for (const t of (await rpc('tools/list')).tools) {
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    const args = Object.entries(props).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}:${v.type ?? (v.enum ? v.enum.join('|') : '?')}`);
    console.log(`${t.name}(${args.join(', ')})`);
  }
} else {
  const result = await rpc('tools/call', { name: tool, arguments: JSON.parse(rawArgs) });
  for (const part of result.content ?? []) console.log(part.type === 'text' ? part.text : part);
  if (result.isError) process.exit(1);
}
