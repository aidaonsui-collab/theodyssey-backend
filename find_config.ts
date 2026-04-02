import { JsonRpcProvider } from '@mysten/sui/jsonRpc';

const provider = new JsonRpcProvider('https://sui-mainnet-rpc.allthatnode.com');

const newPkg = '0x7d06213cb4fe0b96c889c09e469a44d1614563efbb23bd4b43e0985d87a210f3';
const deployer = '0x2957f0f19ee92eb5283bf1aa6ce7a3742ea7bc79bc9d1dc907fbbf7a11567409';

async function main() {
  console.log('Querying for moonbags config...');
  
  const r1 = await provider.getOwnedObjects({
    owner: deployer,
    filter: { StructType: `${newPkg}::moonbags::Configuration` }
  });
  console.log('Moonbags Config:', r1.data.map((o: any) => o.data?.objectId));
  
  const r2 = await provider.getOwnedObjects({
    owner: deployer,
    filter: { StructType: `${newPkg}::moonbags_stake::Configuration` }
  });
  console.log('Stake Config:', r2.data.map((o: any) => o.data?.objectId));
  
  const r3 = await provider.getOwnedObjects({
    owner: deployer,
    filter: { StructType: `${newPkg}::moonbags_token_lock::Configuration` }
  });
  console.log('Lock Config:', r3.data.map((o: any) => o.data?.objectId));
}

main().catch(e => console.error(e));
