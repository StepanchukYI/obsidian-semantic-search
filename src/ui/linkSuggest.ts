import { App, debounce, Debouncer, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, normalizePath, renderResults, SearchResult, setIcon, TFile } from "obsidian";
import { semanticSearchSettings } from "src/settings/settings";
import { Suggestion, WASMSuggestion } from "./suggestion";

import * as plugin from "../../pkg/obsidian_rust_plugin.js";

export class LinkSuggest extends EditorSuggest<Suggestion> {
    app: App;
    settings: semanticSearchSettings;
    debouncer: Debouncer<[EditorSuggestContext, (suggestions: Suggestion[]) => void], void> | undefined;

    constructor(app: App, settings: semanticSearchSettings) {
      super(app);
      this.app = app;
      this.settings = settings;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
      const line = editor.getLine(cursor.line);
      // using "{{}}" as a way to trigger this suggest
      const rx = /\{\{.*\}\}/;
      const matchedIdx = line.search(rx);

      if (matchedIdx == -1) {
        return null;
      }
      // cursor is not within braces
      if (cursor.ch <= matchedIdx + 1) {
        return null
      }

      return {
        start: {
          ch: matchedIdx, // For multi-word completion
          line: cursor.line,
        },
        end: {
          ch: cursor.ch + 2,
          line: cursor.line,
        },
        query: line.substring(matchedIdx+2, cursor.ch)
      };
    }

    async getSuggestions(context: EditorSuggestContext): Promise<Suggestion[]> {
      if (this.debouncer !== undefined) {
        this.debouncer.cancel();
      }

      this.debouncer = debounce(async (context: EditorSuggestContext, cb: (suggestions: Suggestion[]) => void) => {
        const query = context.query;
        console.log(query);

        if (query === "") {
          return []
        }

        const wasmSuggestions: WASMSuggestion[] = await plugin.get_suggestions(this.app, this.settings, query);
        const suggestions: Suggestion[] = wasmSuggestions.map(wasmSuggestion => new Suggestion(this.app, wasmSuggestion, this.settings.sectionDelimeterRegex));

        // Wait for all suggestions to load their file and heading data
        await Promise.all(suggestions.map(async suggestion => {
          await suggestion.addSuggestionFile().addSuggestionHeading();
        }));

        cb(suggestions);
      }, 500, true);


      return new Promise((resolve) => {
        if (this.debouncer !== undefined) {
          this.debouncer(context, (suggestions) => {
            resolve(suggestions)
          })
        }
      })
    }

    renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
      const resultContainer = el.createDiv({cls: ["suggestion-item", "mod-complex" ]})
	  suggestion.renderIntoHTML(resultContainer);
    }

    selectSuggestion(suggestion: Suggestion, evt: MouseEvent | KeyboardEvent): void {
      const linkPath = normalizePath(encodeURI(suggestion.file?.path + "#" + suggestion.header));
      const textToLink = this.context?.query;
      this.context?.editor.replaceRange(`[${textToLink}](${linkPath})`, this.context.start, this.context.end);
    }
}


