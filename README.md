# MC Mods

CLI for creating and managing personal Fabric mods on this machine.

## Executable

```sh
./build/mc-mods --help
```

The executable lives at `build/mc-mods`.

## Usage

```sh
mc-mods init "My Cool Mod"
mc-mods build my-cool-mod
mc-mods install my-cool-mod
mc-mods uninstall my-cool-mod
```

`init` creates projects under `$HOME/src/mc-mods`, opens them with `code` when available, and writes a `mod.yml`. The install commands detect TLauncher/Minecraft paths from the local TLauncher config when present.
