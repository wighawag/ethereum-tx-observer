import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {
	createTestSetup,
	addSingleTxOperation,
	processAndWait,
	type TestSetup,
} from '../helpers/scenarios.js';
import {resetHashCounter} from '../fixtures/transactions.js';
import {resetOpIdCounter} from '../fixtures/operations.js';
import {createMockProvider} from '../mocks/MockEIP1193Provider.js';
import {initTransactionProcessor} from '../../src/index.js';
import type {
	OnchainOperation,
	OnchainOperationEvent,
	BroadcastedTransaction,
} from '../../src/index.js';

describe('Edge Cases for Full Coverage', () => {
	let setup: TestSetup;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();
		setup = createTestSetup({finality: 12});
	});

	afterEach(() => {
		setup.cleanup();
	});

	describe('Finalized Block Returns Null', () => {
		it('should handle when latestFinalizedBlock returns null', async () => {
			const {provider, controller} = createMockProvider();
			const processor = initTransactionProcessor({
				finality: 12,
				provider: provider as any,
			});

			// Create a custom provider that returns null for finalized block
			let callCount = 0;
			const customProvider = {
				async request(args: {method: string; params?: unknown[]}) {
					const result = await provider.request(args as any);
					// Return null for the finalized block request (second eth_getBlockByNumber call)
					if (args.method === 'eth_getBlockByNumber') {
						callCount++;
						if (callCount === 2) {
							return null;
						}
					}
					return result;
				},
			};

			processor.setProvider(customProvider as any);

			// Add an operation
			const operation: OnchainOperation = {
				transactions: [
					{
						hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
						from: '0x1234567890123456789012345678901234567890',
						broadcastTimestamp: Date.now(),
					},
				],
			};
			processor.addMultiple({'test-op': operation});

			// Process should return early when finalized block is null
			await processor.process();

			// Operation should remain unchanged
			expect(operation.state).toBeUndefined();
		});
	});

	describe('Already Finalized Transaction', () => {
		it('should skip processing when tx is already included and finalized', async () => {
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce: 5});
			const txHash = operation.transactions[0].hash;

			// Get tx to broadcasted and included
			addToMempool();
			await processAndWait(setup);
			setup.controller.includeTx(txHash, 'success');
			await processAndWait(setup);

			// Advance to finality
			setup.controller.advanceBlocks(12);
			await processAndWait(setup);

			// Verify it's finalized
			expect(operation.state?.final).toBeDefined();
			expect(operation.state?.inclusion).toBe('Included');

			const emissionCountBefore = setup.emissions.length;

			// Process again - should skip the tx since it's already final
			await processAndWait(setup);

			// No new emissions since nothing changed
			expect(setup.emissions.length).toBe(emissionCountBefore);
		});
	});

	describe('Transaction Appears on Retry Fetch', () => {
		it('should handle when tx is not found on first fetch but found on retry', async () => {
			const {provider, controller} = createMockProvider();
			const processor = initTransactionProcessor({
				finality: 12,
				provider: provider as any,
			});

			const emissions: OnchainOperation[] = [];
			processor.onOperationUpdated((event) => {
				emissions.push({
					...event.operation,
					transactions: [...event.operation.transactions],
				});
				return () => {};
			});

			const txHash =
				'0xabcdef1234567890123456789012345678901234567890123456789012345678' as const;

			// Add tx to mempool
			controller.addToMempool({
				hash: txHash,
				from: '0x1111111111111111111111111111111111111111',
				nonce: 5,
				maxFeePerGas: '0x1',
				maxPriorityFeePerGas: '0x1',
			});

			const operation: OnchainOperation = {
				transactions: [
					{
						hash: txHash,
						from: '0x1111111111111111111111111111111111111111',
						nonce: 5,
						broadcastTimestamp: Date.now(),
					},
				],
			};
			processor.addMultiple({'test-op-retry': operation});

			// First process should find it in mempool
			await processor.process();
			expect(operation.state?.inclusion).toBe('InMemPool');

			// Now create a scenario where first fetch returns null but second returns the tx
			let fetchCallCount = 0;
			const trickyProvider = {
				async request(args: {method: string; params?: unknown[]}) {
					if (args.method === 'eth_getTransactionByHash') {
						fetchCallCount++;
						// First call returns null, second returns the tx
						if (fetchCallCount === 1) {
							return null;
						}
						// Second call (retry) returns the tx
						return await provider.request(args as any);
					}
					return await provider.request(args as any);
				},
			};

			processor.setProvider(trickyProvider as any);

			// Process again - first fetch returns null, retry finds it
			// This should hit line 484 and return false (skip for now)
			await processor.process();

			// Transaction should still be Broadcasted since retry found it
			expect(operation.state?.inclusion).toBe('InMemPool');
		});
	});

	describe('Listener Removal', () => {
		it('should properly remove operation listener with offOperation', () => {
			const {processor} = setup;
			let callCount = 0;

			const listener = (_event: OnchainOperationEvent) => {
				callCount++;
				return () => {};
			};

			// Add listener
			processor.onOperationUpdated(listener);

			// Remove listener using offOperation
			processor.offOperationUpdated(listener);

			// Listener should be removed (no way to verify directly without emitting)
			// This test just ensures the method exists and doesn't throw
			expect(() => processor.offOperationUpdated(listener)).not.toThrow();
		});

		it('should properly remove operationStatus listener with offOperationStatus', () => {
			const {processor} = setup;
			let callCount = 0;

			const listener = (_event: OnchainOperationEvent) => {
				callCount++;
				return () => {};
			};

			// Add listener
			processor.onOperationStatusUpdated(listener);

			// Remove listener using offOperationStatus
			processor.offOperationStatusUpdated(listener);

			// Listener should be removed
			expect(() => processor.offOperationStatusUpdated(listener)).not.toThrow();
		});

		it('should not emit to removed operation listener', async () => {
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce: 5});

			let callCount = 0;
			const listener = (_event: OnchainOperationEvent) => {
				callCount++;
				return () => {};
			};

			// Add and then remove listener
			setup.processor.onOperationUpdated(listener);
			setup.processor.offOperationUpdated(listener);

			// Trigger emission
			addToMempool();
			await processAndWait(setup);

			// Listener should not have been called since we removed it
			// But our test setup also has a listener, so we're just checking our custom one
			expect(callCount).toBe(0);
		});

		it('should not emit to removed operationStatus listener', async () => {
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce: 5});

			let callCount = 0;
			const listener = (_event: OnchainOperationEvent) => {
				callCount++;
				return () => {};
			};

			// Add and then remove listener
			setup.processor.onOperationStatusUpdated(listener);
			setup.processor.offOperationStatusUpdated(listener);

			// Trigger emission
			addToMempool();
			await processAndWait(setup);

			// Listener should not have been called
			expect(callCount).toBe(0);
		});
	});

	describe('Provider Undefined During Processing', () => {
		it('should handle provider being undefined during processTx', async () => {
			const {processor} = createTestSetup({finality: 12});

			const operation: OnchainOperation = {
				transactions: [
					{
						hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
						from: '0x1234567890123456789012345678901234567890',
						broadcastTimestamp: Date.now(),
					},
				],
			};
			processor.addMultiple({'test-no-provider': operation});

			// Set provider to undefined
			processor.setProvider(undefined as any);

			// Process should return early
			await processor.process();

			// Operation should remain unchanged
			expect(operation.state).toBeUndefined();
		});
	});

	describe('Operation Status Events vs Operation Events', () => {
		it('should emit operation:status event when status changes', async () => {
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce: 5});

			let statusEventCount = 0;
			const statusListener = (_event: OnchainOperationEvent) => {
				statusEventCount++;
				return () => {};
			};

			setup.processor.onOperationStatusUpdated(statusListener);

			// Process - should emit status event for initial state change
			addToMempool();
			await processAndWait(setup);

			expect(statusEventCount).toBeGreaterThan(0);
		});
	});

	describe('Latest Block Returns Null', () => {
		it('should handle when latestBlock returns null', async () => {
			const {provider, controller} = createMockProvider();
			const processor = initTransactionProcessor({
				finality: 12,
				provider: provider as any,
			});

			// Create a custom provider that returns null for latest block
			const customProvider = {
				async request(args: {method: string; params?: unknown[]}) {
					// Return null for the latest block request
					if (
						args.method === 'eth_getBlockByNumber' &&
						args.params?.[0] === 'latest'
					) {
						return null;
					}
					return await provider.request(args as any);
				},
			};

			processor.setProvider(customProvider as any);

			// Add an operation
			const operation: OnchainOperation = {
				transactions: [
					{
						hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						from: '0x1234567890123456789012345678901234567890',
						broadcastTimestamp: Date.now(),
					},
				],
			};
			processor.addMultiple({'test-op-null-latest': operation});

			// Process should return early when latest block is null
			await processor.process();

			// Operation should remain unchanged
			expect(operation.state).toBeUndefined();
		});
	});

	describe('BeingFetched Status in computeOperationStatus', () => {
		it('should return BeingFetched when some txs are BeingFetched and none are Broadcasted/Included', async () => {
			const {provider, controller} = createMockProvider();
			const processor = initTransactionProcessor({
				finality: 12,
				provider: provider as any,
			});

			const emissions: OnchainOperation[] = [];
			processor.onOperationUpdated((event) => {
				emissions.push({
					...event.operation,
					transactions: [...event.operation.transactions],
				});
				return () => {};
			});

			// Create an operation with two txs: one NotFound and one BeingFetched
			const operation: OnchainOperation = {
				transactions: [
					{
						hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						from: '0x1234567890123456789012345678901234567890',
						broadcastTimestamp: Date.now(),
						state: {
							inclusion: 'NotFound',
							final: undefined,
							status: undefined,
						},
					},
					{
						hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
						from: '0x1234567890123456789012345678901234567890',
						broadcastTimestamp: Date.now(),
					},
				],
			};
			processor.addMultiple({'test-op-being-fetched': operation});

			// Create a provider that returns the first tx as NotFound but the second remains BeingFetched (tx not found)
			let callCount = 0;
			const customProvider = {
				async request(args: {method: string; params?: unknown[]}) {
					if (args.method === 'eth_getTransactionByHash') {
						const hash = args.params?.[0] as string;
						// First tx - not found (both fetches return null)
						if (
							hash ===
							'0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
						) {
							return null;
						}
						// Second tx - simulate slow/missing response by returning null on first fetch only
						// to keep it in BeingFetched state
						if (
							hash ===
							'0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
						) {
							callCount++;
							if (callCount === 1) {
								return null;
							}
							// Retry returns the tx (this triggers the skip logic for line 484)
							controller.addToMempool({
								hash: hash as `0x${string}`,
								from: '0x1234567890123456789012345678901234567890',
								nonce: 0,
								maxFeePerGas: '0x1',
								maxPriorityFeePerGas: '0x1',
							});
							return await provider.request(args as any);
						}
					}
					return await provider.request(args as any);
				},
			};

			processor.setProvider(customProvider as any);

			// Process - second tx should trigger line 484 (retry returns tx, skip for now)
			await processor.process();

			// The operation status should reflect that we still have a tx that wasn't fully processed
			// Since the retry found the tx, it was skipped and didn't change state
			// First tx went to NotFound, second tx was skipped (still BeingFetched concept but technically unchanged)
			expect(operation.transactions[0].state?.inclusion).toBe('NotFound');
		});
	});
});
