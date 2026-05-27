/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./updater";
import "./ipcPlugins";
import "./settings";

import { debounce } from "@shared/debounce";
import { IpcEvents } from "@shared/IpcEvents";
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeTheme, screen, shell, systemPreferences } from "electron";
import monacoHtml from "file://monacoWin.html?minify&base64";
import { FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { open, readdir, readFile, unlink } from "fs/promises";
import { join, normalize } from "path";

import { registerCspIpcHandlers } from "./csp/manager";
import { ALLOWED_PROTOCOLS, DATA_DIR, QUICK_CSS_PATH, SETTINGS_DIR, THEMES_DIR } from "./utils/constants";
import { makeLinksOpenExternally } from "./utils/externalLinks";

const RENDERER_CSS_PATH = join(__dirname, "renderer.css");
const USERPLUGINS_DIR = join(DATA_DIR, "userplugins");

mkdirSync(THEMES_DIR, { recursive: true });
mkdirSync(USERPLUGINS_DIR, { recursive: true });

registerCspIpcHandlers();

import * as ghostNative from "../nightcordplugins/ghostClient/native";
(async () => {
    try {
        await (ghostNative as any).init(null);
    } catch (e) {
        console.warn("[Nightcord] Ghost-server pre-start failed:", e);
    }
})();

export function ensureSafePath(basePath: string, path: string) {
    const normalizedBasePath = normalize(basePath + "/");
    const newPath = join(basePath, path);
    const normalizedPath = normalize(newPath);
    const base = normalizedBasePath.toLowerCase();
    const target = normalizedPath.toLowerCase();
    return target.startsWith(base) ? normalizedPath : null;
}

function readCss() {
    return readFile(QUICK_CSS_PATH, "utf-8").catch(() => "");
}

async function listThemes(): Promise<{ fileName: string; content: string; }[]> {
    try {
        const files = await readdir(THEMES_DIR);
        return await Promise.all(files.map(async fileName => ({ fileName, content: await getThemeData(fileName) })));
    } catch {
        return [];
    }
}

function getThemeData(fileName: string) {
    fileName = fileName.replace(/\?v=\d+$/, "");
    const safePath = ensureSafePath(THEMES_DIR, fileName);
    if (!safePath) return Promise.reject(`Unsafe path ${fileName}`);
    return readFile(safePath, "utf-8");
}


ipcMain.handle(IpcEvents.OPEN_QUICKCSS, () => shell.openPath(QUICK_CSS_PATH));

ipcMain.handle(IpcEvents.OPEN_EXTERNAL, (_, url) => {
    try {
        var { protocol } = new URL(url);
    } catch {
        throw "Malformed URL";
    }
    if (!ALLOWED_PROTOCOLS.includes(protocol))
        throw "Disallowed protocol.";

    shell.openExternal(url);
});

ipcMain.handle(IpcEvents.GET_QUICK_CSS, () => readCss());
ipcMain.handle(IpcEvents.SET_QUICK_CSS, (_, css) =>
    writeFileSync(QUICK_CSS_PATH, css)
);

ipcMain.handle(IpcEvents.GET_THEMES_DIR, () => THEMES_DIR);
ipcMain.handle(IpcEvents.GET_THEMES_LIST, () => listThemes());
ipcMain.handle(IpcEvents.GET_THEME_DATA, (_, fileName) => getThemeData(fileName));
ipcMain.handle(IpcEvents.DELETE_THEME, (_, fileName) => {
    const safePath = ensureSafePath(THEMES_DIR, fileName);
    if (!safePath) return Promise.reject(`Unsafe path ${fileName}`);
    return unlink(safePath);
});
ipcMain.handle(IpcEvents.GET_THEME_SYSTEM_VALUES, () => {
    let accentColor = systemPreferences.getAccentColor?.() ?? "";

    if (accentColor.length && accentColor[0] !== "#") {
        accentColor = `#${accentColor}`;
    }

    return {
        "os-accent-color": accentColor
    };
});

ipcMain.handle(IpcEvents.OPEN_THEMES_FOLDER, () => shell.openPath(THEMES_DIR));
ipcMain.handle(IpcEvents.OPEN_SETTINGS_FOLDER, () => shell.openPath(SETTINGS_DIR));

ipcMain.handle(IpcEvents.INIT_FILE_WATCHERS, ({ sender }) => {
    let quickCssWatcher: FSWatcher | undefined;
    let rendererCssWatcher: FSWatcher | undefined;

    open(QUICK_CSS_PATH, "a+").then(fd => {
        fd.close();
        quickCssWatcher = watch(QUICK_CSS_PATH, { persistent: false }, debounce(async () => {
            sender.postMessage(IpcEvents.QUICK_CSS_UPDATE, await readCss());
        }, 50));
    }).catch(() => { });

    const themesWatcher = watch(THEMES_DIR, { persistent: false }, debounce(() => {
        sender.postMessage(IpcEvents.THEME_UPDATE, void 0);
    }));

    if (IS_DEV) {
        rendererCssWatcher = watch(RENDERER_CSS_PATH, { persistent: false }, async () => {
            sender.postMessage(IpcEvents.RENDERER_CSS_UPDATE, await readFile(RENDERER_CSS_PATH, "utf-8"));
        });
    }

    sender.once("destroyed", () => {
        quickCssWatcher?.close();
        themesWatcher.close();
        rendererCssWatcher?.close();
    });
});

ipcMain.on(IpcEvents.GET_MONACO_THEME, e => {
    e.returnValue = nativeTheme.shouldUseDarkColors ? "vs-dark" : "vs-light";
});

ipcMain.handle(IpcEvents.GET_DESKTOP_SOURCES, async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 }
        });
        return sources.map(s => ({ id: s.id, name: s.name }));
    } catch {
        return [];
    }
});

