import type {OnchainOperation, BroadcastedTransaction} from '../../src/index.js';
import {createBroadcastedTx, TEST_ACCOUNT} from './transactions.js';

// Counter for generating unique operation IDs
let opIdCounter = 0;

/**
 * Generate a unique operation ID
 */
export function generateOpId(): string {
	opIdCounter++;
	return `op-${opIdCounter}`;
}

/**
 * Reset the operation ID counter (call in beforeEach)
 */
export function resetOpIdCounter(): void {
	opIdCounter = 0;
}

/**
 * Create an OnchainOperation for testing
 */
export function createOperation<T = unknown>(
	overrides: Partial<OnchainOperation<T>> & {
		transactions?: BroadcastedTransaction[];
	} = {},
): OnchainOperation<T> {
	const id = overrides.id || generateOpId();

	// Default to one pending transaction if none provided
	const transactions =
		overrides.transactions ||
		[createBroadcastedTx({inclusion: 'BeingFetched'})];

	return {
		id,
		transactions,
		inclusion: overrides.inclusion || 'BeingFetched',
		final: overrides.final,
		status: overrides.status,
		txIndex: overrides.txIndex,
		metadata: overrides.metadata,
	} as OnchainOperation<T>;
}

/**
 * Create an operation with multiple transactions (for replacement scenarios)
 */
export function createMultiTxOperation(
	txConfigs: Array<Partial<BroadcastedTransaction>>,
	opOverrides: Partial<OnchainOperation> = {},
): OnchainOperation {
	const transactions = txConfigs.map((config) => createBroadcastedTx(config));
	return createOperation({
		...opOverrides,
		transactions,
	});
}

/**
 * Create an operation with a single transaction already broadcasted
 */
export function createBroadcastedOperation(
	txOverrides: Partial<BroadcastedTransaction> = {},
	opOverrides: Partial<OnchainOperation> = {},
): OnchainOperation {
	const tx = createBroadcastedTx({
		...txOverrides,
		inclusion: 'Broadcasted',
	});
	return createOperation({
		...opOverrides,
		transactions: [tx],
		inclusion: 'Broadcasted',
	});
}

/**
 * Create an operation with an included (successful) transaction
 */
export function createIncludedOperation(
	txOverrides: Partial<BroadcastedTransaction> = {},
	opOverrides: Partial<OnchainOperation> = {},
): OnchainOperation {
	const tx = createBroadcastedTx({
		...txOverrides,
		inclusion: 'Included',
		status: 'Success',
	});
	return createOperation({
		...opOverrides,
		transactions: [tx],
		inclusion: 'Included',
		status: 'Success',
		txIndex: 0,
	});
}

/**
 * Create an operation with a failed transaction
 */
export function createFailedOperation(
	txOverrides: Partial<BroadcastedTransaction> = {},
	opOverrides: Partial<OnchainOperation> = {},
): OnchainOperation {
	const tx = createBroadcastedTx({
		...txOverrides,
		inclusion: 'Included',
		status: 'Failure',
	});
	return createOperation({
		...opOverrides,
		transactions: [tx],
		inclusion: 'Included',
		status: 'Failure',
		txIndex: 0,
	});
}

/**
 * Create an operation with a dropped transaction
 */
export function createDroppedOperation(
	txOverrides: Partial<BroadcastedTransaction> = {},
	opOverrides: Partial<OnchainOperation> = {},
): OnchainOperation {
	const tx = createBroadcastedTx({
		...txOverrides,
		inclusion: 'Dropped',
		final: txOverrides.final || Date.now(),
	});
	return createOperation({
		...opOverrides,
		transactions: [tx],
		inclusion: 'Dropped',
		final: tx.final,
	});
}

/**
 * Create an operation representing a gas bump scenario:
 * - Original TX with low gas
 * - Replacement TX with higher gas (same nonce)
 */
export function createGasBumpOperation(
	nonce: number = 5,
	opOverrides: Partial<OnchainOperation> = {},
): {operation: OnchainOperation; originalTx: BroadcastedTransaction; replacementTx: BroadcastedTransaction} {
	const originalTx = createBroadcastedTx({
		nonce,
		maxFeePerGas: '0x3b9aca00', // 1 gwei
		maxPriorityFeePerGas: '0x3b9aca00',
		inclusion: 'BeingFetched',
	});

	const replacementTx = createBroadcastedTx({
		nonce,
		maxFeePerGas: '0x77359400', // 2 gwei (higher)
		maxPriorityFeePerGas: '0x77359400',
		from: originalTx.from,
		inclusion: 'BeingFetched',
	});

	const operation = createOperation({
		...opOverrides,
		transactions: [originalTx, replacementTx],
		inclusion: 'BeingFetched',
	});

	return {operation, originalTx, replacementTx};
}

/**
 * Create a chain of replacement transactions (TX1 → TX2 → TX3)
 */
export function createReplacementChain(
	chainLength: number = 3,
	nonce: number = 5,
	opOverrides: Partial<OnchainOperation> = {},
): {operation: OnchainOperation; transactions: BroadcastedTransaction[]} {
	const transactions: BroadcastedTransaction[] = [];

	for (let i = 0; i < chainLength; i++) {
		const gasMultiplier = i + 1;
		const tx = createBroadcastedTx({
			nonce,
			from: TEST_ACCOUNT,
			// Increase gas with each replacement
			maxFeePerGas: `0x${(1000000000 * gasMultiplier).toString(16)}`,
			maxPriorityFeePerGas: `0x${(1000000000 * gasMultiplier).toString(16)}`,
			inclusion: 'BeingFetched',
		});
		transactions.push(tx);
	}

	const operation = createOperation({
		...opOverrides,
		transactions,
		inclusion: 'BeingFetched',
	});

	return {operation, transactions};
}

/**
 * Sample operations for common test scenarios
 */
export const SAMPLE_OPS = {
	// Single pending operation
	pending: () => createOperation(),

	// Operation with broadcasted tx
	broadcasted: () => createBroadcastedOperation(),

	// Successfully included operation
	included: () => createIncludedOperation(),

	// Failed operation
	failed: () => createFailedOperation(),

	// Dropped operation
	dropped: () => createDroppedOperation(),

	// Gas bump scenario
	gasBump: () => createGasBumpOperation(),

	// Chain of replacements
	replacementChain: () => createReplacementChain(3),
};
