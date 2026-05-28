import { EmbeddingProvider } from './types';
import { pipeline, Pipeline } from '@xenova/transformers';

const SUPPORTED_MODELS: Record<string, { dims: number; id: string }> = {
	'multilingual-MiniLM-L12': { dims: 384, id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' },
	'all-MiniLM-L6': { dims: 384, id: 'Xenova/all-MiniLM-L6-v2' },
};

export class LocalProvider implements EmbeddingProvider {
	private extractor: Pipeline | null = null;
	private modelKey: string;
	private ready = false;

	constructor(modelKey: string = 'multilingual-MiniLM-L12') {
		this.modelKey = modelKey;
	}

	async init(onProgress?: (msg: string) => void): Promise<void> {
		const model = SUPPORTED_MODELS[this.modelKey];
		if (!model) throw new Error(`Unknown model: ${this.modelKey}`);

		onProgress?.(`Loading model ${model.id}...`);
		this.extractor = await pipeline('feature-extraction', model.id, {
			progress_callback: (p: any) => {
				if (p.status === 'progress' && p.progress) {
					onProgress?.(`Downloading ${p.file}: ${Math.round(p.progress)}%`);
				}
			},
		});
		this.ready = true;
		onProgress?.('Model loaded');
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (!this.extractor) throw new Error('Provider not initialized');

		const results: number[][] = [];
		for (let i = 0; i < texts.length; i += 8) {
			const chunk = texts.slice(i, i + 8);
			const output = await this.extractor(chunk, { pooling: 'mean', normalize: true });
			const data = output.tolist();
			for (const row of data) {
				results.push(Array.isArray(row[0]) ? row.flat() : row as number[]);
			}
		}
		return results;
	}

	async embedQuery(texts: string[]): Promise<number[][]> {
		return this.embed(texts);
	}

	getDimension(): number {
		return SUPPORTED_MODELS[this.modelKey]?.dims ?? 384;
	}

	getName(): string {
		return `local:${this.modelKey}`;
	}

	isReady(): boolean {
		return this.ready;
	}
}
