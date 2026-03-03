# ethereum-tx-observer

A TypeScript library for monitoring Ethereum onchain operations containing multiple transactions, with automatic status merging and finality tracking.

## Overview

The Operation Processor tracks **operations** - logical groupings of transactions that belong together. This is useful when:

- **Gas price bumping**: Multiple transactions with the same nonce but different gas prices
- **Sequential retries**: Transactions with different nonces for the same logical action
- **Multi-step operations**: Related transactions that form a single user action

The processor monitors all transactions in an operation and computes a merged status, emitting events when the operation status changes.

## Installation

```bash
npm install ethereum-tx-observer
```

## Quick Start

```typescript
import { initTransactionProcessor } from 'ethereum-tx-observer';
import type { OnchainOperation, BroadcastedTransaction, OnchainOperationEvent } from 'ethereum-tx-observer';

// Initialize the processor
const processor = initTransactionProcessor({
  finality: 12, // blocks until considered final
  throttle: 5000, // optional: throttle process() calls
  provider: window.ethereum,
});

// Create an operation with one or more transactions
const operation: OnchainOperation = {
  transactions: [
    {
      hash: '0xabc...',
      from: '0x123...',
      nonce: 5,
      broadcastTimestamp: Date.now(),
    },
  ],,
};

// Add the operation to tracking (ID is passed separately)
processor.add('my-operation-1', operation);

// Listen for operation status changes (for UI updates)
processor.onOperationStatusUpdated((event: OnchainOperationEvent) => {
  console.log(`Operation ${event.id}: ${event.operation.state?.inclusion}`);
  
  if (event.operation.state?.inclusion === 'Included') {
    const winningTx = event.operation.transactions[event.operation.state.txIndex];
    console.log(`Status: ${event.operation.state.status}`);
    console.log(`Winning TX: ${winningTx.hash}`);
  }
  
  return () => {}; // cleanup function
});

// Listen for any transaction changes (for persistence)
processor.onOperationUpdated((event: OnchainOperationEvent) => {
  console.log(`Operation ${event.id} updated, save to storage`);
  return () => {}; // cleanup function
});

// Process periodically (check for status updates)
setInterval(() => processor.process(), 5000);
```

## API Reference

### `initTransactionProcessor(config)`

Creates a new operation processor instance.

**Config:**

| Field | Type | Description |
|-------|------|-------------|
| `finality` | `number` | Number of blocks until a transaction is considered final |
| `throttle` | `number?` | Optional: throttle interval in ms for `process()` calls |
| `provider` | `EIP1193ProviderWithoutEvents?` | Optional Ethereum provider (can be set later) |

**Returns:** Processor instance with the following methods:

#### `add(id: string, operation: OnchainOperation)`

Add an operation to track. If an operation with the same ID already exists, the transactions are merged into the existing operation.

```typescript
// Add new operation
processor.add('my-operation-1', operation);

// Add another transaction to existing operation (same ID merges)
processor.add('my-operation-1', {
  transactions: [bumpedTx], // New tx with higher gas
  // ... state fields
});
// and in case where you track the txs already you can simply re-add
operation.transactions.push(bumpedTx);
processor.add('my-operation-1', operation);
```

#### `addMultiple(operations: {[id: string]: OnchainOperation})`

Add multiple operations at once.

```typescript
processor.addMultiple({
  'operation-1': operation1,
  'operation-2': operation2,
});
```

#### `remove(operationId: string)`

Remove an operation by ID and stop tracking it.

```typescript
processor.remove('my-operation-1');
```

#### `clear()`

Remove all operations.

```typescript
processor.clear();
```

#### `process(): Promise<void>`

Check and update the status of all tracked operations. This queries the Ethereum provider for transaction receipts and updates statuses accordingly.

```typescript
await processor.process();
```

#### `setProvider(provider: EIP1193Provider)`

Update the Ethereum provider.

```typescript
processor.setProvider(newProvider);
```

#### `onOperationUpdated(listener): void`

Subscribe to any operation changes (when any transaction in the operation changes). Useful for persistence.

```typescript
processor.onOperationUpdated((event: OnchainOperationEvent) => {
  console.log(`Operation ${event.id} changed:`, event.operation);
  return () => {}; // cleanup
});
```

#### `offOperationUpdated(listener): void`

Unsubscribe from operation changes.

#### `onOperationStatusUpdated(listener): void`

Subscribe to operation status changes only (when the merged status changes). Useful for UI updates.

