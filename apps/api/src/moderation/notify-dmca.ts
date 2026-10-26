// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The DMCA notices (ROADMAP R9; policy docs/legal/dmca-policy.md): a takedown
 * notice to the AUTHOR carrying a copy of the complainant's notice and the
 * counter-notice link, and the outcome emails to the CLAIMANT. Pure renderers
 * only: the notice outbox queues the result inside the deciding transaction
 * (notice-enqueue.ts) and the cron drain sends it.
 *
 * The wording is a placeholder for the attorney, like the policy it follows.
 * ⚠️ The author's copy names the complainant and their contact details: a
 * counter-notice cannot be made without them, and policy section 2 promises "a
 * copy of the notice". The privacy policy says so.
 */
import { CONTACT_EMAIL } from "@thinkersjournal/shared";

import { escapeHtml } from "../auth/email-verify";
import type { RenderedNotice } from "./notify-author";

export interface DmcaNoticeCopy {
  readonly complainantName: string;
  readonly complainantEmail: string;
  readonly complainantAddress: string;
  readonly complainantPhone: string;
  readonly workDescription: string;
  readonly signature: string;
  /** When the notice was sent (its `created_at`). */
  readonly sentAt: Date;
}

export interface DmcaAuthorNoticeInput {
  readonly subject: "post" | "comment";
  /** The post's title; for a comment, its parent post's title. */
  readonly postTitle: string;
  readonly notice: DmcaNoticeCopy;
  /** Where the author sends a counter-notice (carries the single-use token). */
  readonly counterUrl: string;
  /** The restore wait named in the text, in business days (a placeholder for the attorney). */
  readonly restoreBusinessDays: number;
}

function what(subject: "post" | "comment", title: string): string {
  return subject === "post" ? `your post "${title}"` : `your comment on "${title}"`;
}

/** The takedown notice to the person who posted the material (§512(g)(2)(A)). */
export function renderDmcaAuthorNotice(input: DmcaAuthorNoticeInput): RenderedNotice {
  const n = input.notice;
  const lead = `We removed ${what(input.subject, input.postTitle)} from Thinker's Journal after receiving a copyright notice under the Digital Millennium Copyright Act (17 U.S.C. §512).`;
  const copyIntro = "A copy of the notice we received:";
  const lines = [
    `Sent: ${n.sentAt.toISOString().slice(0, 10)}`,
    `From: ${n.complainantName}, ${n.complainantAddress}, ${n.complainantPhone}, ${n.complainantEmail}`,
    `Copyrighted work they say was infringed: ${n.workDescription}`,
    `They stated that they have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law, and, under penalty of perjury, that the information in the notice is accurate and that they are the owner or authorized to act for the owner.`,
    `Signed: ${n.signature}`,
  ];
  const counter = `If you believe the material was removed by mistake or misidentification, you can send us a counter-notice at this link: ${input.counterUrl}`;
  const timeline = `If we receive a valid counter-notice we will send it to the person who sent the notice. We may then restore the material in about ${input.restoreBusinessDays} business days, unless they tell us they have filed a court action to stop it.`;
  const repeat = "Accounts that repeatedly post infringing material can be terminated.";

  return {
    subject: "A copyright notice led us to remove your content",
    textBody: `${lead}\n\n${copyIntro}\n\n${lines.join("\n")}\n\n${counter}\n\n${timeline}\n\n${repeat}\n`,
    htmlBody:
      `<p>${escapeHtml(lead)}</p><p>${escapeHtml(copyIntro)}</p>` +
      `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` +
      `<p>If you believe the material was removed by mistake or misidentification, you can send us a counter-notice: ` +
      `<a href="${escapeHtml(input.counterUrl)}">${escapeHtml(input.counterUrl)}</a></p>` +
      `<p>${escapeHtml(timeline)}</p><p>${escapeHtml(repeat)}</p>`,
  };
}

export interface DmcaClaimantOutcomeInput {
  readonly outcome: "taken_down" | "rejected";
  readonly subject: "post" | "comment";
  readonly postTitle: string;
  /** Rejection only: the moderator's reason. */
  readonly reason?: string;
}

