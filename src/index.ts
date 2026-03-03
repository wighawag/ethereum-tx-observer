import type {EIP1193Provider, EIP1193Block} from 'eip-1193';
import {logs} from 'named-logs';
// TODO // import {throttle} from 'lodash-es';
import {Emitter} from 'radiate';
const logger = logs('tx-observer');

export type BroadcastedTransactionInclusion =
	| 'BeingFetched'
	| 'Broadcasted'
	| 'NotFound'
	| 'Dropped'
	| 'Included';

export type BroadcastedTransactionStatus =
	| {
			inclusion: 'BeingFetched' | 'Broadcasted' | 'NotFound' | 'Dropped';
			final: undefined;
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
	readonly maxFeePerGas: string;
	readonly maxPriorityFeePerGas: string;
} & BroadcastedTransactionStatus;

/**
 * Operation status represents the merged status of all transactions in an operation.
 * - txIndex: index into transactions[] for the "winning" tx (first success, or first failure if all failed)
 * - The hash can be retrieved via: operation.transactions[operation.txIndex].hash
 */
export type OperationStatus =
	| {
			inclusion: 'BeingFetched' | 'Broadcasted' | 'NotFound';
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

export type OnchainOperation<Metadata extends unknown = unknown> =
	OperationStatus & {
		id: string;
		transactions: BroadcastedTransaction[];
		metadata?: Metadata;

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
 * Compute the merged operation status from all its transactions.
 *
 * Priority order (highest wins):
 * 1. Included - At least one tx is included in a block
 * 2. Broadcasted - At least one tx is active in mempool
 * 3. BeingFetched - Still determining status
 * 4. NotFound - None visible in mempool
 * 5. Dropped - ALL txs are dropped (operation failed)
 *
 * For Included status:
 * - If ANY tx succeeded → status: Success
 * - If ALL included txs failed → status: Failure
 * - txIndex points to first success, or first failure if all failed
 */
function computeOperationStatus(op: OnchainOperation): OperationStatus {
	const txs = op.transactions;

	// Check for any Included txs - find index of first success, or first failure
	let winningIndex = -1;
	let hasSuccess = false;

	for (let i = 0; i < txs.length; i++) {
		const tx = txs[i];
		if (tx.inclusion === 'Included') {
			if (tx.status === 'Success') {
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
		const includedTxs = txs.filter((tx) => tx.inclusion === 'Included');
		let finalTimestamp: number | undefined;
		for (const tx of includedTxs) {
			if (tx.final !== undefined) {
				if (finalTimestamp === undefined || tx.final > finalTimestamp) {
					finalTimestamp = tx.final;
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
	if (txs.some((tx) => tx.inclusion === 'Broadcasted')) {
		return {
			inclusion: 'Broadcasted',
			final: undefined,
			status: undefined,
			txIndex: undefined,
		};
	}

	// Check for any BeingFetched
	if (txs.some((tx) => tx.inclusion === 'BeingFetched')) {
		return {
			inclusion: 'BeingFetched',
			final: undefined,
			status: undefined,
			txIndex: undefined,
		};
	}

	// Check for any NotFound
	if (txs.some((tx) => tx.inclusion === 'NotFound')) {
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
		if (tx.final !== undefined) {
			if (droppedTimestamp === undefined || tx.final < droppedTimestamp) {
				droppedTimestamp = tx.final;
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
	newStatus: OperationStatus,
): void {
	(op as any).inclusion = newStatus.inclusion;
	(op as any).final = newStatus.final;
	(op as any).status = newStatus.status;
	(op as any).txIndex = newStatus.txIndex;
}

/**
 * Check if operation status has changed.
 */
function hasOperationStatusChanged(
	op: OnchainOperation,
	newStatus: OperationStatus,
): boolean {
	return (
		op.inclusion !== newStatus.inclusion ||
		op.final !== newStatus.final ||
		op.status !== newStatus.status ||
		op.txIndex !== newStatus.txIndex
	);
}

export function initTransactionProcessor(config: {
	finality: number;
	provider?: EIP1193Provider;
}) {
	const emitter = new Emitter<{operation: OnchainOperation}>();

	let provider: EIP1193Provider | undefined = config.provider;
	const $ops: OnchainOperation[] = [];
	const opsById: {[id: string]: OnchainOperation} = {};
	// Maintain tx hash lookup for efficient updates
	const txToOp: {[txHash: string]: OnchainOperation} = {};

	function add(operations: OnchainOperation[]) {
		logger.debug(`adding ${operations.length} operations...`);
		for (const op of operations) {
			_addSingle(op);
		}
	}

	function _addSingle(operation: OnchainOperation) {
		logger.debug(`adding operation ${operation.id}...`);
		if (!opsById[operation.id]) {
			opsById[operation.id] = operation;
			$ops.push(operation);
			// Index all tx hashes for this operation
			for (const tx of operation.transactions) {
				txToOp[tx.hash] = operation;
			}
		} else {
			// Update existing operation - merge transactions
			const existing = opsById[operation.id];
			for (const tx of operation.transactions) {
				if (!txToOp[tx.hash]) {
					existing.transactions.push(tx);
					txToOp[tx.hash] = existing;
				}
			}
		}
	}

	function clear() {
		logger.debug(`clearing operations...`);
		for (const op of $ops) {
			for (const tx of op.transactions) {
				delete txToOp[tx.hash];
			}
			delete opsById[op.id];
		}
		$ops.splice(0, $ops.length);
	}

	function remove(operationId: string) {
		logger.debug(`removing operation ${operationId}...`);
		const op = opsById[operationId];
		if (op) {
			const index = $ops.indexOf(op);
			if (index >= 0) {
				$ops.splice(index, 1);
			}
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

		logger.debug(`operations: ${$ops.length}`);

		for (const op of $ops) {
			await processOperation(op, {
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
		if (!provider) {
			return false;
		}

		let anyTxChanged = false;

		// Process each transaction in the operation
		for (const tx of op.transactions) {
			const changed = await processTx(tx, {
				latestBlockNumber,
				latestBlockTime,
				latestFinalizedBlock,
				latestFinalizedBlockTime,
			});
			if (changed) anyTxChanged = true;
		}

		if (anyTxChanged) {
			// Recompute operation status from merged tx statuses
			const newStatus = computeOperationStatus(op);

			// Check if status actually changed
			if (hasOperationStatusChanged(op, newStatus)) {
				// Update operation status fields
				applyOperationStatus(op, newStatus);

				// Emit operation event if still tracked
				if (opsById[op.id]) {
					emitter.emit('operation', op);
				}
			}
		}

		return anyTxChanged;
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
		if (!provider) {
			return false;
		}

		if (tx.inclusion === 'Included') {
			if (tx.final) {
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
					if (tx.inclusion !== 'Included') {
						// we change type here
						(tx as any).inclusion = 'Included';
						changes = true;
					}
					const blockNumber = Number(block.number);
					const blockTimestamp = Number(block.timestamp);
					const is_final = latestBlockNumber - blockNumber >= config.finality;
					if (receipt.status === '0x0' || receipt.status === '0x00') {
						if (tx.status !== 'Failure' || tx.final !== blockTimestamp) {
							tx.status = 'Failure';
							tx.final = is_final ? blockTimestamp : undefined;
							changes = true;
						}
					} else {
						if (tx.status !== 'Success' || tx.final !== blockTimestamp) {
							tx.status = 'Success';
							tx.final = is_final ? blockTimestamp : undefined;
							changes = true;
						}
					}
				}
			} else {
				if (tx.inclusion !== 'Broadcasted') {
					tx.inclusion = 'Broadcasted';
					tx.final = undefined;
					tx.status = undefined;
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
				if (tx.inclusion !== 'Dropped' || !tx.final) {
					tx.inclusion = 'Dropped';
					tx.final =
						typeof tx.broadcastTimestamp !== undefined
							? tx.broadcastTimestamp
							: latestFinalizedBlockTime;
					tx.status = undefined;
					changes = true;
				}
			} else {
				if (tx.inclusion !== 'NotFound') {
					tx.inclusion = 'NotFound';
					tx.final = undefined;
					tx.status = undefined;
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
		add,
		remove,
		clear,

		process: process, // TODO: throttle(process, 1000) as typeof process, // TODO throotle delay

		onOperation: (listener: (operation: OnchainOperation) => () => void) =>
			emitter.on('operation', listener),
		offOperation: (listener: (operation: OnchainOperation) => void) =>
			emitter.off('operation', listener),
	};
}
