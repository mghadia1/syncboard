// WebSocket checks for scripts/smoke.sh, with Node's built-in WebSocket
// client (Node 22+): node scripts/ws-check.mjs <ws-url> <check>
//
//   hello        a hello gets a welcome
//   protocol     another protocol version is refused with close code 4001
//   oversized    a frame over 1 MiB closes the connection with 1009
//   wait-close   say hello, print "ready", then print the close code when
//                the server closes the connection (for the shutdown check)
//
// Prints what it saw; exits 1 if it was not what the check expects.

const [url, check] = process.argv.slice(2);
const PROTOCOL = 1;

function fail(message) {
  console.error(`FAIL ws ${check}: ${message}`);
  process.exit(1);
}

setTimeout(() => fail("timed out after 10 s"), 10_000).unref();

const ws = new WebSocket(url);
ws.onerror = () => fail("connection error");
const messages = [];
ws.onmessage = (event) => messages.push(JSON.parse(event.data));

function closed() {
  return new Promise((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
}

await new Promise((resolve) => {
  ws.onopen = resolve;
});

switch (check) {
  case "hello": {
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL }));
    while (messages.length === 0) await new Promise((r) => setTimeout(r, 10));
    if (messages[0].type !== "welcome") fail(`got ${JSON.stringify(messages[0])}`);
    console.log(messages[0].type);
    ws.close();
    break;
  }
  case "protocol": {
    const end = closed();
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL + 1 }));
    console.log(await end);
    break;
  }
  case "oversized": {
    const end = closed();
    ws.send("x".repeat(1024 * 1024 + 1));
    console.log(await end);
    break;
  }
  case "wait-close": {
    const end = closed();
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL }));
    while (messages.length === 0) await new Promise((r) => setTimeout(r, 10));
    console.log("ready");
    console.log(await end);
    break;
  }
  default:
    fail("unknown check");
}
process.exit(0);
