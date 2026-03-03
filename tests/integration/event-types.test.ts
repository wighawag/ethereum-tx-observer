/**
 * Tests for the dual-event system:
 * - 'operation' event: fires when any TX in the operation changes (for persistence)
 * - 'operation:status' event: fires only when operation status changes (for UI/state)
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

describe('Event Types', () => {
	let processor: ReturnType<typeof initTransactionProcessor>;
	let controller: MockProviderController;
	let operationEmissions: OnchainOperation[];
	let statusEmissions: OnchainOperation[];
	let cleanupOperation: () => void;
	let cleanupStatus: () => void;

	beforeEach(() => {
		resetHashCounter();
		resetOpIdCounter();

		const {provider, controller: ctrl} = createMockProvider();
		controller = ctrl;

		processor = initTransactionProcessor({
			finality: 12,
			provider,
		});

		operationEmissions = [];
		statusEmissions = [];

		// Listen to both event types
		cleanupOperation = processor.onOperationUpdated((event) => {
			operationEmissions.push(structuredClone(event.operation));
			return () => {};
		});

		cleanupStatus = processor.onOperationStatusUpdated((event) => {
			statusEmissions.push(structuredClone(event.operation));
			return () => {};
		});
	});

	afterEach(() => {
		cleanupOperation();
		cleanupStatus();
	});

	describe('operation vs operation:status events', () => {
		it('should emit both events when operation status changes', async () => {
			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'dual-emit': op});

			// First process: BeingFetched -> Broadcasted (status change)
			await processor.process();

			// Both events should fire for initial status change
			expect(operationEmissions.length).toBe(1);
			expect(statusEmissions.length).toBe(1);

			expect(operationEmissions[0].state?.inclusion).toBe('InMemPool');
			expect(statusEmissions[0].state?.inclusion).toBe('InMemPool');
		});

		it('should emit operation but NOT operation:status when only TX changes without status change', async () => {
			/**
			 * Scenario:
			 * - Operation has TX1 (Broadcasted) and TX2 (Broadcasted)
			 * - TX1 becomes Included (Success)
			 * - TX2 also becomes Included (Success)
			 *
			 * After TX1 inclusion:
			 * - Operation status: Included (changed)
			 * - Both events fire
			 *
			 * After TX2 inclusion:
			 * - Operation status: still Included (no change)
			 * - Only 'operation' event fires (TX2 changed)
			 * - 'operation:status' does NOT fire (status unchanged)
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const tx2 = createBroadcastedTx({nonce: 6, from: TEST_ACCOUNT});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
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
			processor.addMultiple({'multi-tx-event': op});

			// First process: both become Broadcasted
			await processor.process();
			expect(op.state?.inclusion).toBe('InMemPool');

			const opCountAfterBroadcast = operationEmissions.length;
			const statusCountAfterBroadcast = statusEmissions.length;

			// Include TX1 - operation becomes Included
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);
			await processor.process();

			expect(op.state?.inclusion).toBe('Included');
			expect(op.state?.txIndex).toBe(0); // TX1

			const opCountAfterTx1Include = operationEmissions.length;
			const statusCountAfterTx1Include = statusEmissions.length;

			// Both events should have fired (status changed to Included)
			expect(opCountAfterTx1Include).toBeGreaterThan(opCountAfterBroadcast);
			expect(statusCountAfterTx1Include).toBeGreaterThan(
				statusCountAfterBroadcast,
			);

			// Now include TX2 - operation is STILL Included (no status change)
			controller.includeTx(tx2.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 7);
			await processor.process();

			// TX2 should now be Included
			expect(op.transactions[1].state?.inclusion).toBe('Included');

			// 'operation' event should fire (TX2 changed)
			expect(operationEmissions.length).toBeGreaterThan(opCountAfterTx1Include);

			// 'operation:status' should NOT fire (status still Included)
			// Note: txIndex might change if TX2 is also successful, but status doesn't change
			// Actually, txIndex won't change because TX1 was first success
			expect(statusEmissions.length).toBe(statusCountAfterTx1Include);
		});

		it('should not emit either event when nothing changes', async () => {
			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'no-change': op});

			await processor.process();
			expect(op.state?.inclusion).toBe('InMemPool');

			const opCountBefore = operationEmissions.length;
			const statusCountBefore = statusEmissions.length;

			// Process again with no changes
			await processor.process();

			// No new events
			expect(operationEmissions.length).toBe(opCountBefore);
			expect(statusEmissions.length).toBe(statusCountBefore);
		});

		it('should emit operation event when TX finality changes', async () => {
			/**
			 * When a TX becomes final:
			 * - 'operation' fires (TX changed)
			 * - 'operation:status' may or may not fire depending on if final affects status
			 */

			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'finality-test': op});
			await processor.process();

			// Include TX1
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);
			await processor.process();

			expect(op.state?.inclusion).toBe('Included');
			expect(op.transactions[0].state?.final).toBeUndefined(); // Not final yet

			const opCountBefore = operationEmissions.length;
			const statusCountBefore = statusEmissions.length;

			// Advance blocks past finality threshold (12 blocks)
			controller.advanceBlocks(15);

			await processor.process();

			// TX should now be final
			expect(op.transactions[0].state?.final).toBeDefined();

			// 'operation' event should fire (TX finality changed)
			expect(operationEmissions.length).toBeGreaterThan(opCountBefore);

			// 'operation:status' should also fire (final field changed)
			expect(statusEmissions.length).toBeGreaterThan(statusCountBefore);
		});
	});

	describe('offOperationStatus', () => {
		it('should stop receiving operation:status events after unsubscribe', async () => {
			const tx1 = createBroadcastedTx({nonce: 5});
			const mockTx1 = createMockTx({
				hash: tx1.hash,
				from: tx1.from,
				nonce: 5,
			});
			const op = createOperation({transactions: [tx1]});

			controller.addToMempool(mockTx1);
			processor.addMultiple({'unsub-test': op});

			// First process triggers events
			await processor.process();
			expect(statusEmissions.length).toBe(1);

			// Unsubscribe from status events
			cleanupStatus();

			// Include TX1 - triggers status change
			controller.includeTx(tx1.hash, 'success');
			controller.setAccountNonce(TEST_ACCOUNT, 6);
			await processor.process();

			// Status emissions should NOT increase (unsubscribed)
			expect(statusEmissions.length).toBe(1);

			// But operation emissions should still work
			expect(operationEmissions.length).toBeGreaterThan(1);
		});
	});
});
