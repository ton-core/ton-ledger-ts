# TON Ledger Library

This library allows you to connect to a ledger device and with with TON from browser (only Chrome), NodeJS and React Native.

## How to install

To add library to your project execute: 

```bash
yarn add @ton-community/ton-ledger
```

## Connecting to a Device

First you need to select transport library for you environment.

Browser:
* [@ledgerhq/hw-transport-webhid](https://www.npmjs.com/package/@ledgerhq/hw-transport-webhid)
* [@ledgerhq/hw-transport-webusb](https://www.npmjs.com/package/@ledgerhq/hw-transport-webusb)

Node:
* [@ledgerhq/hw-transport-node-ble](https://www.npmjs.com/package/@ledgerhq/hw-transport-node-ble)
* [@ledgerhq/hw-transport-node-hid](https://www.npmjs.com/package/@ledgerhq/hw-transport-node-hid)
* [@ledgerhq/hw-transport-node-hid-noevents](https://www.npmjs.com/package/@ledgerhq/hw-transport-node-hid-noevents)
* [@ledgerhq/hw-transport-node-hid-singleton](https://www.npmjs.com/package/@ledgerhq/hw-transport-node-hid-singleton)

React Native:
* [@ledgerhq/hw-transport-web-ble](https://www.npmjs.com/package/@ledgerhq/hw-transport-web-ble)

After connecting to a device create a TonTransport instance:
```typescript
import { TonTransport } from 'ton-ledger';
let transport = new TonTransport(device);
```

## Deriviation Path

For hardware wallets you need to specify deriviation path of your account for TON it is specified as:

```typescript
function pathForAccount(testnet: boolean, workchain: number, account: number) {
    let network = testnet ? 1 : 0;
    let chain = workchain === -1 ? 255 : 0;
    return [44, 607, network, chain, account, 0]; // Last zero is reserved for alternative wallet contracts
}
```

You can specify any path that starts with `[44, 607]`, but it could be incompatible with other apps.

## Get an Address and Public Key

To get an address without confimration on device you can perform next things:

```typescript
let testnet = true;
let workchain = 0;
let accountIndex = 0;
let bounceable = false;
let path = pathForAccount(testnet, workchain, accountIndex);
let response = await transport.getAddress(path, { chain, bounceable, testOnly: testnet });
let publiKey: Buffer = response.publicKey;
let address: string = response.address;
```

## Validate Address

The same as getting address, but returns address and key only when user confirms that address on the screen is correct. This method usually used after the non-confirming one and displaying address in dApp ad then requesting address validation.

```typescript
let testnet = true;
let workchain = 0;
let accountIndex = 0;
let bounceable = false;
let path = pathForAccount(testnet, workchain, accountIndex);
let response = await transport.validateAddress(path, { chain, bounceable, testOnly: testnet });
let publiKey: Buffer = response.publicKey;
let address: string = response.address;
```

## Sign simple transaction

Ledger Nanoapp works with Wallet v4 for now, we recommend you to continue to use it:

```typescript
import { WalletV4Contract, WalletV4Source } from 'ton';
import { TonPayloadFormat } from 'ton-ledger';
import { TonClient, Address, SendMode, toNano } from 'ton-core';

let client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });
let source = WalletV4Source.create({ workchain: 0, publicKey: deviceAddress.publicKey });
let contract = new WalletV4Contract(address, source);
let seqno = await contract.getSeqNo();

// Parameters
let path: number[]; // Account path from above
let to: Address = Address.parse('...'); // Destination
let amount: bigint = toNano('100'); // Send 100 TON
let sendMode = SendMode.IGNORE_ERRORS | SendMode.PAY_GAS_SEPARATLY;
let timeout = Math.floor((Date.now() / 1000) + 60);
let bounce = false;
let payload: TonPayloadFormat | null = null; // See below

// Signing on device
let signed = await transport.signTransaction(path, {
    to,
    sendMode,
    amount,
    seqno,
    timeout: Math.floor((Date.now() / 1000) + 60),
    bounce,
    payload: payload ? payload : undefined
});

// Send transaction to the network
await c.sendExternalMessage(contract, signed);

```

## Payload formats

### Transaction with a comment
Comments are limited to ASCII-only symbols and 127 letters. Anything above would be automatically downgraded to Blind Signing Mode that you want to avoid at all cost.

```typescript
const payload: TonPayloadFormat = {
    type: 'comment',
    text: 'Deposit'
};
```

### Jetton transfer

```typescript
const payload: TonPayloadFormat = {
    type: 'jetton-transfer',
    queryId: null, // null will be replaced with 0; you can pass any value of the BigInt type
    amount: 1n,
    destination: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
    responseDestination: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
    customPayload: null, // you can pass any value of the Cell type
    forwardAmount: 0n,
    forwardPayload: null // you can pass any value of the Cell type
};
```

### NFT transfer

```typescript
const payload: TonPayloadFormat = {
    type: 'nft-transfer',
    queryId: null, // null will be replaced with 0; you can pass any value of the BigInt type
    newOwner: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
    responseDestination: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
    customPayload: null, // you can pass any value of the Cell type
    forwardAmount: 0n,
    forwardPayload: null // you can pass any value of the Cell type
};
```

# License

MIT
