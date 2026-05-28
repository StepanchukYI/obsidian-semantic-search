import { EmbeddingProvider } from './types';
import { requestUrl } from 'obsidian';

export class TEIProvider implements EmbeddingProvider {
	private host: string;
	private port: number;
	private apiKey: string;
	private dims: number;

	constructor(host: string = 'localhost', port: number = 8082, apiKey: string = '') {
		this.host = host;
		this.port = port;
		this.apiKey = apiKey;
		this.dims = 1024; // bge-m3 default
	}

	async embed(texts: string[]): Promise<number[][]> {
		return this.doEmbed(texts);
	}

	async embedQuery(texts: string[]): Promise<number[][]> {
		const prefixed = texts.map(t => `Represent this sentence for searching relevant passages: ${t}`);
		return this.doEmbed(prefixed);
	}

	private async doEmbed(texts: string[]): Promise<number[][]> {
		const url = `http://${this.host}:${this.port}/embed`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}

		const resp = await requestUrl({
			url,
			method: 'POST',
			headers,
			body: JSON.stringify({ inputs: texts }),
		});

		const data = resp.json;
		if (Array.isArray(data) && data.length > 0) {
			if (data[0].embedding) {
				return data.map((d: any) => d.embedding);
			}
			return data;
		}
		throw new Error(`Unexpected TEI response format: ${JSON.stringify(data).slice(0, 200)}`);
	}

	getDimension(): number {
		return this.dims;
	}

	getName(): string {
		return `tei:${this.host}:${this.port}`;
	}

	isReady(): boolean {
		return true;
	}
}
