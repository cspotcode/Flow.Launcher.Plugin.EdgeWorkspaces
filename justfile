set windows-shell := ["pwsh", "-noprofile", "-nologo", "-c"]

Name := `deno eval 'console.log(JSON.parse(Deno.readTextFileSync("plugin.json")).Name)'`
Repo := `deno eval 'console.log(JSON.parse(Deno.readTextFileSync("plugin.json")).Website.match(/github.com\/.+?\/(.+)/)[1])'`

InstalledVersion := '0.0.5'
InstallDir := "~/AppData/Roaming/FlowLauncher/Plugins/" + Name + '-' + InstalledVersion

export PATH := source_dir() + '/tools/node_modules/.bin' + PATH_VAR_SEP + env_var('PATH')

help:
    just --list --unsorted

init-tools:
    cd tools && deno install

codegen: init-tools
    buf generate

# Pack .exe
compile:
    deno compile --no-check -A --target x86_64-pc-windows-msvc -o plugin.exe src/main.ts
compile-ci:
    deno compile --no-check -A --target x86_64-pc-windows-msvc --frozen -o plugin.exe src/main.ts

# Install locally into your Flow Launcher
install: compile
    mkdir -f "{{InstallDir}}/Images"
    cp -recurse -force plugin.exe,plugin.json,Images "{{InstallDir}}"

# Package .zip on CI for release
pack: compile-ci
    zip -r {{Repo}}.zip plugin.exe plugin.json Images

# Test plugin with a query
query arg:
    deno run -A ./src/main.ts '{"method": "query", "parameters": ["{{arg}}"]}'

e:
    explorer (get-item "{{InstallDir}}").fullname

# Test *installed* plugin with a query. NOTE: currently hardcoded version number, needs to be updated every time you use it
query-installed arg:
    & "{{InstallDir}}/plugin.exe" '{"method": "query", "parameters": ["{{arg}}"]}'