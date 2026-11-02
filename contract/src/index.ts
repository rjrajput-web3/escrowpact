/**
 * EscrowPact — milestone escrow for freelance work on NEAR.
 *
 * Problem: freelancers get stiffed and clients get ghosted. EscrowPact puts
 * milestone payments in a trustless on-chain escrow: the client funds each
 * milestone up front, the freelancer submits proof of work, and funds release
 * only on client approval. Disputes lock the funds until the client resolves
 * them; unfunded-by-work milestones can be refunded by the client.
 *
 * All state transitions are enforced on-chain. Money only moves on:
 *  - approve_milestone   -> pays the freelancer
 *  - resolve_dispute     -> pays the freelancer OR refunds the client
 *  - refund_milestone    -> refunds the client (work never submitted)
 *
 * Track: Real-World Money (invoices / stablecoin payments onchain).
 */
import {
  NearBindgen,
  near,
  call,
  view,
  LookupMap,
  NearPromise,
} from "near-sdk-js";

export type MilestoneInput = {
  description: string;
  /** Amount in yoctoNEAR, as a decimal string (bigint-safe). */
  amount: string;
};

export type Milestone = {
  description: string;
  amount: string;
  funded: boolean;
  submitted: boolean;
  /** Proof of work supplied by the freelancer (URL or text, <= 500 chars). */
  proof: string;
  approved: boolean;
  disputed: boolean;
};

export type Job = {
  client: string;
  freelancer: string;
  title: string;
  milestones: Milestone[];
  /** Block timestamp (ns) at creation, as a string. */
  created_at: string;
};

const MAX_MILESTONES = 10;
const MAX_ID_LEN = 64;
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 200;
const MAX_PROOF_LEN = 500;

@NearBindgen({})
class EscrowPact {
  jobs: LookupMap<Job> = new LookupMap("jobs");
  job_ids: string[] = [];

  private loadJob(job_id: string): Job {
    const job = this.jobs.get(job_id);
    if (!job) {
      throw new Error(`EscrowPact: unknown job '${job_id}'`);
    }
    return job;
  }

  private saveJob(job_id: string, job: Job): void {
    this.jobs.set(job_id, job);
  }

  private milestone(job: Job, index: number): Milestone {
    if (!Number.isInteger(index) || index < 0 || index >= job.milestones.length) {
      throw new Error("EscrowPact: milestone index out of range");
    }
    return job.milestones[index];
  }

