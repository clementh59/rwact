/**
 * ERC-4337 smart account module for RWAct (INK chain).
 * Provides ZeroDev Kernel account creation with session keys, transaction execution,
 * ERC-20 helpers, CoW Swap integration, and Tydro (AAVE fork) deposit/withdraw operations.
 */
import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ink } from "viem/chains";
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  addressToEmptyAccount,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import {
  toPermissionValidator,
  serializePermissionAccount,
  deserializePermissionAccount,
} from "@zerodev/permissions";

const ZERODEV_RPC = process.env.ZERODEV_RPC;
if (!ZERODEV_RPC) {
  throw new Error("ZERODEV_RPC is required in .env for smart account features");
}

const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY;
if (!OWNER_PRIVATE_KEY) {
  throw new Error("OWNER_PRIVATE_KEY is required in .env for smart account features");
}

const chain = ink;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

const publicClient = createPublicClient({
  chain,
  transport: http(ZERODEV_RPC),
});

function makePaymaster() {
  return createZeroDevPaymasterClient({
    chain,
    transport: http(ZERODEV_RPC),
  });
}

const USE_PAYMASTER = process.env.ZERODEV_PAYMASTER === "true";

function makeKernelClient(account) {
  const opts = {
    account,
    chain,
    bundlerTransport: http(ZERODEV_RPC),
    client: publicClient,
  };

  if (USE_PAYMASTER) {
    const paymasterClient = makePaymaster();
    opts.paymaster = {
      getPaymasterData: (userOperation) =>
        paymasterClient.sponsorUserOperation({ userOperation }),
    };
  }

  return createKernelAccountClient(opts);
}

/**
 * Create a new Kernel smart account and a session key for automation.
 *
 * @param {string} [ownerPrivateKey] - hex private key for the owner. Generated if omitted.
 * @returns {{ ownerPrivateKey, sessionPrivateKey, smartAccountAddress, serializedSessionKey }}
 */
export async function createSmartAccountWithSessionKey(ownerPrivateKey) {
  const ownerKey = ownerPrivateKey || OWNER_PRIVATE_KEY;
  const ownerSigner = privateKeyToAccount(ownerKey);

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerSigner,
    entryPoint,
    kernelVersion,
  });

  // Generate session key pair
  const sessionPrivateKey = generatePrivateKey();
  const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);

  // Build permission validator (sudo policy = allow everything for now)
  const emptyAccount = addressToEmptyAccount(sessionKeyAccount.address);
  const emptySessionKeySigner = await toECDSASigner({ signer: emptyAccount });

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint,
    signer: emptySessionKeySigner,
    policies: [toSudoPolicy({})],
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: {
      sudo: ecdsaValidator,
      regular: permissionPlugin,
    },
    kernelVersion,
  });

  const serializedSessionKey = await serializePermissionAccount(account);

  return {
    ownerPrivateKey: ownerKey,
    sessionPrivateKey,
    smartAccountAddress: account.address,
    serializedSessionKey,
  };
}

/**
 * Get the smart account address for a given owner key (deterministic).
 */
export async function getSmartAccountAddress(ownerPrivateKey) {
  const ownerSigner = privateKeyToAccount(ownerPrivateKey);

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

  return account.address;
}

/**
 * Send a transaction using a serialized session key.
 *
 * @param {string} serializedSessionKey - from createSmartAccountWithSessionKey
 * @param {string} sessionPrivateKey - hex private key of the session key
 * @param {{ to: string, value?: string|bigint, data?: string }} tx
 * @returns {{ userOpHash, txHash }}
 */
export async function sendTransaction(serializedSessionKey, sessionPrivateKey, { to, value, data }) {
  const sessionSigner = privateKeyToAccount(sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    serializedSessionKey,
    sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);

  // Self-funded gas overrides (bundler returns 0 without paymaster)
  // First tx deploys the account + installs permission plugin — needs high verification gas.
  // Subsequent txs need less, but overestimating is safe (unused gas is refunded).
  const gasOverrides = USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(200_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([
      {
        to,
        value: BigInt(value || 0),
        data: data || "0x",
      },
    ]),
    ...gasOverrides,
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
  };
}

/**
 * Send a batch of transactions in a single UserOp.
 */
export async function sendBatchTransactions(serializedSessionKey, sessionPrivateKey, calls) {
  const sessionSigner = privateKeyToAccount(sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    serializedSessionKey,
    sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);

  const encodedCalls = calls.map((c) => ({
    to: c.to,
    value: BigInt(c.value || 0),
    data: c.data || "0x",
  }));

  // First tx deploys the account + installs permission plugin — needs high verification gas.
  // Subsequent txs need less, but overestimating is safe (unused gas is refunded).
  const gasOverrides = USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(200_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(encodedCalls),
    ...gasOverrides,
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
  };
}

/**
 * Helper: encode an ERC-20 transfer call.
 */
export function encodeERC20Transfer(tokenAddress, to, amount) {
  const data = encodeFunctionData({
    abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
    functionName: "transfer",
    args: [to, BigInt(amount)],
  });
  return { to: tokenAddress, value: "0", data };
}

/**
 * Helper: encode an ERC-20 approve call.
 */
export function encodeERC20Approve(tokenAddress, spender, amount) {
  const data = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [spender, BigInt(amount)],
  });
  return { to: tokenAddress, value: "0", data };
}

// --- Tydro (AAVE fork on INK) ---

const TYDRO_POOL = "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA";
const INK_USDC = "0x2D270e6886d130D724215A266106e6832161EAEd"; // Circle native USDC on INK

const POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getReservesList() view returns (address[])",
]);

/**
 * Deposit (supply) an asset into Tydro via the smart account.
 * Batches approve + supply in a single UserOp.
 *
 * @param {string} serializedSessionKey
 * @param {string} sessionPrivateKey
 * @param {{ asset?: string, amount: string|bigint }} opts - asset defaults to USDC
 * @returns {{ userOpHash, txHash }}
 */
export async function tydroDeposit(serializedSessionKey, sessionPrivateKey, { asset, amount }) {
  const tokenAddress = asset || INK_USDC;
  const amountBn = BigInt(amount);

  const sessionSigner = privateKeyToAccount(sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    serializedSessionKey,
    sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);

  // Batch: approve + supply
  const calls = [
    {
      to: tokenAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [TYDRO_POOL, amountBn],
      }),
    },
    {
      to: TYDRO_POOL,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: POOL_ABI,
        functionName: "supply",
        args: [tokenAddress, amountBn, account.address, 0],
      }),
    },
  ];

  const gasOverrides = USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(500_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(calls),
    ...gasOverrides,
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    pool: TYDRO_POOL,
    asset: tokenAddress,
    amount: amountBn.toString(),
  };
}

/**
 * Withdraw an asset from Tydro via the smart account.
 */
export async function tydroWithdraw(serializedSessionKey, sessionPrivateKey, { asset, amount }) {
  const tokenAddress = asset || INK_USDC;
  const amountBn = BigInt(amount);

  const sessionSigner = privateKeyToAccount(sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    serializedSessionKey,
    sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);

  const gasOverrides = USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(500_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([
      {
        to: TYDRO_POOL,
        value: BigInt(0),
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: "withdraw",
          args: [tokenAddress, amountBn, account.address],
        }),
      },
    ]),
    ...gasOverrides,
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    pool: TYDRO_POOL,
    asset: tokenAddress,
    amount: amountBn.toString(),
  };
}

export { TYDRO_POOL, INK_USDC, publicClient, makeKernelClient, USE_PAYMASTER };
