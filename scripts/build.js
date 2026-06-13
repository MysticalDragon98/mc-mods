"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "mc-mods.js");
const outputDir = path.join(root, "build");
const output = path.join(outputDir, "mc-mods");

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(source, output);
fs.chmodSync(output, 0o755);

console.log(`Built ${path.relative(root, output)}`);
