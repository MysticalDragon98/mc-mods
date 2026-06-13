#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawnSync } = require("node:child_process");

const TOOL_VERSION = "0.1.0";
const DEFAULT_PROJECT_ROOT = path.join(os.homedir(), "src", "mc-mods");
const DEFAULT_MINECRAFT_VERSION = "26.1.2";
const DEFAULT_LOADER_VERSION = "0.19.3";
const DEFAULT_LOOM_VERSION = "1.17.11";
const DEFAULT_GRADLE_VERSION = "9.4.1";
const FABRIC_LOADER_URL = "https://meta.fabricmc.net/v2/versions/loader";
const FABRIC_GAME_URL = "https://meta.fabricmc.net/v2/versions/game";
const FABRIC_LOOM_METADATA_URL =
  "https://maven.fabricmc.net/net/fabricmc/fabric-loom/net.fabricmc.fabric-loom.gradle.plugin/maven-metadata.xml";

function usage() {
  return `
mc-mods ${TOOL_VERSION}

Usage:
  mc-mods init <name> [--root <dir>] [--minecraft-version <version>] [--package <name>] [--no-open]
  mc-mods build [name] [--root <dir>]
  mc-mods install [name] [--root <dir>] [--target <global|version>] [--game-dir <dir>] [--yes]
  mc-mods uninstall [name] [--root <dir>] [--target <global|version>] [--game-dir <dir>] [--all] [--yes]

Commands:
  init       Create a Fabric mod project under $HOME/src/mc-mods and open it in VS Code.
  build      Run Gradle and update mod.yml with the produced jar path.
  install    Copy the built jar into the detected Minecraft/TLauncher mods folder.
  uninstall  Remove the installed jar from the detected Minecraft/TLauncher mods folder.

Options:
  --loader-version <version>  Override the Fabric Loader version used by init.
  --loom-version <version>    Override the Fabric Loom version used by init.
  --path <dir>                Create a project at an exact path instead of <root>/<id>.
  --version                   Print the CLI version.
  --help                      Show this help.
`.trim();
}

