// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;
import '@openzeppelin/contracts/utils/Address.sol';

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
  IHashedTimeLockEther htlc;

  constructor(address htlc_address) {
    htlc = IHashedTimeLockEther(htlc_address);
    poolId = 0;
  }

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
  error CanNotPunish();

  struct AtomicPool {
    address payable LiquidityProvider;
    uint256 huge_amount;
    uint256 long_timelock;
    bool punished;
    bool unlocked;
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

  function punishLP(uint256 Id, uint256 secret, bytes32 hashlock) external _locked(Id) {
    AtomicPool storage atomicpool = pools[Id];
    if (atomicpool.punished) revert AlreadyPunished();
    if (atomicpool.unlocked) revert AlreadyUnlocked();

    HTLC memory cur_htlc = htlc.getLockDetails(hashlock);

    if (cur_htlc.redeemed) revert CanNotPunish();
    if (hashlock == sha256(abi.encodePacked(secret))) {
      atomicpool.punished = true;
      (bool success, ) = cur_htlc.srcReceiver.call{ value: atomicpool.huge_amount }('');
      require(success, 'Punishment failed');
      emit LPunished(msg.sender, atomicpool.huge_amount);
    } else {
      revert HashlockNotMatch();
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
}
