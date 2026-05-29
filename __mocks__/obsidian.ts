// Minimal stub for the 'obsidian' package so vitest can import plugin modules
export class TFile {
	path = '';
	extension = 'md';
	stat = { mtime: 0, ctime: 0, size: 0 };
}

export class Vault {}
export class App {
	vault = new Vault();
	metadataCache = { getFileCache: () => null };
}
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class Notice {}
export class SuggestModal {}
export class ItemView {}
export class WorkspaceLeaf {}
export class TAbstractFile {}
export class TFolder {}
