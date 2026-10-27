import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { WebViewHandle } from "@zenbu-labs/pixel";
import { bundledAsset } from "../assets";
import { grabPlugin } from "./context";

const CHANNEL = "grab";
const PLUGIN = "terminal-browser";
const SCRIPT_ASSET = "react-grab/index.global.js";
const BINDING = "__pixelEmit";
const REGION_PADDING = 8;

let librarySource: string | null = null;
function reactGrabLibrary(): string {
  if (librarySource) return librarySource;
  const file = bundledAsset(SCRIPT_ASSET);
  if (!file) throw new Error(`react-grab bundle missing: assets/${SCRIPT_ASSET} (run pnpm install)`);
  librarySource = `${fs.readFileSync(file, "utf8")}\n;undefined;`;
  return librarySource;
}

const REGISTER_PLUGIN = grabPlugin({ channel: CHANNEL, plugin: PLUGIN, binding: BINDING, regionPadding: REGION_PADDING });

const COPY_ON_SELECT_BINDING = "__terminalBrowserCopyOnSelect";
const COPY_ON_SELECT_WORLD_ID = 1013;
const COPY_ON_SELECT_WORLD = "terminal-browser-copy-on-select";

const COPY_ON_SELECT_WATCHER = `;(() => {
  let last = "";
  document.addEventListener("mouseup", (e) => {
    if (!e.isTrusted) return;
    setTimeout(() => {
      const sel = window.getSelection && window.getSelection();
      const text = sel ? String(sel).trim() : "";
      if (text && text !== last && typeof window.${COPY_ON_SELECT_BINDING} === "function") {
        last = text;
        window.${COPY_ON_SELECT_BINDING}(text);
      }
    }, 0);
  });
})();`;

let preloadFile: string | null = null;
export function reactGrabPreloadPath(copyOnSelect = false): string {
  if (!preloadFile) {
    const early = `window.__REACT_GRAB_DISABLED__ = true;\n${reactGrabLibrary()}`;
    const copyOnSelectInjection = copyOnSelect
      ? `
  webFrame.setIsolatedWorldInfo(${COPY_ON_SELECT_WORLD_ID}, { name: ${JSON.stringify(COPY_ON_SELECT_WORLD)} });
  void webFrame.executeJavaScriptInIsolatedWorld(${COPY_ON_SELECT_WORLD_ID}, [{ code: ${JSON.stringify(COPY_ON_SELECT_WATCHER)} }]);`
      : "";
    preloadFile = path.join(app.getPath("userData"), "terminal-browser-react-grab-preload.js");
    fs.writeFileSync(
      preloadFile,
      `if (process.isMainFrame) {
  const { webFrame } = require("electron");
  void webFrame.executeJavaScript(${JSON.stringify(early)});${copyOnSelectInjection}
}
`,
    );
  }
  return preloadFile;
}

export class CopyOnSelect {
  private listening = false;
  private readonly onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Runtime.bindingCalled") return;
    const call = params as { name: string; payload: string };
    if (call.name === COPY_ON_SELECT_BINDING) this.hooks.copied(call.payload);
  };

  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: { copied(text: string): void },
  ) {}

  async enable(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.view.cdp("Runtime.addBinding", { name: COPY_ON_SELECT_BINDING, executionContextName: COPY_ON_SELECT_WORLD });
    this.view.webContents.debugger.on("message", this.onMessage);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    try {
      this.view.webContents.debugger.removeListener("message", this.onMessage);
    } catch {}
  }
}

const ACTIVATE_SCRIPT = `(() => {
  const api = (window.__REACT_GRAB__ ??= globalThis.__REACT_GRAB_MODULE__?.init({ telemetry: false }));
  if (!api) return "missing";
  (${REGISTER_PLUGIN})(api);
  api.activate();
  return "active";
})()`;

const DEACTIVATE_SCRIPT = "window.__REACT_GRAB__?.deactivate()";

export interface GrabRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type GrabMessage =
  | { type: "active"; active: boolean }
  | { type: "selected"; content: string; region: GrabRegion | null };

export interface GrabHooks {
  selected(content: string, region: GrabRegion | null): void;
  changed(): void;
}

export class Grab {
  private _active = false;
  get active(): boolean {
    return this._active;
  }
  private set active(value: boolean) {
    if (this._active === value) return;
    this._active = value;
    this.hooks.changed();
  }
  private readonly onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method === "Page.frameNavigated") {
      const frame = (params as { frame?: { parentId?: string } }).frame;
      if (!frame?.parentId) this.active = false;
      return;
    }
    if (method !== "Runtime.bindingCalled") return;
    const call = params as { name: string; payload: string };
    if (call.name !== BINDING) return;
    try {
      const message = JSON.parse(call.payload) as { channel: string; data: GrabMessage };
      if (message.channel === CHANNEL) this.receive(message.data);
    } catch {}
  };
  private listening = false;

  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: GrabHooks,
  ) {}

  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.view.cdp("Runtime.addBinding", { name: BINDING });
    this.view.webContents.debugger.on("message", this.onMessage);
  }

  private runJs(source: string): Promise<unknown> {
    return this.view.webContents.executeJavaScript(source, true);
  }

  async activate(): Promise<void> {
    await this.listen();
    const loaded = await this.runJs("Boolean(window.__REACT_GRAB__)");
    if (!loaded) await this.runJs(reactGrabLibrary());
    const result = await this.runJs(ACTIVATE_SCRIPT);
    if (result !== "active") {
      throw new Error("react-grab failed to start");
    }
    this.active = true;
  }

  async deactivate(): Promise<void> {
    this.active = false;
    await this.runJs(DEACTIVATE_SCRIPT).catch(() => {});
  }

  dispose() {
    if (!this.listening) return;
    this.listening = false;
    try {
      this.view.webContents.debugger.removeListener("message", this.onMessage);
    } catch {}
  }

  private receive(message: GrabMessage) {
    if (message.type === "active") {
      if (!message.active) this.active = false;
      return;
    }
    if (message.type === "selected") {
      if (!this.active) return;
      this.active = false;
      this.hooks.selected(message.content, message.region ?? null);
      void this.deactivate();
    }
  }
}