function parseArgv(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();

    if (key === "help" || key === "version" || key === "yes" || key === "all") {
      options[key] = true;
      continue;
    }

    if (key === "no-open") {
      options.open = false;
      continue;
    }

    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || (inlineValue === undefined && next.startsWith("--"))) {
      throw new Error(`Missing value for --${key}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }

    options[key] = next;
  }

  return { options, positionals };
}

function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeModId(value) {
  let id = slugify(value).replace(/[^a-z0-9_-]/g, "-");

  if (!id) {
    throw new Error("Mod name must contain at least one letter or number");
  }

  if (!/^[a-z]/.test(id)) {
    id = `mod-${id}`;
  }

  return id.slice(0, 64);
}

function packageFromId(id) {
  const segment = id
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^([0-9])/, "_$1");

  return `net.local.${segment}`;
}

function classNameFromId(id) {
  const base = id
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  if (!base) {
    return "PersonalMod";
  }

  return base.endsWith("Mod") ? base : `${base}Mod`;
}

function javaReleaseForMinecraft(version) {
  return /^26(?:\.|-)/.test(version) ? 25 : 21;
}

function escapeForSingleQuotedGradle(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function readProperties(filePath) {
  const properties = {};

  if (!fs.existsSync(filePath)) {
    return properties;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }

    const separatorIndex = trimmed.search(/[:=]/);
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    properties[key] = value;
  }

  return properties;
}

function parseConfigText(text) {
  const config = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    config[match[1]] = value;
  }

  return config;
}

function readModConfig(projectDir) {
  const filePath = path.join(projectDir, "mod.yml");
  if (!fs.existsSync(filePath)) {
    throw new Error(`No mod.yml found in ${projectDir}`);
  }

  return parseConfigText(fs.readFileSync(filePath, "utf8"));
}

function formatYamlScalar(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:+=@ -]+$/.test(stringValue) && stringValue.trim() === stringValue) {
    return stringValue;
  }

  return JSON.stringify(stringValue);
}

function formatModConfig(config) {
  const preferredOrder = [
    "name",
    "id",
    "version",
    "project",
    "minecraft",
    "loader",
    "loom",
    "build",
    "installed"
  ];
  const keys = [
    ...preferredOrder.filter((key) => Object.prototype.hasOwnProperty.call(config, key)),
    ...Object.keys(config)
      .filter((key) => !preferredOrder.includes(key))
      .sort()
  ];

  return `${keys.map((key) => `${key}: ${formatYamlScalar(config[key])}`).join("\n")}\n`;
}

function writeModConfig(projectDir, config) {
  fs.writeFileSync(path.join(projectDir, "mod.yml"), formatModConfig(config));
}

function detectTLauncherGameDir(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const candidates = [];

  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "tlauncher", "tlauncher-2.0.properties")
    );
  }

  candidates.push(
    path.join(home, ".tlauncher", "tlauncher-2.0.properties"),
    path.join(home, "tlauncher", "tlauncher-2.0.properties")
  );

  for (const candidate of candidates) {
    const properties = readProperties(candidate);
    if (properties["minecraft.gamedir"]) {
      return expandHome(properties["minecraft.gamedir"]);
    }
  }

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "minecraft");
  }

  if (platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, ".minecraft");
  }

  return path.join(home, ".minecraft");
}

function listInstalledVersions(gameDir) {
  const versionsDir = path.join(gameDir, "versions");
  if (!fs.existsSync(versionsDir)) {
    return [];
  }

  return fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((version) => fs.existsSync(path.join(versionsDir, version, `${version}.json`)))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

function detectMinecraftVersion(gameDir) {
  return listInstalledVersions(gameDir)[0] ?? DEFAULT_MINECRAFT_VERSION;
}

function discoverInstallTargets(gameDir) {
  const targets = [];
  const globalModsDir = path.join(gameDir, "mods");

  if (fs.existsSync(globalModsDir)) {
    targets.push({ label: "global", path: globalModsDir });
  }

  for (const version of listInstalledVersions(gameDir)) {
    const versionModsDir = path.join(gameDir, "versions", version, "mods");
    if (fs.existsSync(versionModsDir)) {
      targets.push({ label: version, path: versionModsDir });
    }
  }

  if (targets.length === 0) {
    targets.push({ label: "global", path: globalModsDir });
  }

  return targets;
}

function targetFromName(gameDir, targetName) {
  if (!targetName || targetName === "global") {
    return { label: "global", path: path.join(gameDir, "mods") };
  }

  return {
    label: targetName,
    path: path.join(gameDir, "versions", targetName, "mods")
  };
}

async function chooseInstallTarget(gameDir, parsedOptions) {
  if (parsedOptions.target) {
    return targetFromName(gameDir, parsedOptions.target);
  }

  const targets = discoverInstallTargets(gameDir);
  if (targets.length === 1 || parsedOptions.yes || !process.stdin.isTTY) {
    return targets[0];
  }

  console.log("Choose a Minecraft install target:");
  targets.forEach((target, index) => {
    console.log(`  ${index + 1}. ${target.label} (${target.path})`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Target [1-${targets.length}]: `);
    const selected = Number.parseInt(answer, 10);
    if (!Number.isInteger(selected) || selected < 1 || selected > targets.length) {
      throw new Error("Invalid target selection");
    }
    return targets[selected - 1];
  } finally {
    rl.close();
  }
}

function commandExists(command) {
  const checker =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
          stdio: "ignore"
        });

  return checker.status === 0;
}

async function fetchText(url) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this Node version");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": `mc-mods/${TOOL_VERSION}` }
    });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchLatestLoaderVersion() {
  const versions = await fetchJson(FABRIC_LOADER_URL);
  const selected = versions.find((version) => version.stable) ?? versions[0];
  if (!selected?.version) {
    throw new Error("Fabric Loader metadata did not include a version");
  }
  return selected.version;
}

async function fetchLatestGameVersion() {
  const versions = await fetchJson(FABRIC_GAME_URL);
  const selected = versions.find((version) => version.stable) ?? versions[0];
  if (!selected?.version) {
    throw new Error("Fabric game metadata did not include a version");
  }
  return selected.version;
}

async function fetchLatestLoomVersion() {
  const metadata = await fetchText(FABRIC_LOOM_METADATA_URL);
  const release = /<release>([^<]+)<\/release>/.exec(metadata)?.[1];
  const latest = /<latest>([^<]+)<\/latest>/.exec(metadata)?.[1];
  return release ?? latest ?? DEFAULT_LOOM_VERSION;
}

async function resolveFabricVersions(options) {
  const loaderVersion =
    options.loaderVersion ?? (await fetchLatestLoaderVersion().catch(() => DEFAULT_LOADER_VERSION));
  const loomVersion =
    options.loomVersion ?? (await fetchLatestLoomVersion().catch(() => DEFAULT_LOOM_VERSION));

  return {
    minecraftVersion: options.minecraftVersion,
    loaderVersion,
    loomVersion,
    gradleVersion: DEFAULT_GRADLE_VERSION
  };
}

function ensureEmptyOrMissingDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    return;
  }

  const entries = fs.readdirSync(directory);
  if (entries.length > 0) {
    throw new Error(`${directory} already exists and is not empty`);
  }
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode !== undefined) {
    fs.chmodSync(filePath, mode);
  }
}

function writeFabricProject(projectDir, context) {
  const packageDir = context.packageName.replace(/\./g, "/");
  const javaRelease = javaReleaseForMinecraft(context.minecraftVersion);
  const gradleSafeName = escapeForSingleQuotedGradle(context.id);

  writeFile(
    path.join(projectDir, "settings.gradle"),
    `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
    }
}

rootProject.name = '${gradleSafeName}'
`
  );

  writeFile(
    path.join(projectDir, "build.gradle"),
    `plugins {
    id 'fabric-loom' version "\${loom_version}"
    id 'maven-publish'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
    mappings loom.officialMojangMappings()
    modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
}

processResources {
    inputs.property "version", project.version

    filesMatching("fabric.mod.json") {
        expand "version": project.version
    }
}

tasks.withType(JavaCompile).configureEach {
    options.release = ${javaRelease}
}

java {
    withSourcesJar()
    sourceCompatibility = JavaVersion.toVersion(${javaRelease})
    targetCompatibility = JavaVersion.toVersion(${javaRelease})
}

jar {
    from("LICENSE") {
        rename { "\${it}_\${project.base.archivesName.get()}" }
    }
}

publishing {
    publications {
        create("mavenJava", MavenPublication) {
            artifactId = project.archives_base_name
            from components.java
        }
    }
}
`
  );

  writeFile(
    path.join(projectDir, "gradle.properties"),
    `org.gradle.jvmargs=-Xmx1G
org.gradle.parallel=true
org.gradle.configuration-cache=false

minecraft_version=${context.minecraftVersion}
loader_version=${context.loaderVersion}
loom_version=${context.loomVersion}

mod_version=0.1.0
maven_group=${context.packageName.split(".").slice(0, -1).join(".") || "net.local"}
archives_base_name=${context.id}
`
  );

  writeFile(
    path.join(projectDir, "src", "main", "java", packageDir, `${context.className}.java`),
    `package ${context.packageName};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ${context.className} implements ModInitializer {
    public static final String MOD_ID = "${context.id}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        LOGGER.info("{} loaded", MOD_ID);
    }
}
`
  );

  writeFile(
    path.join(projectDir, "src", "main", "resources", "fabric.mod.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: context.id,
        version: "${version}",
        name: context.name,
        description: "Personal Fabric mod generated by mc-mods.",
        authors: ["kyc"],
        contact: {},
        license: "All-Rights-Reserved",
        icon: `assets/${context.id}/icon.png`,
        environment: "*",
        entrypoints: {
          main: [`${context.packageName}.${context.className}`]
        },
        depends: {
          fabricloader: `>=${context.loaderVersion}`,
          minecraft: `>=${context.minecraftVersion}`,
          java: `>=${javaRelease}`
        }
      },
      null,
      2
    )}\n`
  );

  writeFile(
    path.join(projectDir, "src", "main", "resources", "assets", context.id, "icon.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVR42mNkYGD4z0ABYBw1gGE0DBqG" +
        "YTAaBg3AQAAe5gIRf7GNaQAAAABJRU5ErkJggg==",
      "base64"
    )
  );

  writeFile(
    path.join(projectDir, "README.md"),
    `# ${context.name}

Personal Fabric mod generated by mc-mods.

## Commands

- Build: \`./gradlew build\`
- Output jars: \`build/libs\`
- Install with mc-mods: \`mc-mods install ${context.id}\`
`
  );

  writeFile(path.join(projectDir, "LICENSE"), `All rights reserved.\n`);
  writeFile(
    path.join(projectDir, ".gitignore"),
    `.gradle/
build/
out/
.idea/
.vscode/
*.iml
`
  );
  writeFile(
    path.join(projectDir, ".gitattributes"),
    `*.java text eol=lf
*.gradle text eol=lf
*.json text eol=lf
gradlew text eol=lf
`
  );

  writeFile(path.join(projectDir, "gradlew"), gradlewScript(context.gradleVersion), 0o755);
  writeFile(path.join(projectDir, "gradlew.bat"), gradlewBatScript());
}

