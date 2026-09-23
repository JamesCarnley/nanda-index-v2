Public synthetic City profile vectors (`cityProfile.ts`) and the owned-Anvil
process helper (`ownedAnvil.ts`) are copied from NandaCity
`9102fdfbd3c7dc309fef89a14b3629c67c019569`, MIT-licensed there.

`referenceRegistry.json` was generated once with that commit's
`compileReferenceContracts()` and its pinned solc 0.8.24, OpenZeppelin 5.4.0,
[MIT-licensed ERC-8004 reference sources](https://github.com/erc-8004/erc-8004-contracts)
at `b9e466c250744a7e06b13dff9d3c2844ed64f825` and
checked source/artifact hashes. It contains the real ABI and creation bytecode
for the identity implementation, minimal UUPS bootstrap and ERC1967 proxy;
the JSON includes the exact compiler/source/artifact provenance. The actual-chain
test deploys this reference stack to a newly owned, loopback-only Anvil process.
It never uses a sibling checkout at runtime, a public chain or an existing key.
