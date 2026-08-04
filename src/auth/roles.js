'use strict';

/**
 * The three community tiers, in order of power. One place decides what each
 * name means so a route, a view and a query can never disagree.
 *
 *   member    — boards, drafts, comments.
 *   leader    — the whole admin console; may be permanent or time-boxed
 *               (users.role_expires_at, UTC ISO; NULL = permanent).
 *   architect — one per board. Every leader power, and the only tier that can
 *               move anyone downward: demote a leader, deactivate a leader,
 *               force a leader's reset code. The architect itself cannot be
 *               deactivated, demoted, deleted or reset by anyone — the only way
 *               out of the chair is to hand it over (POST /admin/members/transfer).
 *
 * "Leader" in the UI means "leader or architect": an architect is a leader with
 * more, never less, so every existing isLeader / requireLeader check keeps
 * working for them.
 */

const MEMBER = 'member';
const LEADER = 'leader';
const ARCHITECT = 'architect';

const ROLES = [MEMBER, LEADER, ARCHITECT];

/** Roles that unlock /admin and every leader-level moderation power. */
const LEADER_ROLES = new Set([LEADER, ARCHITECT]);

const isRole = (role) => ROLES.includes(role);
const isLeaderRole = (role) => LEADER_ROLES.has(role);
const isArchitectRole = (role) => role === ARCHITECT;

/** Convenience for the user-object form the routes actually hold. */
const isLeaderUser = (user) => !!user && isLeaderRole(user.role);
const isArchitectUser = (user) => !!user && isArchitectRole(user.role);

/** "ARCHITECT" / "LEADER" / "MEMBER" for badges. */
const roleLabel = (role) => (isRole(role) ? role.toUpperCase() : String(role || '').toUpperCase());

module.exports = {
  MEMBER,
  LEADER,
  ARCHITECT,
  ROLES,
  LEADER_ROLES,
  isRole,
  isLeaderRole,
  isArchitectRole,
  isLeaderUser,
  isArchitectUser,
  roleLabel,
};
