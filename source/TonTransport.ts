import Transport from "@ledgerhq/hw-transport";
import { Address, beginCell, Cell, contractAddress, Message, SendMode, StateInit, storeStateInit } from "ton-core";
import { sha256, signVerify } from 'ton-crypto';
import { AsyncLock } from 'teslabot';
import { writeAddress, writeCellRef, writeUint16, writeUint32, writeUint64, writeUint8 } from "./utils/ledgerWriter";
import { getInit } from "./utils/getInit";

const LEDGER_SYSTEM = 0xB0;
const LEDGER_CLA = 0xe0;
const INS_VERSION = 0x03;
const INS_ADDRESS = 0x05;

export type TonPayloadFormat =
    | { type: 'unsafe', message: Cell }
    | { type: 'comment', text: string }
    | { type: 'upgrade', queryId: bigint | null, gasLimit: bigint | null, code: Cell }
    | { type: 'deposit', queryId: bigint | null, gasLimit: bigint | null }
    | { type: 'withdraw', queryId: bigint | null, gasLimit: bigint | null, amount: bigint }
    | { type: 'transfer-ownership', queryId: bigint | null, address: Address }
    | { type: 'create-proposal', queryId: bigint | null, id: number | null, proposal: Cell, metadata: Cell }
    | { type: 'vote-proposal', queryId: bigint | null, id: number, vote: 'yes' | 'no' | 'abstain' }
    | { type: 'execute-proposal', queryId: bigint | null, id: number }
    | { type: 'abort-proposal', queryId: bigint | null, id: number }
    | { type: 'change-address', queryId: bigint | null, gasLimit: bigint | null, index: number, address: Address }

export class TonTransport {
    readonly transport: Transport;
    #lock = new AsyncLock();

    constructor(transport: Transport) {
        this.transport = transport;
    }

    //
    // Apps
    //

