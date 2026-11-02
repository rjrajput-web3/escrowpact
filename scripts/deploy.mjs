/**
 * EscrowPact testnet deploy script (fresh, NEAR testnet only).
 * Reads NEAR_DEPLOYER_ACCOUNT / NEAR_DEPLOYER_KEY from ../.env (chmod 600).
 * Steps: create subaccount escrow.<deployer> -> deploy contract.wasm -> verify.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as nearApi from "near-api-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) throw new Error("missing .env (see .env.example)");
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const YOCTO = 10n ** 24n;

async function main() {
  loadEnv();
  const deployerId = process.env.NEAR_DEPLOYER_ACCOUNT;
  const secretKey = process.env.NEAR_DEPLOYER_KEY;
  if (!deployerId || !secretKey) throw new Error(".env incomplete");

  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const keyPair = nearApi.KeyPair.fromString(secretKey);
  await keyStore.setKey("testnet", deployerId, keyPair);

  const near = await nearApi.connect({
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.fastnear.com",
    keyStore,
  });
  const deployer = await near.account(deployerId);
  const contractId = `escrow.${deployerId}`;

  // 1. Create the subaccount (idempotent-ish: skip if it exists)
  let exists = true;
  try {
    await near.connection.provider.query({
      request_type: "view_account",
      finality: "final",
      account_id: contractId,
    });
    console.log(`subaccount ${contractId} already exists`);
  } catch {
    exists = false;
  }
  if (!exists) {
    console.log(`creating subaccount ${contractId}...`);
    const pubKey = keyPair.getPublicKey();
    await deployer.createAccount(
      contractId,
      pubKey,
      nearApi.utils.format.parseNearAmount("3.5") // storage staking + gas buffer
    );
    console.log("subaccount created");
    await keyStore.setKey("testnet", contractId, keyPair);
  } else {
    await keyStore.setKey("testnet", contractId, keyPair);
  }

  // 2. Deploy the contract
  const wasm = readFileSync(join(ROOT, "contract", "build", "contract.wasm"));
  console.log(`deploying ${wasm.length} bytes to ${contractId}...`);
  const contractAccount = await near.account(contractId);
  const deployRes = await contractAccount.deployContract(wasm);
  console.log("deploy tx:", deployRes.transaction.hash);

  // 3. Verify: code deployed + view works
  const acct = await near.connection.provider.query({
    request_type: "view_account",
    finality: "final",
    account_id: contractId,
  });
  console.log("code_hash:", acct.code_hash.slice(0, 12) + "...");
  console.log("balance:", (BigInt(acct.amount) / YOCTO).toString(), "NEAR");

  const ids = await contractAccount.viewFunction({ contractId, methodName: "list_job_ids", args: {} });
  console.log("list_job_ids ->", JSON.stringify(ids));
  console.log("DEPLOY_OK contract=" + contractId);
}

main().catch((e) => {
  console.error("DEPLOY_FAILED:", e.message);
  process.exit(1);
});