let monacoWin: BrowserWindow | null = null;

ipcMain.handle(IpcEvents.OPEN_MONACO_EDITOR, async () => {
    if (monacoWin && !monacoWin.isDestroyed()) {
        monacoWin.show();
        monacoWin.focus();
        return;
    }

    monacoWin = new BrowserWindow({
        title: "Nightcord QuickCSS Editor",
        autoHideMenuBar: true,
        darkTheme: true,
        webPreferences: {
            preload: join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    monacoWin.once("closed", () => { monacoWin = null; });

    monacoWin.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                "Content-Security-Policy": ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"]
            }
        });
    });

    makeLinksOpenExternally(monacoWin);

    await monacoWin.loadURL(`data:text/html;base64,${monacoHtml}`);
});

app.on("before-quit", async event => {
    if (monacoWin && !monacoWin.isDestroyed() && !monacoWin.isVisible()) {
        const result = await dialog.showMessageBox({
            type: "question",
            buttons: ["Cancel", "Close Anyway"],
            defaultId: 0,
            title: "QuickCSS Editor Open",
            message: "QuickCSS editor is still open in the background.",
            detail: "Do you want to close Discord anyway? This will also close the QuickCSS editor."
        });

        if (result.response === 1) {
            app.exit();
        }
    }
});

ipcMain.handle(IpcEvents.GET_RENDERER_CSS, () => readFile(RENDERER_CSS_PATH, "utf-8"));

ipcMain.handle(IpcEvents.SET_WINDOW_BACKGROUND_MATERIAL, (event, material: "none" | "acrylic" | "mica" | "tabbed") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    try {

        const canSetMaterial = typeof win.setBackgroundMaterial === "function";

        const canSetVibrancy = typeof win.setVibrancy === "function";

        if (material === "none") {
            win.setBackgroundColor("#36393f");
            if (canSetMaterial) {

                win.setBackgroundMaterial("none");
            }
            if (canSetVibrancy) {

                win.setVibrancy(null);
            }
        } else {
            win.setBackgroundColor("#00000000");
            if (canSetMaterial) {

                win.setBackgroundMaterial(material);
            } else if (canSetVibrancy) {

                win.setVibrancy(material === "acrylic" ? "acrylic" : "under-window");
            }
        }
    } catch (e) {
        console.error("[CreateTheme] setBackgroundMaterial failed:", e);
    }
});