function gradlewScript(gradleVersion) {
  return `#!/bin/sh
set -eu

GRADLE_VERSION="\${GRADLE_VERSION:-${gradleVersion}}"
GRADLE_USER_HOME="\${GRADLE_USER_HOME:-$HOME/.gradle}"
GRADLE_CACHE="$GRADLE_USER_HOME/mc-mods/gradle-$GRADLE_VERSION"
GRADLE_HOME="$GRADLE_CACHE/gradle-$GRADLE_VERSION"
GRADLE_ZIP="$GRADLE_CACHE/gradle-$GRADLE_VERSION-bin.zip"
GRADLE_URL="https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"

if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
  mkdir -p "$GRADLE_CACHE"

  if [ ! -f "$GRADLE_ZIP" ]; then
    echo "Downloading Gradle $GRADLE_VERSION..."
    if command -v curl >/dev/null 2>&1; then
      curl -fL "$GRADLE_URL" -o "$GRADLE_ZIP"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$GRADLE_ZIP" "$GRADLE_URL"
    else
      echo "curl or wget is required to download Gradle." >&2
      exit 1
    fi
  fi

  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$GRADLE_ZIP" -d "$GRADLE_CACHE"
  elif command -v jar >/dev/null 2>&1; then
    (cd "$GRADLE_CACHE" && jar xf "$GRADLE_ZIP")
  else
    echo "unzip or jar is required to extract Gradle." >&2
    exit 1
  fi
fi

exec "$GRADLE_HOME/bin/gradle" "$@"
`;
}

function gradlewBatScript() {
  return `@echo off
where gradle >nul 2>nul
if %errorlevel%==0 (
  gradle %*
  exit /b %errorlevel%
)
echo Install Gradle or run this project from macOS/Linux/WSL where ./gradlew can bootstrap Gradle.
exit /b 1
`;
}

async function commandInit(parsed) {
  const name = parsed.positionals.join(" ").trim();
  if (!name) {
    throw new Error("init requires a mod name");
  }

  const id = normalizeModId(parsed.options.id ?? name);
  const projectRoot = path.resolve(expandHome(parsed.options.root ?? DEFAULT_PROJECT_ROOT));
  const projectDir = path.resolve(
    expandHome(parsed.options.path ?? path.join(projectRoot, id))
  );
  const gameDir = path.resolve(
    expandHome(parsed.options["game-dir"] ?? detectTLauncherGameDir())
  );
  const detectedMinecraftVersion = detectMinecraftVersion(gameDir);
  const minecraftVersion =
    parsed.options["minecraft-version"] ??
    detectedMinecraftVersion ??
    (await fetchLatestGameVersion().catch(() => DEFAULT_MINECRAFT_VERSION));
  const versions = await resolveFabricVersions({
    minecraftVersion,
    loaderVersion: parsed.options["loader-version"],
    loomVersion: parsed.options["loom-version"]
  });
  const packageName = parsed.options.package ?? packageFromId(id);
  const className = classNameFromId(id);

  ensureEmptyOrMissingDirectory(projectDir);
  writeFabricProject(projectDir, {
    name,
    id,
    packageName,
    className,
    ...versions
  });
  writeModConfig(projectDir, {
    name,
    id,
    version: "0.1.0",
    project: projectDir,
    minecraft: versions.minecraftVersion,
    loader: versions.loaderVersion,
    loom: versions.loomVersion
  });

  if (parsed.options.open !== false && commandExists("code")) {
    spawnSync("code", [projectDir], { stdio: "ignore" });
  }

  console.log(`Created ${projectDir}`);
}

function resolveProjectPath(name, options) {
  if (!name) {
    return process.cwd();
  }

  const direct = path.resolve(expandHome(name));
  if (fs.existsSync(path.join(direct, "mod.yml"))) {
    return direct;
  }

  const root = path.resolve(expandHome(options.root ?? DEFAULT_PROJECT_ROOT));
  const byId = path.join(root, normalizeModId(name));
  if (fs.existsSync(path.join(byId, "mod.yml"))) {
    return byId;
  }

  throw new Error(`Could not find a mod project for "${name}"`);
}

function findBuiltJar(projectDir) {
  const libsDir = path.join(projectDir, "build", "libs");
  if (!fs.existsSync(libsDir)) {
    throw new Error(`No build/libs directory found in ${projectDir}`);
  }

  const jars = fs
    .readdirSync(libsDir)
    .filter((file) => file.endsWith(".jar"))
    .filter((file) => !/-(sources|javadoc|dev|all)\.jar$/.test(file))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

  if (jars.length === 0) {
    throw new Error(`No distributable jar found in ${libsDir}`);
  }

  return path.join(libsDir, jars[0]);
}

function runGradleBuild(projectDir) {
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  let command;
  let args;
  let shell = false;

  if (fs.existsSync(path.join(projectDir, gradlew))) {
    command = process.platform === "win32" ? path.join(projectDir, gradlew) : `./${gradlew}`;
    args = ["build"];
    shell = process.platform === "win32";
  } else if (commandExists("gradle")) {
    command = "gradle";
    args = ["build"];
  } else {
    throw new Error("No Gradle wrapper or global gradle command found");
  }

  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
    shell
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Gradle build failed");
  }
}

