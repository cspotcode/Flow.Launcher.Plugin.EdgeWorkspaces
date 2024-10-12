set windows-shell := ["pwsh", "-noprofile", "-nologo", "-c"]

Name := `deno eval 'console.log(JSON.parse(Deno.readTextFileSync("plugin.json")).Name)'`
Repo := `deno eval 'console.log(JSON.parse(Deno.readTextFileSync("plugin.json")).Website.match(/github.com\/.+?\/(.+)/)[1])'`

help:
    just --list --unsorted

# Pack .exe
compile:
    deno compile --no-check -A --target x86_64-pc-windows-msvc -o plugin.exe main.ts
compile-ci:
    deno compile --no-check -A --target x86_64-pc-windows-msvc -o plugin.exe main.ts --frozen

# Install locally into your Flow Launcher
install: compile
    mkdir -f "~/AppData/Roaming/FlowLauncher/Plugins/{{Name}}/Images"
    cp -recurse -force plugin.exe,plugin.json,Images "~/AppData/Roaming/FlowLauncher/Plugins/{{Name}}/"

# Package .zip on CI for release
pack: compile-ci
    zip -r {{Repo}}.zip plugin.exe plugin.json Images

# Test plugin with a query
query arg:
    deno run -A ./main.ts '{"method": "query", "parameters": ["{{arg}}"]}'