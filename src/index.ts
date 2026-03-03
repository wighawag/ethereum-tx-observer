import type {
	EIP1193Provider,
	EIP1193Block,
	EIP1193ProviderWithoutEvents,
} from 'eip-1193';
import {logs} from 'named-logs';
import {throttle} from 'lodash-es';
import {Emitter} from 'radiate';
const logger = logs('tx-observer');

export type BroadcastedTransactionInclusion =
	| 'InMemPool'
	| 'NotFound'
	| 'Dropped'
	| 'Included';

export type BroadcastedTransactionState =
	| {
			inclusion: 'InMemPool' | 'NotFound';
			final: undefined;
			status: undefined;
	  }
	| {
			inclusion: 'Dropped';
			final?: number;
			status: undefined;
	  }
	| {
			inclusion: 'Included';
			status: 'Failure' | 'Success';
			final?: number;
	  };

export type BroadcastedTransaction = {
	readonly hash: `0x${string}`;
	readonly from: `0x${string}`;
	nonce?: number;
	readonly broadcastTimestamp: number;
	state?: BroadcastedTransactionState;
};

/**
 * Operation status represents the merged status of all transactions in an operation.
 * - txIndex: index into transactions[] for the "winning" tx (first success, or first failure if all failed)
 * - The hash can be retrieved via: operation.transactions[operation.txIndex].hash
 */
export type OnchainOperationStatus =
	| {
			inclusion: 'InMemPool' | 'NotFound';
			final: undefined;
			status: undefined;
			txIndex: undefined;
	  }
	| {
			inclusion: 'Dropped';
			final?: number;
			status: undefined;
			txIndex: undefined;
	  }
	| {
			inclusion: 'Included';
			status: 'Failure' | 'Success';
			final?: number;
			txIndex: number;
	  };

export type OnchainOperation = {
	transactions: BroadcastedTransaction[];
	state?: OnchainOperationStatus;

	// TODO, use these to detect out of band inclusion
	expectedUpdate?:
		| {
				event: {topics: `0x${string}`[]};
		  }
		| {
				functionCall: {name: string; result: `0x${string}`};
		  };
};

/**
 * Event payload that includes both the operation ID and the operation data.
 */
export type OnchainOperationEvent = {
	id: string;
	operation: OnchainOperation;
};

/**
 * Event payload for adding operations
 */
export type OnchainOperationsAddedEvent = {
	[id: string]: OnchainOperation;
};

/**
 * Compute the merged operation status from all its transactions.
 *
 * Priority order (highest wins):
 * 1. Included - At least one tx is included in a block
 * 2. Broadcasted - At least one tx is active in mempool
 * 4. NotFound - None visible in mempool
 * 5. Dropped - ALL txs are dropped (operation failed)
 *
 * For Included status:
 * - If ANY tx succeeded → status: Success
 * - If ALL included txs failed → status: Failure
 * - txIndex points to first success, or first failure if all failed
 */
function computeOperationStatus(op: OnchainOperation): OnchainOperationStatus {
	const txs = op.transactions;

	// Check for any Included txs - find index of first success, or first failure
	let winningIndex = -1;
	let hasSuccess = false;

	for (let i = 0; i < txs.length; i++) {
		const tx = txs[i];
		if (tx.state?.inclusion === 'Included') {
			if (tx.state.status === 'Success') {
				winningIndex = i;
				hasSuccess = true;
				break; // First success wins
			} else if (winningIndex === -1) {
				winningIndex = i; // First failure as fallback
			}
		}
	}

	if (winningIndex >= 0) {
		// Determine finality - use the most final timestamp from included txs
		const includedTxs = txs.filter((tx) => tx.state?.inclusion === 'Included');
		let finalTimestamp: number | undefined;
		for (const tx of includedTxs) {
			if (tx.state?.final !== undefined) {
				if (finalTimestamp === undefined || tx.state.final > finalTimestamp) {
					finalTimestamp = tx.state.final;
				}
			}
		}

		return {
			inclusion: 'Included',
			status: hasSuccess ? 'Success' : 'Failure',
			final: finalTimestamp,
			txIndex: winningIndex,
		};
	}

	// Check for any Broadcasted
	if (txs.some((tx) => tx.state?.inclusion === 'InMemPool')) {
		return {
			inclusion: 'InMemPool',
			final: undefined,
			status: undefined,
			txIndex: undefined,
		};
	}

	// Check for any NotFound
	if (txs.some((tx) => tx.state?.inclusion === 'NotFound')) {
		return {
			inclusion: 'NotFound',
			final: undefined,
			status: undefined,
			txIndex: undefined,
		};
	}

	// All must be Dropped - find earliest dropped timestamp
	let droppedTimestamp: number | undefined;
	for (const tx of txs) {
		if (tx.state?.final !== undefined) {
			if (droppedTimestamp === undefined || tx.state.final < droppedTimestamp) {
				droppedTimestamp = tx.state.final;
			}
		}
	}

	return {
		inclusion: 'Dropped',
		final: droppedTimestamp,
		status: undefined,
		txIndex: undefined,
	};
}

