const { ethers } = require('hardhat');
const { assert } = require('chai');
const { parseUnits } = require('@ethersproject/units');
const { BigNumber } = require('@ethersproject/bignumber');
const { expect } = require('chai');

const {
  bufToStr,
  getBalance,
  htlcArrayToObj,
  isSha256Hash,
  newSecretHashPair,
  nowSeconds,
  random32,
  txLoggedArgs,
} = require('./helper/utils');

const hourSeconds = 3600;
const timeLock1Hour = nowSeconds() + hourSeconds;
const oneFinney = parseUnits('1').toString();
const twoFinney = parseUnits('2').toString();
const chainId = 1;
const _address = '0x0';

describe('HashedTimelock', () => {
  let HashedTimelock;
  let htlc;
  let accounts;

  before(async () => {
    // Deploy the HashedTimelock contract
    HashedTimelock = await ethers.getContractFactory('HashedTimelockEther');
    htlc = await HashedTimelock.deploy();
    accounts = await ethers.getSigners();
  });

  it('newContract() should create new contract and store correct details', async () => {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];

    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver.address, hashPair.hash, timeLock1Hour, chainId, _address, {
        value: oneFinney,
      });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;

    assert(isSha256Hash(contractId));

    assert.equal(logArgs.sender, sender.address);
    assert.equal(logArgs.receiver, receiver.address);
    assert.equal(logArgs.amount.toString(), oneFinney.toString());
    assert.equal(logArgs.hashlock, hashPair.hash);
    assert.equal(logArgs.timelock, timeLock1Hour);

    const contractArr = await htlc.getHTLCDetails(contractId);
    const contract = htlcArrayToObj(contractArr);
    assert.equal(contract.sender, sender.address);
    assert.equal(contract.receiver, receiver.address);
    assert.equal(contract.amount.toString(), oneFinney.toString());
    assert.equal(contract.hashlock, hashPair.hash);
    assert.equal(contract.timelock, timeLock1Hour);
    assert.isFalse(contract.withdrawn);
    assert.isFalse(contract.refunded);
    assert.equal(contract.preimage, '0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('newContract() should fail when no ETH sent', async function () {
    const hashPair = newSecretHashPair();
    const receiver = accounts[1].address;
    try {
      // Execute the transaction that should revert with the custom error
      await htlc.createHTLC(receiver, hashPair.hash, timeLock1Hour, chainId, _address, { value: 0 });
      // If no error is thrown, fail the test
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      // Check if the error thrown is of type 'FundsNotSent'
      assert.include(error.message, 'FundsNotSent');
    }
  });

  it('newContract() should fail with timelocks in the past', async function () {
    const hashPair = newSecretHashPair();
    const receiver = accounts[1].address;
    const pastTimelock = (await ethers.provider.getBlock('latest')).timestamp - 1;
    try {
      // Execute the transaction that should revert with the custom error
      await htlc.createHTLC(receiver, hashPair.hash, pastTimelock, chainId, _address, { value: oneFinney });
      // If no error is thrown, fail the test
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      assert.include(error.message, 'NotFutureTimelock');
    }
  });

  it('newContract() should reject a duplicate contract request', async function () {
    const hashPair = newSecretHashPair();
    const receiver = accounts[1].address;
    await htlc.createHTLC(receiver, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    try {
      await htlc.createHTLC(receiver, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      assert.include(error.message, 'ContractAlreadyExist');
    }
  });

  it('redeem() should send receiver funds when given the correct secret preimage', async function () {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];
    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;

    const receiver1BalBefore = await getBalance(receiver);

    const withdrawTx = await htlc.connect(receiver).redeem(contractId, hashPair.secret);
    const tx = await withdrawTx.wait();

    const gasUsed = BigNumber.from(tx.gasUsed);
    const gasPrice = BigNumber.from(tx.gasPrice);

    const gasCost = gasUsed.mul(gasPrice);

    const expectedBal = receiver1BalBefore.add(oneFinney).sub(gasCost);

    const receiverBalAfter = await getBalance(receiver);

    expect(receiverBalAfter.eq(expectedBal)).to.be.true;

    const contractArr = await htlc.getHTLCDetails(contractId);
    const contract = htlcArrayToObj(contractArr);
    expect(contract.withdrawn).to.be.true;
    expect(contract.refunded).to.be.false;
    expect(contract.preimage).to.equal(hashPair.secret);
  });

  it('redeem() should fail if preimage does not hash to hashX', async function () {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];
    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver.address, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;
    const wrongSecret = bufToStr(random32());
    try {
      await htlc.connect(receiver).redeem(contractId, wrongSecret);
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      assert.include(error.message, 'HashlockNotMatch');
    }
  });

  it('redeem() should send receiver funds when caller is not the receiver', async function () {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];
    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;

    const receiver1BalBefore = await getBalance(receiver);
    const someGuy = accounts[4];
    const withdrawTx = await htlc.connect(someGuy).redeem(contractId, hashPair.secret);

    const expectedBal = receiver1BalBefore.add(oneFinney);
    const receiverBalAfter = await getBalance(receiver);
    expect(receiverBalAfter.eq(expectedBal)).to.be.true;

    const contractArr = await htlc.getHTLCDetails(contractId);
    const contract = htlcArrayToObj(contractArr);
    expect(contract.withdrawn).to.be.true;
    expect(contract.refunded).to.be.false;
    expect(contract.preimage).to.equal(hashPair.secret);
  });

  it('redeem() should fail after timelock expiry', async function () {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];
    const timelock1Second = (await ethers.provider.getBlock('latest')).timestamp + 10;

    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver.address, hashPair.hash, timelock1Second, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;

    await ethers.provider.send('evm_increaseTime', [20]); // Increase time by 20 seconds

    try {
      await htlc.connect(receiver).redeem(contractId, hashPair.secret);
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      assert.include(error.message, 'NotFutureTimelock');
    }
  });

  it('batchRedeem() should send receiver funds when given the correct secret preimage', async function () {
    const hashPair1 = newSecretHashPair();
    const hashPair2 = newSecretHashPair();
    const hashPair3 = newSecretHashPair();
    const hashPair4 = newSecretHashPair();
    const receiver = accounts[0];
    const receiver2 = accounts[1];
    const sender1 = accounts[2];
    const sender2 = accounts[3];
    const sender3 = accounts[4];
    const sender4 = accounts[5];

    const txReceipt1 = await htlc
      .connect(sender1)
      .createHTLC(receiver, hashPair1.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents1 = await txReceipt1.wait();
    const logArgs1 = txLoggedArgs(txReceiptWithEvents1);
    const contractId1 = logArgs1.contractId;

    const txReceipt2 = await htlc
      .connect(sender2)
      .createHTLC(receiver, hashPair2.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents2 = await txReceipt2.wait();
    const logArgs2 = txLoggedArgs(txReceiptWithEvents2);
    const contractId2 = logArgs2.contractId;

    const txReceipt3 = await htlc
      .connect(sender3)
      .createHTLC(receiver, hashPair3.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents3 = await txReceipt3.wait();
    const logArgs3 = txLoggedArgs(txReceiptWithEvents3);
    const contractId3 = logArgs3.contractId;

    const txReceipt4 = await htlc
      .connect(sender4)
      .createHTLC(receiver2, hashPair4.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents4 = await txReceipt4.wait();
    const logArgs4 = txLoggedArgs(txReceiptWithEvents4);
    const contractId4 = logArgs4.contractId;

    const receiver1BalBefore = await getBalance(receiver);
    const receiver2BalBefore = await getBalance(receiver2);

    const withdrawTx = await htlc
      .connect(receiver)
      .batchRedeem(
        [contractId1, contractId2, contractId3, contractId4],
        [hashPair1.secret, hashPair2.secret, hashPair3.secret, hashPair4.secret]
      );
    const tx = await withdrawTx.wait();

    const gasUsed = BigNumber.from(tx.gasUsed);
    const gasPrice = BigNumber.from(tx.gasPrice);

    const gasCost = gasUsed.mul(gasPrice);

    const oneFinneyBN = BigNumber.from(oneFinney);

    const expectedBal1 = receiver1BalBefore.add(oneFinneyBN.mul(3)).sub(gasCost);
    const expectedBal2 = receiver2BalBefore.add(oneFinney);

    const receiver1BalAfter = await getBalance(receiver);
    const receiver2BalAfter = await getBalance(receiver2);

    expect(receiver1BalAfter.eq(expectedBal1)).to.be.true;
    expect(receiver2BalAfter.eq(expectedBal2)).to.be.true;

    const contractArr1 = await htlc.getHTLCDetails(contractId1);
    const contract1 = htlcArrayToObj(contractArr1);
    expect(contract1.withdrawn).to.be.true;
    expect(contract1.refunded).to.be.false;
    expect(contract1.preimage).to.equal(hashPair1.secret);

    const contractArr2 = await htlc.getHTLCDetails(contractId2);
    const contract2 = htlcArrayToObj(contractArr2);
    expect(contract2.withdrawn).to.be.true;
    expect(contract2.refunded).to.be.false;
    expect(contract2.preimage).to.equal(hashPair2.secret);

    const contractArr3 = await htlc.getHTLCDetails(contractId3);
    const contract3 = htlcArrayToObj(contractArr3);
    expect(contract3.withdrawn).to.be.true;
    expect(contract3.refunded).to.be.false;
    expect(contract3.preimage).to.equal(hashPair3.secret);
  });

  it('refund() should fail before the timelock expiry', async function () {
    const hashPair = newSecretHashPair();
    const sender = accounts[0];
    const receiver = accounts[1];

    const txReceipt = await htlc
      .connect(sender)
      .createHTLC(receiver.address, hashPair.hash, timeLock1Hour, chainId, _address, { value: oneFinney });
    const txReceiptWithEvents = await txReceipt.wait();
    const logArgs = txLoggedArgs(txReceiptWithEvents);
    const contractId = logArgs.contractId;

    try {
      await htlc.connect(sender).refund(contractId);
      assert.fail('Transaction did not revert as expected');
    } catch (error) {
      assert.include(error.message, 'NotPassedTimelock');
    }
  });

  it("getHTLCDetails() returns empty record when contract doesn't exist", async function () {
    // Use a placeholder address for a non-existent contract
    const nonExistentContractId = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const contract = await htlc.getHTLCDetails(nonExistentContractId);
    expect(Number(contract[0])).to.equal(0);
  });
});


it("should create batch HTLCs successfully", async function () {
  const _receivers = [accounts[1], accounts[2]];
  const _hashlocks = [newSecretHashPair().hash, newSecretHashPair().hash]; 
  const _timelocks = [(await ethers.provider.getBlock('latest')).timestamp + 300, (await ethers.provider.getBlock('latest')).timestamp + 600];
  const _chainIDs = [1, 1];
  const _targetCurrencyReceiversAddresses = ["currencyAddress1", "currencyAddress2"];
  const _amounts = [oneFinney,oneFinney];
  const totalValue = twoFinney;

  const tx = await htlc.connect(accounts[0]).createBatchHTLC(
    _receivers,
    _hashlocks,
    _timelocks,
    _chainIDs,
    _targetCurrencyReceiversAddresses,
    _amounts,
    { value: totalValue }
  );

  await expect(tx)
    .to.emit(htlc, "EtherTransferInitiated");

    const receipt = await tx.wait();

    expect(receipt.logs.length).to.equal(2);


    const contractId1 = receipt.logs[0].args.contractId;
    const contract1Details = await htlc.getHTLCDetails(contractId1);
    const contract1Obj = htlcArrayToObj(contract1Details);

    expect(contractId1.length).to.equal(66);
    expect(contract1Obj.amount).to.equal(_amounts[0]);
    expect(contract1Obj.hashlock).to.equal(_hashlocks[0]);
    expect(contract1Obj.timelock).to.equal(_timelocks[0]);
    expect(contract1Obj.sender).to.equal(accounts[0]);
    expect(contract1Obj.receiver).to.equal(accounts[1]);
    expect(contract1Obj.withdrawn).to.be.false;
    expect(contract1Obj.refunded).to.be.false;
    expect(contract1Obj.preimage).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');



    const contractId2 = receipt.logs[1].args.contractId;
    const contract2Details = await htlc.getHTLCDetails(contractId2);
    const contract2Obj = htlcArrayToObj(contract2Details);

    expect(contract2Obj.amount).to.equal(_amounts[1]);
    expect(contractId2.length).to.equal(66);
    expect(contract2Obj.hashlock).to.equal(_hashlocks[1]);
    expect(contract2Obj.timelock).to.equal(_timelocks[1]);
    expect(contract2Obj.sender).to.equal(accounts[0]);
    expect(contract2Obj.receiver).to.equal(accounts[2]);
    expect(contract2Obj.withdrawn).to.be.false;
    expect(contract2Obj.refunded).to.be.false;
    expect(contract2Obj.preimage).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
});

