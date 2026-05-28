export interface EmbeddingProvider {
	embed(texts: string[]): Promise<number[][]>;
	embedQuery(texts: string[]): Promise<number[][]>;
	getDimension(): number;
	getName(): string;
	isReady(): boolean;
}

