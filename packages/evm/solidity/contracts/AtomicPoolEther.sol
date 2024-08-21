// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;
import '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import '@openzeppelin/contracts/utils/Address.sol';

struct EIP712Domain {
  string name;
  string version;
  uint256 chainId;
  address verifyingContract;
  bytes32 salt;
}
struct HTLC {
  string dstAddress;
  string dstChain;
  string dstAsset;
  string srcAsset;
  address payable sender;
  address payable srcReceiver;
  bytes32 hashlock;
  uint256 secret;
  uint256 amount;
  uint256 timelock;
  bool redeemed;
  bool unlocked;
}

interface IHashedTimeLockEther {
  function getLockDetails(bytes32 lockId) external view returns (HTLC memory);
  function hasHTLC(bytes32 lockId) external view returns (bool exists);
}

contract AtomicPoolEther {
  uint256 poolId;
  bytes32 private DOMAIN_SEPARATOR;
  bytes32 private constant SALT = 0x2e5ff7160d640efc0d28f2e302a56f1cf54aff7e107eededda94b3df0946f5c0;
  IHashedTimeLockEther htlc;

  constructor(address htlc_address) {
    htlc = IHashedTimeLockEther(htlc_address);
    poolId = 0;
    DOMAIN_SEPARATOR = hashDomain(
      EIP712Domain({
        name: 'AtomicPoolEther',
        version: '1',
        chainId: 11155111,
        verifyingContract: address(this),
        salt: SALT
      })
    );
  }

  using ECDSA for bytes32;
  using Address for address;

  error FundsNotSent();
  error NotFutureTimelock();
  error NotPassedTimelock();
  error PoolAlreadyExists();
  error PoolNotExists();
  error HashlockNotMatch();
  error AlreadyPunished();
  error AlreadyUnlocked();
  error AlreadyLocked();
  error InvalidSigniture();
  error CanNotPunish();

  struct AtomicPool {
    address payable LiquidityProvider;
    uint256 huge_amount;
    uint256 long_timelock;
    bool punished;
    bool unlocked;
  }
  struct SIG {
    address payable LiquidityProvider;
    address srcReceiver;
    uint256 amount;
    uint256 timelock;
    bytes32 hashlock;
  }

  event PoolLocked(address LiquidityProvider, uint256 huge_amount, uint256 long_timelock);
  event LowLevelErrorOccurred(bytes lowLevelData);
  event PoolUnlocked(address LiquidityProvider);
  event LPunished(address punisher, uint256 huge_amount);

  modifier _locked(uint256 Id) {
    if (Id > poolId) revert PoolNotExists();
    _;
  }

  mapping(uint256 => AtomicPool) pools;
  // bytes32 blockHash = blockhash(block.number - 1);
  // uint256 blockHashAsUint = uint256(blockHash);

  function poolLock(uint256 timelock) external payable returns (address LiquidityProvider) {
    if (msg.value == 0) {
      revert FundsNotSent();
    }
    if (timelock <= block.timestamp) {
      revert NotFutureTimelock();
    }
    poolId += 1;

    pools[poolId] = AtomicPool(payable(msg.sender), msg.value, timelock, false, false);
    emit PoolLocked(msg.sender, msg.value, timelock);
    return msg.sender;
  }

  function punishLP(
    uint256 Id,
    uint256 secret,
    SIG memory lp_signature,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external _locked(Id) {
    AtomicPool storage atomicpool = pools[Id];
    if (atomicpool.punished) revert AlreadyPunished();
    if (atomicpool.unlocked) revert AlreadyUnlocked();

    if (verifySignature(lp_signature, v, r, s)) {
      HTLC memory cur_htlc = htlc.getLockDetails(lp_signature.hashlock);
      if (
        htlc.hasHTLC(lp_signature.hashlock) &&
        lp_signature.amount == cur_htlc.amount &&
        lp_signature.srcReceiver != cur_htlc.srcReceiver &&
        lp_signature.timelock != cur_htlc.timelock
      ) {
        revert CanNotPunish();
      } else {
        if (lp_signature.hashlock == sha256(abi.encodePacked(secret))) {
          atomicpool.punished = true;
          (bool success, ) = msg.sender.call{ value: atomicpool.huge_amount }('');
          require(success, 'Transfer failed');
          emit LPunished(msg.sender, atomicpool.huge_amount);
        } else {
          revert HashlockNotMatch();
        }
      }
    } else {
      revert InvalidSigniture();
    }
  }

  function poolUnlock(uint256 Id) external _locked(Id) returns (bool) {
    AtomicPool storage atomicpool = pools[Id];
    if (atomicpool.punished) revert AlreadyPunished();
    if (atomicpool.unlocked) revert AlreadyUnlocked();
    if (atomicpool.long_timelock > block.timestamp) revert NotPassedTimelock();

    atomicpool.unlocked = true;
    (bool success, ) = atomicpool.LiquidityProvider.call{ value: atomicpool.huge_amount }('');
    require(success, 'Transfer failed');
    emit PoolUnlocked(atomicpool.LiquidityProvider);
    return true;
  }

  function getPoolDetails(uint256 Id) public view returns (AtomicPool memory) {
    if (Id > poolId) {
      AtomicPool memory emptyPool = AtomicPool({
        LiquidityProvider: payable(address(0)),
        huge_amount: uint256(0),
        long_timelock: uint256(0),
        punished: false,
        unlocked: false
      });
      return emptyPool;
    }
    AtomicPool storage atomicpool = pools[Id];
    return atomicpool;
  }

  // function PoolExists(address LiquidityProvider) internal view returns (bool exists) {
  //   exists = (!pools[LiquidityProvider].unlocked);
  // }

  function hashDomain(EIP712Domain memory domain) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)'),
          keccak256(bytes(domain.name)),
          keccak256(bytes(domain.version)),
          domain.chainId,
          domain.verifyingContract,
          domain.salt
        )
      );
  }

  // Hashes an EIP712 lp_signature struct
  function hashMessage(SIG memory lp_signature) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          keccak256(
            bytes(
              'AtomicPool(address payable LiquidityProvider,address srcReceiver,uint256 amount,uint256 imelock,bytes32 hashlock)'
            )
          ),
          lp_signature.LiquidityProvider,
          lp_signature.srcReceiver,
          lp_signature.amount,
          lp_signature.timelock,
          lp_signature.hashlock
        )
      );
  }

  // Verifies an EIP712 lp_signature signature
  function verifySignature(SIG memory lp_signature, uint8 v, bytes32 r, bytes32 s) private view returns (bool) {
    bytes32 digest = keccak256(abi.encodePacked('\x19\x01', DOMAIN_SEPARATOR, hashMessage(lp_signature)));

    address recoveredAddress = digest.recover(v, r, s);

    return (recoveredAddress == lp_signature.LiquidityProvider);
  }
}
