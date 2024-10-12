import { join, basename } from "jsr:@std/path";
import { existsSync } from "jsr:@std/fs";

enum EdgeVersion {
    Dev,
    Beta,
    Canary,
    Stable
}

export interface EdgeInstance {
    ExecutablePath: string;
    AppData: string;
    UserData: string;
    IconPath: string;
    Version: EdgeVersion;
}

export async function discoverEdgeInstances(): Promise<EdgeInstance[]> {
    const edgeInstances: EdgeInstance[] = [];

    const _programFilesx86Path = Deno.env.get('ProgramFiles(x86)') || '';
    const _userAppDataPath = Deno.env.get("LOCALAPPDATA") || "";

    const MicrosoftEdgePath = join(_programFilesx86Path, "Microsoft");
    const paths = [];

    for await (const dirEntry of Deno.readDir(MicrosoftEdgePath)) {
        if (dirEntry.isDirectory && (dirEntry.name.endsWith("Dev") || dirEntry.name.endsWith("Beta") || dirEntry.name.endsWith("Edge"))) {
            paths.push(join(MicrosoftEdgePath, dirEntry.name));
        }
    }

    const canaryPath = join(_userAppDataPath, "Microsoft", "Edge SxS");
    if (existsSync(canaryPath)) {
        paths.push(canaryPath);
    }

    for (const path of paths) {
        const directoryName = basename(path);
        const executablePath = join(path, "Application", "msedge.exe");
        const appDataPath = join(_userAppDataPath, "Microsoft", directoryName);
        const userDataPath = join(appDataPath, "User Data");

        if (existsSync(executablePath) && existsSync(appDataPath)) {
            let edgeVersion: EdgeVersion;
            let iconPath = join(path, "Application");

            for await (const dirEntry of Deno.readDir(iconPath)) {
                if (dirEntry.isDirectory) {
                    iconPath = join(iconPath, dirEntry.name, "VisualElements");
                    break;
                }
            }

            if (directoryName.includes("Dev")) {
                edgeVersion = EdgeVersion.Dev;
                iconPath = join(iconPath, "SmallLogoDev.png");
            } else if (directoryName.includes("Beta")) {
                edgeVersion = EdgeVersion.Beta;
                iconPath = join(iconPath, "SmallLogoBeta.png");
            } else if (directoryName.includes("SxS")) {
                edgeVersion = EdgeVersion.Canary;
                iconPath = join(iconPath, "SmallLogoCanary.png");
            } else {
                edgeVersion = EdgeVersion.Stable;
                iconPath = join(iconPath, "SmallLogo.png");
            }

            const instance: EdgeInstance = {
                ExecutablePath: executablePath,
                AppData: appDataPath,
                UserData: userDataPath,
                IconPath: iconPath,
                Version: edgeVersion
            };
            edgeInstances.push(instance);
        }
    }
    return edgeInstances;
}
