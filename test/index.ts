import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import { Address, Cell, toNano } from "ton";
import { TonTransport } from "../source";

(async () => {
    console.log('Connecting...');
    let device = (await TransportNodeHid.list())[0];
    let dev = await TransportNodeHid.open(device);
    let client = new TonTransport(dev);
    console.log('Getting app version');
    let version = await client.getVersion();
    console.log(version);
    // let address = await client.getAddress([44, 607, 0, 0, 0, 0], { testOnly: true });
    // console.log(address);

    console.warn(new Cell().hash().toString('base64'));

    await client.signTransaction([44, 607, 0, 0, 0, 0], {
        to: Address.parse('kQCSct8Hk6AUHlrma5xn_uUsvxPKyVUdEIZAyCzIht3TFTmt'),
        amount: toNano(1),
        sendMode: 0,
        seqno: 1,
        timeout: Math.floor((Date.now() / 1000) + 60),
        bounce: true,
        // payload: { type: 'create-proposal', id: 1, proposal: new Cell(), metadata: new Cell(), queryId: null }
        // payload: { type: 'upgrade', code: new Cell(), queryId: null, gasLimit: null }
        // payload: { type: 'vote-proposal', id: 1, vote: 'abstain', queryId: null }
        // payload: { type: 'abort-proposal', id: 1, queryId: null }
        payload: { type: 'change-address', index: 0, address: Address.parse('kQCSct8Hk6AUHlrma5xn_uUsvxPKyVUdEIZAyCzIht3TFTmt'), queryId: null, gasLimit: null }
    });
})();