/**
 * Update an operation's status fields from a computed status.
 * This mutates the operation in place.
 */
function applyOperationStatus(
	op: OnchainOperation,
	newState: OnchainOperationStatus,
): void {
	if (!op.state) {
		op.state = newState;
	}
	op.state.inclusion = newState.inclusion;
	op.state.final = newState.final;
	op.state.status = newState.status;
	op.state.txIndex = newState.txIndex;
}

/**
 * Check if operation status has changed.
 */
function hasOperationStatusChanged(
	op: OnchainOperation,
	newStatus: OnchainOperationStatus,
): boolean {
	if (!op.state) {
		return true;
	}
	return (
		op.state.inclusion !== newStatus.inclusion ||
		op.state.final !== newStatus.final ||
		op.state.status !== newStatus.status ||
		op.state.txIndex !== newStatus.txIndex
	);
}

export function initTransactionProcessor(config: {
	finality: number;
	throttle?: number;
	provider?: EIP1193ProviderWithoutEvents;
}) {
	const emitter = new Emitter<{
		// Fires when any TX in the operation changes (for persistence)
		operation: OnchainOperationEvent;
		// Fires only when operation status changes (for UI/state updates)
		'operation:status': OnchainOperationEvent;
		'operations:added': OnchainOperationsAddedEvent;
	}>();

	let provider: EIP1193ProviderWithoutEvents | undefined = config.provider;
	const opsById: {[id: string]: OnchainOperation} = {};
	// Maintain tx hash lookup for efficient updates
	const txToOp: {[txHash: string]: OnchainOperation} = {};

	function addMultiple(operations: {[id: string]: OnchainOperation}) {
		logger.debug(`adding ${Object.keys(operations).length} operations...`);
		for (const entry of Object.entries(operations)) {
			_add(entry[0], entry[1]);
		}
		if (emitter.hasListeners('operations:added')) {
			emitter.emit('operations:added', structuredClone(operations));
		}
	}

	function _add(id: string, operationToAdd: OnchainOperation) {
		const operation = structuredClone(operationToAdd);
		logger.debug(`adding operation ${id}...`);
		const existing = opsById[id];
		if (!existing) {
			opsById[id] = operation;
			// Index all tx hashes for this operation
			for (const tx of operation.transactions) {
				txToOp[tx.hash] = operation;
			}
		} else {
			// Update existing operation - merge transactions
			for (const tx of operation.transactions) {
				if (!txToOp[tx.hash]) {
					existing.transactions.push(tx);
					txToOp[tx.hash] = existing;
				}
			}
		}
	}

	function add(id: string, operationToAdd: OnchainOperation) {
		_add(id, operationToAdd);
		if (emitter.hasListeners('operations:added')) {
			emitter.emit('operations:added', {[id]: structuredClone(operationToAdd)});
		}
	}

	function clear() {
		logger.debug(`clearing operations...`);
		const keys = Object.keys(opsById);
		for (const key of keys) {
			const op = opsById[key];
			for (const tx of op.transactions) {
				delete txToOp[tx.hash];
			}
			delete opsById[key];
		}
	}

	function remove(operationId: string) {
		logger.debug(`removing operation ${operationId}...`);
		const op = opsById[operationId];
		if (op) {
			// Remove tx hash mappings
			for (const tx of op.transactions) {
				delete txToOp[tx.hash];
			}
			delete opsById[operationId];
		}
	}

	async function process() {
		if (!provider) {
			return;
		}

		const latestBlock = await provider.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
		});

		if (!latestBlock) {
			return;
		}

		const latestBlockTime = Number(latestBlock.timestamp);
		const latestBlockNumber = Number(latestBlock.number);

		logger.debug(`latestBlock: ${latestBlockNumber}`);

		const latestFinalizedBlockNumber = Math.max(
			latestBlockNumber - config.finality,
			0,
		);

		const latestFinalizedBlock = await provider.request({
			method: 'eth_getBlockByNumber',
			params: [`0x${latestFinalizedBlockNumber.toString(16)}`, false],
		});

		if (!latestFinalizedBlock) {
			return;
		}
		const latestFinalizedBlockTime = Number(latestFinalizedBlock.timestamp);

		logger.debug(`latestFinalizedBlock: ${latestFinalizedBlockNumber}`);

		for (const id of Object.keys(opsById)) {
			await processOperation(id, opsById[id], {
				latestBlockNumber,
				latestBlockTime,
				latestFinalizedBlock,
				latestFinalizedBlockTime,
			});
			// TODO stop on clear ?
			// TODO stop on provider change ?
		}
	}

	async function processOperation(
		id: string,
		op: OnchainOperation,
		{
			latestBlockNumber,
			latestBlockTime,
			latestFinalizedBlock,
			latestFinalizedBlockTime,
		}: {
			latestBlockNumber: number;
			latestBlockTime: number;
			latestFinalizedBlock: EIP1193Block;
			latestFinalizedBlockTime: number;
		},
	): Promise<boolean> {
		/* v8 ignore start - defensive check: provider verified in process() */
		if (!provider) {
			return false;
		}
		/* v8 ignore stop */

		// CONSISTENCY GUARANTEE: Snapshot transactions to avoid mid-iteration modifications
		// This ensures stable iteration while allowing new txs to be added via addMultiple()
		const txsSnapshot = [...op.transactions];
		const initialTxCount = txsSnapshot.length;

		// Process each transaction from the snapshot, track if any changed
		let anyTxChanged = false;
		for (const tx of txsSnapshot) {
			const changed = await processTx(tx, {
				latestBlockNumber,
				latestBlockTime,
				latestFinalizedBlock,
				latestFinalizedBlockTime,
			});
			if (changed) anyTxChanged = true;
		}

		// Check if new txs were added during processing
		const txsWereAdded = op.transactions.length > initialTxCount;

		// Only recompute status if we processed something or new txs were added
		// This prevents spurious emissions for empty operations
		if (initialTxCount === 0 && !txsWereAdded) {
			return false;
		}

		// IMPORTANT: Compute status from ALL current txs, not just snapshot
		// This ensures txs added during processing are included in status computation
		// and emitted operations always include all known transactions
		const newStatus = computeOperationStatus(op);
		const statusChanged = hasOperationStatusChanged(op, newStatus);

		// Update operation status fields if changed
		if (statusChanged) {
			applyOperationStatus(op, newStatus);
		}

		// Emit events if still tracked
		if (opsById[id]) {
			// Emit 'operation' for any TX change (for persistence)
			if (anyTxChanged || txsWereAdded) {
				if (emitter.hasListeners('operation')) {
					emitter.emit('operation', {id, operation: structuredClone(op)});
				}
			}

			// Emit 'operation:status' only when operation status changes (for UI/state)
			if (statusChanged) {
				if (emitter.hasListeners('operation:status')) {
					emitter.emit('operation:status', {
						id,
						operation: structuredClone(op),
					});
				}
			}
		}

		return anyTxChanged || statusChanged;
	}

	async function processTx(
		tx: BroadcastedTransaction,
		{
			latestBlockNumber,
			latestBlockTime,
			latestFinalizedBlock,
			latestFinalizedBlockTime,
		}: {
			latestBlockNumber: number;
			latestBlockTime: number;
			latestFinalizedBlock: EIP1193Block;
			latestFinalizedBlockTime: number;
		},
	): Promise<boolean> {
		/* v8 ignore start - defensive check: provider verified in process() */
		if (!provider) {
			return false;
		}
		/* v8 ignore stop */

		if (tx.state && tx.state.inclusion === 'Included') {
			if (tx.state.final) {
				// TODO auto remove ?
				return false;
			}
		}

		const txFromPeers = await provider.request({
			method: 'eth_getTransactionByHash',
			params: [tx.hash],
		});

		let changes = false;
		if (txFromPeers) {
			let receipt;
			if (txFromPeers.blockNumber) {
				receipt = await provider.request({
					method: 'eth_getTransactionReceipt',
					params: [tx.hash],
				});
			}
			if (receipt) {
				const block = await provider.request({
					method: 'eth_getBlockByHash',
					params: [txFromPeers.blockHash, false],
				});
				if (block) {
					const blockNumber = Number(block.number);
					const blockTimestamp = Number(block.timestamp);
					const is_final = latestBlockNumber - blockNumber >= config.finality;
					if (receipt.status === '0x0' || receipt.status === '0x00') {
						if (tx.state) {
							if (
								tx.state.status !== 'Failure' ||
								tx.state.final !== blockTimestamp
							) {
								tx.state.inclusion = 'Included';
								tx.state.status = 'Failure';
								tx.state.final = is_final ? blockTimestamp : undefined;
								changes = true;
							}
						} else {
							tx.state = {
								inclusion: 'Included',
								status: 'Failure',
								final: is_final ? blockTimestamp : undefined,
							};
							changes = true;
						}
					} else {
						if (tx.state) {
							if (
								tx.state.status !== 'Success' ||
								tx.state.final !== blockTimestamp
							) {
								tx.state.inclusion = 'Included';
								tx.state.status = 'Success';
								tx.state.final = is_final ? blockTimestamp : undefined;
								changes = true;
							}
						} else {
							tx.state = {
								inclusion: 'Included',
								status: 'Success',
								final: is_final ? blockTimestamp : undefined,
							};
							changes = true;
						}
					}
				}
			} else {
				if (tx.state) {
					if (tx.state && tx.state.inclusion !== 'InMemPool') {
						tx.state.inclusion = 'InMemPool';
						tx.state.final = undefined;
						tx.state.status = undefined;
						tx.nonce = Number(txFromPeers.nonce);
						changes = true;
					}
				} else {
					tx.state = {
						inclusion: 'InMemPool',
						final: undefined,
						status: undefined,
					};
					tx.nonce = Number(txFromPeers.nonce);
					changes = true;
				}
			}
		} else {
			// NOTE: we feteched it again to ensure the call was not lost
			const txFromPeers = await provider.request({
				method: 'eth_getTransactionByHash',
				params: [tx.hash],
			});
			if (txFromPeers) {
				return false; // we skip it for now
			}

			// TODO cache finalityNonce
			const account = tx.from;
			const tranactionCount = await provider.request({
				method: 'eth_getTransactionCount',
				params: [account, latestFinalizedBlock.hash],
			});
			const finalityNonce = Number(tranactionCount);

			logger.debug(`finalityNonce: ${finalityNonce}`);

			if (typeof tx.nonce === 'number' && finalityNonce > tx.nonce) {
				if (tx.state) {
					if (tx.state.inclusion !== 'Dropped' || !tx.state.final) {
						tx.state.inclusion = 'Dropped';
						tx.state.final =
							tx.broadcastTimestamp !== undefined
								? tx.broadcastTimestamp
								: latestFinalizedBlockTime;
						tx.state.status = undefined;
						changes = true;
					}
				} else {
					tx.state = {
						inclusion: 'Dropped',
						status: undefined,
						final:
							tx.broadcastTimestamp !== undefined
								? tx.broadcastTimestamp
								: latestFinalizedBlockTime,
					};
					changes = true;
				}
			} else {
				if (tx.state) {
					if (tx.state.inclusion !== 'NotFound') {
						tx.state.inclusion = 'NotFound';
						tx.state.final = undefined;
						tx.state.status = undefined;
						changes = true;
					}
				} else {
					tx.state = {
						inclusion: 'NotFound',
						final: undefined,
						status: undefined,
					};
					changes = true;
				}
			}
		}

		return changes;
	}

	return {
		setProvider(newProvider: EIP1193Provider) {
			provider = newProvider;
		},

		remove,
		clear,
		add,
		addMultiple,

		process: (config.throttle
			? throttle(process, config.throttle)
			: process) as typeof process,

		onOperationsAdded: (
			listener: (event: OnchainOperationsAddedEvent) => () => void,
		) => emitter.on('operations:added', listener),
		offOperationsAdded: (
			listener: (event: OnchainOperationsAddedEvent) => void,
		) => emitter.off('operations:added', listener),

		// 'onOperationUpdatedUpdated' fires when any TX in the operation changes (for persistence)
		onOperationUpdated: (
			listener: (event: OnchainOperationEvent) => () => void,
		) => emitter.on('operation', listener),
		offOperationUpdated: (listener: (event: OnchainOperationEvent) => void) =>
			emitter.off('operation', listener),

		// 'onOperationUpdatedStatusUpdated' fires only when operation status changes (for UI/state updates)
		onOperationStatusUpdated: (
			listener: (event: OnchainOperationEvent) => () => void,
		) => emitter.on('operation:status', listener),
		offOperationStatusUpdated: (
			listener: (event: OnchainOperationEvent) => void,
		) => emitter.off('operation:status', listener),
	};
}
