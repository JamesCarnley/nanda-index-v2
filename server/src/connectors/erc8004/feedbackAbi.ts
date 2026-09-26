import { parseAbi } from 'viem';

/** ERC-8004 reference ReputationRegistryUpgradeable.sol at
 * b9e466c250744a7e06b13dff9d3c2844ed64f825 (MIT).
 * https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/contracts/ReputationRegistryUpgradeable.sol
 * In ResponseAppended, responder is indexed; feedbackIndex is NOT indexed. */
export const feedbackEvents = parseAbi([
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,address indexed responder,string responseURI,bytes32 responseHash)',
]);
