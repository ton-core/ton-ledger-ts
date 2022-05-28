import Transport from "@ledgerhq/hw-transport";
import BN from "bn.js";
import { Address, beginCell, Cell, contractAddress, Message, SendMode, StateInit } from "ton";
import { WalletV4Source } from "ton-contracts";
import { signVerify } from 'ton-crypto';

const LEDGER_CLA = 0xe0;
const INS_VERSION = 0x03;
const INS_ADDRESS = 0x05;

export class TonTransport {
    readonly transport: Transport;

    constructor(transport: Transport) {
        this.transport = transport;
    }

    async getVersion(): Promise<string> {
        let loaded = await this.#doRequest(INS_VERSION, 0x00, 0x00, Buffer.alloc(0));
        const [major, minor, patch] = loaded;
        return `${major}.${minor}.${patch}`;
    }

    async getAddress(path: number[], opts?: { testOnly?: boolean, bounceable?: boolean, chain?: number }) {

        // Check path
        validatePath(path);

        // Resolve flags
        let bounceable = true;
        let chain = 0;
        let test = false;
        let flags = 0x00;
        if (opts && opts.bounceable !== undefined && !opts.bounceable) {
            flags |= 0x01;
            bounceable = false;
        }
        if (opts && opts.testOnly) {
            flags |= 0x02;
            test = true;
        }
        if (opts && opts.chain !== undefined) {
            if (opts.chain !== 0 && opts.chain !== -1) {
                throw Error('Invalid chain');
            }
            chain = opts.chain;
            if (opts.chain === -1) {
                flags |= 0x04;
            }
        }

        // Get public key
        let response = await this.#doRequest(INS_ADDRESS, 0x00, 0x00, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        if (response.length !== 32) {
            throw Error('Invalid response');
        }

        // Contract
        const contract = WalletV4Source.create({ workchain: chain, publicKey: response });
        const address = contractAddress(contract);

