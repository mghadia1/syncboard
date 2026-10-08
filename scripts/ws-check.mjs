// WebSocket checks for scripts/smoke.sh, with Node's built-in WebSocket
// client (Node 22+): node scripts/ws-check.mjs <ws-url> <check>
//
//   hello        a hello gets a welcome to the board
//   protocol     another protocol version is refused with close code 4001
//   oversized    a frame over 1 MiB closes the connection with 1009
//   relay        two clients on one board: one's edit reaches the other,
//                and is acknowledged; a third, joining later, gets it in
//                the welcome's snapshot
//   wait-close   say hello, print "ready", then print the close code when
//                the server closes the connection (for the shutdown check)
//
// Prints what it saw; exits 1 if it was not what the check expects.

const [url, check] = process.argv.slice(2);
const PROTOCOL = 2;
const BOARD = `smoke${Date.now().toString(36)}`;

function fail(message) {
  console.error(`FAIL ws ${check}: ${message}`);
  process.exit(1);
}

setTimeout(() => fail("timed out after 10 s"), 10_000).unref();

/** A connection that queues what arrives, so the check can wait for it. */
async function connect(client) {
  const ws = new WebSocket(url);
  const inbox = [];
  let wake = () => {};
  ws.onmessage = (event) => {
    inbox.push(JSON.parse(event.data));
    wake();
  };
  const closed = new Promise((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
  ws.onerror = () => fail("connection error");
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  const next = async (type) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(0, i + 1).at(-1);
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  };
  const send = (message) => ws.send(JSON.stringify(message));
  const hello = async () => {
    send({ type: "hello", protocol: PROTOCOL, board: BOARD, client });
    return next("welcome");
  };
  return { ws, next, send, hello, closed };
}

switch (check) {
  case "hello": {
    const c = await connect("smoke1");
    const welcome = await c.hello();
    if (welcome.board !== BOARD) fail(`got ${JSON.stringify(welcome)}`);
    console.log(welcome.type);
    c.ws.close();
    break;
  }
  case "protocol": {
    const c = await connect("smoke1");
    c.send({ type: "hello", protocol: PROTOCOL + 1, board: BOARD, client: "smoke1" });
    console.log(await c.closed);
    break;
  }
  case "oversized": {
    const c = await connect("smoke1");
    c.ws.send("x".repeat(1024 * 1024 + 1));
    console.log(await c.closed);
    break;
  }
  case "relay": {
    const a = await connect("smokeA");
    const b = await connect("smokeB");
    await a.hello();
    await b.hello();
    const op = {
      shape: "smokeA.1",
      stamp: { counter: 1, client: "smokeA" },
      set: { kind: "note", x: 0, y: 0, w: 10, h: 10, z: "V", text: "smoke" },
    };
    a.send({ type: "ops", ops: [op] });
    const ack = await a.next("ack");
    const relayed = await b.next("ops");
    if (ack.upTo !== 1 || relayed.ops[0]?.set.text !== "smoke") fail(`ack ${JSON.stringify(ack)}, ops ${JSON.stringify(relayed)}`);
    const c = await connect("smokeC");
    const welcome = await c.hello();
    const shape = welcome.snapshot.find(([id]) => id === "smokeA.1");
    if (!shape) fail("a later joiner did not get the shape");
    console.log("relayed");
    for (const x of [a, b, c]) x.ws.close();
    break;
  }
  case "wait-close": {
    const c = await connect("smoke1");
    await c.hello();
    console.log("ready");
    console.log(await c.closed);
    break;
  }
  default:
    fail("unknown check");
}
process.exit(0);
