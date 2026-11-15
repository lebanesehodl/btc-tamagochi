/** Stable boundary between chain ingestion and the shared world. Owned by Bitcoin. */
export interface BlockMetadata {
  id: string;
  height: number;
  timestamp: number;
  previousblockhash: string | null;
}

export interface BlockSource {
  getTipHash(): Promise<string>;
  getBlockByHash(hash: string): Promise<BlockMetadata>;
  getHashByHeight(height: number): Promise<string>;
}

export interface PantryItem {
  id: string;
  name: string;
  reaction: "happy" | "curious" | "sleepy";
}

export interface BlockMeal {
  blockHash: string;
  height: number;
  foodId: string;
}

export interface ChainTransition {
  /** Current blocks to undo, highest height first. */
  disconnect: BlockMetadata[];
  /** Replacement/missing blocks to apply, lowest height first. */
  connect: BlockMetadata[];
}
