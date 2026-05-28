import { EmbeddingProvider } from './types';
import { requestUrl } from 'obsidian';

const MODEL_DIMENSIONS: Record<string, number> = {
	'text-embedding-3-small': 1536,
	'text-embedding-3-large': 3072,
	'text-embedding-ada-002': 1536,
};

export class OpenAIProvider implements EmbeddingProvider {
	private apiKey: string;
	private model: string;

	constructor(apiKey: string, model: string = 'text-embedding-3-small') {
		this.apiKey = apiKey;
		this.model = model;
	}

	async embed(texts: string[]): Promise<number[][]> {
		return this.doEmbed(texts);
	}

	async embedQuery(texts: string[]): Promise<number[][]> {
		return this.embed(texts);
	}

	private async doEmbed(texts: string[]): Promise<number[][]> {
		const resp = await requestUrl({
			url: 'https://api.openai.com/v1/embeddings',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				input: texts,
				model: this.model,
			}),
		});

		const data = resp.json;
		if (data.data && Array.isArray(data.data)) {
			return data.data
				.sort((a: any, b: any) => a.index - b.index)
				.map((d: any) => d.embedding);
		}
		throw new Error(`Unexpected OpenAI response: ${JSON.stringify(data).slice(0, 200)}`);
	}

	getDimension(): number {
		return MODEL_DIMENSIONS[this.model] ?? 1536;
	}

	getName(): string {
		return `openai:${this.model}`;
	}

	isReady(): boolean {
		return this.apiKey.length > 0;
	}
}
