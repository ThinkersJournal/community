// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Terms acceptance at signup (ROADMAP R10 / S6; CireSnave 2026-10-25: a checkbox,
 * a stored record, and a signup age of 16 and over).
 *
 * `TERMS_VERSION` names the text a person agreed to. The SERVER stamps it, the
 * client never sends one: a client-supplied version could claim agreement to a
 * text that never existed. Change it in the same PR that changes the Terms,
 * Guidelines or Privacy text in a material way (docs/legal/README.md).
 */
export const TERMS_VERSION = '2026-10-25';

/**
 * The minimum age a person attests to at signup (design decision 15,
 * docs/superpowers/specs/2026-07-13-community-platform-design.md). Stored with
 * each acceptance so a later change of the age does not rewrite what was agreed.
 */
export const SIGNUP_MINIMUM_AGE = 16;

/** What `GET /account/terms` answers (ROADMAP R12): has this member accepted the CURRENT Terms text? */
export interface TermsStatus {
  readonly currentVersion: string;
  /** The newest `terms_version` this member has accepted, or null if they never recorded one. */
  readonly lastAcceptedVersion: string | null;
  /** True when they have no acceptance of `currentVersion`: show the notice and the accept form. */
  readonly needsAcceptance: boolean;
}
