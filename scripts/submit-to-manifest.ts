// Assumes https://github.com/Flow-Launcher/Flow.Launcher.PluginsManifest is cloned locally

import * as path from 'jsr:@std/path';

const __dirname = import.meta.dirname!;

const pluginPath = path.resolve(__dirname, '../plugin.json');
const plugin = JSON.parse(await Deno.readTextFile(pluginPath));

let repo: string;
let org: string;
const m = plugin.Website.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
if(m) {
    [, org, repo] = m;
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
    UrlDownload: `${plugin.Website}/releases/download/v${plugin.Version}/${repo}.zip`,
    UrlSourceCode: `${plugin.Website}`,
    IcoPath: `https://cdn.jsdelivr.net/gh/${org}/${repo}@main/Images/app.png`
};

const manifestPath = path.resolve(__dirname, `../Flow.Launcher.PluginsManifest/plugins/${plugin.Name}-${plugin.ID}.json`);

await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
