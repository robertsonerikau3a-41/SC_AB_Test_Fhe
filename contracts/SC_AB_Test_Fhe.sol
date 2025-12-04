pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SC_AB_Test_Fhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;
    mapping(uint256 => euint32) public encryptedSumVariantA;
    mapping(uint256 => euint32) public encryptedCountVariantA;
    mapping(uint256 => euint32) public encryptedSumVariantB;
    mapping(uint256 => euint32) public encryptedCountVariantB;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event DataSubmitted(address indexed provider, uint256 batchId, uint256 variant, uint256 value);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 sumA, uint256 countA, uint256 sumB, uint256 countB);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedError();
    error ReplayError();
    error StateMismatchError();
    error InvalidVariantError();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (batchClosed[currentBatchId]) revert BatchClosedError();
        batchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitData(uint256 batchId, uint256 variant, uint256 value) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchClosed[batchId]) {
            revert BatchClosedError();
        }
        if (variant != 1 && variant != 2) {
            revert InvalidVariantError();
        }

        lastSubmissionTime[msg.sender] = block.timestamp;
        euint32 encryptedValue = FHE.asEuint32(value);
        _initIfNeeded(batchId);

        if (variant == 1) {
            encryptedSumVariantA[batchId] = encryptedSumVariantA[batchId].add(encryptedValue);
            encryptedCountVariantA[batchId] = encryptedCountVariantA[batchId].add(FHE.asEuint32(1));
        } else { // variant == 2
            encryptedSumVariantB[batchId] = encryptedSumVariantB[batchId].add(encryptedValue);
            encryptedCountVariantB[batchId] = encryptedCountVariantB[batchId].add(FHE.asEuint32(1));
        }
        emit DataSubmitted(msg.sender, batchId, variant, value);
    }

    function requestBatchResultsDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batchClosed[batchId]) {
            revert BatchClosedError(); // Must be closed to request decryption
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        bytes32[] memory cts = new bytes32[](4);
        cts[0] = encryptedSumVariantA[batchId].toBytes32();
        cts[1] = encryptedCountVariantA[batchId].toBytes32();
        cts[2] = encryptedSumVariantB[batchId].toBytes32();
        cts[3] = encryptedCountVariantB[batchId].toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayError();
        }

        // Rebuild ciphertexts from current storage in the same order
        uint256 batchId = decryptionContexts[requestId].batchId;
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = encryptedSumVariantA[batchId].toBytes32();
        cts[1] = encryptedCountVariantA[batchId].toBytes32();
        cts[2] = encryptedSumVariantB[batchId].toBytes32();
        cts[3] = encryptedCountVariantB[batchId].toBytes32();

        // Verify state hash
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatchError();
        }

        // Verify proof
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts
        uint256 sumA = abi.decode(cleartexts.slice(0, 32), (uint256));
        uint256 countA = abi.decode(cleartexts.slice(32, 32), (uint256));
        uint256 sumB = abi.decode(cleartexts.slice(64, 32), (uint256));
        uint256 countB = abi.decode(cleartexts.slice(96, 32), (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, sumA, countA, sumB, countB);
    }

    function _initIfNeeded(uint256 batchId) internal {
        if (!FHE.isInitialized(encryptedSumVariantA[batchId])) {
            encryptedSumVariantA[batchId] = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedCountVariantA[batchId])) {
            encryptedCountVariantA[batchId] = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedSumVariantB[batchId])) {
            encryptedSumVariantB[batchId] = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedCountVariantB[batchId])) {
            encryptedCountVariantB[batchId] = FHE.asEuint32(0);
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}