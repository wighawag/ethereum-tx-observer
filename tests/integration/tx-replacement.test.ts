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
	assertOperationContainsTx,
	assertWinningTx,
	assertTxInclusion,
	assertOperationTxCount,
} from '../helpers/assertions.js';
import {resetHashCounter, TEST_ACCOUNT} from '../fixtures/transactions.js';
import {resetOpIdCounter} from '../fixtures/operations.js';

describe('Transaction Replacement Scenarios', () => {
	let setup: TestSetup;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();
		setup = createTestSetup({finality: 12});
	});

	afterEach(() => {
		setup.cleanup();
	});

	describe('Basic Replacement', () => {
		it('replacement-basic-success: TX1 replaced by TX2 with higher gas, TX2 succeeds', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {
				nonce,
			});
			const tx1Hash = operation.transactions[0].hash;

			// TX1 appears in mempool
			addTx1ToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Add replacement TX2 with higher gas
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;

			// TX2 replaces TX1 in mempool
			setup.controller.removeFromMempool(tx1Hash);
			addTx2ToMempool();
			await processAndWait(setup);

			// Operation should still be broadcasted with 2 txs
			assertOperationInclusion(operation, 'InMemPool');
			assertOperationTxCount(operation, 2);

			// TX2 gets included (this consumes nonce 5)
			setup.controller.includeTx(tx2Hash, 'success');
			// Set account nonce to nonce+1 to reflect that nonce was consumed
			setup.controller.setAccountNonce(TEST_ACCOUNT, nonce + 1);
			await processAndWait(setup);

			// Operation should be Included/Success with TX2 as winner
			assertOperationIncluded(operation, 'Success');
			assertWinningTx(operation, tx2Hash);

			// TX1 should be Dropped (nonce consumed)
			const tx1 = operation.transactions.find((t) => t.hash === tx1Hash);
			expect(tx1).toBeDefined();
			assertTxInclusion(tx1!, 'Dropped');
		});

		it('replacement-original-wins: TX1 with lower gas gets included first', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {
				nonce,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2 with higher gas
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2ToMempool();
			await processAndWait(setup);

			// TX1 gets included first (miner preference scenario)
			setup.controller.removeFromMempool(tx2Hash);
			setup.controller.includeTx(tx1Hash, 'success');
			// Set account nonce to nonce+1 to reflect that nonce was consumed
			setup.controller.setAccountNonce(TEST_ACCOUNT, nonce + 1);
			await processAndWait(setup);

			// Operation should be Included/Success with TX1 as winner
			assertOperationIncluded(operation, 'Success');
			assertWinningTx(operation, tx1Hash);

			// TX2 should be Dropped (nonce consumed)
			const tx2Found = operation.transactions.find((t) => t.hash === tx2Hash);
			expect(tx2Found).toBeDefined();
			assertTxInclusion(tx2Found!, 'Dropped');
		});

		it('replacement-both-broadcast: Both TX1 and TX2 visible in mempool briefly', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Add TX2 - both in mempool simultaneously
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			addTx2ToMempool();
			await processAndWait(setup);

			// Both txs should be tracked, operation still Broadcasted
			assertOperationTxCount(operation, 2);
			assertOperationInclusion(operation, 'InMemPool');

			// Both txs should be Broadcasted
			assertTxInclusion(operation.transactions[0], 'InMemPool');
			assertTxInclusion(operation.transactions[1], 'InMemPool');
		});

		it('replacement-failure-fallback: TX2 replaces TX1, but TX2 fails', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2 with higher gas
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			setup.controller.removeFromMempool(tx1Hash);
			addTx2ToMempool();
			await processAndWait(setup);

			// TX2 gets included but fails
			setup.controller.includeTx(tx2Hash, 'failure');
			await processAndWait(setup);

			// Operation should be Included/Failure with TX2 as (losing) winner
			assertOperationIncluded(operation, 'Failure');
			assertWinningTx(operation, tx2Hash);
		});

		it('replacement-chain-of-three: TX1 → TX2 → TX3 progressive gas bumping', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {
				nonce,
			});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			setup.controller.removeFromMempool(tx1Hash);
			addTx2ToMempool();
			await processAndWait(setup);

			// Add TX3
			const {newTx: tx3, addToMempool: addTx3ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx3Hash = tx3.hash;
			setup.controller.removeFromMempool(tx2Hash);
			addTx3ToMempool();
			await processAndWait(setup);

			// Operation should have 3 txs
			assertOperationTxCount(operation, 3);
			assertOperationInclusion(operation, 'InMemPool');

			// TX3 gets included (consumes nonce 5)
			setup.controller.includeTx(tx3Hash, 'success');
			// Set account nonce to nonce+1 to reflect that nonce was consumed
			setup.controller.setAccountNonce(TEST_ACCOUNT, nonce + 1);
			await processAndWait(setup);

			assertOperationIncluded(operation, 'Success');
			assertWinningTx(operation, tx3Hash);

			// TX1 and TX2 should be Dropped (nonce consumed)
			assertTxInclusion(operation.transactions[0], 'Dropped');
			assertTxInclusion(operation.transactions[1], 'Dropped');
		});
	});

	describe('Race Conditions in Replacement', () => {
		it('replacement-simultaneous-update: Both txs change status in same process call', async () => {
			const nonce = 5;

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();

			// Add TX2 without processing yet
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce,
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2ToMempool();

			// Process - both should be discovered simultaneously
			await processAndWait(setup);

			assertOperationTxCount(operation, 2);
			assertOperationInclusion(operation, 'InMemPool');
		});

		it('replacement-flapping: TX appears/disappears from mempool intermittently', async () => {
			const nonce = 5;

			// Create operation with TX
			const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
			const txHash = operation.transactions[0].hash;

			// Appear in mempool
			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Disappear from mempool
			setup.controller.removeFromMempool(txHash);
			await processAndWait(setup);
			assertOperationInclusion(operation, 'NotFound');

			// Reappear in mempool
			addToMempool();
			await processAndWait(setup);
			assertOperationInclusion(operation, 'InMemPool');

			// Finally get included
			setup.controller.includeTx(txHash, 'success');
			await processAndWait(setup);
			assertOperationIncluded(operation, 'Success');
		});
	});

	describe('Mixed Success/Failure Scenarios', () => {
		it('should prioritize success over failure when multiple txs are included', async () => {
			const nonce = 5;

			// This tests the merge logic: if one tx succeeds and another fails,
			// the operation should report success

			// Create operation with TX1
			const {
				operation,
				operationId,
				addToMempool: addTx1ToMempool,
			} = addSingleTxOperation(setup, {nonce});
			const tx1Hash = operation.transactions[0].hash;
			addTx1ToMempool();
			await processAndWait(setup);

			// Add TX2 with different nonce (so both can be included - edge case)
			const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
				setup,
				operationId,
				operation,
				{
					nonce: nonce + 1, // Different nonce
					from: TEST_ACCOUNT,
				},
			);
			const tx2Hash = tx2.hash;
			addTx2ToMempool();
			await processAndWait(setup);

			// TX1 fails
			setup.controller.includeTx(tx1Hash, 'failure');
			await processAndWait(setup);

			// Operation should be Included/Failure (only TX1 included so far)
			assertOperationIncluded(operation, 'Failure');

			// TX2 succeeds
			setup.controller.includeTx(tx2Hash, 'success');
			await processAndWait(setup);

			// Now operation should be Included/Success (success takes priority)
			assertOperationIncluded(operation, 'Success');
			assertWinningTx(operation, tx2Hash); // TX2 is the winning tx
		});
	});
});