    async #getCurrentApp(): Promise<{ name: string, version: string }> {
        return this.#lock.inLock(async () => {
            let r = await this.transport.send(
                LEDGER_SYSTEM,
                0x01,
                0x00,
                0x00,
                undefined,
                [0x9000]
            );
            let data = r.slice(0, r.length - 2);
            if (data[0] !== 0x01) {
                throw Error('Invalid response');
            }
            let nameLength = data[1];
            let name = data.slice(2, 2 + nameLength).toString();
            let versionLength = data[2 + nameLength];
            let version = data.slice(3 + nameLength, 3 + nameLength + versionLength).toString();
            return { name, version };
        });
    }

    async isAppOpen() {
        return (await this.#getCurrentApp()).name === 'TON';
    }

    async getVersion(): Promise<string> {
        let loaded = await this.#doRequest(INS_VERSION, 0x00, 0x00, Buffer.alloc(0));
        const [major, minor, patch] = loaded;
        return `${major}.${minor}.${patch}`;
    }

    //
    // Operations
    //

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
        const contract = getInit(chain, response);
        const address = contractAddress(chain, contract);

        return { address: address.toString({ bounceable: bounceable, testOnly: test }), publicKey: response };
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
        const contract = getInit(chain, response);
        const address = contractAddress(chain, contract);

        return { address: address.toString({ bounceable: bounceable, testOnly: test }), publicKey: response };
    }

    signTransaction = async (
        path: number[],
        transaction: {
            to: Address,
            sendMode: SendMode,
            seqno: number,
            timeout: number,
            bounce: boolean,
            amount: bigint,
            stateInit?: StateInit,
            payload?: TonPayloadFormat
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
            writeUint8(0), // Header
            writeUint32(transaction.seqno),
            writeUint32(transaction.timeout),
            writeUint64(transaction.amount),
            writeAddress(transaction.to),
            writeUint8(transaction.bounce ? 1 : 0),
            writeUint8(transaction.sendMode),
        ]);

        //
        // State init
        //

        let stateInit: Cell | null = null;
        if (transaction.stateInit) {
            stateInit = beginCell()
                .store(storeStateInit(transaction.stateInit))
                .endCell();
            pkg = Buffer.concat([
                pkg,
                writeUint8(1),
                writeUint16(stateInit.depth()),
                stateInit.hash()
            ])
        } else {
            pkg = Buffer.concat([
                pkg,
                writeUint8(0)
            ]);
        }

        //
        // Payload
        //

        let payload: Cell | null = null;
        let hints: Buffer = Buffer.concat([writeUint8(0)]);
        if (transaction.payload) {
            if (transaction.payload.type === 'comment') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x00),
                    writeUint16(Buffer.from(transaction.payload.text).length),
                    Buffer.from(transaction.payload.text)
                ]);
                payload = beginCell()
                    .storeUint(0, 32)
                    .storeBuffer(Buffer.from(transaction.payload.text))
                    .endCell()
            } else if (transaction.payload.type === 'unsafe') {
                payload = transaction.payload.message;
            } else if (transaction.payload.type === 'upgrade') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x01)
                ]);


                // Build cells and hints
                let b = beginCell()
                    .storeUint(0xdbfaf817, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Gas Limit
                if (transaction.payload.gasLimit !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.gasLimit)]);
                    b = b.storeCoins(transaction.payload.gasLimit);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Complete
                d = Buffer.concat([d,
                    writeUint16(transaction.payload.code.depth()),
                    transaction.payload.code.hash()
                ]);
                payload = b.storeRef(transaction.payload.code).endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ])
            } else if (transaction.payload.type === 'deposit') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x02)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0x7bcd1fef, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Gas Limit
                if (transaction.payload.gasLimit !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.gasLimit)]);
                    b = b.storeCoins(transaction.payload.gasLimit);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ])
            } else if (transaction.payload.type === 'withdraw') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x03)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0xda803efd, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Gas Limit
                if (transaction.payload.gasLimit !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.gasLimit)]);
                    b = b.storeCoins(transaction.payload.gasLimit);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Amount
                d = Buffer.concat([d, writeUint64(transaction.payload.amount)]);
                b = b.storeCoins(transaction.payload.amount);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ])
            } else if (transaction.payload.type === 'transfer-ownership') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x04)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0x295e75a9, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Address
                d = Buffer.concat([d,
                    writeAddress(transaction.payload.address),
                ]);
                b = b.storeAddress(transaction.payload.address);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ])
            } else if (transaction.payload.type === 'create-proposal') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x05)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0xc1387443, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Proposal ID
                if (transaction.payload.id !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint32(transaction.payload.id)]);
                    b = b.storeUint(transaction.payload.id, 32);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Proposal
                d = Buffer.concat([d,
                    writeCellRef(transaction.payload.proposal)
                ]);
                b = b.storeRef(transaction.payload.proposal);

                // Proposal
                d = Buffer.concat([d,
                    writeCellRef(transaction.payload.metadata)
                ]);
                b = b.storeRef(transaction.payload.metadata);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ]);
            } else if (transaction.payload.type === 'vote-proposal') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x06)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0xb5a563c1, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // ID
                d = Buffer.concat([d, writeUint32(transaction.payload.id)]);
                b = b.storeUint(transaction.payload.id, 32);

                // Vote
                let voteKey = 0x00;
                if (transaction.payload.vote === 'yes') {
                    voteKey = 0x01;
                } else if (transaction.payload.vote === 'abstain') {
                    voteKey = 0x02;
                }

                // Store
                d = Buffer.concat([d, writeUint8(voteKey)]);
                b = b.storeUint(voteKey, 2);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ]);
            } else if (transaction.payload.type === 'execute-proposal') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x07)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0x93ff9cd3, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // ID
                d = Buffer.concat([d, writeUint32(transaction.payload.id)]);
                b = b.storeUint(transaction.payload.id, 32);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ]);
            } else if (transaction.payload.type === 'abort-proposal') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x08)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0x5ce656a5, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // ID
                d = Buffer.concat([d, writeUint32(transaction.payload.id)]);
                b = b.storeUint(transaction.payload.id, 32);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ]);
            } else if (transaction.payload.type === 'change-address') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(0x09)
                ]);

                // Build cells and hints
                let b = beginCell()
                    .storeUint(0x90eafae1, 32);
                let d = Buffer.alloc(0);

                // Query ID
                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Gas Limit
                if (transaction.payload.gasLimit !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.gasLimit)]);
                    b = b.storeCoins(transaction.payload.gasLimit);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                }

                // Index
                d = Buffer.concat([d,
                    writeUint8(transaction.payload.index)]);
                b = b.storeUint(transaction.payload.index, 8);

                // Address
                d = Buffer.concat([d,
                    writeAddress(transaction.payload.address),
                ]);
                b = b.storeAddress(transaction.payload.address);

                // Complete
                payload = b.endCell();
                hints = Buffer.concat([
                    hints,
                    writeUint16(d.length),
                    d
                ])
            }
        }

        //
        // Serialize payload
        //

        if (payload) {
            pkg = Buffer.concat([
                pkg,
                writeUint8(1),
                writeUint16(payload.depth()),
                payload.hash(),
                hints
            ])
        } else {
            pkg = Buffer.concat([
                pkg,
                writeUint8(0),
                writeUint8(0)
            ]);
        }

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
                .storeBit(true) // Always in reference
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
        return beginCell()
            .storeBuffer(signature)
            .storeSlice(transfer.beginParse())
            .endCell();
    }

    signMessage = async (path: number[], text: string) => {

        // Check path
        validatePath(path);

        //
        // Fetch key
        //

        let publicKey = (await this.getAddress(path)).publicKey;

        // Send request
        let pkg = Buffer.from(text);
        await this.#doRequest(0x07, 0x00, 0x80, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        let res = await this.#doRequest(0x07, 0x01, 0x00, pkg);

        // Check signature
        let signature = res.slice(1, 1 + 64);
        let intHash = Buffer.concat([Buffer.from([0x96, 0x89, 0x0e, 0x83]), await sha256(pkg)]);
        let hash = res.slice(2 + 64, 2 + 64 + 36);
        if (!signVerify(intHash, signature, publicKey)) {
            throw Error('Received signature is invalid');
        }

        return signature;
    }

    #doRequest = async (ins: number, p1: number, p2: number, data: Buffer) => {
        return this.#lock.inLock(async () => {
            let r = await this.transport.send(
                LEDGER_CLA,
                ins,
                p1,
                p2,
                data
            );
            return r.slice(0, r.length - 2);
        });
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