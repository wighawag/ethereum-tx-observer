import type {BroadcastedTransaction} from '../../src/index.js';
import type {MockTransaction} from '../mocks/MockEIP1193Provider.js';

// Default test account
export const TEST_ACCOUNT =
	'0x1234567890123456789012345678901234567890' as const;
export const TEST_ACCOUNT_2 =
	'0xabcdef1234567890123456789012345678901234' as const;

// Counter for generating unique hashes
let hashCounter = 0;

/**
 * Generate a unique transaction hash
 */
export function generateTxHash(): `0x${string}` {
	hashCounter++;
	return `0x${hashCounter.toString(16).padStart(64, '0')}` as `0x${string}`;
}

/**
 * Reset the hash counter (call in beforeEach)
 */
export function resetHashCounter(): void {
	hashCounter = 0;
}

/**
 * Create a BroadcastedTransaction for use with the processor
 */
export function createBroadcastedTx(
	overrides: Partial<BroadcastedTransaction> = {},
): BroadcastedTransaction {
	const hash = overrides.hash || generateTxHash();
	const from = overrides.from || TEST_ACCOUNT;

	return {
		hash,
		from,
		nonce: overrides.nonce,
		broadcastTimestamp: overrides.broadcastTimestamp || Date.now(),
		state: overrides.state,
	} as BroadcastedTransaction;
}

/**
 * Create a MockTransaction for use with the mock provider
 */
export function createMockTx(
	overrides: Partial<MockTransaction> = {},
): MockTransaction {
	const hash = overrides.hash || generateTxHash();
	const from = overrides.from || TEST_ACCOUNT;

	return {
		hash,
		from,
		to: overrides.to || TEST_ACCOUNT_2,
		nonce: overrides.nonce ?? 0,
		maxFeePerGas: overrides.maxFeePerGas || '0x3b9aca00',
		maxPriorityFeePerGas: overrides.maxPriorityFeePerGas || '0x3b9aca00',
		gas: overrides.gas || '0x5208',
		gasPrice: overrides.gasPrice || '0x3b9aca00',
		value: overrides.value || '0x0',
		input: overrides.input || '0x',
		blockHash: overrides.blockHash,
		blockNumber: overrides.blockNumber,
	};
}

/**
 * Create a pair of transactions (broadcasted + mock) for a test case
 */
export function createTxPair(
	overrides: Partial<BroadcastedTransaction & MockTransaction> = {},
): {broadcasted: BroadcastedTransaction; mock: MockTransaction} {
	const hash = overrides.hash || generateTxHash();
	const from = overrides.from || TEST_ACCOUNT;
	const nonce = overrides.nonce ?? 0;

	const broadcasted = createBroadcastedTx({
		...overrides,
		hash,
		from,
		nonce,
	});

	const mock = createMockTx({
		...overrides,
		hash,
		from,
		nonce,
	});

	return {broadcasted, mock};
}

/**
 * Create a replacement transaction pair (same nonce, higher gas)
 */
export function createReplacementTxPair(
	originalHash: `0x${string}`,
	overrides: Partial<BroadcastedTransaction & MockTransaction> = {},
): {broadcasted: BroadcastedTransaction; mock: MockTransaction} {
	const hash = overrides.hash || generateTxHash();
	const from = overrides.from || TEST_ACCOUNT;
	const nonce = overrides.nonce ?? 0;

	// Higher gas for replacement
	const maxFeePerGas = overrides.maxFeePerGas || '0x77359400'; // 2 gwei (higher than default 1 gwei)
	const maxPriorityFeePerGas = overrides.maxPriorityFeePerGas || '0x77359400';

	return createTxPair({
		...overrides,
		hash,
		from,
		nonce,
		maxFeePerGas,
		maxPriorityFeePerGas,
	});
}

/**
 * Sample transactions for common test scenarios
 */
export const SAMPLE_TXS = {
	// Basic pending transaction
	pending: () =>
		createTxPair({
			hash: '0x0000000000000000000000000000000000000000000000000000000000000001',
			nonce: 5,
		}),

	// Transaction with higher gas (for replacement)
	highGas: () =>
		createTxPair({
			hash: '0x0000000000000000000000000000000000000000000000000000000000000002',
			nonce: 5,
			maxFeePerGas: '0xba43b7400', // 50 gwei
			maxPriorityFeePerGas: '0xba43b7400',
		}),

	// Different nonce transaction
	differentNonce: () =>
		createTxPair({
			hash: '0x0000000000000000000000000000000000000000000000000000000000000003',
			nonce: 6,
		}),

	// Transaction from different account
	differentAccount: () =>
		createTxPair({
			hash: '0x0000000000000000000000000000000000000000000000000000000000000004',
			from: TEST_ACCOUNT_2,
			nonce: 0,
		}),
};
