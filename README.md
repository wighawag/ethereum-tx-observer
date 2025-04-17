# Ethereum Transaction Observer

A lightweight TypeScript library for tracking and monitoring Ethereum transactions throughout their lifecycle.

## Features

- Track transaction status from broadcasting to final confirmation
- Monitor transaction inclusion states: BeingFetched, Broadcasted, NotFound, Cancelled, Included
- Track transaction success/failure status
- Handle transaction finality based on configurable confirmation count
- Reactive updates via Svelte store-compatible interface
- Support for EIP-1193 compatible providers
- TypeScript support with full type definitions

## Installation

```bash
npm install ethereum-tx-observer
# or
yarn add ethereum-tx-observer
# or 
pnpm add ethereum-tx-observer
```

## Usage

```typescript
import { initTransactionProcessor } from 'ethereum-tx-observer';
import type { EIP1193Provider } from 'eip-1193';

// Initialize the transaction processor with desired finality
const txObserver = initTransactionProcessor({
  finality: 12 // Consider transactions final after 12 confirmations
});

// Set the Ethereum provider (compatible with EIP-1193)
txObserver.setProvider(yourProvider as EIP1193Provider);

// Subscribe to transaction updates
const unsubscribe = txObserver.txs.subscribe(transactions => {
  console.log('Current transactions:', transactions);
});

// Add a transaction to be tracked
txObserver.add([{
  hash: '0xabcd...',
  request: {
    from: '0x1234...',
    to: '0x5678...',
    value: '0x0',
    // Other transaction data
    metadata: { 
      // Custom metadata for your application
      purpose: 'Token transfer',
      userAction: 'swap'
    }
  },
  inclusion: 'Broadcasted',
  final: undefined,
  status: undefined
}]);

// Process transactions (check their status)
// This is typically called periodically or on new blocks
txObserver.process();

// Listen for changes to specific transactions
txObserver.onTx(tx => {
  console.log(`Transaction ${tx.hash} updated:`, tx);
});

// Stop tracking a transaction
txObserver.remove('0xabcd...');

// Clear all tracked transactions
txObserver.clear();

// Clean up when done
unsubscribe();
```

## Transaction States

Transactions can be in the following states:

- **BeingFetched**: Initial state when the transaction is being looked up
- **Broadcasted**: Transaction found in the mempool, waiting for inclusion
- **NotFound**: Transaction not found (may have been dropped)
- **Cancelled**: Transaction was cancelled or replaced (nonce used by another transaction)
- **Included**: Transaction included in a block
  - With status **Success** or **Failure**
  - With **final** timestamp once it reaches the configured finality

## License

MIT