// Assumes https://github.com/Flow-Launcher/Flow.Launcher.PluginsManifest is cloned locally

import * as path from 'jsr:@std/path';

const __dirname = import.meta.dirname!;

const pluginPath = path.resolve(__dirname, '../plugin.json');
const plugin = JSON.parse(await Deno.readTextFile(pluginPath));

let name: string;
const m = plugin.Website.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
if(m) {
    name = m[1];
} else {
    throw new Error(`Couldn't parse plugin name from website`);
}

const manifest = {
    ID: plugin.ID,
    Name: plugin.Name,
    Description: plugin.Description,
    Author: plugin.Author,
    Version: plugin.Version,
    Language: plugin.Language,
    Website: plugin.Website,
    urlDownload: `https://github.com/cspotcode/${name}/releases/download/v${plugin.Version}/${name}.zip`,
    urlSourceCode: `https://github.com/cspotcode/${name}`,
    icoPath: `https://cdn.jsdelivr.net/gh/cspotcode/${name}@main/Images/app.png`
};

const manifestPath = path.resolve(__dirname, `../Flow.Launcher.PluginsManifest/plugins/${plugin.Name}-${plugin.ID}.json`);

await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
