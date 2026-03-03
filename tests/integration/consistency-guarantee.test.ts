/**
 * Critical Consistency Tests for Local State Handler
 *
 * These tests verify the guarantee from plans/testing-plan.md:
 * "After addMultiple() returns, any subsequent operation event MUST include the newly added transaction."
 *
 * The potential race condition:
 * 1. process() starts iterating over op.transactions (snapshot or live)
 * 2. While iterating, addMultiple() is called with a new TX
 * 3. The new TX is pushed to op.transactions
 * 4. process() continues/finishes iteration
 * 5. computeOperationStatus() is called
 *
 * The guarantee: computeOperationStatus() must use ALL current transactions,
 * including any added during iteration.
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
	initTransactionProcessor,
	type OnchainOperation,
} from '../../src/index.js';
import {
	createMockProvider,
	type MockProviderController,
} from '../mocks/MockEIP1193Provider.js';
import {
	createBroadcastedTx,
	createMockTx,
	resetHashCounter,
	TEST_ACCOUNT,
} from '../fixtures/transactions.js';
import {createOperation, resetOpIdCounter} from '../fixtures/operations.js';

describe('Consistency Guarantee with Local State Handler', () => {
	let processor: ReturnType<typeof initTransactionProcessor>;
	let controller: MockProviderController;
	let emissions: OnchainOperation[];
	let cleanup: () => void;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();

		const {provider, controller: ctrl} = createMockProvider();
		controller = ctrl;

		processor = initTransactionProcessor({
			finality: 12,
			provider,
		});

		emissions = [];
		cleanup = processor.onOperationUpdated((event) => {
			emissions.push(structuredClone(event.operation));
			return () => {};
		});
	});

	afterEach(() => {
		cleanup();
	});

	describe('Race Condition: Add during Process Iteration', () => {
		it('CRITICAL: New TX added mid-iteration MUST be in emitted status', async () => {
			/**
			 * This test verifies the critical consistency guarantee.
			 *
			 * Scenario:
			 * 1. Operation starts with TX1 in mempool (Broadcasted)
			 * 2. While processing TX1, we add TX2 to the operation
			 * 3. TX1 gets included (triggers status change and emission)
			 * 4. The emitted operation MUST contain both TX1 and TX2
			 *
			 * If the code uses a snapshot of transactions for iteration but
			 * forgets to include new transactions in the status computation,
			 * TX2 would be missing from the emitted event.
			 */

			// Create TX1 and add to operation
			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'consistency-test': op});

			// First process to establish TX1 as Broadcasted
			await processor.process();
			expect(op.state?.inclusion).toBe('InMemPool');

			// Create TX2
			const tx2 = createBroadcastedTx({
				nonce: 5,
				from: TEST_ACCOUNT,
			});
			const mockTx2 = createMockTx({
				hash: tx2.hash,
				from: tx2.from,
				nonce: 5,
				maxFeePerGas: '0x77359400',
			});

			// Set up a hook to inject TX2 during the processing of TX1
			// This simulates: the state handler adds TX2 while process() is running
			let injected = false;
			const removeHook = controller.onRequest(
				async (method: string, params: unknown[]) => {
					// When processing fetches TX1 info, inject TX2
					if (
						method === 'eth_getTransactionByHash' &&
						params[0] === tx1.hash &&
						!injected
					) {
						injected = true;
						// Add TX2 to the operation mid-process
						controller.addToMempool(mockTx2);
						processor.addMultiple({
							'consistency-test': {...op, transactions: [tx2]},
						});
					}
				},
			);

			// Include TX1 to trigger a status change (Broadcasted -> Included)
			// This will cause an emission
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);

			await processor.process();
			removeHook();

			// Get the latest emission after TX1 was included
			const includedEmission = emissions.find(
				(e) => e.state?.inclusion === 'Included',
			);

			expect(includedEmission).toBeDefined();

			// CRITICAL ASSERTION: TX2 must be in the emitted operation
			// This is the consistency guarantee - state handler can safely
			// overwrite local state with this emission
			expect(includedEmission!.transactions.length).toBe(2);

			const tx1InEmission = includedEmission!.transactions.some(
				(t) => t.hash === tx1.hash,
			);
			const tx2InEmission = includedEmission!.transactions.some(
				(t) => t.hash === tx2.hash,
			);

			expect(tx1InEmission).toBe(true);
			expect(tx2InEmission).toBe(true);
		});

		it('CRITICAL: Status computation must use ALL transactions, not iteration snapshot', async () => {
			/**
			 * More specific test:
			 * If the code does:
			 *   const snapshot = [...op.transactions];
			 *   for (const tx of snapshot) { process... }
			 *   const status = computeStatus(snapshot); // BUG: should use op.transactions
			 *
			 * Then new TXs added during iteration would be excluded from status.
			 *
			 * To trigger an emission, we need a status change. We'll include TX1
			 * and verify that the emission includes TX2 that was added mid-process.
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'snapshot-test': op});
			await processor.process();
			expect(op.state?.inclusion).toBe('InMemPool');

			const emissionCountBefore = emissions.length;

			// Add TX2 during the next process call
			const tx2 = createBroadcastedTx({nonce: 5, from: TEST_ACCOUNT});
			const mockTx2 = createMockTx({
				hash: tx2.hash,
				from: tx2.from,
				nonce: 5,
			});

			// Hook: add TX2 right when process starts (before iteration)
			let added = false;
			const removeHook = controller.onRequest(async () => {
				if (!added) {
					added = true;
					controller.addToMempool(mockTx2);
					processor.addMultiple({
						'snapshot-test': {...op, transactions: [tx2]},
					});
				}
			});

			// Include TX1 to trigger a status change and emission
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);

			// Process again - TX2 should be added, TX1 should be Included
			await processor.process();
			removeHook();

			// Verify the operation itself has both transactions
			expect(op.transactions.length).toBe(2);

			// There should be a new emission (due to TX1 becoming Included)
			expect(emissions.length).toBeGreaterThan(emissionCountBefore);

			// Find the emission for our operation after the status change
			const newEmissions = emissions.slice(emissionCountBefore);

			expect(newEmissions.length).toBeGreaterThan(0);

			// CRITICAL: The emission MUST include TX2 that was added mid-process
			const latestEmission = newEmissions[newEmissions.length - 1];
			expect(latestEmission.transactions.length).toBe(2);
			expect(latestEmission.transactions.some((t) => t.hash === tx1.hash)).toBe(
				true,
			);
			expect(latestEmission.transactions.some((t) => t.hash === tx2.hash)).toBe(
				true,
			);
		});

		it('CRITICAL: Add between process start and event emission', async () => {
			/**
			 * Test the exact sequence described in the plan:
			 * 1. process() starts
			 * 2. processOperation() begins iterating transactions
			 * 3. DURING iteration: addMultiple() is called with new TX
			 * 4. computeOperationStatus() is called
			 * 5. Event is emitted
			 *
			 * The event MUST include the new TX.
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({
				transactions: [tx1],
			});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'mid-iteration-add': op});
			await processor.process();

			const emissionCountBefore = emissions.length;

			// Use onBeforeResponse to inject TX2 just before the response
			// This ensures TX2 is added mid-processing
			const tx2 = createBroadcastedTx({nonce: 6, from: TEST_ACCOUNT});
			const mockTx2 = createMockTx({
				hash: tx2.hash,
				from: tx2.from,
				nonce: 6,
			});

			let injected = false;
			const removeHook = controller.onBeforeResponse(
				'eth_getTransactionByHash',
				() => {
					if (!injected) {
						injected = true;
						controller.addToMempool(mockTx2);
						processor.addMultiple({
							'mid-iteration-add': {...op, transactions: [tx2]},
						});
					}
				},
			);

			// Include TX1 to cause a state change and emission
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);

			await processor.process();
			removeHook();

			// Should have new emissions
			expect(emissions.length).toBeGreaterThan(emissionCountBefore);

			// Find the emissions after the change
			const relevantEmissions = emissions.slice(emissionCountBefore);

			// At least one emission should have both transactions
			const hasCompleteEmission = relevantEmissions.some(
				(e) => e.transactions.length === 2,
			);

			expect(hasCompleteEmission).toBe(true);
		});
	});

	describe('Snapshot Iteration Verification', () => {
		it('should process all existing TXs even if iteration uses snapshot', async () => {
			/**
			 * If the code uses [...op.transactions] for iteration,
			 * existing TXs should still be processed normally.
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const tx2 = createBroadcastedTx({nonce: 6, from: TEST_ACCOUNT});
			const mockTx2 = createMockTx({
				hash: tx2.hash,
				from: tx2.from,
				nonce: 6,
			});

			const op = createOperation({
				transactions: [tx1, tx2],
			});

			controller.addToMempool(mockTx1);
			controller.addToMempool(mockTx2);
			processor.addMultiple({'multi-tx': op});

			await processor.process();

			// Both should be Broadcasted
			expect(op.transactions[0].state?.inclusion).toBe('InMemPool');
			expect(op.transactions[1].state?.inclusion).toBe('InMemPool');
			expect(op.state?.inclusion).toBe('InMemPool');
		});

		it('should correctly compute merged status with multiple TXs', async () => {
			/**
			 * Test that status merging works correctly when multiple
			 * TXs have different statuses.
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const tx2 = createBroadcastedTx({nonce: 6, from: TEST_ACCOUNT});
			const mockTx2 = createMockTx({
				hash: tx2.hash,
				from: tx2.from,
				nonce: 6,
			});

			const op = createOperation({
				transactions: [tx1, tx2],
			});

			controller.addToMempool(mockTx1);
			controller.addToMempool(mockTx2);
			processor.addMultiple({'merged-status': op});
			await processor.process();

			// Include TX1, TX2 stays in mempool
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);
			await processor.process();

			// Operation should be Included (TX1 succeeded)
			expect(op.state?.inclusion).toBe('Included');
			expect(op.state?.status).toBe('Success');
			expect(op.state?.txIndex).toBe(0); // TX1
		});
	});
});