/** The outcome email to the complainant. */
export function renderDmcaClaimantOutcome(input: DmcaClaimantOutcomeInput): RenderedNotice {
  const about = input.subject === "post" ? `the post "${input.postTitle}"` : `the comment on "${input.postTitle}"`;
  if (input.outcome === "taken_down") {
    const lead = `We reviewed your copyright notice about ${about} and removed it.`;
    const next =
      "We have told the person who posted it. If they send a counter-notice, we will forward it to you; unless you tell us you have filed a court action, we may then restore the material.";
    return {
      subject: "We removed the material in your copyright notice",
      textBody: `${lead}\n\n${next}\n`,
      htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(next)}</p>`,
    };
  }
  const lead = `We reviewed your copyright notice about ${about} and did not remove it.`;
  const why = input.reason ?? "";
  return {
    subject: "We did not act on your copyright notice",
    textBody: `${lead}\n\nReason:\n\n${why}\n\nYou can send a new notice if you can correct the problem.\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p><strong>Reason:</strong></p><p>${escapeHtml(why)}</p><p>You can send a new notice if you can correct the problem.</p>`,
  };
}

export interface DmcaCounterToClaimantInput {
  readonly subject: "post" | "comment";
  readonly label: string;
  readonly counter: {
    readonly authorName: string;
    readonly authorAddress: string;
    readonly authorPhone: string;
    readonly signature: string;
  };
  /** The earliest the material can be restored; the claimant must tell us of a court action before it. */
  readonly restoreAfter: Date;
}

/**
 * The counter-notice, forwarded to the claimant (§512(g)(2)(B)): who sent it,
 * their contact details, and the one thing that stops the restoration.
 */
export function renderDmcaCounterToClaimant(input: DmcaCounterToClaimantInput): RenderedNotice {
  const about = input.subject === "post" ? `the post "${input.label}"` : `the comment on "${input.label}"`;
  const c = input.counter;
  const lead = `The person who posted ${about} sent us a counter-notice to your copyright notice. They say, under penalty of perjury, that they have a good-faith belief that the material was removed by mistake or misidentification, and they consent to the jurisdiction of the federal court for their district and will accept service of process from you.`;
  const lines = [`From: ${c.authorName}, ${c.authorAddress}, ${c.authorPhone}`, `Signed: ${c.signature}`];
  const date = input.restoreAfter.toISOString().slice(0, 10);
  const next = `We may restore the material on or after ${date}, unless before then you tell us that you have filed a court action asking for an order to stop the person from infringing. To tell us, email ${CONTACT_EMAIL} with a copy of the filing.`;
  return {
    subject: "A counter-notice was sent in reply to your copyright notice",
    textBody: `${lead}\n\n${lines.join("\n")}\n\n${next}\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul><p>${escapeHtml(next)}</p>`,
  };
}

export interface DmcaRestoreInput {
  readonly subject: "post" | "comment";
  readonly postTitle: string;
  /** Why it was restored: a counter-notice that went unanswered, or the claimant withdrew. */
  readonly cause: "counter_notice" | "withdrawn";
}

const RESTORE_CAUSE: Readonly<Record<DmcaRestoreInput["cause"], string>> = {
  counter_notice: "We received your counter-notice and the person who sent the copyright notice did not tell us they had filed a court action in time.",
  withdrawn: "The person who sent the copyright notice withdrew it.",
};

/** To the author: the material is visible again. */
export function renderDmcaRestoreToAuthor(input: DmcaRestoreInput): RenderedNotice {
  const what = input.subject === "post" ? `your post "${input.postTitle}"` : `your comment on "${input.postTitle}"`;
  const lead = `We restored ${what}.`;
  const why = RESTORE_CAUSE[input.cause];
  return {
    subject: "Your content is visible again",
    textBody: `${lead}\n\n${why}\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(why)}</p>`,
  };
}

/** To the claimant: what happened to the material their notice named. */
export function renderDmcaRestoreToClaimant(input: DmcaRestoreInput): RenderedNotice {
  const about = input.subject === "post" ? `the post "${input.postTitle}"` : `the comment on "${input.postTitle}"`;
  const lead =
    input.cause === "withdrawn"
      ? `As you asked, we restored ${about} after you withdrew your copyright notice.`
      : `We restored ${about}: the person who posted it sent a counter-notice and we did not hear from you that you had filed a court action in time.`;
  const next = "If you believe the material still infringes your copyright, your remedy is a court action against the person who posted it.";
  return {
    subject: "The material in your copyright notice was restored",
    textBody: `${lead}\n\n${next}\n`,
    htmlBody: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(next)}</p>`,
  };
}
