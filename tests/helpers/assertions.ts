import {expect} from 'vitest';
import type {
	OnchainOperation,
	BroadcastedTransaction,
	BroadcastedTransactionInclusion,
} from '../../src/index.js';

/**
 * Assert that an operation has the expected inclusion status
 */
export function assertOperationInclusion(
	op: OnchainOperation,
	expectedInclusion: BroadcastedTransactionInclusion,
	message?: string,
): void {
	expect(op.state?.inclusion, message).toBe(expectedInclusion);
}

/**
 * Assert that an operation is in the Included state with expected status
 */
export function assertOperationIncluded(
	op: OnchainOperation,
	expectedStatus: 'Success' | 'Failure',
	message?: string,
): void {
	expect(op.state?.inclusion, message).toBe('Included');
	expect(op.state?.status, message).toBe(expectedStatus);
	expect(typeof op.state?.txIndex, message).toBe('number');
}

/**
 * Assert that an operation is finalized
 */
export function assertOperationFinalized(
	op: OnchainOperation,
	message?: string,
): void {
	expect(op.state?.final, message).toBeDefined();
	expect(typeof op.state?.final, message).toBe('number');
}

/**
 * Assert that an operation is dropped
 */
export function assertOperationDropped(
	op: OnchainOperation,
	message?: string,
): void {
	expect(op.state?.inclusion, message).toBe('Dropped');
}

/**
 * Assert that a transaction has the expected inclusion status
 */
export function assertTxInclusion(
	tx: BroadcastedTransaction,
	expectedInclusion: BroadcastedTransactionInclusion,
	message?: string,
): void {
	expect(tx.state?.inclusion, message).toBe(expectedInclusion);
}

/**
 * Assert that an operation contains a specific transaction hash
 */
export function assertOperationContainsTx(
	op: OnchainOperation,
	txHash: `0x${string}`,
	message?: string,
): void {
	const found = op.transactions.some((tx) => tx.hash === txHash);
	expect(found, message || `Operation should contain tx ${txHash}`).toBe(true);
}

/**
 * Assert that an operation has the expected number of transactions
 */
export function assertOperationTxCount(
	op: OnchainOperation,
	expectedCount: number,
	message?: string,
): void {
	expect(
		op.transactions.length,
		message || `Operation should have ${expectedCount} transactions`,
	).toBe(expectedCount);
}

/**
 * Assert that the winning tx (txIndex) points to a specific hash
 */
export function assertWinningTx(
	op: OnchainOperation,
	expectedHash: `0x${string}`,
	message?: string,
): void {
	expect(op.state?.txIndex, 'txIndex should be defined').toBeDefined();
	const winningTx = op.transactions[op.state?.txIndex!];
	expect(
		winningTx.hash,
		message || `Winning tx should be ${expectedHash}`,
	).toBe(expectedHash);
}

/**
 * Assert that all transactions in an operation have a specific inclusion status
 */
export function assertAllTxsInclusion(
	op: OnchainOperation,
	expectedInclusion: BroadcastedTransactionInclusion,
	message?: string,
): void {
	for (const tx of op.transactions) {
		expect(
			tx.state?.inclusion,
			message || `All txs should be ${expectedInclusion}`,
		).toBe(expectedInclusion);
	}
}

/**
 * Assert that at least one transaction has a specific inclusion status
 */
export function assertSomeTxInclusion(
	op: OnchainOperation,
	expectedInclusion: BroadcastedTransactionInclusion,
	message?: string,
): void {
	const found = op.transactions.some(
		(tx) => tx.state?.inclusion === expectedInclusion,
	);
	expect(
		found,
		message || `At least one tx should be ${expectedInclusion}`,
	).toBe(true);
}

/**
 * Assert emission sequence
 */
export function assertEmissionSequence(
	emissions: OnchainOperation[],
	expectedSequence: BroadcastedTransactionInclusion[],
	message?: string,
): void {
	expect(
		emissions.length,
		message || 'Emission count should match expected sequence',
	).toBe(expectedSequence.length);

	for (let i = 0; i < expectedSequence.length; i++) {
		expect(
			emissions[i].state?.inclusion,
			message || `Emission ${i} should be ${expectedSequence[i]}`,
		).toBe(expectedSequence[i]);
	}
}

/**
 * Assert that an emission contains a newly added transaction
 * (Critical for local state handler consistency)
 */
export function assertEmissionContainsNewTx(
	emission: OnchainOperation,
	newTxHash: `0x${string}`,
	message?: string,
): void {
	assertOperationContainsTx(
		emission,
		newTxHash,
		message ||
			`Emission must contain newly added tx ${newTxHash} for state handler consistency`,
	);
}

/**
 * Assert that the latest emission in a list contains a transaction
 */
export function assertLatestEmissionContainsTx(
	emissions: OnchainOperation[],
	txHash: `0x${string}`,
	message?: string,
): void {
	expect(emissions.length, 'Should have at least one emission').toBeGreaterThan(
		0,
	);
	const latestEmission = emissions[emissions.length - 1];
	assertOperationContainsTx(latestEmission, txHash, message);
}

/**
 * Assert operation status matches expected values
 */
export function assertOperationStatus(
	op: OnchainOperation,
	expected: {
		inclusion: BroadcastedTransactionInclusion;
		status?: 'Success' | 'Failure';
		final?: number | undefined;
		txIndex?: number;
	},
	message?: string,
): void {
	expect(op.state?.inclusion, message).toBe(expected.inclusion);

	if (expected.status !== undefined) {
		expect(op.state?.status, message).toBe(expected.status);
	}

	if (expected.final !== undefined) {
		expect(op.state?.final, message).toBe(expected.final);
	} else if (
		expected.inclusion === 'InMemPool' ||
		expected.inclusion === 'NotFound'
	) {
		expect(op.state?.final, message).toBeUndefined();
	}

	if (expected.txIndex !== undefined) {
		expect(op.state?.txIndex, message).toBe(expected.txIndex);
	}
}
