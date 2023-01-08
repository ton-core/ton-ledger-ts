import { Address, Cell } from 'ton';
import BN from 'bn.js';

export function writeUint32(value: number) {
    let b = Buffer.alloc(4);
    b.writeUint32BE(value, 0);
    return b;
}

export function writeUint16(value: number) {
    let b = Buffer.alloc(2);
    b.writeUint16BE(value, 0);
    return b;
}

export function writeUint64(value: BN) {
    return value.toBuffer('be', 8);
}

export function writeUint8(value: number) {
    let b = Buffer.alloc(1);
    b[0] = value;
    return b;
}

export function writeAddress(address: Address) {
    return Buffer.concat([
        writeUint8(address.workChain === -1 ? 0xff : address.workChain),
        address.hash
    ]);
}

export function writeCellRef(ref: Cell) {
    return Buffer.concat([
        writeUint16(ref.getMaxDepth()),
        ref.hash()
    ])
}