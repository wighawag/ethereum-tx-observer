import {
	initTransactionProcessor,
	type OnchainOperation,
	type OnchainOperationEvent,
} from '../../src/index.js';
import {
	createMockProvider,
	type MockProviderController,
	type MockProviderConfig,
} from '../mocks/MockEIP1193Provider.js';
import {
	createBroadcastedTx,
	createMockTx,
	resetHashCounter,
	type TEST_ACCOUNT,
} from '../fixtures/transactions.js';
import {createOperation, resetOpIdCounter} from '../fixtures/operations.js';

/**
 * Test setup interface
 */
export interface TestSetup {
	processor: ReturnType<typeof initTransactionProcessor>;
	controller: MockProviderController;
	emissions: OnchainOperation[];
	emissionEvents: OnchainOperationEvent[];
	cleanup: () => void;
}

/**
 * Create a complete test setup with processor and mock provider
 */
export function createTestSetup(
	config: MockProviderConfig & {finality?: number} = {},
): TestSetup {
	const {finality = 12, ...providerConfig} = config;

	// Reset counters for clean test state
	resetHashCounter();
	resetOpIdCounter();

	const {provider, controller} = createMockProvider(providerConfig);

	const processor = initTransactionProcessor({
		finality,
		provider,
	});

	const emissions: OnchainOperation[] = [];
	const emissionEvents: OnchainOperationEvent[] = [];
	const cleanupListener = processor.onOperationUpdated((event) => {
		emissions.push(structuredClone(event.operation));
		emissionEvents.push(structuredClone(event));
		return () => {};
	});

	return {
		processor,
		controller,
		emissions,
		emissionEvents,
		cleanup: cleanupListener,
	};
}

let counter = 0;
/**
 * Helper to create and add an operation with a single tx to the processor
 */
export function addSingleTxOperation(
	setup: TestSetup,
	txOverrides: Parameters<typeof createBroadcastedTx>[0] = {},
	opOverrides: Partial<OnchainOperation> = {},
): {
	operation: OnchainOperation;
	operationId: string;
	addToMempool: () => void;
} {
	const tx = createBroadcastedTx(txOverrides);
	const mockTx = createMockTx({
		hash: tx.hash,
		from: tx.from,
		nonce: tx.nonce ?? 0,
	});

	const operation = createOperation({
		...opOverrides,
		transactions: [tx],
	});

	const operationId = `op-${++counter}`;
	setup.processor.addMultiple({[operationId]: operation});

	return {
		operation,
		operationId,
		addToMempool: () => setup.controller.addToMempool(mockTx),
	};
}

/**
 * Helper to add a replacement transaction to an existing operation
 */
export function addReplacementTx(
	setup: TestSetup,
	operationId: string,
	operation: OnchainOperation,
	txOverrides: Parameters<typeof createBroadcastedTx>[0] = {},
): {newTx: ReturnType<typeof createBroadcastedTx>; addToMempool: () => void} {
	const newTx = createBroadcastedTx(txOverrides);
	const mockTx = createMockTx({
		hash: newTx.hash,
		from: newTx.from,
		nonce: newTx.nonce ?? 0,
	});

	// Add the new tx to the operation via processor.add using the same operation ID
	setup.processor.addMultiple({
		[operationId]: {
			...operation,
			transactions: [newTx],
		},
	});

	return {
		newTx,
		addToMempool: () => setup.controller.addToMempool(mockTx),
	};
}

/**
 * Wait for a specific number of emissions
 */
