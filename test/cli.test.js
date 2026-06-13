"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/mc-mods");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-mods-test-"));
}

test("normalizes user-facing names into Fabric-safe ids", () => {
  assert.equal(cli.normalizeModId("My Cool Mod!"), "my-cool-mod");
  assert.equal(cli.normalizeModId("123 Tools"), "mod-123-tools");
  assert.equal(cli.packageFromId("my-cool-mod"), "net.local.my_cool_mod");
  assert.equal(cli.classNameFromId("my-cool-mod"), "MyCoolMod");
});

test("parses and formats mod.yml without losing simple keys", () => {
  const parsed = cli.parseConfigText(`
name: My Cool Mod
id: my-cool-mod
build: build/libs/my-cool-mod-0.1.0.jar
`);

  assert.deepEqual(parsed, {
    name: "My Cool Mod",
    id: "my-cool-mod",
    build: "build/libs/my-cool-mod-0.1.0.jar"
  });
  assert.match(cli.formatModConfig(parsed), /name: My Cool Mod/);
  assert.match(cli.formatModConfig(parsed), /build: build\/libs\/my-cool-mod-0.1.0.jar/);
});

test("detects the TLauncher game directory from macOS properties", () => {
  const home = tempDir();
  const configDir = path.join(home, "Library", "Application Support", "tlauncher");
  const gameDir = path.join(home, "Library", "Application Support", "minecraft");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "tlauncher-2.0.properties"),
    `minecraft.gamedir=${gameDir}\n`
  );

  assert.equal(cli.detectTLauncherGameDir({ home, platform: "darwin" }), gameDir);
});

test("lists installed Minecraft versions from version json files", () => {
  const root = tempDir();
  const versionsDir = path.join(root, "versions");
  fs.mkdirSync(path.join(versionsDir, "26.1.2"), { recursive: true });
  fs.mkdirSync(path.join(versionsDir, "26.1.1"), { recursive: true });
  fs.writeFileSync(path.join(versionsDir, "26.1.2", "26.1.2.json"), "{}");
  fs.writeFileSync(path.join(versionsDir, "26.1.1", "26.1.1.json"), "{}");

  assert.deepEqual(cli.listInstalledVersions(root), ["26.1.2", "26.1.1"]);
  assert.equal(cli.detectMinecraftVersion(root), "26.1.2");
});

test("chooses the shortest distributable jar after a build", () => {
  const project = tempDir();
  const libs = path.join(project, "build", "libs");
  fs.mkdirSync(libs, { recursive: true });
  fs.writeFileSync(path.join(libs, "demo-0.1.0-sources.jar"), "");
  fs.writeFileSync(path.join(libs, "demo-0.1.0.jar"), "");
  fs.writeFileSync(path.join(libs, "demo-0.1.0-dev.jar"), "");

  assert.equal(cli.findBuiltJar(project), path.join(libs, "demo-0.1.0.jar"));
});

test("writes a Fabric project skeleton with a Gradle helper", () => {
  const project = tempDir();
  cli.writeFabricProject(project, {
    name: "My Cool Mod",
    id: "my-cool-mod",
    packageName: "net.local.my_cool_mod",
    className: "MyCoolMod",
    minecraftVersion: "26.1.2",
    loaderVersion: "0.19.3",
    loomVersion: "1.17.11",
    gradleVersion: "9.4.1"
  });

  const buildGradle = fs.readFileSync(path.join(project, "build.gradle"), "utf8");
  const modJson = fs.readFileSync(
    path.join(project, "src", "main", "resources", "fabric.mod.json"),
    "utf8"
  );
  const gradlewMode = fs.statSync(path.join(project, "gradlew")).mode;

  assert.match(buildGradle, /loom\.officialMojangMappings\(\)/);
  assert.match(modJson, /"id": "my-cool-mod"/);
  assert.equal((gradlewMode & 0o111) !== 0, true);
});
