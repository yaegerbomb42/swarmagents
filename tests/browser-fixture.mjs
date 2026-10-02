#!/usr/bin/env node
// Local fixture site for the browser-tool tests. Covers the shapes a real agent hits:
// a login, a multi-step form, upload, download, a modal, tabs, infinite scroll, an iframe,
// shadow DOM, a slow page, and an element that disappears under the agent's feet.
//
//   node tests/browser-fixture.mjs [port]              (standalone; default 38150)
//   import { startSite } from "./browser-fixture.mjs"  (from a test)
//
// No dependencies, no network. Everything is served from this file.

import http from "node:http";
import { fileURLToPath } from "node:url";

const html = (body, title = "Fixture") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const NAV = `<nav><a href="/">home</a> <a href="/login">login</a> <a href="/form">form</a> <a href="/files">files</a> <a href="/modal">modal</a> <a href="/vanish">vanish</a> <a href="/tabs">tabs</a> <a href="/scroll">scroll</a> <a href="/iframe">iframe</a> <a href="/shadow">shadow</a> <a href="/slow">slow</a></nav>`;

const PAGES = {
  "/": html(`${NAV}<h1>Fixture site</h1><p>Everything the browser tests need.</p>`, "Fixture site"),

  "/login": html(
    `${NAV}<h1>Sign in</h1>
<form method="post" action="/welcome">
  <label for="u">Username</label><input id="u" name="user" autocomplete="username">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button id="go" type="submit">Sign in</button>
</form>
<p id="err"></p>`,
    "Sign in",
  ),

  "/form": html(
    `${NAV}<h1>Multi-step form</h1>
<form id="wizard" method="post" action="/form-done">
  <section data-step="1"><h2>Step 1 — you</h2>
    <label for="name">Full name</label><input id="name" name="name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <button id="next1" type="button" onclick="go(2)">Next</button></section>
  <section data-step="2" hidden><h2>Step 2 — address</h2>
    <label for="street">Street</label><input id="street" name="street" required>
    <label for="city">City</label><input id="city" name="city" required>
    <button id="next2" type="button" onclick="go(3)">Next</button></section>
  <section data-step="3" hidden><h2>Step 3 — plan</h2>
    <label for="plan">Plan</label><select id="plan" name="plan"><option value="">choose…</option><option value="basic">Basic</option><option value="pro">Pro</option></select>
    <label><input id="agree" name="agree" type="checkbox"> I agree to the terms</label>
    <button id="finish" type="submit">Finish</button></section>
</form>
<script>function go(n){document.querySelectorAll('section[data-step]').forEach(s=>s.hidden = Number(s.dataset.step)!==n);}</script>`,
    "Multi-step form",
  ),

  "/files": html(
    `${NAV}<h1>Files</h1>
<input id="f" type="file" onchange="document.getElementById('picked').textContent='picked:'+this.files[0].name">
<p id="picked">nothing picked</p>
<a id="dl" href="/report.csv" download>Download report</a>
<a id="dlbig" href="/big.bin" download>Download big file</a>
<a id="dlexe" href="/notes.exe" download>Download bad type</a>`,
    "Files",
  ),

  "/modal": html(
    `${NAV}<h1>Modal</h1>
<button id="open" onclick="document.getElementById('m').hidden=false">Open modal</button>
<div id="m" role="dialog" aria-modal="true" hidden>
  <p id="mtext">Do you want to continue?</p>
  <button id="confirm" onclick="document.getElementById('m').hidden=true;document.title='confirmed'">Confirm</button>
  <button id="cancel" onclick="document.getElementById('m').hidden=true">Cancel</button>
</div>`,
    "Modal",
  ),

  "/vanish": html(
    `${NAV}<h1>Vanishing element</h1>
<button id="trap" onclick="setTimeout(()=>document.getElementById('gone').remove(), 300)">Start</button>
<button id="gone" onclick="document.title='clicked-gone'">Click me fast</button>`,
    "Vanish",
  ),

  "/tabs": html(
    `${NAV}<h1>Tabs</h1>
<a id="newtab" href="/tab-one" target="_blank">Open tab one</a>
<a id="popup" href="/tab-two" target="_blank">Open tab two</a>`,
    "Tabs",
  ),

  "/scroll": html(
    `${NAV}<h1>Infinite scroll</h1><div id="list"></div>
<script>
  let n=0;
  function more(){for(let i=0;i<20;i++){n++;const d=document.createElement('div');d.className='row';d.style.minHeight='48px';d.textContent='Item '+n;document.getElementById('list').appendChild(d);}}
  function nearBottom(){ return innerHeight + scrollY >= document.body.scrollHeight - 200; }
  more();
  addEventListener('scroll',()=>{ if (nearBottom()) more(); });
  // Also grow on a timer so a page that is not yet scrollable still fills up (the agent scrolls too).
  setInterval(()=>{ if (nearBottom() && n < 400) more(); }, 200);
</script>`,
    "Scroll",
  ),

  "/slow": html(`${NAV}<h1>Slow</h1><div id="late">…</div><script>setTimeout(()=>{document.getElementById('late').textContent='arrived'},1500)</script>`, "Slow"),

  "/tab-one": html(`<h1>Tab one</h1><p id="t1">first tab</p>`, "Tab one"),
  "/tab-two": html(`<h1>Tab two</h1><p id="t2">second tab</p>`, "Tab two"),

  "/iframe": html(`${NAV}<h1>Iframe</h1><iframe id="fr" src="/frame-child" width="400" height="200"></iframe>`, "Iframe"),

  "/frame-child": html(`<button id="inside" onclick="parent.document.title='iframe-clicked'">Inside frame</button>`, "Child frame"),

  "/shadow": html(
    `${NAV}<h1>Shadow DOM</h1><div id="host"></div>
<script>
  const r = document.getElementById('host').attachShadow({mode:'open'});
  r.innerHTML = '<button id="shadowbtn">Shadow button</button>';
  r.querySelector('#shadowbtn').addEventListener('click', () => document.title = 'shadow-clicked');
</script>`,
    "Shadow",
  ),

  "/drag": html(
    `${NAV}<h1>Drag</h1>
<div id="src" draggable="true" style="padding:10px;border:1px solid #333;width:120px">drag me</div>
<div id="dst" style="padding:24px;border:1px dashed #333;margin-top:16px;width:160px">drop here</div>
<script>
  const dst = document.getElementById('dst');
  dst.addEventListener('dragover', e => e.preventDefault());
  dst.addEventListener('drop', e => { e.preventDefault(); document.title = 'dropped'; dst.textContent = 'dropped'; });
</script>`,
    "Drag",
  ),

  "/echo": html(
    `${NAV}<h1>Echo</h1>
<input id="box" oninput="document.getElementById('seen').textContent = 'seen:' + this.value">
<p id="seen">seen:</p>`,
    "Echo",
  ),
};

