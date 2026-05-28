import { EmbeddingProvider } from './types';
import { requestUrl } from 'obsidian';

export class OllamaProvider implements EmbeddingProvider {
	private host: string;
	private model: string;
	private apiKey: string;

	constructor(host: string = 'localhost:11434', model: string = 'nomic-embed-text', apiKey: string = '') {
		this.host = host;
		this.model = model;
		this.apiKey = apiKey;
	}

	async embed(texts: string[]): Promise<number[][]> {
		return this.doEmbed(texts);
	}

	async embedQuery(texts: string[]): Promise<number[][]> {
		// BGE-M3 works well without query prefix for multilingual content
		// Prefix helps short English queries but hurts Russian/technical queries
		return this.doEmbed(texts);
	}

	private async doEmbed(texts: string[]): Promise<number[][]> {
		const url = `http://${this.host}/api/embed`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}

		const resp = await requestUrl({
			url,
			method: 'POST',
			headers,
			body: JSON.stringify({ model: this.model, input: texts }),
		});

		const data = resp.json;
		if (data.embeddings) {
			return data.embeddings;
		}
		throw new Error(`Unexpected Ollama response: ${JSON.stringify(data).slice(0, 200)}`);
	}

	getDimension(): number {
		if (this.model.includes('bge-m3')) return 1024;
		if (this.model.includes('nomic')) return 768;
		if (this.model.includes('mxbai')) return 1024;
		return 768;
	}

	getName(): string {
		return `ollama:${this.host}/${this.model}`;
	}

	isReady(): boolean {
		return true;
	}
}