const THUMBAR_ICONS = {
    prev: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAY0lEQVR4nGNgGLngPxIgRy+MzUKpI9DFmKhpGAMDGS4kFCQkuZCY8CXKhaREFEEXkhrrOF1ITvJhYMDjQkYooJqByAZT1UCYocQaTFKyIcZQknMKIdeSnfXIiTCiAblJbGAAADXRMBdqfKdTAAAAAElFTkSuQmCC",
    next: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAZklEQVR4nOXUMQrAMAxDUbXk/ld2lwoMwbGcein5YxMeylLg7MzMqvcZv93Rpd1RE+jhVpBoFV6CHm4FiSqwDHp4dT6qYIaWFwLA9dYCRhCTn5xBTFqoYkCysAKxcOEONvXlp/CfHp4sPAHr7DkEAAAAAElFTkSuQmCC",
    play: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAXElEQVR4nO3UsQoAIAhFUY3+/5dtCiTS9NnQ0N0cOohDRD8Rkcr7ZqEovAUrsAsicAjU8FVwoh6cBk8wDFpwr4LMzHqGwRWCQQuapW54woiCG0agEJiBzKq/zfsN8Hg8AZZiLwgAAAAASUVORK5CYII=",
    pause: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAKklEQVR4nGNgGHGAEV3g/////1EUMDIykiLPRE3XjRo4auCogcPHwBEIAFPvCBxAwtPtAAAAAElFTkSuQmCC",
};

ipcMain.handle(IpcEvents.SET_THUMBAR_BUTTONS, (event, state: "playing" | "paused" | "stopped") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || process.platform !== "win32") return;

    const { nativeImage } = require("electron");

    if (state === "stopped") {
        win.setThumbarButtons([]);
        return;
    }

    const prevIcon = nativeImage.createFromDataURL(`data:image/png;base64,${THUMBAR_ICONS.prev}`);
    const nextIcon = nativeImage.createFromDataURL(`data:image/png;base64,${THUMBAR_ICONS.next}`);
    const midIcon = nativeImage.createFromDataURL(`data:image/png;base64,${state === "playing" ? THUMBAR_ICONS.pause : THUMBAR_ICONS.play}`);
    const midTip = state === "playing" ? "Pause" : "Play";
    const midAction = state === "playing" ? "pause" : "play";

    win.setThumbarButtons([
        {
            tooltip: "Previous",
            icon: prevIcon,
            click() { event.sender.send(IpcEvents.THUMBAR_BUTTON_CLICK, "prev"); }
        },
        {
            tooltip: midTip,
            icon: midIcon,
            click() { event.sender.send(IpcEvents.THUMBAR_BUTTON_CLICK, midAction); }
        },
        {
            tooltip: "Next",
            icon: nextIcon,
            click() { event.sender.send(IpcEvents.THUMBAR_BUTTON_CLICK, "next"); }
        }
    ]);
});

if (IS_DISCORD_DESKTOP) {
    let rendererJsCache: string | null = null;
    ipcMain.on(IpcEvents.PRELOAD_GET_RENDERER_JS, e => {
        if (!rendererJsCache) {
            rendererJsCache = readFileSync(join(__dirname, "renderer.js"), "utf-8");
        }
        e.returnValue = rendererJsCache;
    });
}

ipcMain.handle(IpcEvents.RELAUNCH_APP, async () => {

    if (process.platform === "win32") {
        const { spawn } = await import("node:child_process");
        spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "ignore"
        }).unref();
        app.exit(0);
        return;
    }
    app.relaunch();
    app.exit(0);
});

const OFFICIAL_UPDATE_URL = "https://github.com/nightcordoff/nightcord/releases/latest/download/Nightcord-Installer.exe";