export function startSite(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/report.csv") {
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="report.csv"' });
      return res.end("id,name\n1,Widget\n2,Gadget\n");
    }
    if (p === "/big.bin") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="big.bin"' });
      return res.end(Buffer.alloc(2 * 1024 * 1024, 7));
    }
    if (p === "/notes.exe") {
      // A download the runtime must refuse (extension not on the allowlist).
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="notes.exe"' });
      return res.end("MZ");
    }
    if (p === "/welcome") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (ch) => (body += ch));
        return req.on("end", () => {
          const u = new URLSearchParams(body).get("user") ?? "";
          res.writeHead(303, { Location: `/welcome?u=${encodeURIComponent(u)}` });
          res.end();
        });
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html(`<h1 id="hi">Welcome ${url.searchParams.get("u") ?? ""}</h1><a href="/">home</a>`, "Welcome"));
    }
    if (p === "/form-done") {
      let body = "";
      req.on("data", (ch) => (body += ch));
      return req.on("end", () => {
        const f = new URLSearchParams(body);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html(`<h1 id="done">Signed up ${f.get("name") ?? ""} (${f.get("plan") ?? ""})</h1>`, "Done"));
      });
    }
    if (p === "/slow" && url.searchParams.get("hard") === "1") {
      return setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PAGES["/slow"]);
      }, 1500);
    }
    const page = PAGES[p];
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page);
    }
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(html("<h1>404</h1>", "Not found"));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Standalone mode.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const site = await startSite(Number(process.argv[2] || 38150));
  console.log(`browser fixture site on ${site.url}`);
}