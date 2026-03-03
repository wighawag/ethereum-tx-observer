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
	assertOperationDropped,
	assertOperationFinalized,
	assertTxInclusion,
	assertOperationTxCount,
	assertOperationIncluded,
} from '../helpers/assertions.js';
import {resetHashCounter, TEST_ACCOUNT} from '../fixtures/transactions.js';
import {resetOpIdCounter} from '../fixtures/operations.js';

describe('Dropped Transaction Scenarios', () => {
	let setup: TestSetup;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();
		setup = createTestSetup({finality: 12});
	});

	afterEach(() => {
		setup.cleanup();
	});

	describe('Drop Detection', () => {
		it('dropped-nonce-consumed: Tx nonce is less than account nonce at finalized block', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const txHash = operation.transactions[0].hash;
			const account = operation.transactions[0].from;

			// Add to mempool and process
			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Tx disappears from mempool
			setup.controller.removeFromMempool(txHash);
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// External transaction consumes the nonce
			// Set account nonce higher than tx nonce
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			// Operation should now be Dropped
			assertOperationDropped(operation);
			assertOperationFinalized(operation);
		});

		it('dropped-all-txs: All txs in operation are dropped', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			const account = operation.transactions[0].from;

			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2 with same nonce
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: account,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2ToMempool();
			await processAndWait(setup);

			// Both txs disappear from mempool
			setup.controller.removeFromMempool(tx1Hash);
			setup.controller.removeFromMempool(tx2Hash);
			await processAndWait(setup);

			// External transaction consumes the nonce
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			// Operation should be Dropped (all txs dropped)
			assertOperationDropped(operation);
			assertTxInclusion(operation.transactions[0], 'Dropped');
			assertTxInclusion(operation.transactions[1], 'Dropped');
		});

		it('dropped-one-of-many: One tx dropped, another still active', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			const account = operation.transactions[0].from;

			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2 with different nonce (can both be valid)
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: nonce + 1,
					from: account,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2ToMempool();
			await processAndWait(setup);

			// TX1 disappears, nonce consumed externally
			setup.controller.removeFromMempool(tx1Hash);
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			// TX1 is dropped but TX2 is still active
			assertTxInclusion(operation.transactions[0], 'Dropped');
			assertTxInclusion(operation.transactions[1], 'InMemPool');

			// Operation should NOT be Dropped - still has active tx
			assertOperationInclusion(operation, 'InMemPool');
		});

		it('dropped-external-tx: Nonce consumed by tx not in our operation', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Simulate external tx consuming nonce:
			// 1. Our tx disappears from mempool
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			// 2. Account nonce advances (external tx was included)
			setup.controller.setAccountNonce(account, nonce + 1);

			await processAndWait(setup);

			// Our tx should be detected as dropped
			assertOperationDropped(operation);
		});

		it('dropped-timing: Drop detected with correct final timestamp', async () => {
			const nonce = 5;
			const broadcastTimestamp = Date.now();

			// Create operation with tx that has specific broadcast timestamp
			const {operation, addToMempool} = addSingleTxOperation(setup, {
				nonce,
				broadcastTimestamp,
			});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);

			// Remove from mempool and consume nonce
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			// Should be dropped with final timestamp
			assertOperationDropped(operation);
			expect(operation.state?.final).toBeDefined();
			// Final should be the broadcast timestamp (from the tx)
			expect(operation.state?.final).toBe(broadcastTimestamp);
		});
	});

	describe('Not Found vs Dropped Distinction', () => {
		it('notfound-temporary: Tx temporarily not visible, nonce still valid', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Tx disappears but nonce still valid (not consumed)
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			// Account nonce stays at nonce (not advanced)
			setup.controller.setAccountNonce(account, nonce);
			await processAndWait(setup);

			// Should be NotFound, not Dropped
			assertOperationInclusion(operation, 'NotFound');
			expect(operation.state?.final).toBeUndefined();
		});

		it('notfound-to-dropped: Tx not found, then nonce consumed', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);

			// Tx disappears, nonce still valid
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			setup.controller.setAccountNonce(account, nonce);
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// Later, nonce gets consumed
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			// Should transition to Dropped
			assertOperationDropped(operation);
		});

		it('notfound-to-broadcasted: Tx reappears in mempool', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});

			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Tx temporarily disappears
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// Tx reappears (e.g., mempool resynced)
			addToMempool();
			await processAndWait(setup);

			// Should be back to Broadcasted
			assertOperationInclusion(operation, 'InMemPool');
		});

		it('notfound-to-included: Tx not in mempool but appears in block', async () => {
			const nonce = 5;

			// Create operation with tx
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const txHash = operation.transactions[0].hash;

			addToMempool();
			await processAndWait(setup);

			// Tx disappears from mempool
			setup.controller.removeFromMempool(txHash);
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// But then it appears in a block (was mined while we weren't looking)
			// Re-add to mempool so includeTx can find it
			addToMempool();
			setup.controller.includeTx(txHash, 'success');
			await processAndWait(setup);

			// Should be Included
			assertOperationIncluded(operation, 'Success');
		});
	});

	describe('Multiple Account Scenarios', () => {
		it('should handle operations from different accounts independently', async () => {
			const nonce1 = 5;
			const nonce2 = 3;

			// Operation 1 from account 1
			const {operation: op1, addToMempool: addTx1} = addSingleTxOperation(
				setup,
				{
					nonce: nonce1,
					from: TEST_ACCOUNT,
				},
			);

			// Operation 2 from account 2
			const account2 = '0xabcdef1234567890123456789012345678901234' as const;
			const {operation: op2, addToMempool: addTx2} = addSingleTxOperation(
				setup,
				{
					nonce: nonce2,
					from: account2,
				},
			);

			addTx1();
			addTx2();
			await processAndWait(setup);

			// Both should be broadcasted
			assertOperationInclusion(op1, 'InMemPool');
			assertOperationInclusion(op2, 'InMemPool');

			// Drop op1's tx
			setup.controller.removeFromMempool(op1.transactions[0].hash);
			setup.controller.setAccountNonce(TEST_ACCOUNT, nonce1 + 1);
			await processAndWait(setup);

			// Op1 should be dropped, op2 still broadcasted
			assertOperationDropped(op1);
			assertOperationInclusion(op2, 'InMemPool');
		});
	});

	describe('Edge Cases', () => {
		it('should handle nonce 0 correctly', async () => {
			const nonce = 0;

			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Remove and consume nonce 0
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			setup.controller.setAccountNonce(account, 1);
			await processAndWait(setup);

			assertOperationDropped(operation);
		});

		it('should handle very high nonces', async () => {
			const nonce = 999999;

			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const account = operation.transactions[0].from;

			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Remove and consume high nonce
			setup.controller.removeFromMempool(operation.transactions[0].hash);
			setup.controller.setAccountNonce(account, nonce + 1);
			await processAndWait(setup);

			assertOperationDropped(operation);
		});
	});
});
