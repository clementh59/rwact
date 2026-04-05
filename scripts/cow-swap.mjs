/**
 * CoW Protocol swap for ERC-4337 smart accounts on INK.
 *
 * Two signing modes:
 *   - EIP-1271 (fast, ~1s): sign off-chain with owner key, Kernel verifies on settlement
 *   - Presign (fallback, ~6s): on-chain setPreSignature via UserOp
 *
 * The EIP-1271 flow requires a one-time max approval of the vault relayer.
 */

import { encodeFunctionData, parseAbi, hashTypedData, encodeAbiParameters, keccak256, concat, numberToHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { deserializePermissionAccount } from "@zerodev/permissions";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

const COW_API = "https://api.cow.fi/ink/api/v1";
const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
const INK_CHAIN_ID = 57073;

export const TOKENS = {
  USDC: "0x2D270e6886d130D724215A266106e6832161EAEd",
  WETH: "0x4200000000000000000000000000000000000006",
  TSLAx: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
};

const SETTLEMENT_ABI = parseAbi([
  "function setPreSignature(bytes orderUid, bool signed)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// --- CoW EIP-712 types for order signing ---

const COW_ORDER_DOMAIN = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: INK_CHAIN_ID,
  verifyingContract: GPV2_SETTLEMENT,
};

const COW_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
};

// --- Quote ---

export async function getQuote({ sellToken, buyToken, sellAmount, from, kind, signingScheme }) {
  const res = await fetch(`${COW_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken,
      buyToken,
      sellAmountBeforeFee: sellAmount,
      from,
      kind: kind || "sell",
      signingScheme: signingScheme || "eip1271",
      onchainOrder: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CoW quote failed (${res.status}): ${body}`);
  }

  return res.json();
}

// --- EIP-1271 signing (fast path) ---

function buildOrderMessage(quote, from, { slippageBps = 0, validForSecs } = {}) {
  let buyAmount = quote.buyAmount;
  if (slippageBps > 0) {
    const original = BigInt(buyAmount);
    buyAmount = (original * BigInt(10000 - slippageBps) / BigInt(10000)).toString();
  }

  const validTo = validForSecs
    ? Math.floor(Date.now() / 1000) + validForSecs
    : Number(quote.validTo);

  return {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver: quote.receiver || from,
    sellAmount: BigInt(quote.sellAmount),
    buyAmount: BigInt(buyAmount),
    validTo,
    appData: quote.appData || "0x0000000000000000000000000000000000000000000000000000000000000000",
    feeAmount: BigInt(0),
    kind: quote.kind || "sell",
    partiallyFillable: quote.partiallyFillable || false,
    sellTokenBalance: quote.sellTokenBalance || "erc20",
    buyTokenBalance: quote.buyTokenBalance || "erc20",
  };
}

/**
 * Sign a CoW order with the owner key for EIP-1271 verification.
 * The Kernel account's sudo ECDSA validator will verify this signature.
 */
async function signOrderEip1271(orderMessage, ownerPrivateKey) {
  const owner = privateKeyToAccount(ownerPrivateKey);

  // Compute the EIP-712 hash
  const orderHash = hashTypedData({
    domain: COW_ORDER_DOMAIN,
    types: COW_ORDER_TYPES,
    primaryType: "Order",
    message: orderMessage,
  });

  // Sign the EIP-712 typed data directly — Kernel's ECDSA validator will verify this
  const signature = await owner.signTypedData({
    domain: COW_ORDER_DOMAIN,
    types: COW_ORDER_TYPES,
    primaryType: "Order",
    message: orderMessage,
  });

  return { orderHash, signature };
}

async function postOrderEip1271(quote, from, ownerPrivateKey, { slippageBps = 0, validForSecs } = {}) {
  const orderMessage = buildOrderMessage(quote, from, { slippageBps, validForSecs });
  const { signature } = await signOrderEip1271(orderMessage, ownerPrivateKey);

  const order = {
    sellToken: orderMessage.sellToken,
    buyToken: orderMessage.buyToken,
    receiver: orderMessage.receiver,
    sellAmount: orderMessage.sellAmount.toString(),
    buyAmount: orderMessage.buyAmount.toString(),
    validTo: orderMessage.validTo,
    appData: orderMessage.appData,
    feeAmount: "0",
    kind: orderMessage.kind,
    partiallyFillable: orderMessage.partiallyFillable,
    sellTokenBalance: orderMessage.sellTokenBalance,
    buyTokenBalance: orderMessage.buyTokenBalance,
    signingScheme: "eip1271",
    signature,
    from,
  };

  const res = await fetch(`${COW_API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CoW post order (eip1271) failed (${res.status}): ${body}`);
  }

  return res.json();
}

// --- Presign (fallback) ---

