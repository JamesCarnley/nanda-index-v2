import { parseAbi } from 'viem';

/** Event and read-only ABI of the pinned public ERC-8004 reference registry. */
export const identityEvents = parseAbi([
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
export const identityReadAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'error ERC721NonexistentToken(uint256 tokenId)',
]);
