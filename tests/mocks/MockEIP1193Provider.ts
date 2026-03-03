import type {EIP1193ProviderWithoutEvents} from 'eip-1193';

// Mock transaction data structure
export interface MockTransaction {
	hash: `0x${string}`;
	from: `0x${string}`;
	to?: `0x${string}`;
	nonce: number;
	maxFeePerGas: string;
	maxPriorityFeePerGas: string;
	blockHash?: `0x${string}`;
	blockNumber?: string;
	gas?: string;
	gasPrice?: string;
	value?: string;
	input?: string;
}

// Mock receipt data structure
export interface MockReceipt {
	transactionHash: `0x${string}`;
	blockHash: `0x${string}`;
	blockNumber: string;
	status: '0x1' | '0x0';
	gasUsed: string;
	cumulativeGasUsed: string;
	transactionIndex: string;
	from: `0x${string}`;
	to?: `0x${string}`;
	logs: unknown[];
}

// Mock block data structure
export interface MockBlock {
	number: string;
	hash: `0x${string}`;
	parentHash: `0x${string}`;
	timestamp: string;
	transactions: `0x${string}`[];
}

// Configuration for the mock provider
export interface MockProviderConfig {
	initialBlockNumber?: number;
	initialTimestamp?: number;
	blockTimeMs?: number;
	failureRate?: number;
	failMethods?: string[];
	latencyMs?: number;
}

// Hooks for intercepting requests
type RequestHook = (method: string, params: unknown[]) => void | Promise<void>;
type BeforeResponseHook = (
	method: string,
	params: unknown[],
	result: unknown,
) => void | Promise<void>;

/**
 * Controller interface for manipulating mock provider state during tests
 */
export interface MockProviderController {
	// Block manipulation
	advanceBlock(): void;
	advanceBlocks(n: number): void;
	setBlockNumber(n: number): void;
	getBlockNumber(): number;

	// Mempool manipulation
	addToMempool(tx: MockTransaction): void;
	removeFromMempool(txHash: string): void;
	clearMempool(): void;
	isInMempool(txHash: string): boolean;

	// Transaction state
	includeTx(txHash: string, status: 'success' | 'failure'): void;
	dropTx(txHash: string): void;

	// Nonce manipulation
	setAccountNonce(address: string, nonce: number): void;
	getAccountNonce(address: string): number;
	incrementAccountNonce(address: string): void;

	// Network simulation
	setLatency(ms: number): void;
	setFailureRate(rate: number): void;
	setFailMethods(methods: string[]): void;
	simulateDisconnect(): void;
	simulateReconnect(): void;

	// Hooks for testing concurrent scenarios
	onRequest(hook: RequestHook): () => void;
	onBeforeResponse(method: string, hook: () => void): () => void;

	// Get state for assertions
	getBlock(blockNumber: number): MockBlock | null;
	getBlockByHash(hash: string): MockBlock | null;
	getTransaction(hash: string): MockTransaction | null;
	getReceipt(hash: string): MockReceipt | null;
}

/**
 * Creates a mock EIP-1193 provider with a controller for test manipulation
 */
