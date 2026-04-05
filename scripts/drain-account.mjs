import "dotenv/config";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ink } from "viem/chains";
import {
  createKernelAccount,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";

const ZERODEV_RPC = process.env.ZERODEV_RPC;
const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY;
const TARGET_EOA = "0x4d2EAAe934a919c25A6345b2CFB5D2a11D6D243E";
const EXPECTED_SMART_ACCOUNT = "0x907274728BfB6C8c2Ce98832D4c249e6dcFF70D4";

const chain = ink;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

const publicClient = createPublicClient({
  chain,
  transport: http(ZERODEV_RPC),
});

// Known tokens on INK
const TOKENS = {
  USDC: "0x2D270e6886d130D724215A266106e6832161EAEd",
  TSLAx: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
};

// Tydro (AAVE fork) aToken addresses — we'll check the reserves list
const TYDRO_POOL = "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const POOL_ABI = parseAbi([
  "function getReservesList() view returns (address[])",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

async function main() {
  console.log("=== Drain Smart Account ===\n");

  // 1. Create kernel account from owner key
  const ownerSigner = privateKeyToAccount(OWNER_PRIVATE_KEY);
  console.log("Owner EOA:", ownerSigner.address);

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerSigner,
    entryPoint,
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion,
  });

  console.log("Smart Account Address:", account.address);

  if (account.address.toLowerCase() !== EXPECTED_SMART_ACCOUNT.toLowerCase()) {
    throw new Error(
      `Address mismatch! Expected ${EXPECTED_SMART_ACCOUNT}, got ${account.address}`
    );
  }
  console.log("✓ Address matches expected\n");

  // 2. Check native balance
  const nativeBalance = await publicClient.getBalance({ address: account.address });
  console.log("Native balance (ETH):", formatUnits(nativeBalance, 18));

  // 3. Check ERC-20 balances
  const tokenBalances = [];
  for (const [symbol, address] of Object.entries(TOKENS)) {
    const balance = await publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const decimals = await publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    console.log(`${symbol} balance:`, formatUnits(balance, decimals));
    if (balance > 0n) {
      tokenBalances.push({ symbol, address, balance, decimals });
    }
  }

  // 4. Check Tydro deposits
  let tydroCollateral = 0n;
  try {
    const userData = await publicClient.readContract({
      address: TYDRO_POOL,
      abi: POOL_ABI,
      functionName: "getUserAccountData",
      args: [account.address],
    });
    tydroCollateral = userData[0]; // totalCollateralBase (in USD, 8 decimals)
    console.log(`\nTydro collateral (USD):`, formatUnits(tydroCollateral, 8));
    console.log(`Tydro debt (USD):`, formatUnits(userData[1], 8));
  } catch (e) {
    console.log("Could not check Tydro deposits:", e.message);
  }

  // 5. Build kernel client and drain
  const kernelClient = createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(ZERODEV_RPC),
    client: publicClient,
  });

  const { encodeFunctionData } = await import("viem");
  const drainCalls = [];

  // Withdraw from Tydro
  if (tydroCollateral > 0n) {
    const reserves = await publicClient.readContract({
      address: TYDRO_POOL,
      abi: POOL_ABI,
      functionName: "getReservesList",
    });

    const MAX_UINT256 = 2n ** 256n - 1n;
    for (const reserve of reserves) {
      drainCalls.push({
        to: TYDRO_POOL,
        value: 0n,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: "withdraw",
          args: [reserve, MAX_UINT256, account.address],
        }),
      });
    }
  }

  // Transfer all ERC-20 tokens (re-check balances after Tydro withdrawal would happen in same batch)
  // For tokens we already know have balances, add transfers
  for (const tok of tokenBalances) {
    drainCalls.push({
      to: tok.address,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [TARGET_EOA, tok.balance],
      }),
    });
  }

  // If we withdrew from Tydro, the token balances changed — we need to handle this.
  // Strategy: do Tydro withdrawals first, then re-read balances, then transfer.
  // But batching means we can't read in between. So let's do it in two steps.

  if (drainCalls.length === 0 && nativeBalance === 0n) {
    console.log("Nothing to drain — account is empty.");
    return;
  }

  // Step 1: Tydro withdrawals (if any)
  if (tydroCollateral > 0n) {
    const tydroCalls = drainCalls.filter((c) => c.to === TYDRO_POOL);
    if (tydroCalls.length > 0) {
      console.log(`Withdrawing from Tydro (${tydroCalls.length} reserves)...`);
      const userOpHash = await kernelClient.sendUserOperation({
        callData: await account.encodeCalls(tydroCalls),
        verificationGasLimit: 2_000_000n,
        callGasLimit: 1_000_000n,
        preVerificationGas: 200_000n,
      });
      const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
      console.log("Tydro withdrawal tx:", receipt.receipt.transactionHash);
    }
  }

  // Re-read all token balances after Tydro withdrawal
  const transferCalls = [];
  for (const [symbol, address] of Object.entries(TOKENS)) {
    const balance = await publicClient.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance > 0n) {
      const decimals = await publicClient.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      console.log(`Transferring ${symbol}: ${formatUnits(balance, decimals)}`);
      transferCalls.push({
        to: address,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [TARGET_EOA, balance],
        }),
      });
    }
  }

  // Also check for any other tokens from Tydro reserves
  if (tydroCollateral > 0n) {
    const reserves = await publicClient.readContract({
      address: TYDRO_POOL,
      abi: POOL_ABI,
      functionName: "getReservesList",
    });
    for (const reserve of reserves) {
      // Skip if already in TOKENS
      if (Object.values(TOKENS).map(a => a.toLowerCase()).includes(reserve.toLowerCase())) continue;
      const balance = await publicClient.readContract({
        address: reserve,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (balance > 0n) {
        let symbol;
        try {
          symbol = await publicClient.readContract({ address: reserve, abi: ERC20_ABI, functionName: "symbol" });
        } catch { symbol = reserve; }
        const decimals = await publicClient.readContract({ address: reserve, abi: ERC20_ABI, functionName: "decimals" });
        console.log(`Transferring ${symbol}: ${formatUnits(balance, decimals)}`);
        transferCalls.push({
          to: reserve,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [TARGET_EOA, balance],
          }),
        });
      }
    }
  }

  // Step 2: Transfer all ERC-20 tokens
  if (transferCalls.length > 0) {
    console.log(`\nSending ${transferCalls.length} ERC-20 transfer(s)...`);
    const userOpHash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls(transferCalls),
      verificationGasLimit: 2_000_000n,
      callGasLimit: 500_000n,
      preVerificationGas: 200_000n,
    });
    const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
    console.log("ERC-20 transfer tx:", receipt.receipt.transactionHash);
  }

  // Step 3: Transfer native balance (need to keep some for gas... but this is a smart account using bundler)
  // Actually smart accounts pay gas from native balance (unless paymaster).
  // We need to leave enough for the UserOp gas. Let's check remaining native balance and send most of it.
  const remainingNative = await publicClient.getBalance({ address: account.address });
  if (remainingNative > 0n) {
    // Reserve gas for the transfer UserOp itself
    // On INK, gas is cheap. Reserve 0.01 ETH to be safe.
    const gasReserve = 10_000_000_000_000_000n; // 0.01 ETH
    const toSend = remainingNative - gasReserve;
    if (toSend > 0n) {
      console.log(`\nTransferring native: ${formatUnits(toSend, 18)} ETH (keeping ${formatUnits(gasReserve, 18)} for gas)`);
      const userOpHash = await kernelClient.sendUserOperation({
        callData: await account.encodeCalls([{
          to: TARGET_EOA,
          value: toSend,
          data: "0x",
        }]),
        verificationGasLimit: 2_000_000n,
        callGasLimit: 200_000n,
        preVerificationGas: 200_000n,
      });
      const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
      console.log("Native transfer tx:", receipt.receipt.transactionHash);
    } else {
      console.log(`\nNative balance (${formatUnits(remainingNative, 18)} ETH) too low to transfer after gas reserve.`);
    }
  }

  // Final balance check
  console.log("\n=== Final Balances ===");
  const finalNative = await publicClient.getBalance({ address: account.address });
  console.log("Native:", formatUnits(finalNative, 18), "ETH");
  for (const [symbol, address] of Object.entries(TOKENS)) {
    const bal = await publicClient.readContract({ address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    const dec = await publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" });
    console.log(`${symbol}:`, formatUnits(bal, dec));
  }
  console.log("\nTarget EOA:", TARGET_EOA);
  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