export async function postOrderPresign(quote, from, { slippageBps = 0, validForSecs } = {}) {
  let buyAmount = quote.buyAmount;
  if (slippageBps > 0) {
    const original = BigInt(buyAmount);
    buyAmount = (original * BigInt(10000 - slippageBps) / BigInt(10000)).toString();
  }

  const order = {
    ...quote,
    buyAmount,
    feeAmount: "0",
    receiver: quote.receiver || from,
    signingScheme: "presign",
    signature: "0x",
    from,
  };

  if (validForSecs) {
    order.validTo = Math.floor(Date.now() / 1000) + validForSecs;
  }

  const res = await fetch(`${COW_API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CoW post order (presign) failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function presignOrder({ serializedSessionKey, sessionPrivateKey, orderUid, sellToken, sellAmount }, deps) {
  const { publicClient, makeKernelClient } = deps;
  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_1;

  const sessionSigner = privateKeyToAccount(sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

  const account = await deserializePermissionAccount(
    publicClient, entryPoint, kernelVersion, serializedSessionKey, sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);

  const calls = [
    {
      to: sellToken,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GPV2_VAULT_RELAYER, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
      }),
    },
    {
      to: GPV2_SETTLEMENT,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: SETTLEMENT_ABI,
        functionName: "setPreSignature",
        args: [orderUid, true],
      }),
    },
  ];

  const gasOverrides = deps.USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(500_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(calls),
    ...gasOverrides,
  });

  // Fire-and-forget: don't wait for receipt if caller wants speed
  if (deps.noWait) {
    return { userOpHash, txHash: null };
  }

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}

// --- Ensure vault relayer approval (one-time) ---

async function ensureApproval(tokenAddress, smartAccountAddress, deps) {
  const { publicClient } = deps;

  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [smartAccountAddress, GPV2_VAULT_RELAYER],
  });

  // If already max-approved, skip
  if (allowance > BigInt("1000000000000000000000000")) {
    return null;
  }

  console.log(`[cow] Approving vault relayer for ${tokenAddress}...`);
  const { makeKernelClient } = deps;
  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_1;

  const sessionSigner = privateKeyToAccount(deps.sessionPrivateKey);
  const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });
  const account = await deserializePermissionAccount(
    publicClient, entryPoint, kernelVersion, deps.serializedSessionKey, sessionKeySigner
  );

  const kernelClient = makeKernelClient(account);
  const gasOverrides = deps.USE_PAYMASTER ? {} : {
    verificationGasLimit: BigInt(2_000_000),
    callGasLimit: BigInt(200_000),
    preVerificationGas: BigInt(200_000),
  };

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([{
      to: tokenAddress,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GPV2_VAULT_RELAYER, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
      }),
    }]),
    ...gasOverrides,
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  console.log(`[cow] Approved in tx: ${receipt.receipt.transactionHash}`);
  return receipt.receipt.transactionHash;
}

// --- Main swap function ---

/**
 * Fast swap: EIP-1271 signing (no on-chain presign tx needed).
 * Falls back to presign if EIP-1271 fails.
 *
 * Requires a one-time approval of the vault relayer for the sell token.
 */
export async function cowSwap({
  serializedSessionKey, sessionPrivateKey, smartAccountAddress, ownerPrivateKey,
  sellToken, buyToken, sellAmount, slippageBps = 50, validForSecs = 1800,
}, deps) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[cow +${Date.now()-t0}ms] ${msg}`);

  log(`Quote: ${sellAmount} of ${sellToken} → ${buyToken} (${slippageBps}bps slippage)`);

  // 1. Ensure vault relayer approval (skips if already approved)
  await ensureApproval(sellToken, smartAccountAddress, {
    ...deps,
    serializedSessionKey,
    sessionPrivateKey,
  });

  // 2. Get quote (always use presign scheme for now — EIP-1271 needs Kernel sig wrapping)
  const quoteResponse = await getQuote({
    sellToken, buyToken, sellAmount,
    from: smartAccountAddress,
    signingScheme: "presign",
  });
  const quote = quoteResponse.quote;
  log(`Quoted: sell ${quote.sellAmount}, buy ${quote.buyAmount}`);

  // 3. Post order + presign on-chain (fire-and-forget the UserOp for speed)
  let orderUid;
  let presignTxHash = null;

  {
    orderUid = await postOrderPresign(quote, smartAccountAddress, { slippageBps, validForSecs });
    log(`Order posted: ${orderUid}`);

    const result = await presignOrder({
      serializedSessionKey, sessionPrivateKey,
      orderUid, sellToken, sellAmount: quote.sellAmount,
    }, { ...deps, noWait: true });
    presignTxHash = result.txHash;
    log(`UserOp sent (hash: ${result.userOpHash.substring(0, 18)}...) — not waiting for receipt`);
  }

  log(`Done. Total: ${Date.now()-t0}ms`);

  return {
    orderUid,
    presignTxHash,
    quote: {
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      feeAmount: quote.feeAmount,
    },
  };
}

export async function getOrderStatus(orderUid) {
  const res = await fetch(`${COW_API}/orders/${orderUid}`);
  if (!res.ok) throw new Error(`Failed to fetch order: ${res.status}`);
  return res.json();
}

export { GPV2_SETTLEMENT, GPV2_VAULT_RELAYER, COW_API };
