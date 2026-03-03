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
import type { OnchainOperation, BroadcastedTransaction } from 'ethereum-tx-observer';

// Initialize the processor
const processor = initTransactionProcessor({
  finality: 12, // blocks until considered final
  provider: window.ethereum,
});

// Create an operation with one or more transactions
const operation: OnchainOperation = {
  id: 'my-operation-1',
  transactions: [
    {
      hash: '0xabc...',
      from: '0x123...',
      nonce: 5,
      broadcastTimestamp: Date.now(),
      maxFeePerGas: '30000000000',
      maxPriorityFeePerGas: '2000000000',
      inclusion: 'Broadcasted',
      status: undefined,
      final: undefined,
    },
  ],
  inclusion: 'Broadcasted',
  status: undefined,
  final: undefined,
  txIndex: undefined,
};

// Add the operation to tracking
processor.add([operation]);

// Listen for status changes
processor.onOperation((op) => {
  console.log(`Operation ${op.id}: ${op.inclusion}`);
  
  if (op.inclusion === 'Included') {
    const winningTx = op.transactions[op.txIndex];
    console.log(`Status: ${op.status}`);
    console.log(`Winning TX: ${winningTx.hash}`);
  }
  
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
| `provider` | `EIP1193Provider?` | Optional Ethereum provider (can be set later) |

**Returns:** Processor instance with the following methods:

#### `add(operations: OnchainOperation[])`

Add operations to track. If an operation with the same ID already exists, the transactions are merged into the existing operation.

```typescript
// Add new operation
processor.add([operation]);

// Add another transaction to existing operation (same ID merges)
processor.add([{
  id: 'my-operation-1', // Same ID
  transactions: [bumpedTx], // New tx with higher gas
  // ... status fields
}]);
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

#### `onOperation(listener): void`

Subscribe to operation status changes.

```typescript
const unsubscribe = processor.onOperation((op) => {
  console.log('Operation changed:', op);
  return () => {}; // cleanup
});
```

#### `offOperation(listener): void`

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
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
} & BroadcastedTransactionStatus;

type BroadcastedTransactionStatus =
  | { inclusion: 'BeingFetched' | 'Broadcasted' | 'NotFound' | 'Dropped'; status: undefined; final: undefined }
  | { inclusion: 'Included'; status: 'Failure' | 'Success'; final?: number };
```

### `OperationStatus`

The merged status of all transactions in an operation.

```typescript
type OperationStatus =
  | { inclusion: 'BeingFetched' | 'Broadcasted' | 'NotFound'; status: undefined; final: undefined; txIndex: undefined }
  | { inclusion: 'Dropped'; status: undefined; final?: number; txIndex: undefined }
  | { inclusion: 'Included'; status: 'Failure' | 'Success'; final?: number; txIndex: number };
```

- `txIndex`: Index into `transactions[]` for the "winning" transaction (first success, or first failure if all failed)
- Get the winning tx hash via: `operation.transactions[operation.txIndex].hash`

### `OnchainOperation<Metadata>`

An operation containing multiple transactions.

```typescript
type OnchainOperation<Metadata = unknown> = OperationStatus & {
  id: string;
  transactions: BroadcastedTransaction[];
  metadata?: Metadata;
};
```

## Status States

| Inclusion | Description |
|-----------|-------------|
| `BeingFetched` | Initial state, checking transaction status |
| `Broadcasted` | At least one transaction is visible in the mempool |
| `NotFound` | No transactions visible in mempool (may be temporary) |
| `Dropped` | All transactions dropped (nonce was used by external tx) |
| `Included` | At least one transaction was included in a block |

## Status Merging Logic

When an operation contains multiple transactions, their statuses are merged using the following priority (highest wins):

1. **Included** - Any tx included in a block → operation is `Included`
2. **Broadcasted** - Any tx in mempool → operation is `Broadcasted`
3. **BeingFetched** - Still checking → operation is `BeingFetched`
4. **NotFound** - None visible → operation is `NotFound`
5. **Dropped** - ALL txs dropped → operation is `Dropped`

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
  maxFeePerGas: '30000000000', // 30 gwei
  maxPriorityFeePerGas: '2000000000',
  broadcastTimestamp: Date.now(),
  inclusion: 'Broadcasted',
  status: undefined,
  final: undefined,
};

processor.add([{
  id: 'transfer-1',
  transactions: [tx1],
  inclusion: 'Broadcasted',
  status: undefined,
  final: undefined,
  txIndex: undefined,
}]);

// Later, bump gas price (same nonce)
const tx2: BroadcastedTransaction = {
  ...tx1,
  hash: '0x222...', // Different hash
  maxFeePerGas: '50000000000', // 50 gwei
};

processor.add([{
  id: 'transfer-1', // Same ID → merges
  transactions: [tx2],
  inclusion: 'Broadcasted',
  status: undefined,
  final: undefined,
  txIndex: undefined,
}]);

// Operation now tracks both txs
// Whichever is included first determines the operation result
```

### Sequential Retry

If a transaction is stuck, retry with a new nonce:

```typescript
const operation: OnchainOperation = {
  id: 'my-action',
  transactions: [
    { hash: '0x1...', nonce: 5, /* ... */ }, // Original
    { hash: '0x2...', nonce: 6, /* ... */ }, // Retry with new nonce
  ],
  inclusion: 'Broadcasted',
  status: undefined,
  final: undefined,
  txIndex: undefined,
};

// If tx with nonce 5 succeeds, operation is Success
// Even if tx with nonce 6 fails (nonce conflict), operation is still Success
```