export function createMockProvider(config: MockProviderConfig = {}): {
	provider: EIP1193ProviderWithoutEvents;
	controller: MockProviderController;
} {
	const {
		initialBlockNumber = 100,
		initialTimestamp = Math.floor(Date.now() / 1000),
		blockTimeMs = 12000,
		failureRate = 0,
		failMethods = [],
		latencyMs = 0,
	} = config;

	// State
	let currentBlockNumber = initialBlockNumber;
	let currentTimestamp = initialTimestamp;
	let latency = latencyMs;
	let failRate = failureRate;
	let failingMethods = [...failMethods];
	let disconnected = false;

	// Storage
	const blocks: Map<number, MockBlock> = new Map();
	const blocksByHash: Map<string, MockBlock> = new Map();
	const mempool: Map<string, MockTransaction> = new Map();
	const includedTxs: Map<string, MockTransaction> = new Map();
	const receipts: Map<string, MockReceipt> = new Map();
	const accountNonces: Map<string, number> = new Map();

	// Hooks
	const requestHooks: RequestHook[] = [];
	const beforeResponseHooks: Map<string, (() => void)[]> = new Map();

	// Initialize genesis block
	function createBlock(blockNum: number, timestamp: number): MockBlock {
		const hexNum = `0x${blockNum.toString(16)}` as `0x${string}`;
		const hash =
			`0x${blockNum.toString(16).padStart(64, '0')}` as `0x${string}`;
		const parentHash =
			blockNum > 0
				? (`0x${(blockNum - 1).toString(16).padStart(64, '0')}` as `0x${string}`)
				: (`0x${'0'.repeat(64)}` as `0x${string}`);

		return {
			number: hexNum,
			hash,
			parentHash,
			timestamp: `0x${timestamp.toString(16)}`,
			transactions: [],
		};
	}

	// Initialize blocks up to current
	for (let i = 0; i <= currentBlockNumber; i++) {
		const timestamp = initialTimestamp - (currentBlockNumber - i) * 12;
		const block = createBlock(i, timestamp);
		blocks.set(i, block);
		blocksByHash.set(block.hash, block);
	}

	// Helper to simulate latency
	async function delay(): Promise<void> {
		if (latency > 0) {
			await new Promise((resolve) => setTimeout(resolve, latency));
		}
	}

	// Helper to check if method should fail
	function shouldFail(method: string): boolean {
		if (disconnected) return true;
		if (failingMethods.includes(method)) return true;
		if (failRate > 0 && Math.random() < failRate) return true;
		return false;
	}

	// Helper to run hooks
	async function runRequestHooks(
		method: string,
		params: unknown[],
	): Promise<void> {
		for (const hook of requestHooks) {
			await hook(method, params);
		}
	}

	async function runBeforeResponseHooks(method: string): Promise<void> {
		const hooks = beforeResponseHooks.get(method) || [];
		for (const hook of hooks) {
			await hook();
		}
	}

	// Provider implementation
	const provider = {
		async request(args: {method: string; params?: unknown[]}): Promise<any> {
			const {method, params = []} = args;

			await runRequestHooks(method, params);
			await delay();

			if (shouldFail(method)) {
				throw new Error(`Mock provider error: ${method} failed`);
			}

			await runBeforeResponseHooks(method);

			switch (method) {
				case 'eth_blockNumber':
					return `0x${currentBlockNumber.toString(16)}`;

				case 'eth_getBlockByNumber': {
					const blockParam = params[0] as string;
					let blockNum: number;

					if (blockParam === 'latest') {
						blockNum = currentBlockNumber;
					} else if (blockParam === 'finalized' || blockParam === 'safe') {
						blockNum = Math.max(currentBlockNumber - 12, 0);
					} else if (blockParam === 'pending') {
						blockNum = currentBlockNumber;
					} else {
						blockNum = parseInt(blockParam, 16);
					}

					return blocks.get(blockNum) || null;
				}

				case 'eth_getBlockByHash': {
					const hash = params[0] as string;
					return blocksByHash.get(hash) || null;
				}

				case 'eth_getTransactionByHash': {
					const hash = params[0] as string;

					// First check if included in a block
					const includedTx = includedTxs.get(hash);
					if (includedTx) {
						return includedTx;
					}

					// Then check mempool
					const mempoolTx = mempool.get(hash);
					if (mempoolTx) {
						// Return without block info for pending tx
						return {
							...mempoolTx,
							blockHash: null,
							blockNumber: null,
						};
					}

					return null;
				}

				case 'eth_getTransactionReceipt': {
					const hash = params[0] as string;
					return receipts.get(hash) || null;
				}

				case 'eth_getTransactionCount': {
					const address = (params[0] as string).toLowerCase();
					const blockParam = params[1] as string;

					// For finalized/safe blocks, return the confirmed nonce
					// For latest/pending, can return a higher nonce
					const nonce = accountNonces.get(address) || 0;
					return `0x${nonce.toString(16)}`;
				}

				case 'eth_chainId':
					return '0x1';

				case 'eth_gasPrice':
					return '0x3b9aca00'; // 1 gwei

				default:
					throw new Error(`Mock provider: unsupported method ${method}`);
			}
		},
		on: () => {},
		removeListener: () => {},
	};

	// Controller implementation
	const controller: MockProviderController = {
		advanceBlock(): void {
			currentBlockNumber++;
			currentTimestamp += Math.floor(blockTimeMs / 1000);
			const block = createBlock(currentBlockNumber, currentTimestamp);
			blocks.set(currentBlockNumber, block);
			blocksByHash.set(block.hash, block);
		},

		advanceBlocks(n: number): void {
			for (let i = 0; i < n; i++) {
				this.advanceBlock();
			}
		},

		setBlockNumber(n: number): void {
			// Create any missing blocks
			while (currentBlockNumber < n) {
				this.advanceBlock();
			}
		},

		getBlockNumber(): number {
			return currentBlockNumber;
		},

		addToMempool(tx: MockTransaction): void {
			mempool.set(tx.hash, tx);
		},

		removeFromMempool(txHash: string): void {
			mempool.delete(txHash);
		},

		clearMempool(): void {
			mempool.clear();
		},

		isInMempool(txHash: string): boolean {
			return mempool.has(txHash);
		},

		includeTx(txHash: string, status: 'success' | 'failure'): void {
			// Get tx from mempool or create it
			let tx = mempool.get(txHash);
			if (!tx) {
				// Try to get from included txs
				tx = includedTxs.get(txHash);
			}

			if (!tx) {
				throw new Error(`Transaction ${txHash} not found in mempool or state`);
			}

			// Remove from mempool
			mempool.delete(txHash);

			// Add to next block (advance if needed)
			this.advanceBlock();
			const block = blocks.get(currentBlockNumber)!;
			block.transactions.push(tx.hash);

			// Update tx with block info
			const includedTx: MockTransaction = {
				...tx,
				blockHash: block.hash,
				blockNumber: block.number,
			};
			includedTxs.set(txHash, includedTx);

			// Create receipt
			const receipt: MockReceipt = {
				transactionHash: tx.hash,
				blockHash: block.hash,
				blockNumber: block.number,
				status: status === 'success' ? '0x1' : '0x0',
				gasUsed: '0x5208',
				cumulativeGasUsed: '0x5208',
				transactionIndex: `0x${(block.transactions.length - 1).toString(16)}`,
				from: tx.from,
				to: tx.to,
				logs: [],
			};
			receipts.set(txHash, receipt);

			// Increment account nonce
			this.incrementAccountNonce(tx.from);
		},

		dropTx(txHash: string): void {
			mempool.delete(txHash);
		},

		setAccountNonce(address: string, nonce: number): void {
			accountNonces.set(address.toLowerCase(), nonce);
		},

		getAccountNonce(address: string): number {
			return accountNonces.get(address.toLowerCase()) || 0;
		},

		incrementAccountNonce(address: string): void {
			const current = accountNonces.get(address.toLowerCase()) || 0;
			accountNonces.set(address.toLowerCase(), current + 1);
		},

		setLatency(ms: number): void {
			latency = ms;
		},

		setFailureRate(rate: number): void {
			failRate = rate;
		},

		setFailMethods(methods: string[]): void {
			failingMethods = [...methods];
		},

		simulateDisconnect(): void {
			disconnected = true;
		},

		simulateReconnect(): void {
			disconnected = false;
		},

		onRequest(hook: RequestHook): () => void {
			requestHooks.push(hook);
			return () => {
				const index = requestHooks.indexOf(hook);
				if (index >= 0) {
					requestHooks.splice(index, 1);
				}
			};
		},

		onBeforeResponse(method: string, hook: () => void): () => void {
			if (!beforeResponseHooks.has(method)) {
				beforeResponseHooks.set(method, []);
			}
			beforeResponseHooks.get(method)!.push(hook);
			return () => {
				const hooks = beforeResponseHooks.get(method);
				if (hooks) {
					const index = hooks.indexOf(hook);
					if (index >= 0) {
						hooks.splice(index, 1);
					}
				}
			};
		},

		getBlock(blockNumber: number): MockBlock | null {
			return blocks.get(blockNumber) || null;
		},

		getBlockByHash(hash: string): MockBlock | null {
			return blocksByHash.get(hash) || null;
		},

		getTransaction(hash: string): MockTransaction | null {
			return includedTxs.get(hash) || mempool.get(hash) || null;
		},

		getReceipt(hash: string): MockReceipt | null {
			return receipts.get(hash) || null;
		},
	};

	return {
		provider: provider as unknown as EIP1193ProviderWithoutEvents,
		controller,
	};
}
