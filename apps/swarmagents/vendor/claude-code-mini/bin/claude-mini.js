#!/usr/bin/env node

const { ClaudeMiniREPL } = require("../dist/repl.js");

const repl = new ClaudeMiniREPL(process.cwd());
repl.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
