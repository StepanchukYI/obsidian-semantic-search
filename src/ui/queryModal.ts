import { App, Editor, Modal, normalizePath, Notice, OpenViewState, PaneType, renderResults, SearchResult, setIcon, SplitDirection, TFile, WorkspaceLeaf } from "obsidian";
import { semanticSearchSettings } from "src/settings/settings";
import { Suggestion, WASMSuggestion } from "./suggestion";

import * as plugin from "../../pkg/obsidian_rust_plugin.js";

export class QueryModal extends Modal {
  settings: semanticSearchSettings;
  estimatedCost = 0;
  timerId: number;
  delay = 200;

  constructor(app: App, settings: semanticSearchSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen(): void {
      const contentEl = this.modalEl;
      this.modalEl.removeClass("modal");
      this.modalEl.addClass("prompt");
      this.modalEl.querySelector(".modal-close-button")?.remove();

      const inputContainer = contentEl.createDiv({cls: "prompt-input-container"})
      const input = inputContainer.createEl("input", {cls: "prompt-input"});

      const estimate_container = contentEl.createDiv({cls: "prompt-instructions"});
      const estimate_text = estimate_container.createDiv({cls: "prompt-instruction"});
	  if (this.settings.costEstimation) {
		  estimate_text.setText("Estimated cost of query: $0");
		  input.addEventListener("input", (e) => {
			  this.debounce(() => this.update_query_cost_estimate(e, estimate_text), this.delay);
		  })
	  } else {
		  estimate_text.setText("Cost estimation is disabled");
	  }

      const button = inputContainer.createEl("button", {text: "Submit", cls: "ss-query-submit-button"});
      const resultsDiv = contentEl.createDiv({cls: "prompt-results"});

      // Function to handle query submission
      const submitQuery = async () => {
        resultsDiv.replaceChildren();
        setIcon(resultsDiv, "loader");
        const suggestions: Suggestion[] = await this.getSuggestions(input.value);
        resultsDiv.replaceChildren();
        suggestions.forEach(suggestion => {
          this.renderSuggestion(suggestion, resultsDiv);
        })
      };

      // Add click handler for button
      button.onclick = submitQuery;

      // Add Enter key support
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitQuery();
        }
      });
  }

  update_query_cost_estimate(e: Event, estimate_text: HTMLElement) {
    if (e.target) {
      const input = e.target as HTMLInputElement;
      this.estimatedCost = plugin.get_query_cost_estimate(input.value);
    }
    estimate_text.setText("Estimated cost of query: $" + this.estimatedCost);
  }

  debounce(fn: Function, delay_in_ms: number) {
    clearTimeout(this.timerId);
    this.timerId = setTimeout(fn, delay_in_ms);
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }

  // Returns all available suggestions.
  async getSuggestions(query: string): Promise<Suggestion[]> {
    console.log("Getting suggestions for query:", query);
    const wasmSuggestions: WASMSuggestion[] = await plugin.get_suggestions(this.app, this.settings, query);
    console.log("WASM suggestions received:", wasmSuggestions);

    const suggestions: Suggestion[] = wasmSuggestions.map(wasmSuggestion => new Suggestion(this.app, wasmSuggestion, this.settings.sectionDelimeterRegex));

    // Wait for all suggestions to load their file and heading data
    await Promise.all(suggestions.map(async suggestion => {
      await suggestion.addSuggestionFile().addSuggestionHeading();
      console.log("Suggestion loaded:", { name: suggestion.name, header: suggestion.header, file: suggestion.file?.path, match: suggestion.match });
    }));

    console.log("All suggestions loaded:", suggestions);
    return suggestions;
  }

  // Renders each suggestion item.
  renderSuggestion(suggestion: Suggestion, el: HTMLElement) {
    console.log("Rendering suggestion:", suggestion);
    const resultContainer = el.createDiv({cls: ["suggestion-item", "ss-suggestion-item"]})
    resultContainer.onclick = async () => await this.onChooseSuggestion(suggestion);

    // Simple, clean display
    if (suggestion.file) {
      // File name (clean, no extra suffixes)
      const fileName = suggestion.file.name.replace('.md', '');
      const fileNameEl = resultContainer.createDiv({cls: "suggestion-filename"});
      fileNameEl.setText(fileName);

      // Header content (if available)
      if (suggestion.header && suggestion.header.trim()) {
        const headerEl = resultContainer.createDiv({cls: "suggestion-header"});
        headerEl.setText(suggestion.header);
      }

      // File path (clean)
      const pathEl = resultContainer.createDiv({cls: "suggestion-path"});
      const path = this.getPathDisplayText(suggestion.file);
      pathEl.setText(path);
    } else {
      // Fallback for missing file
      resultContainer.createDiv({ text: suggestion.name, cls: "suggestion-fallback" });
    }
  }

  renderContent(
    parentEl: HTMLElement,
    content: string,
    match: SearchResult,
    offset?: number,
  ): HTMLDivElement {
    const contentEl = parentEl.createDiv({
      cls: 'suggestion-content',
    });

    const titleEl = contentEl.createDiv({
      cls: 'suggestion-title',
    });

    renderResults(titleEl, content, match, offset);

    return contentEl;
  }

  renderPath(
    parentEl: HTMLElement,
    file: TFile,
    match: SearchResult,
  ): void {
    if (parentEl && file) {
      const isRoot = file.parent.isRoot();
      let hidePath = isRoot;

      if (!hidePath) {
        const wrapperEl = parentEl.createDiv({ cls: 'suggestion-note' });
        const path = this.getPathDisplayText(file);

        const iconEl = wrapperEl.createSpan();
        setIcon(iconEl, 'folder');

        const pathEl = wrapperEl.createSpan();
        renderResults(pathEl, path, match);
      }
    }
  }

  getPathDisplayText(
    file: TFile,
  ): string {
    let text = '';

    if (file) {
      const { parent } = file;
      const dirname = parent.name;
      const isRoot = parent.isRoot();
      text = isRoot ? `${file.name}` : normalizePath(`${dirname}/${file.name}`);
    }

    return text;
  }

  // Perform action on the selected suggestion.
  async onChooseSuggestion(suggestion: Suggestion) {
    console.log("Choosing suggestion:", suggestion);
    console.log("Suggestion position data:", suggestion.pos);
    this.close();
    const isMatch = (candidateLeaf: WorkspaceLeaf) => {
      let val = false;

      if (candidateLeaf?.view) {
        val = candidateLeaf.view.file === suggestion.file;
      }

      return val;
    };
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves(leaf => leaves.push(leaf));
    const matchingLeaf = leaves.find(isMatch);

    // Only set cursor position if we have valid position data
    const eState: any = {
      active: true,
      focus: true,
    };

    // Add position data only if it exists and is valid
    if (suggestion.pos?.start && suggestion.pos?.end) {
      eState.startLoc = suggestion.pos.start;
      eState.endLoc = suggestion.pos.end;
      eState.cursor = {
        from: {line: suggestion.pos.start.line, ch: suggestion.pos.start.col },
        to: {line: suggestion.pos.start.line, ch: suggestion.pos.start.col },
      };
    }

    if (matchingLeaf === undefined) {
      if (suggestion.file) {
        await this.openFileInLeaf(suggestion.file, "tab", "vertical", {
          active: true,
          eState
        })
      }
    } else {
      this.app.workspace.setActiveLeaf(matchingLeaf, {focus: true});
      matchingLeaf.view.setEphemeralState(eState);
    }
  }

  async openFileInLeaf(file: TFile, navType: PaneType, splitDirection: SplitDirection = "vertical", openState: OpenViewState) {
    const { workspace } = this.app;
    const leaf = navType === "split" ? workspace.getLeaf(navType, splitDirection) : workspace.getLeaf(navType)
    await leaf.openFile(file, openState);
  }
}

export class LinkSuggestQueryModal extends QueryModal {
  editor: Editor;

  constructor(app: App, settings: semanticSearchSettings, editor: Editor) {
    super(app, settings);
    this.editor = editor;
  }

  onOpen(): void {
    const selection = this.editor.getSelection();
    if (selection === "") {
      new Notice("No selection found");
      this.close();
      return
    }

    super.onOpen();
    const input: HTMLInputElement | null = this.modalEl.querySelector(".prompt-input");

    if (input) {
      input.value = this.editor.getSelection();
      // trigger the input event which calculates estimated cost
      input.dispatchEvent(new InputEvent("input"));
    }
  }

  async onChooseSuggestion(suggestion: Suggestion) {
    this.close();
    const linkPath = normalizePath(encodeURI(suggestion.file?.path + "#" + suggestion.header));
    const textToLink = this.editor.getSelection();
    this.editor.replaceSelection(`[${textToLink}](${linkPath})`);
  }
}