```typescript
processor.onOperationStatusUpdated((event: OnchainOperationEvent) => {
  console.log(`Operation ${event.id} status:`, event.operation.state?.inclusion);
  return () => {}; // cleanup
});
```

#### `offOperationStatusUpdated(listener): void`

Unsubscribe from operation status changes.

## Types

### `BroadcastedTransaction`

Represents a single broadcasted transaction.

```typescript
type BroadcastedTransaction = {
  readonly hash: `0x${string}`;
  readonly from: `0x${string}`;
  nonce?: number;
  readonly broadcastTimestamp: number;
  state?: BroadcastedTransactionState;
};

type BroadcastedTransactionState =
  | { inclusion: 'InMemPool' | 'NotFound'; final: undefined; status: undefined }
  | { inclusion: 'Dropped'; final?: number; status: undefined }
  | { inclusion: 'Included'; status: 'Failure' | 'Success'; final?: number };
```

### `OnchainOperationStatus`

The merged status of all transactions in an operation.

```typescript
type OnchainOperationStatus =
  | { inclusion: 'InMemPool' | 'NotFound'; final: undefined; status: undefined; txIndex: undefined }
  | { inclusion: 'Dropped'; final?: number; status: undefined; txIndex: undefined }
  | { inclusion: 'Included'; status: 'Failure' | 'Success'; final?: number; txIndex: number };
```

- `txIndex`: Index into `transactions[]` for the "winning" transaction (first success, or first failure if all failed)
- Get the winning tx hash via: `operation.transactions[operation.state.txIndex].hash`

### `OnchainOperation`

An operation containing multiple transactions.

```typescript
type OnchainOperation = {
  transactions: BroadcastedTransaction[];
  state?: OnchainOperationStatus;
};
```

### `OnchainOperationEvent`

Event payload emitted by listeners, includes both the operation ID and operation data.

```typescript
type OnchainOperationEvent = {
  id: string;
  operation: OnchainOperation;
};
```

## Status States

| Inclusion | Description |
|-----------|-------------|
| `Broadcasted` | At least one transaction is visible in the mempool |
| `NotFound` | No transactions visible in mempool (may be temporary) |
| `Dropped` | All transactions dropped (nonce was used by external tx) |
| `Included` | At least one transaction was included in a block |

## Status Merging Logic

When an operation contains multiple transactions, their statuses are merged using the following priority (highest wins):

1. **Included** - Any tx included in a block → operation is `Included`
2. **Broadcasted** - Any tx in mempool → operation is `Broadcasted`
3. **NotFound** - None visible → operation is `NotFound`
4. **Dropped** - ALL txs dropped → operation is `Dropped`

### For `Included` Operations

- If **any** transaction succeeded → `status: 'Success'`
- If **all** included transactions failed → `status: 'Failure'`
- `txIndex` points to the first successful tx, or first failure if all failed

This allows scenarios like:
- Tx A (nonce 5) succeeds, Tx B (nonce 6) fails due to nonce conflict → Operation is **Success**
- Tx A (nonce 5, low gas) dropped, Tx B (nonce 5, high gas) succeeds → Operation is **Success**

## Use Cases

### Gas Price Bumping

When network congestion increases, submit a replacement transaction with the same nonce but higher gas price:

```typescript
// Initial transaction
const tx1: BroadcastedTransaction = {
  hash: '0x111...',
  from: '0xabc...',
  nonce: 5,
  broadcastTimestamp: Date.now(),
  state: {
    inclusion: 'InMemPool',
    status: undefined,
    final: undefined,
  },
};

processor.add('transfer-1', {
  transactions: [tx1],
  state: {
    inclusion: 'InMemPool',
    status: undefined,
    final: undefined,
    txIndex: undefined,
  },
});

// Later, bump gas price (same nonce)
const tx2: BroadcastedTransaction = {
  ...tx1,
  hash: '0x222...', // Different hash
};

processor.add('transfer-1', { // Same ID → merges
  transactions: [tx2],
});

// Operation now tracks both txs
// Whichever is included first determines the operation result
```

### Sequential Retry

If a transaction is stuck, retry with a new nonce:

```typescript
processor.add('my-action', {
  transactions: [
    { hash: '0x1...', from: '0xabc...', nonce: 5, broadcastTimestamp: Date.now() }, // Original
    { hash: '0x2...', from: '0xabc...', nonce: 6, broadcastTimestamp: Date.now() }, // Retry with new nonce
  ],
});

// If tx with nonce 5 succeeds, operation is Success
// Even if tx with nonce 6 fails (nonce conflict), operation is still Success
```
