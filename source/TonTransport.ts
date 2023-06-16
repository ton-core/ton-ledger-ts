import Transport from "@ledgerhq/hw-transport";
import { Address, beginCell, Cell, contractAddress, SendMode, StateInit, storeStateInit } from "ton-core";
import { signVerify } from 'ton-crypto';
import { AsyncLock } from 'teslabot';
import { writeAddress, writeCellRef, writeUint16, writeUint32, writeUint64, writeUint8, writeVarUInt } from "./utils/ledgerWriter";
import { getInit } from "./utils/getInit";

const LEDGER_SYSTEM = 0xB0;
const LEDGER_CLA = 0xe0;
const INS_VERSION = 0x03;
const INS_ADDRESS = 0x05;
const INS_SIGN_TX = 0x06;
const INS_PROOF = 0x08;
const INS_SIGN_DATA = 0x09;

export type TonPayloadFormat =
    | { type: 'unsafe', message: Cell }
    | { type: 'comment', text: string }
    | { type: 'jetton-transfer', queryId: bigint | null, amount: bigint, decimals: number, ticker: string, destination: Address, responseDestination: Address, customPayload: Cell | null, forwardAmount: bigint, forwardPayload: Cell | null }
    | { type: 'nft-transfer', queryId: bigint | null, newOwner: Address, responseDestination: Address, customPayload: Cell | null, forwardAmount: bigint, forwardPayload: Cell | null }

export type SignDataRequest =
    | { type: 'plaintext', text: string }
    | { type: 'app-data', address?: Address, domain?: string, data: Cell, ext?: Cell }

function chunks(buf: Buffer, n: number): Buffer[] {
    const nc = Math.ceil(buf.length / n);
    const cs: Buffer[] = [];
    for (let i = 0; i < nc; i++) {
        cs.push(buf.subarray(i * n, (i + 1) * n));
    }
    return cs;
}

