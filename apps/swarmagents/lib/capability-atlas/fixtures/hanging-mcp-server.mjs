// Intentionally hangs forever without responding to JSON-RPC stdin
process.stdin.resume();
setInterval(() => {}, 60_000);