ipcMain.handle(IpcEvents.NIGHTCORD_DOWNLOAD_AND_RUN, async (_, url: string) => {
    if (url !== OFFICIAL_UPDATE_URL) {
        throw new Error("URL de mise à jour non autorisée");
    }

    const https = require("https");
    const os = require("os");
    const path = require("path");
    const fs = require("original-fs");
    const crypto = require("crypto");

    const tmpPath = path.join(os.tmpdir(), "NightcordUpdate-Setup.exe");

    await new Promise<void>((resolve, reject) => {
        https.get(url, (res: any) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(tmpPath);
            res.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
            file.on("error", (err: any) => { fs.unlink(tmpPath, () => { }); reject(err); });
            res.on("error", (err: any) => { fs.unlink(tmpPath, () => { }); reject(err); });
        }).on("error", (err: any) => {
            fs.unlink(tmpPath, () => { });
            reject(err);
        });
    });

    const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: ["Installer la mise à jour", "Annuler"],
        defaultId: 0,
        title: "Mise à jour Nightcord",
        message: "Une mise à jour de Nightcord est disponible.",
        detail: "Voulez-vous installer la mise à jour maintenant ?"
    });
    if (response === 1) return false;

    const { spawn } = require("child_process");
    const child = spawn(tmpPath, [], {
        detached: true,
        stdio: "ignore"
    });
    child.unref();

    return true;
});

ipcMain.handle(IpcEvents.CHECK_VB_CABLE, async () => {
    if (process.platform !== "win32") return { installed: false };
    const { existsSync } = require("fs");

    const p1 = "C:\\Program Files\\VB\\Cable\\VBCABLE_ControlPanel.exe";
    const p2 = "C:\\Program Files (x86)\\VB\\Cable\\VBCABLE_ControlPanel.exe";
    return { installed: existsSync(p1) || existsSync(p2) };
});

ipcMain.handle(IpcEvents.INSTALL_VB_CABLE, async () => {
    if (process.platform !== "win32") return { success: false, error: "Windows only" };

    const { spawn } = require("child_process");
    const os = require("os");
    const path = require("path");
    const fs = require("fs");

    const zipUrl = "https://download.vb-audio.com/Download_Html/VBCABLE_Setup.zip";
    const tmpDir = path.join(os.tmpdir(), "Nightcord-VBCable");
    const tmpZip = path.join(os.tmpdir(), "VBCable_Setup.zip");

    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn("powershell", [
                "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-Command",
                `Invoke-WebRequest -Uri "${zipUrl}" -OutFile "${tmpZip}";` +
                `Expand-Archive -Path "${tmpZip}" -DestinationPath "${tmpDir}" -Force;`
            ]);
            child.on("error", reject);
            child.on("exit", code => {
                if (code === 0) resolve();
                else reject(new Error(`Download/Extract failed with code ${code}`));
            });
        });

        const installerPath = path.join(tmpDir, "VBCABLE_Setup_x64.exe");
        if (!fs.existsSync(installerPath)) {
            return { success: false, error: "Installer not found after extraction" };
        }

        const { response } = await dialog.showMessageBox({
            type: "info",
            buttons: ["Installer VB-Cable", "Annuler"],
            defaultId: 0,
            title: "Installation VB-Cable",
            message: "VB-Cable doit être installé avec les droits administrateur.",
            detail: "Une fenêtre UAC va s'ouvrir pour confirmer l'installation."
        });
        if (response === 1) return { success: false, error: "Annulé par l'utilisateur" };

        await new Promise<void>((resolve, reject) => {
            const child = spawn("powershell", [
                "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-Command",
                `Start-Process -FilePath "${installerPath}" -ArgumentList "/SILENT" -Verb RunAs -Wait;`
            ]);
            child.on("error", reject);
            child.on("exit", code => {
                if (code === 0) resolve();
                else reject(new Error(`Install failed with code ${code}`));
            });
        });

        return { success: true };
    } catch (err: any) {
        console.error("[Nightcord] VBCable install failed:", err);
        return { success: false, error: "Installation failed: " + (err.message || err) };
    } finally {
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
});
