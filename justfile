set windows-shell := ["pwsh", "-noprofile", "-nologo", "-c"]

Name := `deno eval 'console.log(JSON.parse(Deno.readTextFileSync("plugin.json")).Name)'`

help:
    just --list --unsorted

# Pack .exe
compile:
    deno compile --no-check -A -o plugin.exe main.ts

# Install locally into your Flow Launcher
install: compile
    mkdir -f "~/AppData/Roaming/FlowLauncher/Plugins/{{Name}}/Images"
    cp -recurse -force plugin.exe,plugin.json,Images "~/AppData/Roaming/FlowLauncher/Plugins/{{Name}}/"
