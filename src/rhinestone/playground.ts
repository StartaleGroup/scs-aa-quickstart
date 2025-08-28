import { createRhinestoneAccount } from '@rhinestone/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, arbitrumSepolia, optimismSepolia, optimism, base, soneium } from 'viem/chains'
import {
  Address,
  Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  Hex,
  http,
  parseEther,
} from 'viem'
import * as dotenv from 'dotenv'

// Load environment variables
dotenv.config()

// Token registry helper function
function getTokenAddress(symbol: string, chainId: number): Address {
  const registry: Record<number, { tokens: Array<{ symbol: string; address: string }> }> = {
    84532: { // Base Sepolia
      tokens: [
        { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
        { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' }
      ]
    },
    11155420: { // Optimism Sepolia
      tokens: [
        { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
        { symbol: 'USDC', address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7' },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' }
      ]
    },
    421614: { // Arbitrum Sepolia
      tokens: [
        { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
        { symbol: 'USDC', address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
        { symbol: 'WETH', address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73' }
      ]
    },
    10: { // Optimism Mainnet
      tokens: [
        {
          symbol: "ETH",
          address: "0x0000000000000000000000000000000000000000",
        },
        {
          symbol: "USDC",
          address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
        },
        {
          symbol: "USDT",
          address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
        },
      ],
    },
    8453: { // Base Mainnet
      tokens: [
        { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
        { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
      ],
    },
    1868: {
      tokens: [
        { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
        { symbol: 'USDC', address: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' },
      ],
    }
  }

  const chain = registry[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${chainId}`)
  }

  const token = chain.tokens.find(t => t.symbol === symbol)
  if (!token) {
    throw new Error(`Token ${symbol} not found for chain ${chainId}`)
  }

  return token.address as Address
}

async function main() {
  console.log('🚀 Starting Rhinestone Quickstart Guide...\n')

  const fundingPrivateKey = process.env.FUNDING_PRIVATE_KEY
  if (!fundingPrivateKey) {
    throw new Error('FUNDING_PRIVATE_KEY is not set in .env file')
  }

  const rhinestoneApiKey = process.env.RHINESTONE_API_KEY
  if (!rhinestoneApiKey) {
    throw new Error('RHINESTONE_API_KEY is not set in .env file')
  }

  const sourceChain = optimism
  const targetChain = soneium

  console.log('📋 Configuration:')
  console.log(`   Source Chain: ${sourceChain.name}`)
  console.log(`   Target Chain: ${targetChain.name}`)
  console.log(`   Funding Account: ${privateKeyToAccount(fundingPrivateKey as Hex).address}\n`)

  // Step 1: Create a smart account with a single owner
  console.log('🔐 Creating smart account...')
  

  // const privateKey = generatePrivateKey()
  // console.log(`   Owner private key: ${privateKey}`)
  const privateKey = process.env.OWNER_PRIVATE_KEY;

    // You can use an existing PK here
  const account = privateKeyToAccount(privateKey as Hex);

  const rhinestoneAccount = await createRhinestoneAccount({
    owners: {
      type: 'ecdsa',
      accounts: [account], // 1 threshold could be n owners.
    },
    account: {
      type: 'startale',
    },
    rhinestoneApiKey,
  })
  const address = rhinestoneAccount.getAddress()
  console.log(`   Smart account address: ${address}\n`)

  // Step 2: Funding the Account
  // console.log('💰 Funding the smart account...')
  
  // const publicClient = createPublicClient({
  //   chain: sourceChain,
  //   transport: http(),
  // })
  // const fundingAccount = privateKeyToAccount(fundingPrivateKey as Hex)
  // const fundingClient = createWalletClient({
  //   account: fundingAccount,
  //   chain: sourceChain,
  //   transport: http(),
  // })

  // Prefund
  // Q. what if I do not fund with eth. but some other tokens are there. does it identify the tokens and pull them?

  // console.log(`   Sending 0.001 ETH to ${address}...`)
  // const txHash = await fundingClient.sendTransaction({
  //   to: address,
  //   value: parseEther('0.001'),
  // })
  // console.log(`   Transaction hash: ${txHash}`)
  
  // console.log('   Waiting for transaction confirmation...')
  // await publicClient.waitForTransactionReceipt({ hash: txHash })
  // console.log('   ✅ Funding transaction confirmed!\n')

  // Step 3: Make a cross-chain token transfer
  console.log('🌉 Making cross-chain USDC transfer...')
  
  const usdcTarget = getTokenAddress('USDC', targetChain.id)
  const usdcAmount = 1000000n

  console.log(`   Transferring ${usdcAmount} USDC to 0x2cf491602ad22944D9047282aBC00D3e52F56B37`)
  console.log(`   Target USDC address: ${usdcTarget}`)

  // same as sendTransaction = prepare + sign + submit ?
  const transactionData = await rhinestoneAccount.prepareTransaction({
    sourceChains: [sourceChain],
    targetChain,
    calls: [
      {
        to: usdcTarget,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: ['0x2cf491602ad22944D9047282aBC00D3e52F56B37', usdcAmount],
        }),
      },
    ],
    tokenRequests: [
      {
        address: usdcTarget,
        amount: usdcAmount,
      },
    ],
    sponsored: true,
  })
  console.log('transactionData', transactionData)

  // What does it mean by changing to ETH works?
  
  
  console.info('signing transaction')
  const signedTansactionData = await rhinestoneAccount.signTransaction(transactionData)

  console.info('submitting transaction')
  const result = await rhinestoneAccount.submitTransaction(signedTansactionData)


  console.log('   Waiting for execution...', result)
  const status = await rhinestoneAccount.waitForExecution(result)
  console.log('   ✅ Transaction status:', status)

  console.log('\n🎉 Success! Your smart account is now deployed on both Optimism and Base !')
  console.log('   The cross-chain USDC transfer has been completed.')
  console.log('\n📝 Note: You don\'t need to manage gas tokens or ETH → USDC swaps manually.')
  console.log('   The Rhinestone Orchestrator handles everything for you!')
}

main().catch((error) => {
  console.error('❌ Error:', error)
  process.exit(1)
})