function processAddressFlags(opts?: { testOnly?: boolean, bounceable?: boolean, chain?: number }): { testOnly: boolean, bounceable: boolean, chain: number, flags: number } {
    const bounceable = opts?.bounceable ?? true;
    const testOnly = opts?.testOnly ?? false;
    const chain = opts?.chain ?? 0;

    let flags = 0x00;
    if (testOnly) {
        flags |= 0x01;
    }
    if (chain === -1) {
        flags |= 0x02;
    }

    return { bounceable, testOnly, chain, flags };
}

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
        const { bounceable, testOnly, chain } = processAddressFlags(opts);

        // Get public key
        let response = await this.#doRequest(INS_ADDRESS, 0x00, 0x00, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        if (response.length !== 32) {
            throw Error('Invalid response');
        }

        // Contract
        const contract = getInit(chain, response);
        const address = contractAddress(chain, contract);

        return { address: address.toString({ bounceable, testOnly }), publicKey: response };
    }

    async validateAddress(path: number[], opts?: { testOnly?: boolean, bounceable?: boolean, chain?: number }) {

        // Check path
        validatePath(path);

        // Resolve flags
        const { bounceable, testOnly, chain, flags } = processAddressFlags(opts);

        // Get public key
        let response = await this.#doRequest(INS_ADDRESS, 0x01, flags, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        if (response.length !== 32) {
            throw Error('Invalid response');
        }

        // Contract
        const contract = getInit(chain, response);
        const address = contractAddress(chain, contract);

        return { address: address.toString({ bounceable, testOnly }), publicKey: response };
    }

    async getAddressProof(path: number[], params: { domain: string, timestamp: number, payload: Buffer }, opts?: { testOnly?: boolean, bounceable?: boolean, chain?: number }) {

        // Check path
        validatePath(path);

        let publicKey = (await this.getAddress(path)).publicKey;

        // Resolve flags
        const { flags } = processAddressFlags(opts);

        const domainBuf = Buffer.from(params.domain, 'utf-8');
        const reqBuf = Buffer.concat([
            pathElementsToBuffer(path.map((v) => v + 0x80000000)),
            writeUint8(domainBuf.length),
            domainBuf,
            writeUint64(BigInt(params.timestamp)),
            params.payload,
        ]);

        // Get public key
        let res = await this.#doRequest(INS_PROOF, 0x01, flags, reqBuf);
        let signature = res.slice(1, 1 + 64);
        let hash = res.slice(2 + 64, 2 + 64 + 32);
        if (!signVerify(hash, signature, publicKey)) {
            throw Error('Received signature is invalid');
        }

        return { signature, hash };
    }

    async signData(path: number[], req: SignDataRequest, opts?: { timestamp?: number }) {
        validatePath(path);

        const publicKey = (await this.getAddress(path)).publicKey;

        const timestamp = opts?.timestamp ?? Math.floor(Date.now() / 1000)

        let schema: number
        let data: Buffer
        let cell: Cell
        switch (req.type) {
            case 'plaintext': {
                schema = 0x754bf91b;
                data = Buffer.from(req.text, 'ascii');
                cell = beginCell().storeStringTail(req.text).endCell();
                break;
            }
            case 'app-data': {
                if (req.address === undefined && req.domain === undefined) {
                    throw new Error('At least one of `address` and `domain` must be set when using \'app-data\' request');
                }
                schema = 0x54b58535;
                let b = beginCell();
                let dp: Buffer[] = [];

                if (req.address !== undefined) {
                    b.storeBit(1);
                    b.storeAddress(req.address);
                    dp.push(writeUint8(1), writeAddress(req.address));
                } else {
                    b.storeBit(0);
                    dp.push(writeUint8(0));
                }

                if (req.domain !== undefined) {
                    b.storeBit(1);
                    let inner = beginCell();
                    req.domain.split('.').reverse().forEach(p => {
                        inner.storeBuffer(Buffer.from(p, 'ascii'));
                        inner.storeUint(0, 8);
                    });
                    b.storeRef(inner);
                    const db = Buffer.from(req.domain, 'ascii');
                    dp.push(writeUint8(1), writeUint8(db.length), db);
                } else {
                    b.storeBit(0);
                    dp.push(writeUint8(0));
                }

                b.storeRef(req.data);
                dp.push(writeCellRef(req.data));

                if (req.ext !== undefined) {
                    b.storeBit(1);
                    b.storeRef(req.ext);
                    dp.push(writeUint8(1), writeCellRef(req.ext));
                } else {
                    b.storeBit(0);
                    dp.push(writeUint8(0));
                }

                data = Buffer.concat(dp);
                cell = b.endCell();
                break;
            }
            default: {
                throw new Error(`Sign data request type '${(req as any).type}' not supported`)
            }
        }

        const commonPart = Buffer.concat([
            writeUint32(schema),
            writeUint64(BigInt(timestamp)),
        ]);

        const pkg = Buffer.concat([
            commonPart,
            data,
        ])

        await this.#doRequest(INS_SIGN_DATA, 0x00, 0x03, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        const pkgCs = chunks(pkg, 255);
        for (let i = 0; i < pkgCs.length - 1; i++) {
            await this.#doRequest(INS_SIGN_DATA, 0x00, 0x02, pkgCs[i]);
        }
        const res = await this.#doRequest(INS_SIGN_DATA, 0x00, 0x00, pkgCs[pkgCs.length-1]);

        let signature = res.subarray(1, 1 + 64);
        let hash = res.subarray(2 + 64, 2 + 64 + 32);
        if (!hash.equals(cell.hash())) {
            throw Error('Hash mismatch. Expected: ' + cell.hash().toString('hex') + ', got: ' + hash.toString('hex'));
        }
        if (!signVerify(Buffer.concat([commonPart, hash]), signature, publicKey)) {
            throw Error('Received signature is invalid');
        }

        return {
            signature,
            cell,
            timestamp,
        }
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
            writeVarUInt(transaction.amount),
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
            } else if (transaction.payload.type === 'jetton-transfer' || transaction.payload.type === 'nft-transfer') {
                hints = Buffer.concat([
                    writeUint8(1),
                    writeUint32(transaction.payload.type === 'jetton-transfer' ? 0x01 : 0x02)
                ]);

                let b = beginCell()
                    .storeUint(transaction.payload.type === 'jetton-transfer' ? 0x0f8a7ea5 : 0x5fcc3d14, 32);
                let d = Buffer.alloc(0);

                if (transaction.payload.queryId !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeUint64(transaction.payload.queryId)]);
                    b = b.storeUint(transaction.payload.queryId, 64);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                    b = b.storeUint(0, 64);
                }

                if (transaction.payload.type === 'jetton-transfer') {
                    d = Buffer.concat([d, writeVarUInt(transaction.payload.amount)]);
                    b = b.storeCoins(transaction.payload.amount);

                    d = Buffer.concat([d, writeUint8(transaction.payload.decimals), writeUint8(transaction.payload.ticker.length), Buffer.from(transaction.payload.ticker, 'ascii')]);

                    d = Buffer.concat([d, writeAddress(transaction.payload.destination)]);
                    b = b.storeAddress(transaction.payload.destination);
                } else {
                    d = Buffer.concat([d, writeAddress(transaction.payload.newOwner)]);
                    b = b.storeAddress(transaction.payload.newOwner);
                }

                d = Buffer.concat([d, writeAddress(transaction.payload.responseDestination)]);
                b = b.storeAddress(transaction.payload.responseDestination);

                if (transaction.payload.customPayload !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeCellRef(transaction.payload.customPayload)]);
                    b = b.storeMaybeRef(transaction.payload.customPayload);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                    b = b.storeMaybeRef(transaction.payload.customPayload);
                }

                d = Buffer.concat([d, writeVarUInt(transaction.payload.forwardAmount)]);
                b = b.storeCoins(transaction.payload.forwardAmount);

                if (transaction.payload.forwardPayload !== null) {
                    d = Buffer.concat([d, writeUint8(1), writeCellRef(transaction.payload.forwardPayload)]);
                    b = b.storeMaybeRef(transaction.payload.forwardPayload);
                } else {
                    d = Buffer.concat([d, writeUint8(0)]);
                    b = b.storeMaybeRef(transaction.payload.forwardPayload);
                }

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

        await this.#doRequest(INS_SIGN_TX, 0x00, 0x03, pathElementsToBuffer(path.map((v) => v + 0x80000000)));
        const pkgCs = chunks(pkg, 255);
        for (let i = 0; i < pkgCs.length - 1; i++) {
            await this.#doRequest(INS_SIGN_TX, 0x00, 0x02, pkgCs[i]);
        }
        let res = await this.#doRequest(INS_SIGN_TX, 0x00, 0x00, pkgCs[pkgCs.length-1]);

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