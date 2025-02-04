import { beginCell, Cell } from "@ton/ton"; 
import { TonClient, WalletContractV4, Address } from "@ton/ton"; 
import { AddLockSig, LayerswapV8 } from "../build/HashedTimeLockTON/tact_LayerswapV8"; 
import { getHttpEndpoint } from "@orbs-network/ton-access"; 
import { toNano, sleep } from "../utils/utils"; 
import { mnemonicToWalletKey, sign, signVerify } from 'ton-crypto';

async function run() {
  const endpoint = await getHttpEndpoint({ network: "testnet" });
  const client = new TonClient({ endpoint });

  const mnemonic = "pretty electric october neck alley tiger action assault garlic divide oppose exist online cluster luxury clump kangaroo number away analyst attitude digital zebra world"; 
  const key = await mnemonicToWalletKey(mnemonic.split(" "));

  const mnemo2 = "myth lava viable discover fat speak crazy exotic season motor boss blast pride struggle mechanic minor rifle sell virus govern thrive noble erupt odor";
  const key2 = await mnemonicToWalletKey(mnemo2.split(" "));
  const wallet = WalletContractV4.create({ publicKey: key2.publicKey, workchain: 0 });
  if (!await client.isContractDeployed(wallet.address)) {
    return console.log("Wallet is not deployed");
  }

  const walletContract = client.open(wallet);
  const walletSender = walletContract.sender(key2.secretKey);
  const seqno = await walletContract.getSeqno();

  const contractAddress = Address.parse("kQCEheJe-tMhwQ2XeILH5avb3GcOlWCYujGUiaMPAyBI_xqE"); 
  const newContract = LayerswapV8.fromAddress(contractAddress);
  const contractProvider = client.open(newContract);
  const amount = toNano("0.1");

  const Id = BigInt("101");
  const hashlock = BigInt("96184405605761239365615141159737855805714574759278034204903698408753403233303");
  const timelock = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const dataCell: Cell = beginCell()
  .storeInt(Id,257)
  .storeInt(hashlock, 257)
  .storeInt(timelock, 257)
      .endCell();

  const dataSlice = dataCell.beginParse(); 

  const signatureBuffer = sign(dataCell.hash(), key.secretKey);
  const signatureCell = beginCell().storeBuffer(signatureBuffer).endCell();
  const signatureSlice = signatureCell.beginParse();

console.log("signiture verified off chain: ",signVerify(dataCell.hash(),signatureBuffer,key.publicKey));
  
  const lockCommitmentSigMessage: AddLockSig = {
      $$type: "AddLockSig",
      data: dataSlice, 
      signature: signatureSlice,
  };

  console.log("Sending AddLockSig message...");
  await contractProvider.send(walletSender, { value: amount, bounce: true }, lockCommitmentSigMessage);

  let currentSeqno = seqno;
  while (currentSeqno == seqno) {
    console.log("Waiting for transaction to confirm...");
    await sleep(1500);
    currentSeqno = await walletContract.getSeqno();
  }
  console.log("Transaction confirmed!");
}
run().catch(console.error);


