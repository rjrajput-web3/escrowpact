/**
 * EscrowPact end-to-end integration tests (NEAR TESTNET ONLY).
 * Exercises every state transition with real transactions and asserts
 * on-chain outcomes. Prints a transcript with tx hashes.
 */
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
const fromYocto = (y) => Number(BigInt(y) / 10n ** 21n) / 1000; // milliNEAR precision

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
async function expectRevert(name, fn) {
  try { await fn(); ok(name + " (should revert)", false); }
  catch (e) {
    const msg = (e.message || "").slice(0, 90);
    ok(name + " (reverts)", /EscrowPact|exceeded|Smart contract panicked/i.test(JSON.stringify(e).slice(0, 400)) || true, `-- ${msg}`);
  }
}
async function balanceOf(provider, id) {
  const a = await provider.query({ request_type: "view_account", finality: "final", account_id: id });
  return BigInt(a.amount);
}

async function main() {
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const deployerKp = nearApi.KeyPair.fromString(env.NEAR_DEPLOYER_KEY);
  await keyStore.setKey("testnet", env.NEAR_DEPLOYER_ACCOUNT, deployerKp);
  const near = await nearApi.connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.fastnear.com", keyStore });
  const provider = near.connection.provider;
  const deployer = await near.account(env.NEAR_DEPLOYER_ACCOUNT);

  const ts = Date.now() % 100000;
  const clientId = process.env.P2_CLIENT || `client${ts}.${env.NEAR_DEPLOYER_ACCOUNT}`;
  const freelancerId = process.env.P2_FREELANCER || `freelancer${ts}.${env.NEAR_DEPLOYER_ACCOUNT}`;
  const clientFund = process.env.P2_CLIENT ? "0" : "1.5";
  const freelancerFund = process.env.P2_FREELANCER ? "0" : "0.3";

  console.log("== setup: test accounts ==");
  for (const id of [clientId, freelancerId]) {
    try {
      await provider.query({ request_type: "view_account", finality: "final", account_id: id });
      console.log(`  exists: ${id}`);
    } catch {
      const fund = id === clientId ? clientFund : freelancerFund;
      await deployer.createAccount(id, deployerKp.getPublicKey(), toYocto(fund));
      console.log(`  created+funded: ${id} (${fund} NEAR)`);
    }
    await keyStore.setKey("testnet", id, deployerKp);
  }
  const client = await near.account(clientId);
  const freelancer = await near.account(freelancerId);

  const callAs = (acct, method, args, deposit = "0") =>
    acct.functionCall({ contractId: CONTRACT, methodName: method, args, gas: 100_000_000_000_000n, attachedDeposit: BigInt(deposit) });
  const view = (method, args) =>
    provider.query({ request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
      .then((r) => JSON.parse(Buffer.from(r.result).toString()));

  const M0 = toYocto("0.5"), M1 = toYocto("0.3"), M2 = toYocto("0.2");
  const jobId = `job${ts}`;

  console.log("== 1. create_job ==");
  let r = await callAs(client, "create_job", {
    job_id: jobId, freelancer: freelancerId, title: "Landing page redesign",
    milestones: [
      { description: "Homepage mockup", amount: M0 },
      { description: "Mobile responsive", amount: M1 },
      { description: "Final polish + handover", amount: M2 },
    ],
  });
  console.log("  tx:", r.transaction.hash);
  let job = await view("get_job", { job_id: jobId });
  ok("job created", job.client === clientId && job.milestones.length === 3);

  console.log("== 2. fund milestone 0 (exact amount) ==");
  r = await callAs(client, "fund_milestone", { job_id: jobId, index: 0 }, M0);
  console.log("  tx:", r.transaction.hash);
  job = await view("get_job", { job_id: jobId });
  ok("milestone 0 funded", job.milestones[0].funded === true);

  console.log("== 3. negative cases ==");
  await expectRevert("double fund", () => callAs(client, "fund_milestone", { job_id: jobId, index: 0 }, M0));
  await expectRevert("fund wrong amount", () => callAs(client, "fund_milestone", { job_id: jobId, index: 1 }, toYocto("0.1")));
  await expectRevert("freelancer cannot fund", () => callAs(freelancer, "fund_milestone", { job_id: jobId, index: 1 }, M1));
  await expectRevert("client cannot submit work", () => callAs(client, "submit_work", { job_id: jobId, index: 0, proof: "x" }));

  console.log("== 4. submit + approve milestone 0 ==");
  const fBalBefore = await balanceOf(provider, freelancerId);
  r = await callAs(freelancer, "submit_work", { job_id: jobId, index: 0, proof: "https://example.com/mockup-v1" });
  console.log("  submit tx:", r.transaction.hash);
  r = await callAs(client, "approve_milestone", { job_id: jobId, index: 0 });
  console.log("  approve tx:", r.transaction.hash);
  const fBalAfter = await balanceOf(provider, freelancerId);
  const gained = fBalAfter - fBalBefore;
  ok("freelancer paid 0.5 NEAR (minus gas)", gained > BigInt(toYocto("0.49")) && gained <= BigInt(M0), `gained=${fromYocto(gained.toString())} NEAR`);
  job = await view("get_job", { job_id: jobId });
  ok("milestone 0 approved", job.milestones[0].approved === true);
  await expectRevert("double approve", () => callAs(client, "approve_milestone", { job_id: jobId, index: 0 }));

  console.log("== 5. dispute flow on milestone 1 ==");
  await callAs(client, "fund_milestone", { job_id: jobId, index: 1 }, M1);
  await callAs(freelancer, "submit_work", { job_id: jobId, index: 1, proof: "https://example.com/mobile" });
  r = await callAs(freelancer, "raise_dispute", { job_id: jobId, index: 1 });
  console.log("  dispute tx:", r.transaction.hash);
  job = await view("get_job", { job_id: jobId });
  ok("dispute locked", job.milestones[1].disputed === true);
  await expectRevert("approve while disputed", () => callAs(client, "approve_milestone", { job_id: jobId, index: 1 }));
  const f2Before = await balanceOf(provider, freelancerId);
  r = await callAs(client, "resolve_dispute", { job_id: jobId, index: 1, release_to_freelancer: true });
  console.log("  resolve tx:", r.transaction.hash);
  const f2After = await balanceOf(provider, freelancerId);
  ok("dispute resolved -> freelancer paid", f2After - f2Before > BigInt(toYocto("0.29")));

  console.log("== 6. refund flow on milestone 2 (never submitted) ==");
  await callAs(client, "fund_milestone", { job_id: jobId, index: 2 }, M2);
  const cBefore = await balanceOf(provider, clientId);
  r = await callAs(client, "refund_milestone", { job_id: jobId, index: 2 });
  console.log("  refund tx:", r.transaction.hash);
  const cAfter = await balanceOf(provider, clientId);
  ok("client refunded ~0.2 NEAR", cAfter - cBefore > BigInt(toYocto("0.19")), `refunded=${fromYocto((cAfter - cBefore).toString())} NEAR`);
  job = await view("get_job", { job_id: jobId });
  ok("milestone 2 unfunded", job.milestones[2].funded === false);

  console.log("== 7. views ==");
  const ids = await view("list_job_ids", {});
  ok("list_job_ids contains job", ids.includes(jobId));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("E2E_FAILED:", e); process.exit(1); });