export async function waitForEmissions(
	setup: TestSetup,
	count: number,
	timeoutMs: number = 1000,
): Promise<void> {
	const startCount = setup.emissions.length;
	const targetCount = startCount + count;
	const startTime = Date.now();

	while (setup.emissions.length < targetCount) {
		if (Date.now() - startTime > timeoutMs) {
			throw new Error(
				`Timeout waiting for emissions: expected ${targetCount}, got ${setup.emissions.length}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * Process and wait for all pending state changes
 */
export async function processAndWait(setup: TestSetup): Promise<void> {
	await setup.processor.process();
	// Small delay to ensure all async operations complete
	await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Scenario: Basic transaction lifecycle
 * - Create operation with single tx
 * - Add to mempool
 * - Process to detect in mempool
 * - Include in block
 * - Process to detect inclusion
 * - Advance to finality
 */
export async function runBasicLifecycleScenario(
	setup: TestSetup,
	nonce: number = 0,
): Promise<{
	operation: OnchainOperation;
	phases: {
		added: OnchainOperation | undefined;
		broadcasted: OnchainOperation | undefined;
		included: OnchainOperation | undefined;
		finalized: OnchainOperation | undefined;
	};
}> {
	const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
	const phases: {
		added: OnchainOperation | undefined;
		broadcasted: OnchainOperation | undefined;
		included: OnchainOperation | undefined;
		finalized: OnchainOperation | undefined;
	} = {
		added: undefined,
		broadcasted: undefined,
		included: undefined,
		finalized: undefined,
	};

	// Phase 1: Added but not yet in mempool
	await processAndWait(setup);
	// Should be NotFound since not in mempool yet
	phases.added = setup.emissions[setup.emissions.length - 1];

	// Phase 2: Add to mempool and process
	addToMempool();
	await processAndWait(setup);
	phases.broadcasted = setup.emissions[setup.emissions.length - 1];

	// Phase 3: Include in block
	setup.controller.includeTx(operation.transactions[0].hash, 'success');
	await processAndWait(setup);
	phases.included = setup.emissions[setup.emissions.length - 1];

	// Phase 4: Advance to finality
	setup.controller.advanceBlocks(12);
	await processAndWait(setup);
	phases.finalized = setup.emissions[setup.emissions.length - 1];

	return {operation, phases};
}

/**
 * Scenario: Gas bump replacement
 * - Create operation with TX1
 * - User bumps gas, adds TX2 with same nonce
 * - TX2 gets included, TX1 dropped
 */
export async function runGasBumpScenario(
	setup: TestSetup,
	nonce: number = 5,
): Promise<{
	operation: OnchainOperation;
	tx1Hash: `0x${string}`;
	tx2Hash: `0x${string}`;
	finalEmission: OnchainOperation | undefined;
}> {
	// Create initial tx
	const {
		operation,
		operationId,
		addToMempool: addTx1ToMempool,
	} = addSingleTxOperation(setup, {
		nonce,
	});
	const tx1Hash = operation.transactions[0].hash;

	// Add TX1 to mempool and process
	addTx1ToMempool();
	await processAndWait(setup);

	// Create replacement TX2 with higher gas
	const {newTx: tx2, addToMempool: addTx2ToMempool} = addReplacementTx(
		setup,
		operationId,
		operation,
		{
			nonce,
			from: operation.transactions[0].from,
		},
	);
	const tx2Hash = tx2.hash;

	// Remove TX1 from mempool (replaced), add TX2
	setup.controller.removeFromMempool(tx1Hash);
	addTx2ToMempool();
	await processAndWait(setup);

	// Include TX2
	setup.controller.includeTx(tx2Hash, 'success');
	await processAndWait(setup);

	return {
		operation,
		tx1Hash,
		tx2Hash,
		finalEmission: setup.emissions[setup.emissions.length - 1],
	};
}

/**
 * Scenario: Dropped transaction
 * - Create operation with tx
 * - Tx disappears from mempool
 * - Another tx consumes the nonce externally
 * - Tx becomes dropped
 */
export async function runDroppedScenario(
	setup: TestSetup,
	nonce: number = 5,
): Promise<{
	operation: OnchainOperation;
	finalEmission: OnchainOperation | undefined;
}> {
	const {operation, addToMempool} = addSingleTxOperation(setup, {nonce});
	const txHash = operation.transactions[0].hash;
	const account = operation.transactions[0].from;

	// Add to mempool and process
	addToMempool();
	await processAndWait(setup);

	// Remove from mempool
	setup.controller.removeFromMempool(txHash);
	await processAndWait(setup);

	// Advance blocks and set account nonce higher (external tx consumed it)
	setup.controller.advanceBlocks(15); // Past finality
	setup.controller.setAccountNonce(account, nonce + 1);
	await processAndWait(setup);

	return {
		operation,
		finalEmission: setup.emissions[setup.emissions.length - 1],
	};
}
