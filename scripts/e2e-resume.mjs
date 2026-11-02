/** Resume e2e: refund flow + views on the already-created job (fastnear RPC). */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as nearApi from "near-api-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);
const CONTRACT = `escrow.${env.NEAR_DEPLOYER_ACCOUNT}`;
const toYocto = (n) => nearApi.utils.format.parseNearAmount(String(n));
const fromYocto = (y) => Number(BigInt(y) / 10n ** 21n) / 1000;
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

async function main() {
  const jobId = process.env.P2_JOB;
  const clientId = process.env.P2_CLIENT;
  if (!jobId || !clientId) throw new Error("need P2_JOB and P2_CLIENT");
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const kp = nearApi.KeyPair.fromString(env.NEAR_DEPLOYER_KEY);
  await keyStore.setKey("testnet", env.NEAR_DEPLOYER_ACCOUNT, kp);
  await keyStore.setKey("testnet", clientId, kp);
  const near = await nearApi.connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.fastnear.com", keyStore });
  const provider = near.connection.provider;
  const client = await near.account(clientId);
  const bal = async (id) => BigInt((await provider.query({ request_type: "view_account", finality: "final", account_id: id })).amount);
  const view = (m, a) => provider.query({ request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") })
    .then((r) => JSON.parse(Buffer.from(r.result).toString()));

  console.log("== 6. refund flow on milestone 2 (never submitted) ==");
  const cBefore = await bal(clientId);
  const r = await client.functionCall({ contractId: CONTRACT, methodName: "refund_milestone", args: { job_id: jobId, index: 2 }, gas: 100_000_000_000_000n });
  console.log("  refund tx:", r.transaction.hash);
  const cAfter = await bal(clientId);
  ok("client refunded ~0.2 NEAR", cAfter - cBefore > BigInt(toYocto("0.19")), `refunded=${fromYocto((cAfter - cBefore).toString())} NEAR`);
  const job = await view("get_job", { job_id: jobId });
  ok("milestone 2 unfunded", job.milestones[2].funded === false);
  ok("milestone states sane",
    job.milestones[0].approved && job.milestones[1].approved && !job.milestones[2].funded);

  console.log("== 7. views ==");
  const ids = await view("list_job_ids", {});
  ok("list_job_ids contains job", ids.includes(jobId));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error("RESUME_FAILED:", e.message); process.exit(1); });