        return { address: address.toFriendly({ bounceable: bounceable, testOnly: test }), publicKey: response };
    }

    async validateAddress(path: number[], opts?: { testOnly?: boolean, bounceable?: boolean, chain?: number }) {

        // Check path
        validatePath(path);

        // Resolve flags
        let bounceable = true;
        let chain = 0;
        let test = false;
        let flags = 0x00;
        if (opts && opts.bounceable !== undefined && !opts.bounceable) {
            flags |= 0x01;
            bounceable = false;
        }
        if (opts && opts.testOnly) {
            flags |= 0x02;
            test = true;
        }
        if (opts && opts.chain !== undefined) {
            if (opts.chain !== 0 && opts.chain !== -1) {
                throw Error('Invalid chain');
            }
            chain = opts.chain;
            if (opts.chain === -1) {
                flags |= 0x04;
            }
        }

        // Get public key
        let response = await this.#doRequest(INS_ADDRESS, 0x01, flags, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        if (response.length !== 32) {
            throw Error('Invalid response');
        }

        // Contract
        const contract = WalletV4Source.create({ workchain: chain, publicKey: response });
        const address = contractAddress(contract);

        return { address: address.toFriendly({ bounceable: bounceable, testOnly: test }), publicKey: response };
    }

    signTransaction = async (
        path: number[],
        transaction: {
            to: Address,
            sendMode: SendMode,
            seqno: number,
            timeout: number,
            bounce: boolean,
            amount: BN,
            stateInit?: StateInit,
            payload?: Message
        }
    ) => {

        // Check path
        validatePath(path);

        //
        // Fetch key
        //

        let publicKey = (await this.getAddress(path)).publicKey;

        //
        // Create package
        //

        let pkg = Buffer.concat([
            writeUin8(0), // Header
            writeUin32(transaction.seqno),
            writeUin32(transaction.timeout),
            writeUin64(transaction.amount),
            writeUin8(transaction.to.workChain === -1 ? 0xff : transaction.to.workChain),
            transaction.to.hash,
            writeUin8(transaction.bounce ? 1 : 0),
            writeUin8(transaction.sendMode),
        ]);

        // State init
        let stateInit: Cell | null = null;
        if (transaction.stateInit) {
            stateInit = new Cell();
            transaction.stateInit.writeTo(stateInit);
            pkg = Buffer.concat([
                pkg,
                writeUin8(1),
                writeUin16(stateInit.getMaxDepth()),
                stateInit.hash()
            ])
        } else {
            pkg = Buffer.concat([
                pkg,
                writeUin8(0)
            ]);
        }

        // Payload
        let payload: Cell | null = null;
        if (transaction.payload) {
            payload = new Cell();
            transaction.payload.writeTo(payload);
            pkg = Buffer.concat([
                pkg,
                writeUin8(1),
                writeUin16(payload.getMaxDepth()),
                payload.hash()
            ])
        } else {
            pkg = Buffer.concat([
                pkg,
                writeUin8(0)
            ]);
        }

        // Hints
        pkg = Buffer.concat([
            pkg,
            writeUin8(0)
        ]);

        //
        // Send package
        //

        await this.#doRequest(0x06, 0x00, 0x80, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        let res = await this.#doRequest(0x06, 0x01, 0x00, pkg);

        //
        // Parse response
        //

        let orderBuilder = beginCell()
            .storeBit(0)
            .storeBit(true)
            .storeBit(transaction.bounce)
            .storeBit(false)
            .storeAddress(null)
            .storeAddress(transaction.to)
            .storeCoins(transaction.amount)
            .storeBit(false)
            .storeCoins(0)
            .storeCoins(0)
            .storeUint(0, 64)
            .storeUint(0, 32)

        // State Init
        if (stateInit) {
            orderBuilder = orderBuilder
                .storeBit(true)
                .storeBit(true) // Always in reference
                .storeRef(stateInit)
        } else {
            orderBuilder = orderBuilder
                .storeBit(false);
        }

        // Payload
        if (payload) {
            orderBuilder = orderBuilder
                .storeBit(true)
                .storeRef(payload)
        } else {
            orderBuilder = orderBuilder
                .storeBit(false)
        }

        // Transfer message
        let transfer = beginCell()
            .storeUint(698983191, 32)
            .storeUint(transaction.timeout, 32)
            .storeUint(transaction.seqno, 32)
            .storeUint(0, 8)
            .storeUint(transaction.sendMode, 8)
            .storeRef(orderBuilder.endCell())
            .endCell();

        // Parse result
        let signature = res.slice(1, 1 + 64);
        let hash = res.slice(2 + 64, 2 + 64 + 32);
        if (!hash.equals(transfer.hash())) {
            throw Error('Hash mismatch. Expected: ' + transfer.hash().toString('hex') + ', got: ' + hash.toString('hex'));
        }
        if (!signVerify(hash, signature, publicKey)) {
            throw Error('Received signature is invalid');
        }

        // Build a message
        let resultCell = new Cell();
        resultCell.bits.writeBuffer(signature);
        resultCell.writeCell(transfer);
        
        return resultCell;
    }

    #doRequest = async (ins: number, p1: number, p2: number, data: Buffer) => {
        let r = await this.transport.send(
            LEDGER_CLA,
            ins,
            p1,
            p2,
            data
        );
        return r.slice(0, r.length - 2);
    }
}

//
// Utils
//

function validatePath(path: number[]) {
    if (path.length < 6) {
        throw Error('Path is too short');
    }
    if (path[0] !== 44) {
        throw Error('First element of a path must be 44');
    }
    if (path[1] !== 607) {
        throw Error('Second element of a path must be 607');
    }
    for (let p of path) {
        if (p >= 0x80000000) {
            throw Error('All path elements must be under 0x80000000');
        }
    }
}

function pathElementsToBuffer(paths: number[]): Buffer {
    const buffer = Buffer.alloc(1 + paths.length * 4);
    buffer[0] = paths.length;
    paths.forEach((element, index) => {
        buffer.writeUInt32BE(element, 1 + 4 * index);
    });
    return buffer;
}

function writeUin32(value: number) {
    let b = Buffer.alloc(4);
    b.writeUint32BE(value, 0);
    return b;
}
function writeUin16(value: number) {
    let b = Buffer.alloc(2);
    b.writeUint16BE(value, 0);
    return b;
}
function writeUin64(value: BN) {
    return value.toBuffer('be', 8);
}

function writeUin8(value: number) {
    let b = Buffer.alloc(1);
    b.writeUint8(value, 0);
    return b;
}