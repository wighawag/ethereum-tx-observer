import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
	createTestSetup,
	addSingleTxOperation,
	addReplacementTx,
	processAndWait,
	type TestSetup,
} from '../helpers/scenarios.js';
import {
	assertOperationInclusion,
	assertOperationIncluded,
	assertOperationDropped,
	assertOperationStatus,
} from '../helpers/assertions.js';
import {resetHashCounter, TEST_ACCOUNT} from '../fixtures/transactions.js';
import {resetOpIdCounter, createOperation} from '../fixtures/operations.js';
import {createBroadcastedTx} from '../fixtures/transactions.js';

describe('Operation Status Merging', () => {
	let setup: TestSetup;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();
		setup = createTestSetup({finality: 12});
	});

	afterEach(() => {
		setup.cleanup();
	});

	describe('Status Priority', () => {
		it('merge-all-broadcasted: All txs in mempool → Broadcasted', async () => {
			// Create operation with multiple txs
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			addTx1();

			const {addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			addTx2();

			await processAndWait(setup);

			assertOperationInclusion(operation, 'InMemPool');
		});

		it('merge-one-included-success: One tx succeeded, others pending → Included/Success', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			addTx2();

			await processAndWait(setup);

			// Include TX1 as success
			setup.controller.includeTx(tx1Hash, 'success');
			await processAndWait(setup);

			// Operation should be Included/Success (one success wins)
			assertOperationIncluded(operation, 'Success');
			expect(operation.state?.txIndex).toBe(0);
		});

		it('merge-one-included-failure: One tx failed, others pending → Included/Failure', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			addTx2();

			await processAndWait(setup);

			// Include TX1 as failure
			setup.controller.includeTx(tx1Hash, 'failure');
			await processAndWait(setup);

			// Operation should be Included/Failure
			assertOperationIncluded(operation, 'Failure');
		});

		it('merge-mixed-included: One success, one failure → Included/Success', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			await processAndWait(setup);

			// TX1 fails
			setup.controller.includeTx(tx1Hash, 'failure');
			await processAndWait(setup);

			// TX2 succeeds
			setup.controller.includeTx(tx2Hash, 'success');
			await processAndWait(setup);

			// Success should win over failure
			assertOperationIncluded(operation, 'Success');
			expect(operation.state?.txIndex).toBe(1); // TX2 index
		});

		it('merge-all-dropped: All txs dropped → Dropped', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 5, // Same nonce
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			await processAndWait(setup);

			// Remove both from mempool
			setup.controller.removeFromMempool(tx1Hash);
			setup.controller.removeFromMempool(tx2Hash);

			// Consume nonce externally
			setup.controller.setAccountNonce(TEST_ACCOUNT, 6);
			await processAndWait(setup);

			assertOperationDropped(operation);
		});

		it('merge-priority-order: Included > Broadcasted > BeingFetched > NotFound > Dropped', async () => {
			// Test that included status takes priority over all others

			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;

			// TX1 not in mempool yet
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// Add TX2 to mempool
			const {addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			addTx2();
			await processAndWait(setup);

			// Should be Broadcasted (TX2 is broadcasted, TX1 is NotFound)
			assertOperationInclusion(operation, 'InMemPool');

			// Include TX1 directly (skipping mempool)
			addTx1();
			setup.controller.includeTx(tx1Hash, 'success');
			await processAndWait(setup);

			// Should be Included (highest priority)
			assertOperationIncluded(operation, 'Success');
		});
	});

	describe('Transaction Index Selection', () => {
		it('should select first successful tx as txIndex', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			const {newTx: tx3, addToMempool: addTx3} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 7,
					from: TEST_ACCOUNT,
				},
			);
			const tx3Hash = tx3.hash;
			addTx3();

			await processAndWait(setup);

			// TX2 succeeds first (middle tx)
			setup.controller.includeTx(tx2Hash, 'success');
			await processAndWait(setup);

			// txIndex should point to TX2 (index 1)
			expect(operation.state?.txIndex).toBe(1);
			expect(operation.transactions[operation.state?.txIndex!].hash).toBe(
				tx2Hash,
			);
		});

		it('should select first failure if no success', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			await processAndWait(setup);

			// TX2 fails first
			setup.controller.includeTx(tx2Hash, 'failure');
			await processAndWait(setup);

			// TX1 also fails
			setup.controller.includeTx(tx1Hash, 'failure');
			await processAndWait(setup);

			// txIndex should point to first failure (TX1, index 0)
			expect(operation.state?.txIndex).toBe(0);
		});

		it('should update txIndex when success arrives after failure', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			await processAndWait(setup);

			// TX1 fails
			setup.controller.includeTx(tx1Hash, 'failure');
			await processAndWait(setup);
			expect(operation.state?.txIndex).toBe(0);

			// TX2 succeeds
			setup.controller.includeTx(tx2Hash, 'success');
			await processAndWait(setup);

			// txIndex should now point to success (TX2)
			expect(operation.state?.txIndex).toBe(1);
		});
	});

	describe('Finality Handling', () => {
		it('should use most recent final timestamp from included txs', async () => {
			const {
				operation,
				operationId,
				addToMempool: addTx1,
			} = addSingleTxOperation(setup, {
				nonce: 5,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1();

			const {newTx: tx2, addToMempool: addTx2} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: 6,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2();

			await processAndWait(setup);

			// Include TX1
			setup.controller.includeTx(tx1Hash, 'success');
			await processAndWait(setup);

			// Include TX2 in next block
			setup.controller.includeTx(tx2Hash, 'success');
			await processAndWait(setup);

			// Advance to finality for both
			setup.controller.advanceBlocks(12);
			await processAndWait(setup);

			// Operation should be finalized
			expect(operation.state?.final).toBeDefined();
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty transactions array', async () => {
			const op = createOperation({
				transactions: [],
			});

			setup.processor.addMultiple({'test-empty': op});
			await processAndWait(setup);

			// With no transactions, the operation stays at initial state
			// (no txs to process means no status change)
			expect(op.state).toBeUndefined();
		});

		it('should handle single transaction operation', async () => {
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce: 5});

			addToMempool();
			await processAndWait(setup);

			assertOperationInclusion(operation, 'InMemPool');
			expect(operation.transactions).toHaveLength(1);
		});

		it('should deduplicate transactions with same hash', async () => {
			const tx = createBroadcastedTx({nonce: 5});
			const op = createOperation({
				transactions: [tx],
			});

			setup.processor.addMultiple({'dedup-test': op});

			// Try to add same tx again
			setup.processor.addMultiple({
				'dedup-test': {
					...op,
					transactions: [tx], // Same tx
				},
			});

			// Should still have only one tx
			expect(op.transactions).toHaveLength(1);
		});

		it('should merge operations with same ID', async () => {
			const tx1 = createBroadcastedTx({nonce: 5});
			const op = createOperation({
				transactions: [tx1],
			});

			setup.processor.addMultiple({'same-op-id': op});

			// Add another tx to same operation
			const tx2 = createBroadcastedTx({nonce: 6});
			setup.processor.addMultiple({
				'same-op-id': {
					transactions: [tx2],
				},
			});

			// Should have both txs
			expect(op.transactions).toHaveLength(2);
			expect(op.transactions[0].hash).toBe(tx1.hash);
			expect(op.transactions[1].hash).toBe(tx2.hash);
		});
	});
});