function commandBuild(parsed) {
  const name = parsed.positionals.join(" ").trim();
  const projectDir = resolveProjectPath(name, parsed.options);
  const config = readModConfig(projectDir);

  runGradleBuild(projectDir);

  const jarPath = findBuiltJar(projectDir);
  const relativeJar = path.relative(projectDir, jarPath);
  writeModConfig(projectDir, {
    ...config,
    build: relativeJar
  });

  console.log(`Built ${jarPath}`);
}

function resolveBuiltJar(projectDir, config) {
  if (config.build) {
    const configured = path.resolve(projectDir, config.build);
    if (fs.existsSync(configured)) {
      return configured;
    }
  }

  return findBuiltJar(projectDir);
}

async function commandInstall(parsed) {
  const name = parsed.positionals.join(" ").trim();
  const projectDir = resolveProjectPath(name, parsed.options);
  const config = readModConfig(projectDir);
  const jarPath = resolveBuiltJar(projectDir, config);
  const gameDir = path.resolve(
    expandHome(parsed.options["game-dir"] ?? detectTLauncherGameDir())
  );
  const target = await chooseInstallTarget(gameDir, parsed.options);

  fs.mkdirSync(target.path, { recursive: true });
  const destination = path.join(target.path, path.basename(jarPath));
  fs.copyFileSync(jarPath, destination);
  writeModConfig(projectDir, {
    ...config,
    build: path.relative(projectDir, jarPath),
    installed: destination
  });

  console.log(`Installed ${destination}`);
}

async function commandUninstall(parsed) {
  const name = parsed.positionals.join(" ").trim();
  const projectDir = resolveProjectPath(name, parsed.options);
  const config = readModConfig(projectDir);
  const gameDir = path.resolve(
    expandHome(parsed.options["game-dir"] ?? detectTLauncherGameDir())
  );
  const removed = [];

  if (parsed.options.all) {
    const targets = discoverInstallTargets(gameDir);
    const builtName = config.build ? path.basename(config.build) : undefined;
    for (const target of targets) {
      for (const fileName of uninstallFileNames(config, builtName)) {
        const candidate = path.join(target.path, fileName);
        if (fs.existsSync(candidate)) {
          fs.rmSync(candidate);
          removed.push(candidate);
        }
      }
    }
  } else if (config.installed && fs.existsSync(config.installed) && !parsed.options.target) {
    fs.rmSync(config.installed);
    removed.push(config.installed);
  } else {
    const target = await chooseInstallTarget(gameDir, parsed.options);
    const builtName = config.build ? path.basename(config.build) : undefined;
    for (const fileName of uninstallFileNames(config, builtName)) {
      const candidate = path.join(target.path, fileName);
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate);
        removed.push(candidate);
      }
    }
  }

  const nextConfig = { ...config };
  delete nextConfig.installed;
  writeModConfig(projectDir, nextConfig);

  if (removed.length === 0) {
    console.log("No installed jar found");
  } else {
    for (const filePath of removed) {
      console.log(`Removed ${filePath}`);
    }
  }
}

function uninstallFileNames(config, builtName) {
  const names = new Set();
  if (builtName) {
    names.add(builtName);
  }

  if (config.id) {
    names.add(`${config.id}-${config.version ?? "0.1.0"}.jar`);
  }

  return [...names];
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const parsed = parseArgv(rest);

  if (!command || command === "help" || command === "--help" || command === "-h" || parsed.options.help) {
    console.log(usage());
    return;
  }

  if (command === "--version" || command === "-v" || command === "version" || parsed.options.version) {
    console.log(TOOL_VERSION);
    return;
  }

  if (command === "init") {
    await commandInit(parsed);
    return;
  }

  if (command === "build") {
    commandBuild(parsed);
    return;
  }

  if (command === "install") {
    await commandInstall(parsed);
    return;
  }

  if (command === "uninstall") {
    await commandUninstall(parsed);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const api = {
  classNameFromId,
  commandExists,
  detectMinecraftVersion,
  detectTLauncherGameDir,
  discoverInstallTargets,
  findBuiltJar,
  formatModConfig,
  javaReleaseForMinecraft,
  listInstalledVersions,
  main,
  normalizeModId,
  packageFromId,
  parseArgv,
  parseConfigText,
  readProperties,
  resolveFabricVersions,
  slugify,
  targetFromName,
  writeFabricProject
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`mc-mods: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  module.exports = api;
}
