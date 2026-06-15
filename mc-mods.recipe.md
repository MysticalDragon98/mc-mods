# MC Mods

CLI Tool that is used to create and manage personal fabric mods in the current computer

## Folder Structure

The repository must follow the following exact directory structure with no exceptions:

- README.md
- mc-mods.recipe.md
- build/
- .gitignore


## Settings

**Config folder:**

- **Linux:** ~/.config/mc-mods
- **MacOS:** ~/Library/Application Support/mc-mods
- **Windows:** %APPDATA%\mc-mods

## Build

1. Read the context from https://docs.fabricmc.net
2. Analyze how the TLauncher is installed in this machine in order to properly setup the tool
3. Create a cli tool at `./build` that has the following commands
   1. **init {name}:** Create a new project at `{Config Folder}/mods` and opens it with the `code` command if available, and creates a mod.yml in that folder with the mod name
   2. **build [name]:** Builds the mod and generates the jar and updates the mod.yml with the build property pointing to the resulting jar, if name is not provided read the name from the mod.yml in the current folder
   3. **install [name]:** Installs the mod in a minecraft version, if there are more than one version installed let the user pick where to install, if name is not provided read the name from the mod.yml in the current folder
   4. **uninstall [name]:** Uninstalls the mod in a minecraft version, follow the same rules as install command, if name is not provided read the name from the mod.yml in the current folder

## Notes

1. Do not save anything related to the app code outside build/
