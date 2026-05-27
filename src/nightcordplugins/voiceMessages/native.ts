import { app } from "electron";
import { readFile, rm } from "fs/promises";
import { basename, normalize } from "path";

export async function readRecording(_: any, filePath: string) {
    filePath = normalize(filePath);
    const filename = basename(filePath);
    const discordBaseDirWithTrailingSlash = normalize(app.getPath("userData") + "/");
    if (!/^\d*recording\.ogg$/.test(filename) || !filePath.startsWith(discordBaseDirWithTrailingSlash)) return null;

    try {
        const buf = await readFile(filePath);
        rm(filePath).catch(() => { });
        return new Uint8Array(buf.buffer);
    } catch {
        return null;
    }
}
