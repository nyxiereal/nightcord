/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EventEmitter } from "events";

import { UserAssetType } from "./userAssets";

export const AppEvents = new EventEmitter<{
    appLoaded: [];
    userAssetChanged: [UserAssetType];
    setTrayVariant: ["tray" | "trayUnread" | "traySpeaking" | "trayIdle" | "trayMuted" | "trayDeafened"];
    voiceCallStateChanged: [boolean];
}>();
