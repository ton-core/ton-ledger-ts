# TON Ledger Library

This library allows you to connect to a ledger device and with with TON from browser (only Chrome), NodeJS and React Native.

## How to install

To add library to your project execute: 

```bash
yarn add ton-ledger
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
function pathFromAccountNumber(testnet: boolean, workchain, account: number) {
    let network = testnet ? 1 : 0;
    let chain = workchain === -1 ? 255 : 0;
    return [44, 607, network, chain, account, 0];
}
```

You can specify any path that starts with `[44, 607]`, but it could be incompatible with other apps.

