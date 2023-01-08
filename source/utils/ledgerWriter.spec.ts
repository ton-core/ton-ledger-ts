import { Address, beginCell } from 'ton-core';
import { writeAddress, writeCellRef, writeUint16, writeUint32, writeUint64, writeUint8 } from "./ledgerWriter";

describe('ledgerWriter', () => {
    it('should write ints', () => {
        expect(writeUint8(0).toString('hex')).toMatchSnapshot();
        expect(writeUint8(10).toString('hex')).toMatchSnapshot();
        expect(writeUint8(255).toString('hex')).toMatchSnapshot();
        expect(writeUint16(0).toString('hex')).toMatchSnapshot();
        expect(writeUint16(255).toString('hex')).toMatchSnapshot();
        expect(writeUint16(12312).toString('hex')).toMatchSnapshot();
        expect(writeUint16(65535).toString('hex')).toMatchSnapshot();
        expect(writeUint32(0).toString('hex')).toMatchSnapshot();
        expect(writeUint32(255).toString('hex')).toMatchSnapshot();
        expect(writeUint32(12312).toString('hex')).toMatchSnapshot();
        expect(writeUint32(65535).toString('hex')).toMatchSnapshot();
        expect(writeUint32(123123123).toString('hex')).toMatchSnapshot();
        expect(writeUint32(4294967295).toString('hex')).toMatchSnapshot();

        expect(writeUint64(0n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(255n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(12312n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(65535n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(123123123n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(4294967295n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(12312312312312n).toString('hex')).toMatchSnapshot();
        expect(writeUint64(18446744073709551615n).toString('hex')).toMatchSnapshot();
    });
    it('should write addresses', () => {
        expect(writeAddress(new Address(0, Buffer.alloc(32))).toString('hex')).toMatchSnapshot();
        expect(writeAddress(new Address(-1, Buffer.alloc(32))).toString('hex')).toMatchSnapshot();
        expect(writeAddress(Address.parse('EQBNVUFfKt2QgqKL5vZvnyP50wmniCFP2ASOKAE-g2noRDlR')).toString('hex')).toMatchSnapshot();
        expect(writeAddress(Address.parse('Ef87m7_QrVM4uXAPCDM4DuF9Rj5Rwa5nHubwiQG96JmyAjQY')).toString('hex')).toMatchSnapshot();
    });
    it('should write cell refs', () => {
        expect(writeCellRef(beginCell().endCell()).toString('hex')).toMatchSnapshot();
        expect(writeCellRef(beginCell().storeUint(0, 32).endCell()).toString('hex')).toMatchSnapshot();
        expect(writeCellRef(beginCell().storeUint(0, 32).storeRef(beginCell().endCell()).endCell()).toString('hex')).toMatchSnapshot();
        expect(writeCellRef(beginCell().storeUint(0, 32).storeRef(beginCell().storeRef(beginCell().endCell()).endCell()).endCell()).toString('hex')).toMatchSnapshot();
    });
});