  /** Client opens a job with 1..10 milestones. No funds move here. */
  @call({})
  create_job({
    job_id,
    freelancer,
    title,
    milestones,
  }: {
    job_id: string;
    freelancer: string;
    title: string;
    milestones: MilestoneInput[];
  }) {
    const client = near.predecessorAccountId();
    if (typeof job_id !== "string" || job_id.length === 0 || job_id.length > MAX_ID_LEN) {
      throw new Error("EscrowPact: job_id must be 1-64 chars");
    }
    if (this.jobs.get(job_id)) {
      throw new Error("EscrowPact: job_id already exists");
    }
    if (typeof freelancer !== "string" || freelancer.length === 0 || freelancer === client) {
      throw new Error("EscrowPact: invalid freelancer (must differ from client)");
    }
    if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LEN) {
      throw new Error("EscrowPact: title must be 1-120 chars");
    }
    if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > MAX_MILESTONES) {
      throw new Error(`EscrowPact: need 1-${MAX_MILESTONES} milestones`);
    }
    const ms: Milestone[] = milestones.map((m, i) => {
      if (!m || typeof m.description !== "string" || m.description.length === 0 || m.description.length > MAX_DESC_LEN) {
        throw new Error(`EscrowPact: milestone ${i} needs a 1-200 char description`);
      }
      let amt: bigint;
      try {
        amt = BigInt(m.amount);
      } catch {
        throw new Error(`EscrowPact: milestone ${i} has an invalid amount`);
      }
      if (amt <= 0n) {
        throw new Error(`EscrowPact: milestone ${i} amount must be > 0`);
      }
      return {
        description: m.description,
        amount: m.amount,
        funded: false,
        submitted: false,
        proof: "",
        approved: false,
        disputed: false,
      };
    });
    this.jobs.set(job_id, {
      client,
      freelancer,
      title,
      milestones: ms,
      created_at: near.blockTimestamp().toString(),
    });
    this.job_ids.push(job_id);
    near.log(`job created: ${job_id} by ${client} for ${freelancer} (${ms.length} milestones)`);
  }

  /** Client funds one milestone — must attach EXACTLY the milestone amount. */
  @call({ payableFunction: true })
  fund_milestone({ job_id, index }: { job_id: string; index: number }) {
    const job = this.loadJob(job_id);
    if (near.predecessorAccountId() !== job.client) {
      throw new Error("EscrowPact: only the client can fund");
    }
    const m = this.milestone(job, index);
    if (m.funded) {
      throw new Error("EscrowPact: milestone already funded");
    }
    if (near.attachedDeposit() !== BigInt(m.amount)) {
      throw new Error(`EscrowPact: attach exactly ${m.amount} yoctoNEAR`);
    }
    m.funded = true;
    this.saveJob(job_id, job);
    near.log(`milestone ${index} of ${job_id} funded with ${m.amount} yoctoNEAR`);
  }

  /** Freelancer submits proof of work for a funded milestone. */
  @call({})
  submit_work({ job_id, index, proof }: { job_id: string; index: number; proof: string }) {
    const job = this.loadJob(job_id);
    if (near.predecessorAccountId() !== job.freelancer) {
      throw new Error("EscrowPact: only the freelancer can submit work");
    }
    const m = this.milestone(job, index);
    if (!m.funded) {
      throw new Error("EscrowPact: milestone not funded yet");
    }
    if (m.submitted) {
      throw new Error("EscrowPact: work already submitted");
    }
    if (m.disputed) {
      throw new Error("EscrowPact: milestone is disputed");
    }
    m.submitted = true;
    m.proof = typeof proof === "string" ? proof.slice(0, MAX_PROOF_LEN) : "";
    this.saveJob(job_id, job);
    near.log(`work submitted for milestone ${index} of ${job_id}`);
  }

  /** Client approves submitted work — escrowed funds go to the freelancer. */
  @call({})
  approve_milestone({ job_id, index }: { job_id: string; index: number }) {
    const job = this.loadJob(job_id);
    if (near.predecessorAccountId() !== job.client) {
      throw new Error("EscrowPact: only the client can approve");
    }
    const m = this.milestone(job, index);
    if (!m.funded || !m.submitted) {
      throw new Error("EscrowPact: milestone not ready for approval");
    }
    if (m.approved) {
      throw new Error("EscrowPact: milestone already approved");
    }
    if (m.disputed) {
      throw new Error("EscrowPact: resolve the dispute first");
    }
    m.approved = true;
    this.saveJob(job_id, job);
    near.log(`milestone ${index} of ${job_id} approved — paying ${m.amount} to ${job.freelancer}`);
    return NearPromise.new(job.freelancer).transfer(BigInt(m.amount));
  }

  /** Client or freelancer flags a submitted milestone — funds lock until resolved. */
  @call({})
  raise_dispute({ job_id, index }: { job_id: string; index: number }) {
    const job = this.loadJob(job_id);
    const caller = near.predecessorAccountId();
    if (caller !== job.client && caller !== job.freelancer) {
      throw new Error("EscrowPact: only the parties can dispute");
    }
    const m = this.milestone(job, index);
    if (!m.funded || !m.submitted) {
      throw new Error("EscrowPact: nothing to dispute yet");
    }
    if (m.approved || m.disputed) {
      throw new Error("EscrowPact: milestone already settled or disputed");
    }
    m.disputed = true;
    this.saveJob(job_id, job);
    near.log(`dispute raised on milestone ${index} of ${job_id} by ${caller}`);
  }

  /** Client resolves a dispute: pay the freelancer, or refund themselves. */
  @call({})
  resolve_dispute({
    job_id,
    index,
    release_to_freelancer,
  }: {
    job_id: string;
    index: number;
    release_to_freelancer: boolean;
  }) {
    const job = this.loadJob(job_id);
    if (near.predecessorAccountId() !== job.client) {
      throw new Error("EscrowPact: only the client resolves disputes");
    }
    const m = this.milestone(job, index);
    if (!m.disputed) {
      throw new Error("EscrowPact: no open dispute on this milestone");
    }
    m.disputed = false;
    if (release_to_freelancer) {
      m.approved = true;
      this.saveJob(job_id, job);
      near.log(`dispute on ${job_id}#${index} resolved FOR freelancer — paying ${m.amount}`);
      return NearPromise.new(job.freelancer).transfer(BigInt(m.amount));
    }
    // Refund path: milestone is cancelled, funds return to the client.
    m.funded = false;
    m.approved = false;
    this.saveJob(job_id, job);
    near.log(`dispute on ${job_id}#${index} resolved FOR client — refunding ${m.amount}`);
    return NearPromise.new(job.client).transfer(BigInt(m.amount));
  }

  /** Client reclaims funds for a milestone whose work was never submitted. */
  @call({})
  refund_milestone({ job_id, index }: { job_id: string; index: number }) {
    const job = this.loadJob(job_id);
    if (near.predecessorAccountId() !== job.client) {
      throw new Error("EscrowPact: only the client can refund");
    }
    const m = this.milestone(job, index);
    if (!m.funded) {
      throw new Error("EscrowPact: milestone is not funded");
    }
    if (m.submitted || m.approved || m.disputed) {
      throw new Error("EscrowPact: cannot refund a submitted milestone");
    }
    m.funded = false;
    this.saveJob(job_id, job);
    near.log(`milestone ${index} of ${job_id} refunded to ${job.client}`);
    return NearPromise.new(job.client).transfer(BigInt(m.amount));
  }

  @view({})
  get_job({ job_id }: { job_id: string }): Job {
    return this.loadJob(job_id);
  }

  @view({})
  list_job_ids(): string[] {
    return this.job_ids;
  }
}
